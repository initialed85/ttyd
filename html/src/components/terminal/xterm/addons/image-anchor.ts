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
// text on the row below the rows it reserved for the picture:
//
//     [[img:<10 hex>.<ext>:<rows>]]
//
// Text is the one thing that survives every repaint listed above. This addon is the other half: it reads those
// lines out of the buffer and draws the file they name, in the rows above the line, on every render. The bytes
// come from ttyd itself - `GET <base>/images/<name>` in src/http.c, which accepts nothing but a name of that exact
// shape and answers `Cache-Control: public, max-age=31536000, immutable`, because a content hash prefix never
// names different content and a picture redrawn from a cache is only the same picture if it is the same bytes.
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
    // The buffer row the anchor line itself sits on, absolute (buffer coordinates, not viewport coordinates).
    row: number;
}

export class ImageAnchorAddon implements ITerminalAddon {
    private terminal: Terminal;
    private canvas?: HTMLCanvasElement;
    private placements: Placement[] = [];
    private scanKey = '';
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
        this.scanKey = '';
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
        if (!(cellW > 0) || !(cellH > 0) || !isFinite(cellW) || !isFinite(cellH)) return;

        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        const canvas = this.ensureCanvas(screen);
        const ctx = canvas && canvas.getContext('2d');
        if (!ctx) return;

        const buffer = terminal.buffer.active;
        // Anything that can move an anchor relative to the grid: scrolling, a resize, the buffer growing, the
        // canvas changing size, and the cursor moving. The last one is not optional, and the first harness run is
        // what proved it: a browser attaching to a pane whose anchor line was already in the grid drew nothing,
        // with the line sitting in the buffer exactly where the scan looked, with the picture fetching fine from
        // the browser (200, image/png, 342 bytes), and with no exception anywhere. The key had not changed
        // between the render of an empty viewport and the render of the same viewport filled with text - writing
        // content into a viewport that is already the right size moves viewportY, baseY, the buffer length and
        // the grid size none at all - so the cached empty answer was kept and nothing was ever looked for again.
        // The cursor is what text arrival actually moves.
        //
        // The residual gap, for the record: a program that rewrites a viewport and parks the cursor exactly where
        // it already was leaves this key untouched, and an anchor that appears in such a rewrite is not noticed.
        // Every placement is still re-verified against its own line and the rows above it on each draw, below, so
        // what cannot happen is a stale picture being drawn; what cannot happen *without something else moving* is
        // a new anchor being found.
        const key = `${buffer.viewportY}|${buffer.baseY}|${buffer.length}|${cols}|${rows}|${width}x${height}|${buffer.cursorY}:${buffer.cursorX}`;
        if (key !== this.scanKey) {
            this.scanKey = key;
            this.placements = this.scan(buffer, rows);
        }

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

        // Bottom-up: the anchor row is the bottom edge of its own reservation, because the relay printed the
        // picture's newlines before the anchor line. So a picture spans the rows immediately above its line.
        const live: Placement[] = [];
        for (const placement of this.placements) {
            const line = buffer.getLine(placement.row);
            if (!this.matches(placement, line ? line.translateToString(true) : '')) continue;
            const top = Math.max(0, placement.row - placement.rows);
            // A picture is drawn only where the grid is genuinely empty over the rows it would cover. Reserved
            // rows are empty by construction; a narrower pane reflows long lines into them, and then text wins,
            // because a covered sentence is a lost sentence while a covered picture is only a lost picture.
            if (!this.clearAbove(buffer, top, placement.row - 1)) continue;
            live.push(placement);
            this.paint(ctx, placement, buffer.viewportY, cellH, width, height);
        }
        this.placements = live;
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

    private clearAbove(buffer: ActiveBuffer, from: number, to: number): boolean {
        for (let y = from; y <= to; y++) {
            const line = buffer.getLine(y);
            if (!line) continue; // off the top of the buffer is still nothing drawn over
            if (line.translateToString(true).trim() !== '') return false;
        }
        return true;
    }

    private paint(
        ctx: CanvasRenderingContext2D,
        placement: Placement,
        viewportY: number,
        cellH: number,
        width: number,
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
        const bottom = anchorRow * cellH; // the top of the anchor row is where the reservation ends
        if (bottom <= 0) return; // the whole reservation is scrolled above the viewport

        let h = placement.rows * cellH;
        let w = h * natural;
        if (w > width) {
            w = width;
            h = w / natural;
        }
        let top = bottom - h;
        if (top < 0) top = 0; // scrolled so that part of the picture is above the viewport: draw what is left
        if (top >= height) return; // and the other way round, scrolled past the bottom
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
            this.scanKey = '';
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
