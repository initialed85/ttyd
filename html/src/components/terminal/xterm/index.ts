import { bind } from 'decko';
import type { IDisposable, ITerminalOptions } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ImageAddon } from '@xterm/addon-image';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { OverlayAddon } from './addons/overlay';
import { ImageAnchorAddon } from './addons/image-anchor';
import { ZmodemAddon } from './addons/zmodem';

import '@xterm/xterm/css/xterm.css';

interface TtydTerminal extends Terminal {
    fit(): void;
}

declare global {
    interface Window {
        term: TtydTerminal;
    }
}

enum Command {
    // server side
    OUTPUT = '0',
    SET_WINDOW_TITLE = '1',
    SET_PREFERENCES = '2',
    SET_CAPABILITIES = '3',
    UPLOAD_RESULT = '4',

    // client side
    INPUT = '0',
    RESIZE_TERMINAL = '1',
    PAUSE = '2',
    RESUME = '3',
    UPLOAD_BEGIN = '4',
    UPLOAD_DATA = '5',
    UPLOAD_COMMIT = '6',
    UPLOAD_ABORT = '7',
}
type Preferences = ITerminalOptions & ClientOptions;

// A phone's pane is a few hundred CSS pixels wide, and the font the server asks for is chosen for a
// desktop terminal: the agent containers run `ttyd -t fontSize=12`, which at 390pt is a 54-column
// terminal whose glyphs are 12 CSS px on a 3x display. That is legible, but it is not what reading an
// agent's answer on your phone wants. 16px is ~40 columns, which is the width a terminal is still
// useful at and the size that does not need zooming.
//
// The pointer, not the width, is the trigger: the desktop grid makes every pane a ~60px cell, and a
// rule keyed on the pane's own width would hand those cells a 16px font and three columns. A laptop
// with a touch screen is coarse and its panes are wide, and it gets the bigger font, which is the
// answer anyone looking at a phone-sized layout on it would want anyway.
//
// The query still wins, so `?fontSize=12` is the escape hatch and the number is overridable per pane.
const MOBILE_FONT_PX = 16;

// What the server said it is willing to do. Reported once per connection, before any of it is offered
// in the UI, so a readonly pane does not pretend a dropped file will land somewhere.
export interface Capabilities {
    upload: boolean;
    uploadMaxBytes: number;
    uploadDir: string;
}

export type RendererType = 'dom' | 'canvas' | 'webgl';

export interface ClientOptions {
    rendererType: RendererType;
    disableLeaveAlert: boolean;
    disableResizeOverlay: boolean;
    enableZmodem: boolean;
    enableTrzsz: boolean;
    enableSixel: boolean;
    enableShiftEnter: boolean;
    enableCtrlVPaste: boolean;
    enableContextMenuGate: boolean;
    enableUpload: boolean;
    titleFixed?: string;
    isWindows: boolean;
    trzszDragInitTimeout: number;
    unicodeVersion: string;
}

export interface FlowControl {
    limit: number;
    highWater: number;
    lowWater: number;
}

export interface XtermOptions {
    wsUrl: string;
    tokenUrl: string;
    flowControl: FlowControl;
    clientOptions: ClientOptions;
    termOptions: ITerminalOptions;
}

function toDisposable(f: () => void): IDisposable {
    return { dispose: f };
}

interface Osc52Request {
    // "?" is a request for the clipboard contents, which this client does not answer.
    query: boolean;
    text: string;
}

// tmux hands a copy-mode selection to the outer terminal as OSC 52. xterm.js 5.4 parses OSC but
// registers no handler for 52, so the sequence tmux emits when a mouse drag ends is dropped and
// nothing reaches the clipboard. tmux sends an empty selection code (";;data"), Vim and Neovim send
// "c;data" or "p;data", so the code field is only inspected for the query form.
const parseOsc52 = (data: string): Osc52Request => {
    const separator = data.indexOf(';');
    const codes = separator < 0 ? data : data.slice(0, separator);
    const payload = separator < 0 ? '' : data.slice(separator + 1);
    if (codes.indexOf('?') >= 0) return { query: true, text: '' };
    if (payload === '') return { query: false, text: '' };
    try {
        const bytes = Uint8Array.from(atob(payload.replace(/\s+/g, '')), c => c.charCodeAt(0));
        // tmux copies whole lines with a trailing line break; pasting it back into a terminal
        // would submit a prompt, so drop one trailing break.
        return { query: false, text: new TextDecoder().decode(bytes).replace(/\r?\n$/, '') };
    } catch (e) {
        console.warn('[ttyd] malformed OSC 52 payload', e);
        return { query: false, text: '' };
    }
};

function addEventListener(target: EventTarget, type: string, listener: EventListener, capture = false): IDisposable {
    target.addEventListener(type, listener, capture);
    return toDisposable(() => target.removeEventListener(type, listener, capture));
}

// btoa over one huge string blows the call stack through String.fromCharCode, so encode in blocks.
function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const block = 8192;
    for (let i = 0; i < bytes.length; i += block) {
        binary += String.fromCharCode(...bytes.subarray(i, i + block));
    }
    return btoa(binary);
}

export class Xterm {
    private disposables: IDisposable[] = [];
    private textEncoder = new TextEncoder();
    private textDecoder = new TextDecoder();
    private written = 0;
    private pending = 0;

    private terminal: Terminal;
    private fitAddon = new FitAddon();
    private overlayAddon = new OverlayAddon();
    private imageAnchorAddon = new ImageAnchorAddon();
    private webglAddon?: WebglAddon;
    private canvasAddon?: CanvasAddon;
    private zmodemAddon?: ZmodemAddon;

    private socket?: WebSocket;
    private token: string;
    private opened = false;
    private title?: string;
    private titleFixed?: string;
    private resizeOverlay = true;
    private reconnect = true;
    private doReconnect = true;
    // True before the websocket reports preferences, so the first keystroke after a page load behaves
    // the same as every one after it.
    private enableShiftEnter = true;
    // Ctrl+V is left to the browser as paste unless the operator turns this off (`-t enableCtrlVPaste=false`),
    // which hands the key back to xterm. See onKey for the measurement that picked the default.
    private enableCtrlVPaste = true;
    // A plain right click belongs to the pane: tmux has its own built-in pane menu and the browser drawing a
    // menu over the terminal on top of it is noise. Ctrl or Meta plus right click still opens the browser
    // menu, which is what a copy/inspect/save gesture wants. `-t enableContextMenuGate=false` restores the
    // browser's default of answering every right click. See the contextmenu listener for what each menu is.
    private enableContextMenuGate = true;
    // Reported by the server once per connection. Uploads need a writable pane and a server that has
    // not been started with --disable-upload.
    private capabilities: Capabilities = { upload: false, uploadMaxBytes: 0, uploadDir: '' };
    // -t enableUpload=false hands drag-and-drop back to trzsz for panes that really do run trz(1).
    private enableUpload = true;
    private uploading = false;
    private pendingUpload?: { settle: (ok: boolean) => void };

    private writeFunc = (data: ArrayBuffer) => this.writeData(new Uint8Array(data));

    constructor(
        private options: XtermOptions,
        private sendCb: () => void
    ) {}

    dispose() {
        for (const d of this.disposables) {
            d.dispose();
        }
        this.disposables.length = 0;
    }

    @bind
    private register<T extends IDisposable>(d: T): T {
        this.disposables.push(d);
        return d;
    }

    @bind
    public sendFile(files: FileList) {
        // The toolbar's "Choose files…" used to mean start a trzsz transfer, which types trz into the
        // pane and needs a trz(1) listening for it there. Under a full-screen TUI that is dead on
        // arrival, so the picker uses the upload path whenever the pane supports it and zmodem keeps
        // the old behaviour when it does not.
        if (this.uploadsReady()) {
            void this.uploadFiles(files);
        } else {
            this.zmodemAddon?.sendFile(files);
        }
    }

    @bind
    public async refreshToken() {
        try {
            const resp = await fetch(this.options.tokenUrl);
            if (resp.ok) {
                const json = await resp.json();
                this.token = json.token;
            }
        } catch (e) {
            console.error(`[ttyd] fetch ${this.options.tokenUrl}: `, e);
        }
    }

    @bind
    private onContextMenu(event: MouseEvent) {
        // Ctrl or Meta passes straight through to the browser. Everything else is cancelled, which stops
        // Chrome answering for the helper textarea xterm.js keeps inside the terminal. tmux's own pane menu
        // is not affected either way: it comes from MouseDown3Pane in tmux's key tables, which reaches tmux
        // through xterm.js's mouse reporting rather than through this event.
        if (!this.enableContextMenuGate || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
    }

    @bind
    private onPaste(event: ClipboardEvent) {
        const files = event.clipboardData?.files;
        // A clipboard that carries text and no files is xterm's business, not ours.
        if (!files || files.length === 0) return;
        if (!this.uploadsReady()) return;
        event.preventDefault();
        event.stopPropagation();
        void this.uploadFiles(files);
    }

    @bind
    private onDragOver(event: DragEvent) {
        if (!this.dragHasFiles(event) || !this.uploadsReady()) return;
        event.preventDefault();
        event.stopPropagation();
        this.overlayAddon.showOverlay('\u2193 file', 100);
    }

    @bind
    private onDrop(event: DragEvent) {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        if (!this.uploadsReady()) return;
        event.preventDefault();
        event.stopPropagation();
        void this.uploadFiles(files);
    }

    private dragHasFiles(event: DragEvent): boolean {
        const types = event.dataTransfer?.types;
        if (!types) return false;
        for (const type of Array.from(types)) {
            if (type === 'Files') return true;
        }
        return false;
    }

    private uploadsReady(): boolean {
        if (!this.capabilities.upload || !this.enableUpload) return false;
        return this.socket?.readyState === WebSocket.OPEN;
    }

    @bind
    private onWindowUnload(event: BeforeUnloadEvent) {
        event.preventDefault();
        if (this.socket?.readyState === WebSocket.OPEN) {
            const message = 'Close terminal? this will also terminate the command.';
            event.returnValue = message;
            return message;
        }
        return undefined;
    }

    @bind
    public open(parent: HTMLElement) {
        this.terminal = new Terminal(this.options.termOptions);
        const { terminal, fitAddon, overlayAddon, imageAnchorAddon } = this;
        window.term = terminal as TtydTerminal;
        window.term.fit = () => {
            this.fitAddon.fit();
        };

        terminal.loadAddon(fitAddon);
        terminal.loadAddon(overlayAddon);
        // No option gates this one: it draws nothing until a pane contains an anchor line, and an anchor line only
        // exists when the pane's relay was started with --anchor. A terminal with no anchors in it costs one
        // substring search per row per render.
        terminal.loadAddon(imageAnchorAddon);
        terminal.loadAddon(new WebLinksAddon());

        terminal.open(parent);
        fitAddon.fit();
    }

    @bind
    private initListeners() {
        const { terminal, fitAddon, overlayAddon, register, sendData } = this;
        register(
            terminal.onTitleChange(data => {
                if (data && data !== '' && !this.titleFixed) {
                    document.title = data + ' | ' + this.title;
                }
            })
        );
        register(terminal.onData(data => sendData(data)));
        register(terminal.onBinary(data => sendData(Uint8Array.from(data, v => v.charCodeAt(0)))));
        register(
            terminal.onResize(({ cols, rows }) => {
                const msg = JSON.stringify({ columns: cols, rows: rows });
                this.socket?.send(this.textEncoder.encode(Command.RESIZE_TERMINAL + msg));
                if (this.resizeOverlay) overlayAddon.showOverlay(`${cols}x${rows}`, 300);
            })
        );
        register(
            terminal.onSelectionChange(() => {
                if (this.terminal.getSelection() === '') return;
                try {
                    document.execCommand('copy');
                } catch (e) {
                    return;
                }
                this.overlayAddon?.showOverlay('\u2702', 200);
            })
        );

        // A pasted or dropped file is not keystrokes, so it does not travel as INPUT: the bytes go up
        // as upload frames, the server writes them under the pane's working directory, and the saved
        // path arrives in the terminal as though the user had typed it. That is what lets a TUI such
        // as Pi open an image with no trz(1) helper running inside the pane.
        //
        // Capturing on an ancestor is deliberate. xterm.js binds 'paste' on both its helper textarea
        // and its own element, and trzsz binds dragover/drop on that same element; a listener added
        // later on one of those nodes would run after clipboard text had already been written to the
        // pty. An ancestor in the capture phase always runs first, and stopping propagation then keeps
        // the event away from them.
        const fileTarget = terminal.element?.parentElement ?? document.body;
        register(addEventListener(fileTarget, 'paste', this.onPaste as EventListener, true));
        register(addEventListener(fileTarget, 'dragover', this.onDragOver as EventListener, true));
        register(addEventListener(fileTarget, 'drop', this.onDrop as EventListener, true));
        // Right click is answered by two independent stacks. tmux's pane menu comes from its own built-in
        // `bind-key -T root MouseDown3Pane display-menu ...` (Horizontal Split, Vertical Split, Swap Up/Down,
        // Swap Marked, Kill, Respawn, Mark, Zoom), which reaches tmux through xterm.js's mouse reporting -
        // nothing in this file can suppress it, and it is not what this is about. The browser's menu is the
        // other stack: it answers the contextmenu event, xterm.js routes button 2 through mousedown when
        // `rightClickSelectsWord` is on (it is on by default) and keeps its own contextmenu listener with an
        // isLinux branch, and Chrome answers for the helper textarea xterm.js keeps inside the terminal. With
        // both answering, a plain right click put tmux's menu and Chrome's menu on screen at the same time.
        //
        // Gated on an ancestor in the capture phase for the same reason the upload listeners are: it runs
        // before xterm.js's handlers. Ctrl or Meta passes through untouched, which is the convention xterm.js
        // already uses on Linux and the one wanted here.
        register(addEventListener(fileTarget, 'contextmenu', this.onContextMenu as EventListener, true));
        // terminal.parser is public API (xterm.js typings: ITerminal.parser -> IParser), so OSC 52
        // lives here rather than in a forked xterm.
        register(terminal.parser.registerOscHandler(52, this.onOsc52));
        // xterm.js 5.4 has no extended-key support (no Kitty keyboard protocol), so the browser is the
        // only place a Shift+Enter can be turned into something an application can use.
        // There is no detach: attachCustomKeyEventHandler takes a function, not null, and Terminal.dispose
        // takes the handler with it. The slot is single, and reconnects reuse this terminal, so attaching
        // once here is the whole lifetime.
        terminal.attachCustomKeyEventHandler(this.onKey);
        register(addEventListener(window, 'resize', () => fitAddon.fit()));
        register(addEventListener(window, 'beforeunload', this.onWindowUnload));
    }

    // The reason Shift+Enter looked broken in a pane is in xterm.js's own key evaluation
    // (src/common/input/Keyboard.ts, case 13): Enter is evaluated as `ev.altKey ? ESC+CR : CR`, so
    // Shift is not consulted and Shift+Enter reaches the pty as a plain CR - the app sees "submit".
    // Pi binds Shift+Enter, and Ctrl+J, to inserting a newline, so a multi-line prompt was untypeable
    // in a pane unless something in front of xterm translated it, which is what the front page did with
    // a synthesised Ctrl+J keydown - for the panes it framed, and for nothing else.
    //
    // LF is the byte to send rather than a Kitty CSI-u Shift+Enter (`\x1b[13;2u`), and that is a
    // measured choice, not a cautious one. Measured with hack/ttyd-ws-probe.mjs against a tmux pane whose
    // application puts its own pty in raw mode (`stty raw -echo; cat > /tmp/k.bin`), so no line discipline
    // is quietly rewriting the bytes on the way in:
    //
    //   tmux 3.6 parses a CSI-u Enter and rewrites it to a plain CR - `\x1b[13;2u` (Shift+Enter) and
    //   `\x1b[13;5u` (Ctrl+Enter) both arrive as `\r`, which is Submit to an application, the exact
    //   opposite of what the key means. A raw LF is forwarded unchanged.
    //
    // So an extended-key spelling cannot survive this deployment, LF can, and LF is also what Ctrl+J
    // types - the other half of Pi's `tui.input.newLine` binding - which makes it the one spelling every
    // application in these panes already handles. (An earlier version of this note claimed tmux turned a
    // CSI-u into LF; that reading came from a cooked pane, where ICRNL rewrites CR to LF and echoes what
    // was typed. Raw mode is the condition a TUI actually runs in, and the only one worth trusting.)
    @bind
    private onKey(event: KeyboardEvent): boolean {
        // Ctrl+V is the paste key on Linux and Windows, and xterm.js eats it. In
        // src/common/input/Keyboard.ts the default branch turns any Ctrl+letter into
        // String.fromCharCode(keyCode - 64), so Ctrl+V becomes 0x16, and Terminal._keyDown finishes a key that
        // produced data with `cancel(event, true)` - preventDefault and stopPropagation - which is precisely
        // the default action the browser would have used to paste. Measured with hack/keys-case.sh against a
        // pane recording its own stdin raw (`stty raw -echo; cat > /tmp/keys.bin`), through Chrome's real
        // input pipeline (hack/front-cdp.mjs --key ctrl+v):
        //
        //   ctrl+v          16                        one byte, and nothing else: the keystroke won
        //   meta+v          (nothing)                 xterm produced no key, so `return true` happened
        //                                               before cancel() and the browser kept the paste
        //   ctrl+shift+v    (nothing)
        //
        // That is the whole of the Mac-works/Linux-doesn't asymmetry the keyboard can show: Cmd+V was already
        // left to the browser, Ctrl+V was not. Returning false from this handler makes xterm do what it does
        // for Cmd+V, because Terminal._keyDown returns at the custom-handler check - before cancel(), before
        // preventDefault and before stopPropagation - and the paste default survives to reach ttyd's own paste
        // listener, which is where a clipboard image becomes an upload.
        //
        // 0x16 is not lost, it moves: Ctrl+Shift+V sends it explicitly. Ctrl+V is `readline`'s
        // literal-next and `bash`'s verbatim-input, and swallowing it silently would break a keystroke people
        // use on purpose, so the byte keeps a spelling rather than being given up.
        if (this.enableCtrlVPaste && event.code === 'KeyV' && event.ctrlKey && !event.altKey && !event.metaKey) {
            // Mid-composition the key belongs to the IME, as with Enter.
            if (event.isComposing) return true;
            if (event.type === 'keyup') return true;
            if (event.shiftKey) {
                if (event.type !== 'keydown') return true;
                event.preventDefault();
                // Holding the key down repeats the byte, which is what a repeated literal-next wants.
                if (!event.repeat) this.sendData('\x16');
                return false;
            }
            // keydown and keypress both: xterm writes terminal data from either one, and the lesson from the
            // Enter work below is that refusing only the keydown leaves the second half of the keystroke
            // intact. Whether Ctrl+V also produces a keypress is measured, not assumed - see hack/keys-case.sh.
            return false;
        }

        // Opt-out for a terminal that can report the real key combination (`-t enableShiftEnter=false`).
        if (!this.enableShiftEnter) return true;
        // Mid-composition an Enter belongs to the IME, and xterm knows that; do not steal it.
        if (event.isComposing) return true;
        if (event.code !== 'Enter' && event.code !== 'NumpadEnter') return true;
        if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return true;
        // While the pane is down, ttyd's own rule is "press Enter to reconnect" (it listens on
        // terminal.onKey for event.key === 'Enter', which Shift+Enter also is). Suppressing the key here
        // would eat that, and sendData would drop the newline anyway.
        if (this.socket?.readyState !== WebSocket.OPEN) return true;
        // keyup is left to xterm, which emits nothing for Enter but does the focus and cursor bookkeeping.
        if (event.type === 'keyup') return true;
        // keypress has to be refused as well as keydown, and nothing in the API suggests that. xterm.js
        // writes terminal data from *both* events: `_keyDown` sets `_keyDownHandled` only on the way through
        // `cancel()` (Terminal.ts: a custom handler returning false returns before either point), and
        // `_keyPress` skips itself only when that flag is true. Left alone, the browser's keypress for the
        // same Enter reaches `_keyPress`, which does `String.fromCharCode(charCode)` - 13, a CR - and writes
        // it. Measured through Chrome's input pipeline (hack/front-cdp.mjs --key 'shift+Enter') against a
        // pane whose application records its own stdin: this mapping produced `\n` and xterm followed it with
        // `\r`, which to Pi is a Submit landing immediately after the newline the key was meant to insert -
        // the key both worked and failed. It took a re-measurement to find, because a KeyboardEvent built and
        // dispatched from JavaScript never produces a keypress; only Chrome's own input pipeline does, so
        // every earlier probe of this handler was blind to the second half of the keystroke.
        if (event.type === 'keypress') return false;
        // The keydown default is a linefeed inserted into xterm's hidden helper textarea - the thing the
        // textarea exists to have xterm read instead of act on - so cancel it rather than let a second
        // listener on the page react to the same Enter.
        event.preventDefault();
        // Holding the key down inserts one newline, matching what these panes did through the front page.
        if (event.repeat) return false;
        this.sendData('\n');
        // Returning false is what suppresses xterm's own CR for the same keystroke.
        return false;
    }

    @bind
    private onOsc52(data: string): boolean {
        const { query, text } = parseOsc52(data);
        if (query || text === '') return true;
        this.copyToClipboard(text).then(copied => {
            if (copied) this.overlayAddon.showOverlay('\u2702', 200);
        });
        return true;
    }

    // navigator.clipboard only exists in a secure context and a ttyd pane opened over plain http on a
    // node address is not one, so keep the scratch textarea ttyd already relies on for xterm selections.
    private async copyToClipboard(text: string): Promise<boolean> {
        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(text);
                return true;
            }
        } catch (e) {
            console.warn('[ttyd] navigator.clipboard.writeText failed', e);
        }
        try {
            const scratch = document.createElement('textarea');
            scratch.setAttribute('aria-hidden', 'true');
            scratch.style.position = 'fixed';
            scratch.style.top = '-1em';
            scratch.style.opacity = '0';
            scratch.value = text;
            document.body.appendChild(scratch);
            scratch.focus();
            scratch.select();
            const copied = document.execCommand('copy');
            scratch.remove();
            this.terminal.focus();
            return copied;
        } catch (e) {
            console.warn('[ttyd] fallback clipboard copy failed', e);
            this.terminal.focus();
            return false;
        }
    }

    @bind
    public writeData(data: string | Uint8Array) {
        const { terminal, textEncoder } = this;
        const { limit, highWater, lowWater } = this.options.flowControl;

        this.written += data.length;
        if (this.written > limit) {
            terminal.write(data, () => {
                this.pending = Math.max(this.pending - 1, 0);
                if (this.pending < lowWater) {
                    this.socket?.send(textEncoder.encode(Command.RESUME));
                }
            });
            this.pending++;
            this.written = 0;
            if (this.pending > highWater) {
                this.socket?.send(textEncoder.encode(Command.PAUSE));
            }
        } else {
            terminal.write(data);
        }
    }

    @bind
    public sendData(data: string | Uint8Array) {
        const { socket, textEncoder } = this;
        if (socket?.readyState !== WebSocket.OPEN) return;

        if (typeof data === 'string') {
            const payload = new Uint8Array(data.length * 3 + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            const stats = textEncoder.encodeInto(data, payload.subarray(1));
            socket.send(payload.subarray(0, (stats.written as number) + 1));
        } else {
            const payload = new Uint8Array(data.length + 1);
            payload[0] = Command.INPUT.charCodeAt(0);
            payload.set(data, 1);
            socket.send(payload);
        }
    }

    // Uploads are one at a time per connection: the server keeps a single transfer slot per client,
    // and a program in the pane can only be handed one path at a time in a readable order.
    @bind
    private async uploadFiles(files: FileList | File[]) {
        if (this.uploading) {
            console.warn('[ttyd] pane upload ignored: one is already running');
            this.overlayAddon.showOverlay('uploading\u2026', 300);
            return;
        }
        this.uploading = true;
        const limit = this.capabilities.uploadMaxBytes;
        try {
            for (const file of Array.from(files)) {
                if (file.size <= 0) {
                    console.warn(`[ttyd] pane upload skipped an empty file: ${file.name}`);
                    continue;
                }
                if (limit > 0 && file.size > limit) {
                    console.warn(`[ttyd] pane upload refused: ${file.name} is ${file.size} bytes, limit ${limit}`);
                    this.overlayAddon.showOverlay('too large', 500);
                    continue;
                }
                const ok = await this.uploadFile(file);
                // The pane refused or dropped the transfer; do not keep pushing bytes at it.
                if (!ok) break;
            }
        } finally {
            this.uploading = false;
        }
    }

    private uploadFile(file: File): Promise<boolean> {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.resolve(false);

        let settle: (ok: boolean) => void = () => undefined;
        const result = new Promise<boolean>(resolve => (settle = resolve));
        const transfer = { settled: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        const finish = (ok: boolean) => {
            if (transfer.settled) return;
            transfer.settled = true;
            if (transfer.timer) clearTimeout(transfer.timer);
            this.pendingUpload = undefined;
            settle(ok);
        };
        this.pendingUpload = { settle: finish };
        transfer.timer = setTimeout(() => {
            console.warn(`[ttyd] pane upload timed out: ${file.name}`);
            this.sendControl(Command.UPLOAD_ABORT);
            finish(false);
        }, 30000);

        // 196608 is divisible by 3, so every chunk is a whole number of base64 groups and only the
        // last one carries padding.
        const chunk = 196608;
        this.sendControl(Command.UPLOAD_BEGIN + JSON.stringify({ name: file.name, size: file.size }));

        const sendChunks = async () => {
            let offset = 0;
            while (offset < file.size) {
                if (this.pendingUpload === undefined || socket.readyState !== WebSocket.OPEN) {
                    this.sendControl(Command.UPLOAD_ABORT);
                    return finish(false);
                }
                const slice = file.slice(offset, offset + chunk);
                const bytes = new Uint8Array(await slice.arrayBuffer());
                this.sendControl(Command.UPLOAD_DATA + bytesToBase64(bytes));
                offset += bytes.byteLength;
                this.overlayAddon.showOverlay(`\u2191 ${Math.round((offset / file.size) * 100)}%`, 40);
                // A websocket does not block on a slow reader, it only grows a send buffer, so wait
                // rather than letting a big paste eat memory in the browser.
                while (socket.bufferedAmount > 4 * 1024 * 1024 && socket.readyState === WebSocket.OPEN) {
                    await new Promise(resolve => setTimeout(resolve, 20));
                }
            }
            // A result that arrived mid-transfer means the server already closed the file.
            if (this.pendingUpload === undefined) return;
            this.sendControl(Command.UPLOAD_COMMIT);
        };
        sendChunks().catch(e => {
            console.error(`[ttyd] pane upload failed to read ${file.name}: ${e}`);
            this.sendControl(Command.UPLOAD_ABORT);
            finish(false);
        });

        return result;
    }

    private sendControl(command: string) {
        const socket = this.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        socket.send(this.textEncoder.encode(command));
    }

    @bind
    public connect() {
        this.socket = new WebSocket(this.options.wsUrl, ['tty']);
        const { socket, register } = this;

        socket.binaryType = 'arraybuffer';
        register(addEventListener(socket, 'open', this.onSocketOpen));
        register(addEventListener(socket, 'message', this.onSocketData as EventListener));
        register(addEventListener(socket, 'close', this.onSocketClose as EventListener));
        register(addEventListener(socket, 'error', () => (this.doReconnect = false)));
    }

    @bind
    private onSocketOpen() {
        console.log('[ttyd] websocket connection opened');

        const { textEncoder, terminal, overlayAddon } = this;
        const msg = JSON.stringify({ AuthToken: this.token, columns: terminal.cols, rows: terminal.rows });
        this.socket?.send(textEncoder.encode(msg));

        if (this.opened) {
            terminal.reset();
            terminal.options.disableStdin = false;
            overlayAddon.showOverlay('Reconnected', 300);
        } else {
            this.opened = true;
        }

        this.doReconnect = this.reconnect;
        this.initListeners();
        terminal.focus();
    }

    @bind
    private onSocketClose(event: CloseEvent) {
        console.log(`[ttyd] websocket connection closed with code: ${event.code}`);

        const { refreshToken, connect, doReconnect, overlayAddon } = this;
        overlayAddon.showOverlay('Connection Closed');
        this.dispose();
        // A socket that dies mid-transfer must not leave the client waiting for a result that can no
        // longer arrive, nor hold the one-upload-at-a-time slot shut.
        this.pendingUpload?.settle(false);
        this.uploading = false;

        // 1000: CLOSE_NORMAL
        if (event.code !== 1000 && doReconnect) {
            overlayAddon.showOverlay('Reconnecting...');
            refreshToken().then(connect);
        } else {
            const { terminal } = this;
            const keyDispose = terminal.onKey(e => {
                const event = e.domEvent;
                if (event.key === 'Enter') {
                    keyDispose.dispose();
                    overlayAddon.showOverlay('Reconnecting...');
                    refreshToken().then(connect);
                }
            });
            overlayAddon.showOverlay('Press ⏎ to Reconnect');
        }
    }

    @bind
    private parseOptsFromUrlQuery(query: string): Preferences {
        const { terminal } = this;
        const { clientOptions } = this.options;
        const prefs = {} as Preferences;
        const queryObj = Array.from(new URLSearchParams(query) as unknown as Iterable<[string, string]>);

        for (const [k, queryVal] of queryObj) {
            let v = clientOptions[k];
            if (v === undefined) v = terminal.options[k];
            switch (typeof v) {
                case 'boolean':
                    prefs[k] = queryVal === 'true' || queryVal === '1';
                    break;
                case 'number':
                case 'bigint':
                    prefs[k] = Number.parseInt(queryVal, 10);
                    break;
                case 'string':
                    prefs[k] = queryVal;
                    break;
                case 'object':
                    prefs[k] = JSON.parse(queryVal);
                    break;
                default:
                    console.warn(`[ttyd] maybe unknown option: ${k}=${queryVal}, treating as string`);
                    prefs[k] = queryVal;
                    break;
            }
        }

        // The merge order at SET_PREFERENCES is the client's own defaults, then the server's -t options,
        // then this function's result, so what is synthesised here is the last word and the agent's
        // `-t fontSize=12` does not override it. Undefined here means the query said nothing.
        if (prefs.fontSize === undefined && window.matchMedia?.('(pointer: coarse)').matches) {
            prefs.fontSize = MOBILE_FONT_PX;
            // The log is what makes the rule debuggable from a pane's own console, and it is the marker
            // CI checks the shipped header against: a client edit that is not rebuilt into src/html.h
            // lands in the fork's source and changes nothing a user can see.
            console.log('[ttyd] mobile font size', MOBILE_FONT_PX);
        }

        return prefs;
    }

    @bind
    private onSocketData(event: MessageEvent) {
        const { textDecoder } = this;
        const rawData = event.data as ArrayBuffer;
        const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);
        const data = rawData.slice(1);

        switch (cmd) {
            case Command.OUTPUT:
                this.writeFunc(data);
                break;
            case Command.SET_WINDOW_TITLE:
                this.title = textDecoder.decode(data);
                document.title = this.title;
                break;
            case Command.SET_PREFERENCES:
                this.applyPreferences({
                    ...this.options.clientOptions,
                    ...JSON.parse(textDecoder.decode(data)),
                    ...this.parseOptsFromUrlQuery(window.location.search),
                } as Preferences);
                break;
            case Command.SET_CAPABILITIES: {
                this.capabilities = {
                    upload: false,
                    uploadMaxBytes: 0,
                    uploadDir: '',
                    ...JSON.parse(textDecoder.decode(data)),
                };
                const where = this.capabilities.upload
                    ? `to ${this.capabilities.uploadDir}`
                    : 'not available on this pane';
                console.log(`[ttyd] pane upload ${where}, limit ${this.capabilities.uploadMaxBytes} bytes`);
                break;
            }
            case Command.UPLOAD_RESULT: {
                const result = JSON.parse(textDecoder.decode(data));
                this.pendingUpload?.settle(result.ok === true);
                if (result.ok) {
                    console.log('[ttyd] pane upload written to', result.path, `${result.bytes} bytes`);
                    this.overlayAddon.showOverlay('\u2191 saved', 400);
                } else {
                    console.warn(`[ttyd] pane upload failed: ${result.reason}`);
                    this.overlayAddon.showOverlay('upload failed', 500);
                }
                break;
            }
            default:
                console.warn(`[ttyd] unknown command: ${cmd}`);
                break;
        }
    }

    @bind
    private applyPreferences(prefs: Preferences) {
        const { terminal, fitAddon, register } = this;
        if (prefs.enableZmodem || prefs.enableTrzsz) {
            this.zmodemAddon = new ZmodemAddon({
                zmodem: prefs.enableZmodem,
                trzsz: prefs.enableTrzsz,
                windows: prefs.isWindows,
                trzszDragInitTimeout: prefs.trzszDragInitTimeout,
                onSend: this.sendCb,
                sender: this.sendData,
                writer: this.writeData,
            });
            this.writeFunc = data => this.zmodemAddon?.consume(data);
            terminal.loadAddon(register(this.zmodemAddon));
        }

        for (const [key, value] of Object.entries(prefs)) {
            switch (key) {
                case 'rendererType':
                    this.setRendererType(value);
                    break;
                case 'disableLeaveAlert':
                    if (value) {
                        window.removeEventListener('beforeunload', this.onWindowUnload);
                        console.log('[ttyd] Leave site alert disabled');
                    }
                    break;
                case 'disableResizeOverlay':
                    if (value) {
                        console.log('[ttyd] Resize overlay disabled');
                        this.resizeOverlay = false;
                    }
                    break;
                case 'disableReconnect':
                    if (value) {
                        console.log('[ttyd] Reconnect disabled');
                        this.reconnect = false;
                        this.doReconnect = false;
                    }
                    break;
                case 'enableZmodem':
                    if (value) console.log('[ttyd] Zmodem enabled');
                    break;
                case 'enableTrzsz':
                    if (value) console.log('[ttyd] trzsz enabled');
                    break;
                case 'trzszDragInitTimeout':
                    if (value) console.log(`[ttyd] trzsz drag init timeout: ${value}`);
                    break;
                case 'enableSixel':
                    if (value) {
                        terminal.loadAddon(register(new ImageAddon()));
                        console.log('[ttyd] Sixel enabled');
                    }
                    break;
                case 'enableShiftEnter':
                    this.enableShiftEnter = value !== false;
                    console.log(`[ttyd] Shift+Enter -> newline ${this.enableShiftEnter ? 'enabled' : 'disabled'}`);
                    break;
                case 'enableCtrlVPaste':
                    this.enableCtrlVPaste = value !== false;
                    if (!this.enableCtrlVPaste) {
                        console.log('[ttyd] Ctrl+V sent to the pane as 0x16 (Ctrl+Shift+V is always 0x16)');
                    }
                    break;
                case 'enableContextMenuGate':
                    this.enableContextMenuGate = value !== false;
                    console.log(`[ttyd] right click menu gate ${this.enableContextMenuGate ? 'on' : 'off'}`);
                    break;
                case 'enableUpload':
                    this.enableUpload = value !== false;
                    if (!this.enableUpload) console.log('[ttyd] browser paste and drag-and-drop disabled');
                    break;
                case 'titleFixed':
                    if (!value || value === '') return;
                    console.log(`[ttyd] setting fixed title: ${value}`);
                    this.titleFixed = value;
                    document.title = value;
                    break;
                case 'isWindows':
                    if (value) console.log('[ttyd] is windows');
                    break;
                case 'unicodeVersion':
                    switch (value) {
                        case 6:
                        case '6':
                            console.log('[ttyd] setting Unicode version: 6');
                            break;
                        case 11:
                        case '11':
                        default:
                            console.log('[ttyd] setting Unicode version: 11');
                            terminal.loadAddon(new Unicode11Addon());
                            terminal.unicode.activeVersion = '11';
                            break;
                    }
                    break;
                default:
                    console.log(`[ttyd] option: ${key}=${JSON.stringify(value)}`);
                    if (terminal.options[key] instanceof Object) {
                        terminal.options[key] = Object.assign({}, terminal.options[key], value);
                    } else {
                        terminal.options[key] = value;
                    }
                    if (key.indexOf('font') === 0) fitAddon.fit();
                    break;
            }
        }
    }

    @bind
    private setRendererType(value: RendererType) {
        const { terminal } = this;
        const disposeCanvasRenderer = () => {
            try {
                this.canvasAddon?.dispose();
            } catch {
                // ignore
            }
            this.canvasAddon = undefined;
        };
        const disposeWebglRenderer = () => {
            try {
                this.webglAddon?.dispose();
            } catch {
                // ignore
            }
            this.webglAddon = undefined;
        };
        const enableCanvasRenderer = () => {
            if (this.canvasAddon) return;
            this.canvasAddon = new CanvasAddon();
            disposeWebglRenderer();
            try {
                this.terminal.loadAddon(this.canvasAddon);
                console.log('[ttyd] canvas renderer loaded');
            } catch (e) {
                console.log('[ttyd] canvas renderer could not be loaded, falling back to dom renderer', e);
                disposeCanvasRenderer();
            }
        };
        const enableWebglRenderer = () => {
            if (this.webglAddon) return;
            this.webglAddon = new WebglAddon();
            disposeCanvasRenderer();
            try {
                this.webglAddon.onContextLoss(() => {
                    this.webglAddon?.dispose();
                });
                terminal.loadAddon(this.webglAddon);
                console.log('[ttyd] WebGL renderer loaded');
            } catch (e) {
                console.log('[ttyd] WebGL renderer could not be loaded, falling back to canvas renderer', e);
                disposeWebglRenderer();
                enableCanvasRenderer();
            }
        };

        switch (value) {
            case 'canvas':
                enableCanvasRenderer();
                break;
            case 'webgl':
                enableWebglRenderer();
                break;
            case 'dom':
                disposeWebglRenderer();
                disposeCanvasRenderer();
                console.log('[ttyd] dom renderer loaded');
                break;
            default:
                break;
        }
    }
}
