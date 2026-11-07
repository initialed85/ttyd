// Images that outlive the frame that drew them.
//
// tmux keeps cells, not pictures. Measured in slopyphus (hack/pane-persistence.sh, 2026-11-07, tmux 3.4): a pane
// that has just drawn an inline image holds none of it in its history - `capture-pane -p -e` finds no copy - so
// every repaint is destructive. `WheelUpPane` into copy-mode reprints a history slice, a resize reprints the pane,
// the pane menu draws over it, a reattach reprints for the new client, and the picture is gone until the
// application emits the bytes again. That is the "sometimes it comes back" behaviour no amount of row reservation
// can fix, and it is why the picture has to live somewhere tmux cannot erase.
//
// tools/tmux-osc-wrap.py --anchor does the saving half: it writes each picture it passes into the pane's own
// working directory under .slopyphus/images, named by a prefix of its content hash, and prints one dimmed line of
// text at the top-left cell of the space it reserves for the picture - its own row, column 0:
//
//     [[img:<10 hex>.<ext>:<rows>]]
//
// Text is the one thing that survives every repaint listed above. This addon is the other half: it reads those
// lines out of the buffer and draws the file they name, downward from the row the line is printed on, on every
// render. The bytes come from ttyd itself - `GET <base>/images/<name>` in src/http.c, which accepts nothing but a
// name of that exact shape and answers `Cache-Control: public, max-age=31536000, immutable`, because a content hash
// prefix never names different content and a picture redrawn from a cache is only the same picture if it is the
// same bytes.
//
// The token sits above the picture rather than below it, and the reason is tmux's reflow. A narrowing pane rewraps
// long lines, and rewrapping inserts rows into the lines that wrap. With the reserved emptiness *below* the record,
// a long line above the picture could wrap into the rows the picture was promised, and the guard below would
// correctly refuse to draw over text - which is what a report described as a picture that reappears on a resize
// "under some situations". With the emptiness *after* the record, wrapping happens above the pair and the token and
// the rows it owns move down together, unchanged.
//
// The row count is part of the anchor rather than something worked out here, for two reasons. Reserved blank rows
// are indistinguishable from blank rows the application printed, so the reservation is only knowable from the
// record that made it; and a count in cells is the one measurement that survives a pane resize, which pixels are
// not. See anchor_line in tools/tmux-osc-wrap.py.
import { bind } from 'decko';
import type { IDisposable, ITerminalAddon, Terminal } from '@xterm/xterm';

// IBuffer is not exported from @xterm/xterm's typings (typings/xterm.d.ts declares it inside the module without an
// export), so the buffer is named through the terminal that owns it rather than imported.
type ActiveBuffer = Terminal['buffer']['active'];

// The name and the row count, exactly as src/http.c's image_name_ok accepts them: ten lowercase hex digits, one
// dot, one of the four extensions the relay writes. The two rules are deliberately redundant - a browser that
// only drew what the server would serve never asks for a 404 - and this one is intentionally not permissive about
// upper case, which is how a mismatch between the two shows up early.
const ANCHOR = /\[\[img:([0-9a-f]{10}\.(?:png|jpg|gif|bmp)):(\d{1,3})\]\]/g;

// A pane with a picture in it is a pane that is looking at a picture; anything older than the last few screens of
// output is not going to be on screen again soon. The cap is on decoded bitmaps, which is where the memory is.
const CACHE_LIMIT = 48;

interface Placement {
    name: string;
    rows: number;
    // The buffer row the anchor line itself sits on, absolute (buffer coordinates, not viewport coordinates), and
    // therefore the picture's own top row: the relay prints the token at the cursor cell and the picture renders
    // downward from that cell, so the token's cell is the picture's top-left.
    row: number;
}

export class ImageAnchorAddon implements ITerminalAddon {
    private terminal: Terminal;
    private canvas?: HTMLCanvasElement;
    private placements: Placement[] = [];
    private geometryNudged = false;
    private images = new Map<string, HTMLImageElement>();
    // One console warning per name, not per frame: a picture that is not there stays not there for the whole
    // scrollback and a warning per render is how a pane becomes unreadable in the developer tools.
    private complained = new Set<string>();
    private loading = new Set<string>();
    private disposables: IDisposable[] = [];

    activate(terminal: Terminal): void {
        this.terminal = terminal;
        // onRender is the only subscription needed. It fires after a scroll, after a resize (the fit addon resizes
        // and the renderer then repaints), and after an image finishes arriving, because drawing one here requests
        // a repaint.
        this.disposables.push(terminal.onRender(() => this.draw()));
    }

    dispose(): void {
        this.disposables.forEach(d => d.dispose());
        this.disposables = [];
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        this.canvas = undefined;
        this.placements = [];
        this.images.clear();
        this.complained.clear();
        this.loading.clear();
    }

    /**
     * The base path ttyd serves this page from. Built the same way app.tsx builds the websocket URL - the page's
     * own path with trailing slashes removed - so the two cannot drift: the route in src/http.c is registered
     * under the server's base path, and this is the only client-side place that has to agree with it.
     */
    @bind
    private imagePath(name: string): string {
        const path = window.location.pathname.replace(/[/]+$/, '');
        return `${path}/images/${name}`;
    }

    @bind
    private draw(): void {
        const terminal = this.terminal;
        if (!terminal || !terminal.element) return;
        const screen = terminal.element.querySelector('.xterm-screen');
        if (!screen) return; // not opened into the DOM yet; the next render will find it

        // Cell size is measured, not assumed. xterm.js sizes .xterm-screen to exactly cols x cellWidth by
        // rows x cellHeight (Terminal.ts: screenElement gets the render service's dimensions), so dividing the
        // element by the grid gives the cell this browser is actually using - which is the only honest number
        // here, since the row count in an anchor was written by a relay that had to guess the cell.
        const rect = screen.getBoundingClientRect();
        const cols = terminal.cols;
        const rows = terminal.rows;
        const cellW = rect.width / cols;
        const cellH = rect.height / rows;
        if (!(cellW > 0) || !(cellH > 0) || !isFinite(cellW) || !isFinite(cellH)) {
            // A render that happens before the page has laid the terminal out measures zero for everything. Ask
            // once for another render instead of returning into a pane that may go idle and never render again: a
            // client attaching to a pane whose picture was already printed is measured, 3 of 15 asserted looks
            // across three harness runs on 07/11, drawing nothing and saying nothing at all. Once per unusable
            // geometry, so a terminal that never gets a size cannot refresh-loop.
            if (!this.geometryNudged) {
                this.geometryNudged = true;
                this.log(`the screen measured ${rect.width}x${rect.height}; asking xterm for another render`);
                terminal.refresh(0, rows - 1);
            }
            return;
        }
        this.geometryNudged = false;

        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        const canvas = this.ensureCanvas(screen);
        const ctx = canvas && canvas.getContext('2d');
        if (!ctx) return;

        const buffer = terminal.buffer.active;
        // tmux draws its own chrome in the columns a client has that the window does not, and this deployment asks
        // for that on purpose: window-size is `largest` (.tmux.conf) so a narrow browser cannot shrink an agent's
        // pane, which guarantees a client wider than what it is attached to. Measured the same afternoon in the
        // anchor-narrow case - a 50-column client on a 40-column window - every row of the pane read `│` at column
        // 40 followed by nine `·`, including the twenty rows an anchor had reserved. Judged as content, that is
        // twenty rows of somebody's writing lying over a picture, and the guard below correctly refused to draw
        // one, which is the report "resizing the window brings it back under some situations" seen from the side
        // where it is a refusal rather than a disappearance.
        const padCol = this.paddingColumn(buffer, rows, cols);
        // The scan runs on every render and nothing is cached about its result. Three separate bugs in this
        // feature have had the same shape: an answer computed for an earlier render, still internally consistent,
        // and no longer true. The viewport key below was the second of them - scrolling, a resize, the buffer
        // growing, the canvas resizing and the cursor moving folded into one string - and adding the cursor to it
        // fixed the case that had been measured (a client attaching to a pane whose anchor was already printed:
        // writing text into a viewport that is already the right size moves viewportY, baseY, the buffer length and
        // the grid size none at all) and left the rest, which is that a program rewriting a viewport and parking
        // the cursor where it already was left the key untouched, so an anchor appearing in such a rewrite was
        // never looked for. Three runs of this harness on 07/11 showed the gap is not theoretical: the same product
        // code and the same cases passed 15 looks on one run and failed 2 on another, and the failing looks logged
        // nothing at all, which is exactly what a cached empty scan looks like from outside.
        //
        // The cost is `rows` line translations per render, measured in the harness (scanCost, reported by the page)
        // rather than assumed. What stays cached is the picture's bytes, keyed by content hash, so a hot pane pays
        // for the scan and not for the fetch.
        const found = this.scan(buffer, rows);
        if (found.length !== this.placements.length) {
            this.log(`scan found ${found.length} anchor(s), was ${this.placements.length}`);
        }
        this.placements = found;

        const dpr = window.devicePixelRatio || 1;
        const pw = Math.round(width * dpr);
        const ph = Math.round(height * dpr);
        if (canvas.width !== pw || canvas.height !== ph) {
            canvas.width = pw;
            canvas.height = ph;
        }
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);

        // Top-down: the anchor is printed at the top-left cell of the space it reserves, so a picture covers its
        // own row and the rows below it. The token's row is allowed to be non-empty - it is what the token is -
        // provided it holds nothing *else*, because a reflow that wrapped somebody's sentence onto the token's row
        // is a sentence a picture must not cover.
        const live: Placement[] = [];
        for (const placement of this.placements) {
            const line = buffer.getLine(placement.row);
            const text = line ? line.translateToString(true) : '';
            if (!this.matches(placement, text)) {
                // Said out loud rather than left to inference, because "nothing was drawn" and "the guard refused
                // to draw" look identical from the outside and only differ in what the grid now contains.
                this.log(
                    `not drawing ${placement.name} at row ${placement.row}: it reads ${JSON.stringify(
                        text.trim().slice(0, 60)
                    )}`
                );
                continue;
            }
            const token = `[[img:${placement.name}:${placement.rows}]]`;
            const extra = this.content(text, 0, padCol).replace(token, '').trim();
            if (extra) {
                this.log(`not drawing ${placement.name}: its own row also reads ${JSON.stringify(extra.slice(0, 60))}`);
                continue;
            }
            const top = placement.row;
            const bottom = placement.row + placement.rows - 1;
            // A picture is drawn only where the grid is genuinely empty over the rows it would cover. Reserved
            // rows are empty by construction; a narrower pane reflows long lines into them, and then text wins,
            // because a covered sentence is a lost sentence while a covered picture is only a lost picture.
            if (bottom > top && !this.clearBelow(buffer, top + 1, bottom, padCol)) {
                const hit = this.firstOccupied(buffer, top + 1, bottom, padCol);
                const why = `row ${hit.row} of the reserved rows is not empty: ${JSON.stringify(hit.text)}`;
                this.log(`not drawing ${placement.name}: ${why}`);
                continue;
            }
            live.push(placement);
            this.paint(ctx, placement, buffer.viewportY, cellH, padCol < cols ? padCol * cellW : width, height);
        }
        if (live.length !== this.placements.length) {
            this.log(`drawing ${live.length} picture(s), was ${this.placements.length}`);
        }
        this.placements = live;
    }

    private log(message: string) {
        // console.log rather than a debug switch: the harness captures the page console and this is the only
        // record of why a picture was declined, which is the question a report can only describe as "it vanished".
        console.log('anchor: ' + message);
    }

    /** The first row in a range that is not empty, for the log above. */
    private firstOccupied(
        buffer: ActiveBuffer,
        from: number,
        to: number,
        padCol: number
    ): { row: number; text: string } {
        for (let row = from; row <= to; row++) {
            const line = buffer.getLine(row);
            const text = line ? line.translateToString(true) : '';
            const content = text.slice(0, padCol).trim();
            if (content) return { row, text: content.slice(0, 60) };
        }
        return { row: -1, text: '' };
    }

    /**
     * The column tmux starts drawing chrome at, or `cols` when a pane's client is not wider than its window.
     *
     * tmux fills the columns a client has that the window does not with a vertical border at the window's edge and
     * the padding character after it, on every row. It is regular across the pane, which is what makes it
     * identifiable without knowing the window's width: a `│` (or `┃`) followed by nothing but padding to the end of
     * the line, at the same column on most rows. Requiring most of the viewport to agree is what keeps this from
     * mistaking a line that happens to end in a box-drawing character for chrome, and taking the smallest such
     * column keeps a genuine `│·` inside real content from being mistaken for the edge.
     */
    private paddingColumn(buffer: ActiveBuffer, rows: number, cols: number): number {
        let edge = -1;
        let hits = 0;
        for (let y = buffer.viewportY; y < buffer.viewportY + rows; y++) {
            const line = buffer.getLine(y);
            const text = line ? line.translateToString(true) : '';
            const m = text.match(/[│┃][·\s]*$/);
            if (!m || m.index === undefined) continue;
            if (m.index === 0) continue; // a border at column 0 is the left edge of a pane, not padding
            if (edge === -1 || m.index < edge) edge = m.index;
            hits++;
        }
        if (edge <= 0 || hits < Math.max(2, Math.floor(rows / 2))) return cols;
        return edge;
    }

    /** A row's text, cut at the column tmux's chrome starts at. */
    private content(text: string, from: number, padCol: number): string {
        return text.slice(from, padCol);
    }

    /** Re-read the anchor line the placement was found on, so a placement never outlives the line it came from. */
    private matches(placement: Placement, text: string): boolean {
        return text.indexOf(`[[img:${placement.name}:${placement.rows}]]`) !== -1;
    }

    private scan(buffer: ActiveBuffer, rows: number): Placement[] {
        const found: Placement[] = [];
        const first = buffer.viewportY;
        for (let y = 0; y < rows; y++) {
            const line = buffer.getLine(first + y);
            if (!line) continue;
            const text = line.translateToString(true);
            if (text.indexOf('[[') === -1) continue; // the common case costs one substring search
            ANCHOR.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = ANCHOR.exec(text)) !== null) {
                const count = parseInt(m[2], 10);
                if (count > 0) found.push({ name: m[1], rows: count, row: first + y });
            }
        }
        return found;
    }

    private clearBelow(buffer: ActiveBuffer, from: number, to: number, padCol: number): boolean {
        for (let y = from; y <= to; y++) {
            const line = buffer.getLine(y);
            if (!line) continue; // past the end of the buffer is still nothing drawn over
            if (line.translateToString(true).slice(0, padCol).trim() !== '') return false;
        }
        return true;
    }

    private paint(
        ctx: CanvasRenderingContext2D,
        placement: Placement,
        viewportY: number,
        cellH: number,
        availW: number,
        height: number
    ): void {
        const img = this.images.get(placement.name);
        if (!img) {
            this.request(placement.name);
            return;
        }
        // Touching the map on use is what makes it least-recently-evicted rather than first-written-wins.
        this.images.delete(placement.name);
        this.images.set(placement.name, img);

        const natural = img.naturalWidth / img.naturalHeight;
        if (!(natural > 0) || !isFinite(natural)) return;

        // Buffer rows are absolute; the canvas is the viewport. A pane scrolled three lines into copy-mode has to
        // move every drawing up by those three cells or the picture lands on the wrong rows, which is the kind of
        // error that only shows up once somebody scrolls - which is the whole reason this feature exists.
        const anchorRow = placement.row - viewportY;
        // The token's cell is the picture's top-left cell, so the picture starts at the top of the anchor's row.
        const top = anchorRow * cellH;
        let h = placement.rows * cellH;
        // Part of the picture scrolled above the viewport is drawn with a negative top and the canvas clips it,
        // rather than clamped to row zero: clamping is what moves a picture onto rows its anchor does not own.
        if (top >= height || top + h <= 0) return;
        let w = h * natural;
        if (w > availW) {
            // The one place an anchor's row count is not the whole story about size: a picture kept at its aspect
            // ratio in a pane narrower than its width is shorter than the rows it was given, and the harness
            // measures that gap rather than pretending it is zero. availW is the pane's own width, which stops at
            // tmux's chrome rather than at the browser's - a picture is not allowed to draw over a pane border.
            w = availW;
            h = w / natural;
        }
        // Left aligned at column 0, which is where every picture measured in hack/image-cases.sh was emitted.
        ctx.drawImage(img, 0, top, w, h);
    }

    private request(name: string): void {
        if (this.loading.has(name)) return;
        this.loading.add(name);
        const url = this.imagePath(name);
        const img = new Image();
        img.onload = () => {
            this.loading.delete(name);
            this.images.set(name, img);
            if (this.images.size > CACHE_LIMIT) {
                const oldest = this.images.keys().next();
                if (!oldest.done) this.images.delete(oldest.value);
            }
            // The render that asked for this picture drew nothing. Ask for another one rather than waiting for
            // whatever the pane does next.
            this.terminal.refresh(0, this.terminal.rows - 1);
        };
        img.onerror = () => {
            this.loading.delete(name);
            if (!this.complained.has(name)) {
                this.complained.add(name);
                console.warn(`[ttyd] image anchor has no bytes behind it: ${url}`);
            }
        };
        img.src = url;
    }

    /**
     * The canvas xterm.js will position for us: css/xterm.css gives `.xterm .xterm-screen canvas`
     * `position: absolute; left: 0; top: 0`, and .xterm-screen is `position: relative`.
     *
     * It needs a z-index as well as a position, and the first harness run is what found that out. Both
     * screenshots came back with the reserved rows empty and the anchor line printed, while the canvas those same
     * runs measured held 180,000 painted pixels - 88,800 of them red, 81,688 blue - in a 600x300 box on exactly
     * the 20 rows the anchor reserved. The picture was drawn and nothing could see it.
     *
     * ttyd's client renders text with the WebGL addon (clientOptions.rendererType in ../../app.tsx), which paints
     * the theme background across the whole viewport. That canvas, and the link layer, are created during open();
     * this addon attached its canvas before that finished, so it was the first child of .xterm-screen and the
     * bottom of the stack. DOM order is not a promise about who ends up on top when the other canvases arrive
     * later. xterm.css and the renderer give the layers their own numbers - measured on a live pane: the link
     * layer canvas sits at z-index 2, the WebGL text canvas at auto (which behaves as 0), the helper layers at 5
     * and the decoration layers at 6 and 7 - so this canvas takes 3, which clears every canvas a pane has without
     * reaching the input helpers. Covering text is still the price, and the blank-row check in draw() is what
     * limits what that price can buy.
     */
    private ensureCanvas(screen: Element): HTMLCanvasElement | undefined {
        if (this.canvas && this.canvas.parentNode === screen) return this.canvas;
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        const canvas = document.createElement('canvas');
        // Not selectable, not part of the pane's text, and not something a click should reach.
        canvas.style.cssText = 'pointer-events: none; -webkit-user-select: none; user-select: none;';
        canvas.style.zIndex = '3';
        canvas.className = 'slopyphus-image-anchor';
        screen.appendChild(canvas);
        this.canvas = canvas;
        return canvas;
    }
}
