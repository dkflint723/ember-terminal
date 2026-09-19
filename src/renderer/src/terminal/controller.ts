import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalPalette } from '@shared/theme'
import { looksLikeSecretPrompt, stripAnsi } from '@shared/secrets'
import { cleanPaste, needsAsking, pasteQuestion, runQuestion } from '@shared/paste'
import { looksLocalDir, parseEmberMarker } from '@shared/integration'
import { renderBufferAsHtml, textFromHtml } from './serialize'
import { useStore, type CommandBlock, type TerminalPaneState } from '../state/store'
import { DEFAULT_THEME, toXtermTheme } from './theme'

/**
 * The block with this id, but only if it is a command.
 *
 * A pane's list now holds conversations with the agent alongside its commands, and
 * everything below this line is about the pty: capturing output, closing a block on
 * an exit code, writing a row to history. None of that means anything for a
 * conversation — it has no output and never finishes with a status — so an id that
 * names one is not an error to report, it is simply nothing for this code to do.
 * Callers already treat a missing block as "carry on without it", which is the
 * right behaviour here too.
 */
function commandBlock(
  pane: TerminalPaneState | null | undefined,
  blockId: string
): CommandBlock | undefined {
  const block = pane?.blocks.find((b) => b.id === blockId)
  return block?.kind === 'command' ? block : undefined
}

/** Undo the escaping applied by the shell-integration scripts. */
function unescapeOsc(value: string): string {
  return value
    .replace(/\\x3b/gi, ';')
    .replace(/\\x0a/gi, '\n')
    .replace(/\\x0d/gi, '\r')
    .replace(/\\x1b/gi, '\x1b')
    .replace(/\\x07/gi, '\x07')
    .replace(/\\\\/g, '\\')
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Owns one pane's terminal. The live xterm shows whatever is running right now;
 * completed commands are lifted out of the stream and stored as blocks.
 *
 * Blocks come from the raw bytes between the shell-integration markers
 * `OSC 133;C` (output starts) and `OSC 133;D` (command finished). Those bytes are
 * replayed into an offscreen terminal and serialized, so progress bars, spinners
 * and cursor movement render as the final frame the user actually saw rather than
 * as dozens of half-drawn lines.
 */
/**
 * Below this, a measurement is not a box worth being true to — it is a pane
 * mid-layout, or one collapsing to nothing between commands. Above it, whatever
 * was measured is what the user can see, and the terminal has to be exactly that
 * tall.
 */
const VISIBLE_ROW_FLOOR = 4

/**
 * The console before anything has been laid out, and the floor under a shell.
 *
 * Only ever used for the moments before the live view has had a real size — a
 * measured zero would hand PSReadLine a console it refuses to render a prompt in,
 * which stops command submission with nothing on screen to say so.
 */
const UNMEASURED_ROWS = 24

/**
 * The narrowest console worth handing a shell, and the width to assume before
 * anything has been measured.
 *
 * A genuinely narrow pane is still a measurement and is clamped to the floor. A
 * pane that cannot be measured at all is not, and the two were the same number
 * here: a hidden pane proposes no dimensions, which fell to zero and then to the
 * floor, so collapsing the terminal region resized the live pty to forty columns
 * underneath a running command.
 */
const MIN_COLS = 40
const UNMEASURED_COLS = 80

export class TerminalController {
  readonly term: Terminal
  private fit = new FitAddon()

  /**
   * The last height the live view actually had, kept for the stretches when it has
   * none. Never larger than a box the user has really seen, so holding it can
   * never put output below a fold.
   */
  private lastVisibleRows = UNMEASURED_ROWS

  /** The same for width, and for the same reason: a pane with no size has one. */
  private lastVisibleCols = UNMEASURED_COLS


  /**
   * What the element this was last drawn into was given, so it can be taken back.
   *
   * A controller is cached by pane id and outlives any element: only the active
   * session renders, so switching away unmounts the pane and switching back
   * attaches again, and the listeners bound to the old element have to come off it
   * rather than accumulate one set per visit.
   */
  private detachMenu: (() => void) | null = null

  /** Offscreen terminal used only to render captured output into HTML. */
  private renderTerm: Terminal

  /**
   * Renders run one at a time, because there is only one of those.
   *
   * Every render resets the offscreen terminal and then yields to it, so two
   * overlapping renders share one screen: the second wipes the first mid-write
   * and the first serializes whatever is left. Two commands finishing inside a
   * single parse chunk already did this, and output arriving at an idle prompt
   * made it ordinary rather than rare. The capture queue decides which bytes a
   * block owns; this decides that it also gets its own screen to draw them on.
   */
  private renderQueue: Promise<void> = Promise.resolve()

  private capture = ''
  private capturing = false

  /**
   * Where the loose-output scan believes it is.
   *
   * Kept apart from `capturing`, which feedCapture maintains, and from the
   * parser's own idea of the prompt: this walk happens before the terminal has
   * parsed anything, so it has to carry its own place in the stream.
   */
  private looseCapturing = false
  private looseInPrompt = false

  /**
   * Something was sent to the shell and has not been echoed back yet.
   *
   * This is what separates a background job from the command you just ran. Both
   * arrive in the same stretch of the stream — after the prompt has finished
   * drawing and before the next command's output begins — and the only thing that
   * tells them apart is that one of them is an answer to something Ember wrote.
   * Cleared by the marker that says the command has started, which is the end of
   * the echo either way.
   */
  private awaitingEcho = false
  /** Set when output was dropped, so the block can say so rather than just lose it. */
  private captureTrimmed = false

  /**
   * Captures that have seen their end marker and are waiting to be claimed.
   *
   * The splitter runs synchronously inside write(); the block that owns those
   * bytes does not come for them until xterm parses its way to the matching
   * `133;D`, which happens later — in short slices, with as much as a megabyte
   * outstanding. So a shell that returns its prompt promptly could emit `D(A)`,
   * the prompt and `C(B)` while the parser was still working through A's output,
   * and `C(B)` reset the single shared buffer: block A was handed B's bytes and
   * block B came back empty.
   *
   * Queued instead, oldest first. A finished capture belongs to a block that has
   * not claimed it yet, so nothing starting afterwards is allowed to touch it.
   */
  private done: { bytes: string; trimmed: boolean }[] = []
  /** Lines one block can keep. Generous: a build log is the normal case, not the extreme. */
  private static readonly RENDER_SCROLLBACK = 50_000
  /** Holds back a few bytes so a marker split across pty chunks is still found. */
  private carry = ''
  private currentBlockId: string | null = null
  private pendingCommand: string | null = null
  private sawAltScreen = false
  private disposers: (() => void)[] = []
  private spawned = false
  private integrationTimer: number | null = null
  /**
   * What this pane's shell was started with, and whether it has ever proved it.
   *
   * Empty when the shell was loaded the old way — the typed fallback — where there
   * is nothing to check against and the old rules stand. Once one signed marker
   * has arrived, unsigned ones are somebody else talking.
   */
  private nonce = ''
  private authenticated = false
  /** Rolling tail of recent output, used only for secret-prompt detection. */
  private tail = ''
  private palette: TerminalPalette

  constructor(
    private paneId: string,
    fontFamily: string,
    fontSize: number,
    palette: TerminalPalette = DEFAULT_THEME.terminal
  ) {
    this.palette = palette
    this.term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily,
      fontSize,
      lineHeight: 1.25,
      /**
       * Powerline separators and other prompt decorations are rarely in the
       * terminal font itself, so the browser falls back to whatever does have
       * them — and those fonts have their own metrics, which is why the shapes
       * come out oversized and overhang the line. This shrinks a glyph to the
       * cell it belongs to rather than letting it set its own size.
       */
      rescaleOverlappingGlyphs: true,
      scrollback: 5000,
      theme: toXtermTheme(palette),
      // Reported to programs so they enable colour and mouse handling.
      windowsPty: { backend: 'conpty' }
    })

    /*
     * A way back out of the terminal.
     *
     * xterm consumes every key, including Tab, so once focus entered a terminal
     * pane it could never leave it from the keyboard — not by Tab, not by
     * Shift+Tab, not by Escape. That is a keyboard trap, and it makes the whole app
     * unusable without a mouse no matter how well everything else is labelled.
     *
     * Shift+Tab is given up rather than plain Tab, because Tab is completion and a
     * shell needs it. Returning false tells xterm not to handle the event, so the
     * app's own handler takes it from there.
     */
    this.term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.key === 'Tab' && event.shiftKey) {
        this.onEscapeFocus?.()
        return false
      }

      /*
       * Copy and paste, on the chord every terminal uses.
       *
       * Plain Ctrl+C cannot be copy here — it is how a running program is
       * interrupted, and taking that away would cost more than having no copy at
       * all. So the shifted pair, as Windows Terminal, VS Code's terminal and
       * GNOME Terminal all do. Returning false keeps the keystroke out of the pty,
       * which would otherwise receive it as a control character.
       */
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'c') {
        this.copySelection()
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'v') {
        void this.paste()
        return false
      }
      return true
    })

    this.term.loadAddon(this.fit)
    /*
     * Links open in the browser, by asking main directly.
     *
     * The addon's default handler opens a window, and the window-open handler
     * denies every one of them — so clicking a URL in output did nothing at all.
     * Going straight to main skips the window that was only ever going to be
     * refused; the http(s) filter there is unchanged.
     */
    this.term.loadAddon(new WebLinksAddon((_event, uri) => window.ember.openExternal(uri)))

    const unicode = new Unicode11Addon()
    this.term.loadAddon(unicode)
    this.term.unicode.activeVersion = '11'

    this.renderTerm = new Terminal({
      allowProposedApi: true,
      cols: 120,
      rows: 200,
      // Deep enough that an ordinary build log survives intact. It used to cut off
      // at ~5200 lines with nothing to say it had, so a long block quietly began in
      // the middle of itself.
      scrollback: TerminalController.RENDER_SCROLLBACK,
      theme: toXtermTheme(palette)
    })

    this.registerHandlers()
  }

  private store = (): ReturnType<typeof useStore.getState> => useStore.getState()

  private registerHandlers(): void {
    // Keystrokes always reach the shell, so Ctrl-C works whichever mode we're in.
    this.disposers.push(
      this.term.onData((d) => {
        this.awaitingEcho = true
        window.ember.write(this.paneId, d)
      }).dispose
    )
    this.disposers.push(
      this.term.onBinary((d) => {
        const buf = new Uint8Array(d.length)
        for (let i = 0; i < d.length; i++) buf[i] = d.charCodeAt(i) & 0xff
        this.awaitingEcho = true
        window.ember.write(this.paneId, String.fromCharCode(...buf))
      }).dispose
    )

    // A program switching to the alternate screen is our signal that it owns the
    // whole viewport: hand it the keyboard and stop trying to build blocks.
    this.disposers.push(
      this.term.buffer.onBufferChange((buffer) => {
        const alternate = buffer.type === 'alternate'
        if (alternate) this.sawAltScreen = true
        this.store().patchPane(this.paneId, { mode: alternate ? 'raw' : 'blocks' })
      }).dispose
    )

    // Shells without integration still set the window title the classic way
    // (OSC 0/2), which is the only name a plain pane has to offer.
    this.disposers.push(
      this.term.onTitleChange((title) => {
        const pane = this.store().terminalPane(this.paneId)
        if (!pane || pane.integration === 'ready') return
        const trimmed = title.trim()
        if (trimmed.length > 0) this.store().patchPane(this.paneId, { title: trimmed })
      }).dispose
    )

    this.term.parser.registerOscHandler(133, (data) => {
      this.handleSemanticPrompt(data)
      return true
    })

    this.term.parser.registerOscHandler(633, (data) => {
      this.handleEmberOsc(data)
      return true
    })
  }

  /**
   * Slice the pty stream into per-command output at the `133;C` / `133;D` marker
   * boundaries. This cannot be done from the OSC handlers alone: a single pty
   * chunk routinely carries a command's output, its `133;D`, and the next prompt
   * together, so appending whole chunks would fold the following prompt into the
   * block. Runs before `term.write`, so the buffer is already correct by the time
   * xterm parses the markers and fires the handlers below.
   */
  private feedCapture(data: string): void {
    const START = '\x1b]133;C'
    const END = '\x1b]133;D'
    let s = this.carry + data
    this.carry = ''

    for (;;) {
      if (!this.capturing) {
        const i = s.indexOf(START)
        if (i === -1) {
          // Hold back enough to catch a marker straddling the chunk boundary.
          this.carry = s.slice(-(START.length - 1))
          return
        }
        // Skip past the marker's terminator, which may be BEL or ST.
        const rest = s.slice(i + START.length)
        const bel = rest.indexOf('\x07')
        const st = rest.indexOf('\x1b\\')
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
        if (end === -1) {
          this.carry = s.slice(i)
          return
        }
        this.capture = ''
        this.captureTrimmed = false
        this.capturing = true
        s = rest.slice(end + (end === st ? 2 : 1))
        continue
      }

      const j = s.indexOf(END)
      if (j !== -1) {
        this.appendCapture(s.slice(0, j))
        /*
         * Handed over the moment the end marker is seen, rather than left in the
         * buffer for whoever reads it next. From here these bytes belong to one
         * block and nothing else can reach them — which is the whole point: the
         * `133;C` below used to clear this buffer while a finished capture was
         * still sitting in it.
         */
        this.done.push({ bytes: this.capture, trimmed: this.captureTrimmed })
        this.capture = ''
        this.captureTrimmed = false
        this.capturing = false
        s = s.slice(j + END.length)
        continue
      }

      const hold = Math.min(END.length - 1, s.length)
      this.appendCapture(s.slice(0, s.length - hold))
      this.carry = s.slice(s.length - hold)
      return
    }
  }

  /**
   * A full-screen repaint arriving in the middle of one command's output.
   *
   * ConPTY keeps its own console screen buffer, and when it decides to redraw —
   * a large scroll, a resize — it emits the entire screen from home. Those bytes
   * land inside whatever capture is open, and replaying them into the offscreen
   * terminal paints earlier commands' text over this block's real output. Blocks
   * ended up showing lines that belonged to something run minutes ago.
   *
   * Home-and-erase is the giveaway, and the erase is the half that carries it.
   * This pattern used to accept a bare cursor-home as well — and conpty sends one
   * every time it redraws its viewport during a long scroll: home, then the rows
   * it has already streamed, each closed with an erase-to-end-of-line. So any
   * command long enough to scroll threw away everything before its last redraw.
   * Six thousand lines came back beginning at line two thousand, having been sent
   * in full.
   *
   * Nothing before an erase survived on the real screen, so restarting there is
   * what the user actually saw. Nothing before a bare home was touched.
   */
  private static readonly REPAINT = /\x1b\[[23]J|\x1b\[(?:H|1;1H)\x1b\[[0-3]?J/g

  /**
   * A repaint, as conpty actually writes one here.
   *
   * REPAINT above is used with exec in a loop and carries its lastIndex around, so
   * this is a separate, non-global copy — and a wider one. Conpty does not erase
   * the display and redraw; it hides the cursor, goes home, and then erases and
   * rewrites line by line, so the shape to look for is [?25l[H rather than
   * an erase-display. Reading only the narrow form meant every resize replayed the
   * prompt past this check and read as output from nowhere.
   */
  private static readonly LOOSE_REPAINT =
    /\x1b\[\?25l\x1b\[H|\x1b\[[23]J|\x1b\[(?:H|1;1H)\x1b\[[0-3]?[JK]/

  private appendCapture(chunk: string): void {
    if (chunk.length === 0) return
    this.capture += chunk

    // Only mid-capture: a repaint at the very start is the command's own doing.
    if (this.capture.length > chunk.length) {
      let last = -1
      TerminalController.REPAINT.lastIndex = 0
      for (
        let m = TerminalController.REPAINT.exec(this.capture);
        m !== null;
        m = TerminalController.REPAINT.exec(this.capture)
      ) {
        if (m.index >= this.capture.length - chunk.length) last = m.index
      }
      if (last > 0) {
        /*
         * Say so when a repaint took something readable.
         *
         * This drop is the right thing to do — nothing before an erase survived
         * on the real screen either — but it was silent, so a block that lost
         * the first half of its output to a conpty redraw came back looking
         * complete and simply starting in the middle. The byte cap below has
         * always set this flag; the older and more common loss never did.
         *
         * Only when there was something to read. A repaint that discards escape
         * sequences and blank rows has taken nothing anybody could have seen,
         * and a block that announces a loss it did not suffer teaches people to
         * ignore the notice on the blocks that did.
         */
        const dropped = stripAnsi(this.capture.slice(0, last))
        if (/\S/.test(dropped)) this.captureTrimmed = true
        this.capture = this.capture.slice(last)
      }
    }

    // Bound one command's output; a huge log would blow up the serialize pass.
    // Trimmed on a line boundary, so the block does not begin mid-escape.
    if (this.capture.length > 2_000_000) {
      const cut = this.capture.slice(-2_000_000)
      const nl = cut.indexOf('\n')
      this.capture = nl === -1 ? cut : cut.slice(nl + 1)
      this.captureTrimmed = true
    }
  }

  /**
   * Any semantic-prompt marker proves the shell is reporting boundaries, whoever
   * emitted it — a user's own OSC 133 setup counts just as much as our script.
   * Recoverable in both directions: a pane written off as `absent` flips back if
   * markers show up late, which is what makes the timeout below safe.
   */
  private markIntegration(state: 'ready' | 'absent'): void {
    if (this.integrationTimer !== null && state === 'ready') {
      window.clearTimeout(this.integrationTimer)
      this.integrationTimer = null
    }
    const pane = this.store().terminalPane(this.paneId)
    if (!pane || pane.integration === state) return
    this.store().patchPane(this.paneId, { integration: state })
  }

  /**
   * Decide whether to expect blocks at all. Shells with no integration hook are
   * settled immediately; the rest get a grace period, since a heavy user profile
   * can take seconds to reach its first prompt.
   */
  private watchForIntegration(): void {
    /*
     * The old watch stops before the new one starts.
     *
     * Restarting reassigned this handle without cancelling what it was holding,
     * and the abandoned timer kept its own deadline — the one counted from the
     * first spawn. Restart a shell that died inside its six-second grace period
     * and that stale timer would land on the new shell, find it still 'pending',
     * and write it off as having no integration before it had finished starting.
     */
    if (this.integrationTimer !== null) {
      window.clearTimeout(this.integrationTimer)
      this.integrationTimer = null
    }
    const pane = this.store().terminalPane(this.paneId)
    const profile = this.store().profiles.find((p) => p.id === pane?.profileId)

    if (profile && profile.integration === 'none') {
      this.markIntegration('absent')
      return
    }

    this.integrationTimer = window.setTimeout(() => {
      this.integrationTimer = null
      const current = this.store().terminalPane(this.paneId)
      if (current?.integration === 'pending') this.markIntegration('absent')
    }, 6000)
  }

  /**
   * A semantic-prompt marker, from whoever emitted it.
   *
   * Any of them still proves a shell is reporting boundaries, which is what a
   * user's own OSC 133 setup is for and why that keeps working. What changes once
   * this pane has seen a signed marker is that these stop driving blocks: an
   * unsigned `133;C` after that point is output talking, and output that can open
   * and close blocks can put a command's name on another command's output.
   */
  private handleSemanticPrompt(data: string): void {
    this.markIntegration('ready')
    if (this.authenticated) return
    const [kind, ...rest] = data.split(';')

    if (kind === 'C') {
      this.beginOutput()
      return
    }

    if (kind === 'D') {
      const exitCode = Number.parseInt(rest[0] ?? '0', 10)
      void this.finishBlock(Number.isNaN(exitCode) ? 0 : exitCode)
      return
    }
    /*
     * A and B are the prompt's own boundaries.
     *
     * The prompt is never drawn — the input editor stands where it would be — but
     * knowing when it is being written is what separates it from output that has
     * no command to belong to. Between A and B the shell is drawing its prompt;
     * after B and before the next C, anything that arrives came from somewhere
     * else.
     */
    // A and B are read by the loose-output scan instead, which walks the bytes
    // before the parser reaches them.
  }

  /**
   * Output that belongs to no command, noticed rather than swallowed.
   *
   * Blocks are cut between a command's start and end markers, and the live view is
   * zero pixels tall while nothing is running — so a background job's writing, a
   * server started with -NoNewWindow, or anything a profile prints after the
   * prompt went to a terminal nobody could see.
   *
   * The reading has to be per stretch of bytes rather than per chunk, which is
   * what the first version of this got wrong. A prompt arrives as one write
   * holding the previous command's end marker, the prompt-start marker, the
   * prompt itself and the prompt-end marker; asked afterwards, the terminal is
   * idle and not in a prompt and the chunk plainly has text in it, so every
   * ordinary prompt read as output from nowhere. So this walks the chunk, keeps
   * its own idea of where it is, and only collects what falls outside both a
   * command and a prompt.
   *
   * Two other things it refuses. A conpty repaint replays the screen — prompt and
   * all — whenever the pty is resized, and carries the erase and home sequences
   * that say so. And a stretch with no printable text in it is most of what a
   * terminal says to itself.
   */
  private noteLooseOutput(data: string): void {
    const MARKS = /\x1b\]133;([ABCD])[^\x07\x1b]*(?:\x07|\x1b\\)?/g
    let idleText = ''
    let at = 0
    let mark: RegExpExecArray | null = MARKS.exec(data)
    const collect = (upTo: number): void => {
      if (this.looseCapturing || this.looseInPrompt || this.awaitingEcho) return
      idleText += data.slice(at, upTo)
    }
    while (mark) {
      collect(mark.index)
      const kind = mark[1]
      if (kind === 'A') {
        this.looseInPrompt = true
        // A fresh prompt means whatever was sent has been dealt with.
        this.awaitingEcho = false
      } else if (kind === 'B') this.looseInPrompt = false
      else if (kind === 'C') {
        this.looseCapturing = true
        this.awaitingEcho = false
      } else if (kind === 'D') this.looseCapturing = false
      at = mark.index + mark[0].length
      mark = MARKS.exec(data)
    }
    collect(data.length)

    if (idleText.length === 0) return
    if (TerminalController.LOOSE_REPAINT.test(idleText)) return
    if (stripAnsi(idleText).trim().length === 0) return
    const pane = this.store().terminalPane(this.paneId)
    if (!pane || pane.looseOutput) return
    this.store().patchPane(this.paneId, { looseOutput: true })
  }

  /**
   * Output begins. The splitter in `feedCapture` owns the buffer itself; this only
   * handles the block's lifecycle.
   */
  private beginOutput(): void {
    this.sawAltScreen = false
    // Whatever arrived outside a command belongs to the last quiet stretch, and
    // this is the end of it.
    if (this.store().terminalPane(this.paneId)?.looseOutput) {
      this.store().patchPane(this.paneId, { looseOutput: false })
    }
    // A new command starts with no pending prompt, stale or otherwise.
    this.tail = ''
    if (this.store().terminalPane(this.paneId)?.awaitingSecret) {
      this.store().patchPane(this.paneId, { awaitingSecret: false })
    }

    // If the user typed straight into the terminal rather than the editor, the
    // block has not been opened yet.
    if (!this.currentBlockId) {
      const command = this.pendingCommand ?? ''
      this.currentBlockId = this.store().beginBlock(this.paneId, command)
    }
    this.pendingCommand = null
  }

  /**
   * Ember's own markers, which are only Ember's if they carry this shell's nonce.
   *
   * With a nonce, nothing else is read at all. Without one — the typed fallback,
   * or a shell that started before this window could ask — the old rules stand,
   * because refusing everything there costs the blocks entirely and protects
   * nobody.
   */
  private handleEmberOsc(data: string): void {
    if (this.nonce) {
      const marker = parseEmberMarker(data, this.nonce)
      if (!marker) return
      if (!this.authenticated) {
        this.authenticated = true
        this.store().patchPane(this.paneId, { authenticated: true })
      }
      switch (marker.kind) {
        case 'ready':
          this.markIntegration('ready')
          return
        case 'output':
          this.beginOutput()
          return
        case 'finished':
          void this.finishBlock(marker.exitCode)
          return
        case 'cwd':
          void this.adoptCwd(marker.path)
          return
        case 'command':
          this.adoptCommand(marker.text)
          return
      }
      return
    }

    if (data === 'Ready') {
      this.markIntegration('ready')
      return
    }
    if (data.startsWith('P;Cwd=')) {
      void this.adoptCwd(unescapeOsc(data.slice('P;Cwd='.length)))
      return
    }
    if (data.startsWith('E;')) {
      this.adoptCommand(unescapeOsc(data.slice(2)).trim())
    }
  }

  /**
   * Follow the shell into a directory, if it is one this side can look at.
   *
   * The shape is judged first and the filesystem second, because asking the
   * filesystem is itself the harm: a UNC path is a blocking network round trip,
   * and this directory is re-read by the git poll every few seconds — so one
   * forged `\\\\somewhere\\share` is a stall that repeats, and a connection to a
   * host of somebody else's choosing carrying this machine's credentials.
   */
  private async adoptCwd(path: string): Promise<void> {
    if (!looksLocalDir(path)) return
    if (!(await window.ember.directoryExists(path))) return
    this.store().patchPane(this.paneId, {
      cwd: path,
      title: path.split(/[\\/]/).pop() || path
    })
    if (this.currentBlockId) {
      this.store().patchBlock(this.paneId, this.currentBlockId, { cwd: path })
    }
  }

  /**
   * What the shell says it is about to run, which beats our own copy: the user may
   * have edited the line in readline after Ember wrote it.
   */
  private adoptCommand(command: string): void {
    if (command.length === 0) return
    if (this.currentBlockId) {
      this.store().patchBlock(this.paneId, this.currentBlockId, { command })
    } else {
      this.pendingCommand = command
    }
  }

  /** Feed captured bytes through the offscreen terminal and serialize the result. */
  private renderCapture(bytes: string, trimmed: boolean): Promise<string> {
    const done = this.renderQueue.then(() => this.renderOne(bytes, trimmed))
    // The chain has to survive a failure, or one bad render stops every later
    // one and the pane stops producing blocks at all.
    this.renderQueue = done.then(
      () => undefined,
      () => undefined
    )
    return done
  }

  private async renderOne(bytes: string, trimmed: boolean): Promise<string> {
    if (bytes.trim().length === 0) return ''

    this.renderTerm.reset()
    /*
     * The same shape as the screen these bytes were written for.
     *
     * Conpty addresses the screen absolutely: it repaints its viewport with a
     * cursor-home and a run of lines, and it names the row to return to by number.
     * Replaying that into a terminal of a different height puts every one of those
     * moves somewhere else. This one matched the live terminal's columns and kept
     * its own two hundred rows, so a fourteen-row repaint landed across fourteen
     * rows in the middle of the output and the stream carried on overwriting from
     * there — and when the repaint arrived before the screen had scrolled at all,
     * it overwrote the whole of the output so far. Rows follow the live terminal
     * now, for the same reason columns always did.
     */
    this.renderTerm.resize(Math.max(this.term.cols, 20), Math.max(this.term.rows, 2))

    await new Promise<void>((resolve) => this.renderTerm.write(bytes, resolve))

    try {
      const html = renderBufferAsHtml(this.renderTerm, this.palette)
      /*
       * Say when output was dropped rather than simply not having it.
       *
       * The offscreen terminal's scrollback is a hard ceiling, and the byte cap is
       * another, so a long command silently lost its beginning — the block looked
       * complete and started in the middle. A line at the top is not the missing
       * output, but it is the difference between truncated and wrong.
       */
      const overflowed =
        trimmed ||
        this.renderTerm.buffer.active.length >=
          this.renderTerm.rows + TerminalController.RENDER_SCROLLBACK
      /*
       * In a row of its own, like every other line.
       *
       * It used to be a bare span alongside the rows, and text is taken from a
       * block by joining its `.row` children — so the one line saying output was
       * lost was the one line dropped from every copy, from history, and from what
       * gets handed to Claude. A truncated block read as a complete one. The same
       * marker written by the history layer has always been wrapped; only the live
       * one was not.
       */
      return overflowed
        ? `<div class="row"><span class="block__elided">… earlier output not kept</span></div>\n${html}`
        : html
    } catch {
      // Rendering must never lose the block; fall back to plain text.
      return `<span>${escapeHtml(this.renderTerm.buffer.active.getLine(0)?.translateToString(true) ?? '')}</span>`
    }
  }

  /**
   * Tell the user a long command finished, when they are not already looking.
   *
   * Two conditions here, and a third in main. Long enough to have been worth
   * walking away from, or the notification is noise. Not an interactive session:
   * quitting vim after ten minutes is not a build finishing, and a toast for it
   * would be baffling.
   *
   * Whether the window has focus is deliberately not decided here.
   * `document.hasFocus()` reports true even for a minimized window, so it would
   * suppress exactly the notifications this feature exists to send. Main asks the
   * window itself, which is the only party that actually knows.
   */
  private maybeNotify(
    command: string,
    durationMs: number | null,
    exitCode: number,
    interactive: boolean
  ): void {
    if (interactive || durationMs === null || !command.trim()) return

    const threshold = this.store().settings.notifyAfterSeconds
    if (threshold <= 0 || durationMs < threshold * 1000) return

    window.ember.notifyCommand({
      command: command.trim(),
      durationMs,
      ok: exitCode === 0,
      paneId: this.paneId
    })
  }

  private async finishBlock(exitCode: number): Promise<void> {
    this.capturing = false
    const blockId = this.currentBlockId
    this.currentBlockId = null
    if (!blockId) return

    const interactive = this.sawAltScreen

    /*
     * The oldest capture that nobody has claimed, which is this block's.
     *
     * This used to read the one shared buffer, and the two ends of that exchange
     * run at different times: the splitter fills it synchronously inside write(),
     * while the block comes for it only when xterm has parsed its way here. Under
     * a flood the parser falls thousands of lines behind, so the next command's
     * `133;C` could arrive first and empty the buffer — the finished block then
     * took whatever the new one had printed, and the new one finished with
     * nothing. Taking it before the await narrowed that window; it did not close
     * it, because the window opens before this line is reached at all.
     *
     * Empty when there is nothing queued, which is the honest answer for an
     * interactive program that never produced a capture of its own.
     */
    const claimed = this.done.shift() ?? { bytes: '', trimmed: false }
    let output = interactive ? '' : await this.renderCapture(claimed.bytes, claimed.trimmed)

    /*
     * Bounded in memory the way it already is on disk. The history and session
     * layers cap what they keep, but the living copy went into the store whole —
     * a command that printed fifty megabytes parked them there for the pane's
     * lifetime. The tail is what someone scrolls back for; the cut lands on a
     * row boundary so what is kept stays valid markup.
     */
    if (output.length > LIVE_OUTPUT_CAP) {
      const from = output.length - LIVE_OUTPUT_CAP
      /*
       * A row boundary if there is one, and a tag boundary if there is not.
       *
       * One `<div class="row">` is emitted per *logical* line, so a command that
       * prints a single line longer than the cap has exactly one of them, at index
       * zero — and the old fallback then cut at an arbitrary character, landing
       * inside a tag or an entity and rendering `olor:#ff0000">` as literal text at
       * the top of the block. The start of any tag is a safe place to cut; a stray
       * closing tag after it is something the parser drops.
       */
      let cut = output.indexOf('<div', from)
      if (cut < 0) cut = output.indexOf('<', from)
      /*
       * Only point at history when history actually has it.
       *
       * This cut is the second one a very long command can meet: the capture
       * itself is bounded, and when that bound was reached the render already says
       * so on the first row. History is written from this same output, so if the
       * start was gone before it got here it is not in history either — and this
       * line replaces that first row, so it would quietly upgrade "not kept" into
       * "go and look it up". Two different losses, and only one of them is
       * recoverable.
       */
      /*
       * And the note does not send anyone somewhere the text is not.
       *
       * This used to read "the full text is in history (Ctrl+R)", which is false
       * twice over. History keeps a hundred thousand characters, against the
       * half-megabyte kept here — and it keeps them from the *front*
       * (history.ts: `entry.output.slice(0, MAX_OUTPUT_CHARS)`), while this cut
       * keeps the end. So for a command long enough to meet this cap, the copy
       * being pointed at is the one place that certainly does not hold what was
       * just dropped: history has the beginning, which is the half still on
       * screen above this line.
       *
       * Saying where something went is only worth doing while it is where you
       * said. The beginning is what history has, so that is what it now offers.
       */
      const lostAlready = output.startsWith('<div class="row"><span class="block__elided">')
      output =
        (lostAlready
          ? '<div class="row"><span class="block__elided">… earlier output not kept</span></div>'
          : '<div class="row">… earlier output trimmed — history (Ctrl+R) kept this command’s first 100,000 characters …</div>') +
        (cut > 0 ? output.slice(cut) : output)
    }

    const pane = this.store().terminalPane(this.paneId)
    const block = commandBlock(pane, blockId)

    const durationMs = block ? Date.now() - block.startedAt : null

    this.store().patchBlock(this.paneId, blockId, {
      output,
      interactive,
      status: exitCode === 0 ? 'done' : 'failed',
      exitCode,
      durationMs
    })

    this.maybeNotify(block?.command ?? '', durationMs, exitCode, interactive)

    // Persist for cross-session search. Output goes over as plain text: history
    // exists to be searched, not to reproduce a block's rendering.
    if (block && block.command.trim().length > 0) {
      window.ember.recordHistory({
        command: block.command,
        cwd: block.cwd,
        shell: pane?.profileId ?? '',
        exitCode,
        durationMs,
        startedAt: block.startedAt,
        output: textFromHtml(output)
      })

      /*
       * And keep the block itself, so the pane comes back holding it.
       *
       * Written as each command finishes rather than as the app closes: a session
       * that ends in a crash or a Windows restart is exactly the one whose blocks
       * are worth having, and it costs one small insert per command. Off when the
       * user has switched session restore off, which is the same bargain Warp
       * offers — no restoring, and no recording either.
       */
      if (this.store().settings.restoreSession) {
        window.ember.saveBlock(this.paneId, {
          id: block.id,
          command: block.command,
          output,
          status: exitCode === 0 ? 'done' : 'failed',
          exitCode,
          cwd: block.cwd,
          startedAt: block.startedAt,
          durationMs,
          interactive,
          collapsed: block.collapsed
        })
      }
    }

    // Reset the live view so the next command starts on a clean screen. Deferred
    // out of the parser callback to avoid writing while the stream is mid-parse.
    queueMicrotask(() => {
      this.term.write('\x1b[H\x1b[2J\x1b[3J')
    })
  }

  /** What is selected in the terminal, put on the clipboard. False if nothing is. */
  copySelection(): boolean {
    const text = this.term.getSelection()
    if (text.length === 0) return false
    void navigator.clipboard.writeText(text)
    return true
  }

  /**
   * The clipboard, typed into the shell.
   *
   * Written as input rather than onto the screen, because that is what a paste is:
   * the shell echoes it, its own line editor sees it, and a program reading stdin
   * receives it exactly as it would receive typing.
   */
  async paste(): Promise<void> {
    const raw = await window.ember.clipboardRead()
    if (raw.length > 0) this.pasteText(raw)
  }

  /**
   * One way in for pasted text, whichever gesture brought it.
   *
   * Through xterm rather than straight at the pty, which is what this used to do.
   * Writing to the pty skips bracketed paste entirely — the shell never receives
   * the markers that say "this is text, hold it until Enter" — so a clipboard with
   * a newline in it ran on arrival even where the shell was perfectly willing to
   * hold it, and the line that ran need not be the line that was visible.
   *
   * And the text is cleaned first, because an escape character in a clipboard is
   * not text but an instruction — including `ESC [ 2 0 1 ~`, the marker that ends a
   * bracketed paste, which is how pasted text talks its way out of being text.
   */
  private pasteText(raw: string): void {
    const clean = cleanPaste(raw, this.term.modes.bracketedPasteMode)
    if (clean.text.length === 0) return
    if (needsAsking(clean) && !window.confirm(pasteQuestion(clean))) return
    this.term.paste(clean.text)
  }

  private startShell(): void {
    const pane = this.store().terminalPane(this.paneId)
    // A restart gets a new shell and so a new nonce; the old one stops meaning
    // anything the moment the old shell does.
    this.nonce = ''
    this.authenticated = false
    // A new shell has to prove itself again; the last one's word does not carry.
    this.store().patchPane(this.paneId, { authenticated: false })
    void window.ember
      .spawn({
        paneId: this.paneId,
        profileId: pane?.profileId ?? '',
        cwd: pane?.cwd,
        cols: this.term.cols,
        rows: this.term.rows
      })
      .then((res) => {
        if (res.nonce) this.nonce = res.nonce
        if (!res.ok) {
          this.term.write(`

[31m${res.error ?? 'Failed to start shell.'}[0m

`)
        }
      })
  }

  /**
   * Start a new shell in a pane whose own has exited.
   *
   * Such a pane was a dead end: it kept its blocks, said `exited 1`, and the only
   * thing left to do with it was close it — which threw the blocks away too. It is
   * the same pane, so its history stays and the new shell opens where the old one
   * was last standing.
   *
   * The capture state goes with it. Whatever the dying shell left half-collected
   * belongs to no command that will ever finish, and keeping it would put it at the
   * top of the first block of the new session.
   */
  restart(): void {
    this.capture = ''
    this.capturing = false
    this.captureTrimmed = false
    // Including the finished ones nobody claimed: they belong to blocks of a
    // shell that has gone, and no command in the new one will ever come for them.
    this.done = []
    this.carry = ''
    this.currentBlockId = null
    this.pendingCommand = null
    this.sawAltScreen = false
    this.tail = ''

    this.store().patchPane(this.paneId, {
      exited: false,
      exitCode: null,
      integration: 'pending',
      awaitingSecret: false,
      mode: 'blocks'
    })

    this.term.write('[H[2J[3J')
    this.watchForIntegration()
    this.startShell()
  }

  attach(container: HTMLElement): void {
    // Whatever the last element was given comes off first. Attaching is not
    // necessarily a first attach.
    this.detachMenu?.()
    this.detachMenu = null

    /*
     * open() builds the terminal's element once and, ever after, returns having
     * done nothing: xterm keeps the parent it was first given. A pane that unmounts
     * and comes back is handed a new host element, so the terminal has to be
     * carried over by hand. Without that, switching sessions left every terminal in
     * the host it first saw — two of them stacked in the pane being looked at, the
     * older one over the newer — and splitting a pane left the original with no
     * terminal at all, so a full-screen program ran in an empty box.
     */
    const drawn = this.term.element
    if (drawn) {
      if (drawn.parentElement !== container) container.appendChild(drawn)
    } else {
      this.term.open(container)
      /*
       * And the renderer is chosen here, once, because this is the only moment it
       * can be chosen the same way twice.
       *
       * It used to be dropped and loaded again on every attach. That was invisible
       * while a pane attached once and never again: the box a pane is given while
       * it sits idle is `height: 0`, a canvas of that size fails, and xterm falls
       * back to the DOM renderer for the life of the terminal. Attaching again —
       * which panes now do, having become things that unmount — asks the same
       * question in front of a box with a size in it, gets the other answer, and
       * moves the terminal onto the GPU halfway through a session. Nothing about a
       * pane being shown again is a reason to change how it is drawn, and the
       * change is not cosmetic: with the palette painted into a canvas rather than
       * onto the screen element, five theme checks in verify.mjs stopped being able
       * to see it, and a Read-Host prompt went unmasked with the typed secret in
       * the DOM.
       */
      this.enableWebgl()
    }
    // Whose screen this is, for the verify harness — which otherwise has to count
    // elements and hope — and for anyone reading the DOM to ask the same question.
    this.term.element?.setAttribute('data-pane', this.paneId)
    this.markPalette()
    this.refit()

    /*
     * And the nonce for a pane that never spawned anything here.
     *
     * A session dragged in from another window arrives with its shell already
     * running, so the spawn result that carries the nonce belongs to a window that
     * has let go of it. Asked for by pane instead, which covers both roads in.
     */
    if (!this.nonce) {
      void window.ember.paneNonce(this.paneId).then((n) => {
        if (typeof n === 'string' && n.length > 0) this.nonce = n
      })
    }

    /*
     * Right-click copies a selection, or pastes when there is none.
     *
     * The convention Windows Terminal set, and worth having here because the app
     * draws its own chrome: there is no menu bar to fall back on, and a terminal is
     * the one place people reach for the mouse to move text around.
     */
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      if (!this.copySelection()) void this.paste()
    }
    /*
     * And plain Ctrl+V, which never came through here at all.
     *
     * xterm answers a paste event on its own textarea and hands the text to
     * onData, so the chord everyone actually presses went straight to the pty past
     * every rule this class has about pasting — the shifted chord was the only one
     * that did not. Caught in the capture phase, before xterm sees it, so both
     * gestures end up in the same place.
     */
    const onPaste = (e: ClipboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      const raw = e.clipboardData?.getData('text') ?? ''
      if (raw.length > 0) this.pasteText(raw)
    }
    container.addEventListener('contextmenu', onContextMenu)
    container.addEventListener('paste', onPaste, true)
    this.detachMenu = (): void => {
      container.removeEventListener('contextmenu', onContextMenu)
      container.removeEventListener('paste', onPaste, true)
    }

    if (!this.spawned) {
      this.spawned = true
      /*
       * A pane that moved here from another window already has its shell — main
       * re-pointed the pty at this window before the source let go. Spawning
       * would put a second shell under a pane that is showing the first one's
       * history. The refit above already sent this window's dimensions, which
       * nudges ConPTY into repainting the prompt where the eye expects it.
       */
      if (takeAdopted(this.paneId)) return
      this.watchForIntegration()
      this.startShell()
    }
  }

  /**
   * Give the host element back, and keep the terminal.
   *
   * A pane unmounts whenever its session is switched away from, or its layout
   * changes, and the element it drew into goes with it. Nothing used to come off
   * that element, so the terminal either stayed inside a div that had been thrown
   * away, or — where React handed the same div to the next session — sat over that
   * session's own terminal. What is kept is the terminal itself: the scrollback is
   * in it, and the shell behind it is still running.
   */
  detach(): void {
    this.detachMenu?.()
    this.detachMenu = null
    // The renderer stays loaded. A canvas keeps its context when it is moved, and
    // one context per pane is what a pane already costs; dropping it here would
    // mean choosing a renderer again on the way back in, which is the thing that
    // must not happen twice.
    this.term.element?.remove()
  }

  /**
   * Watch the tail of the output for a prompt asking for a secret. A rolling
   * window rather than the current chunk, because a prompt can be split across
   * pty reads.
   */
  private detectSecretPrompt(data: string): void {
    this.tail = (this.tail + stripAnsi(data)).slice(-400)
    const wants = looksLikeSecretPrompt(this.tail)

    const pane = this.store().terminalPane(this.paneId)
    if (!pane || pane.awaitingSecret === wants) return
    this.store().patchPane(this.paneId, { awaitingSecret: wants })
  }

  /**
   * The GPU renderer, which is markedly faster on large bursts of output. It can
   * only be loaded after open(), and the context can be lost at any time (driver
   * reset, GPU process crash) — dropping the addon then falls back to the DOM
   * renderer rather than leaving a dead canvas.
   */
  private enableWebgl(): void {
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      this.term.loadAddon(webgl)
    } catch {
      // No GPU path available; the DOM renderer is still correct, just slower.
    }
  }

  /** Called from the pane's pty data subscription. */
  write(data: string): void {
    // Order matters: the capture must be sliced before xterm parses the markers
    // and fires finishBlock.
    this.feedCapture(data)
    // Before the parser, deliberately: this walk keeps its own place in the
    // stream, and wants the bytes as they arrive rather than the state they leave
    // behind.
    this.noteLooseOutput(data)
    // The callback is xterm saying "parsed" — the acknowledgement that lets
    // main reopen the pty once the renderer has genuinely kept up, rather than
    // merely received. Without it a flooding command queues here unboundedly.
    this.term.write(data, () => {
      /*
       * Read for a no-echo prompt only after the parser has been through the same
       * bytes, because the parser is what throws the reading away.
       *
       * `beginOutput` empties the rolling tail at a start marker and puts
       * `awaitingSecret` back to false — right, for output that has not arrived
       * yet. Reading first meant a prompt that shared a conpty chunk with that
       * marker was detected and then immediately undetected by the same bytes,
       * and the only thing that saved it was the repaint from the next pty
       * resize delivering the prompt a second time. That is a race, and it was
       * losing about one run in three: the composer stayed an ordinary composer
       * and the password was typed into it in the clear. Reading afterwards, the
       * tail holds what the terminal has parsed since the marker, which is what
       * it was always meant to hold.
       */
      this.detectSecretPrompt(data)
      window.ember.ptyAck(this.paneId, data.length)
    })
  }

  /**
   * Send a secret the program is waiting for. Kept separate from `send` so it is
   * obvious at the call site that this value must never reach history, the block
   * list, or a log.
   */
  sendSecret(value: string): void {
    this.awaitingEcho = true
    window.ember.write(this.paneId, `${value}\r`)
    this.tail = ''
    this.store().patchPane(this.paneId, { awaitingSecret: false })
  }

  send(data: string): void {
    this.awaitingEcho = true
    window.ember.write(this.paneId, data)
  }

  /** Run a command from the input editor, opening its block up front. */
  runCommand(command: string): void {
    const trimmed = command.trim()
    if (trimmed.length === 0) {
      this.send('\r')
      return
    }

    /*
     * More than one line is more than one command, and it is asked about.
     *
     * Enter in the composer sends the whole buffer, newlines and all, and each of
     * those newlines is an Enter of its own by the time the shell reads it: a page
     * pasted into the composer ran top to bottom on one keystroke, under a single
     * block named after the whole blob. The text is cleaned for the same reason a
     * paste is — an escape character that reached the composer is still an
     * instruction — and for an ordinary one-line command both are no change at all.
     */
    const clean = cleanPaste(trimmed, false)
    if (needsAsking(clean) && !window.confirm(runQuestion(clean))) return

    // Without integration there is no `133;D` to close a block, so opening one
    // would leave it spinning forever. Just send the text.
    if (this.store().terminalPane(this.paneId)?.integration === 'ready') {
      this.currentBlockId = this.store().beginBlock(this.paneId, clean.text)
    }
    this.send(`${clean.text}\r`)
  }

  /**
   * The live view is collapsed to nothing while the shell is idle, which would
   * otherwise hand the pty a row count of zero — PSReadLine refuses to render a
   * prompt at that size, which silently breaks command submission. So the
   * measured size is clamped to something a shell can actually work with.
   */
  refit(): void {
    try {
      const dims = this.fit.proposeDimensions()
      const measuredCols = Number.isFinite(dims?.cols) ? (dims?.cols as number) : 0
      const measured = Number.isFinite(dims?.rows) ? (dims?.rows as number) : 0
      /*
       * The terminal is exactly as tall as the box it is drawn in.
       *
       * This used to floor the row count at 120 — deep on purpose, to keep conpty
       * from scrolling long output away before a block could capture it. But the
       * same number sizes the grid xterm lays out, and xterm gives its screen an
       * explicit rows × cellHeight height that nothing clips or scrolls to fit.
       * The only clip is `.live { overflow: hidden }`. So a running command, whose
       * strip is 42% of the pane, got 284px of box holding 2160px of terminal:
       * about eighteen rows visible and a hundred rendered below the fold, where
       * no amount of scrolling can reach them — xterm can only scroll back into
       * scrollback, never down past its own screen.
       *
       * That is what "the instance runs off below the screen" was. The second half
       * of the report — a prompt that "does nothing unless I hold enter" — is the
       * same bug: xterm advances the cursor on a newline and only scrolls when it
       * reaches the *last* row, so with a hundred empty rows underneath, every
       * press was delivered and answered somewhere nobody could see. Holding it
       * walked the cursor down far enough to finally scroll, which is why a
       * hundred prompts came back on the next Ctrl+C.
       *
       * The depth turned out to be protecting nothing: capture is the raw byte
       * stream, taken in write() before xterm parses any of it, and conpty streams
       * what scrolls rather than only rendering frames. Measured directly — the
       * shell reports a 15-row console now, and a 6000-character line still keeps
       * both its head and its tail.
       *
       * Held across the collapse rather than recomputed, so the pty is not resized
       * twice for every command: a resize is a conpty repaint, and a repaint inside
       * an open capture costs the block everything before it.
       */
      if (measured >= VISIBLE_ROW_FLOOR) this.lastVisibleRows = measured
      const rows = this.lastVisibleRows

      /*
       * Width is held across the same stretches, which it was not.
       *
       * Any real measurement counts, however narrow — a thin split is a width
       * someone chose, and the floor is there so a shell still has room to draw a
       * prompt in it. But a pane that cannot be measured proposes nothing, and
       * that fell through the same clamp to forty. Collapsing the terminal region
       * while a command ran therefore resized conpty to forty columns and made it
       * rewrap everything still to come.
       */
      /*
       * Whether there is a box at all, asked of the box rather than of the fit
       * addon. A hidden pane still proposes a width: the addon reads computed
       * styles, and a percentage width computes to a number even with nothing to
       * apply it to, so a collapsed pane proposed about a dozen columns — a real
       * enough looking figure to pass any "did we measure something" test, and
       * then to be clamped up to the forty-column floor. clientWidth is the used
       * value and is plainly zero, which is the question actually being asked.
       */
      const box = this.term.element
      const hasBox = !!box && box.clientWidth > 0 && box.clientHeight > 0
      if (hasBox && measuredCols > 0) this.lastVisibleCols = Math.max(measuredCols, MIN_COLS)
      const cols = this.lastVisibleCols
      if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows)
      /*
       * Sent on every fit, deliberately.
       *
       * Skipping it when the size has not changed looks like free economy and is
       * not: a conpty resize is also a repaint, and the repaint is what redraws
       * the prompt after the live view has been cleared. Secret-prompt detection
       * depends on that redraw — `beginOutput` empties the rolling tail when the
       * start marker is parsed, which for a prompt arriving in the same chunk
       * discards it, and only the repaint delivers it a second time. Guarding
       * this call left `Read-Host` unmasked and the typed secret in the DOM.
       */
      window.ember.resize(this.paneId, cols, rows)
    } catch {
      // The pane can be measured before layout settles; the next resize wins.
    }
  }

  setFont(fontFamily: string, fontSize: number): void {
    this.term.options.fontFamily = fontFamily
    this.term.options.fontSize = fontSize
    this.refit()
  }

  setPalette(palette: TerminalPalette): void {
    this.palette = palette
    const theme = toXtermTheme(palette)
    this.term.options.theme = theme
    // The offscreen terminal must match, or already-captured blocks would be
    // serialized with the previous theme's colours.
    this.renderTerm.options.theme = theme
    this.markPalette()
  }

  /**
   * The background xterm is holding, written where it can be read.
   *
   * Read back out of `term.options` rather than from the palette this was handed,
   * so it says what the terminal took rather than what it was offered. It is on the
   * element because the alternative is unreadable: the screen element carries the
   * background only while the DOM renderer is drawing, and is transparent whenever
   * the GPU one is — so a harness reading the screen's computed background is
   * really asking which renderer is running, and got told the palette was missing
   * by a terminal that had it.
   */
  private markPalette(): void {
    const bg = this.term.options.theme?.background
    if (typeof bg === 'string') this.term.element?.setAttribute('data-term-bg', bg)
  }

  focus(): void {
    this.term.focus()
  }

  /**
   * Whether the keyboard may reach this terminal by Tab.
   *
   * xterm keeps a textarea to read input through, it carries tabIndex 0, and its
   * focus ring is removed — which is fine while the terminal is on screen and a
   * trap while it is not. Idle, the live view is height 0 and opacity 0, so a
   * Shift+Tab out of the composer landed in a control nobody could see, with
   * every keystroke going to the shell and Enter running it. Out of the tab order
   * while there is nothing to look at; back in the moment there is.
   */
  setReachable(reachable: boolean): void {
    const area = this.term.textarea
    if (area) area.tabIndex = reachable ? 0 : -1
  }

  /** Called when the user asks to leave the terminal with Shift+Tab. */
  onEscapeFocus: (() => void) | null = null

  dispose(): void {
    if (this.integrationTimer !== null) window.clearTimeout(this.integrationTimer)
    for (const d of this.disposers) {
      try {
        d()
      } catch {
        // Already disposed.
      }
    }
    this.renderTerm.dispose()
    this.term.dispose()
  }
}

/**
 * Controllers outlive React renders, so they live in a registry keyed by pane id
 * rather than in component state.
 */
/** How much of one command's rendered output the store keeps live. */
const LIVE_OUTPUT_CAP = 512 * 1024

const registry = new Map<string, TerminalController>()

/**
 * Panes that arrived from another window with their shells alive. Consumed on
 * first attach — the one moment a controller would otherwise spawn — and never
 * again, so a later restart in the same pane behaves like any other.
 */
const adopted = new Set<string>()

export function markAdopted(paneIds: string[]): void {
  for (const id of paneIds) adopted.add(id)
}

function takeAdopted(paneId: string): boolean {
  if (!adopted.has(paneId)) return false
  adopted.delete(paneId)
  return true
}

/**
 * The controller a pane already has, or nothing.
 *
 * `getController` builds one when there is none, which is right for a pane that is
 * mounting and wrong for anyone else: a caller that only wants to send a command to
 * a shell would otherwise create a second terminal for a pane that has one.
 */
export function existingController(paneId: string): TerminalController | undefined {
  return registry.get(paneId)
}

export function getController(
  paneId: string,
  fontFamily: string,
  fontSize: number,
  palette?: TerminalPalette
): TerminalController {
  let c = registry.get(paneId)
  if (!c) {
    c = new TerminalController(paneId, fontFamily, fontSize, palette)
    registry.set(paneId, c)
  }
  return c
}

export function disposeController(paneId: string): void {
  const c = registry.get(paneId)
  if (!c) return
  registry.delete(paneId)
  c.dispose()
}

export function allControllers(): TerminalController[] {
  return [...registry.values()]
}

/** Fan pty output out to the right controller. */
window.ember.onData(({ paneId, data }) => registry.get(paneId)?.write(data))

window.ember.onExit(({ paneId, exitCode }) => {
  const store = useStore.getState()
  store.patchPane(paneId, { exited: true, exitCode, mode: 'blocks' })

  // A shell that dies mid-command never sends `133;D`, so close the open block
  // here rather than leaving it running for the life of the window. Commands only:
  // a conversation still streaming when the shell exits is being answered by the
  // agent, which the pty's death says nothing about.
  const running = store
    .terminalPane(paneId)
    ?.blocks.find((b): b is CommandBlock => b.kind === 'command' && b.status === 'running')
  if (running) {
    store.patchBlock(paneId, running.id, {
      status: 'failed',
      exitCode,
      durationMs: Date.now() - running.startedAt
    })
  }
})
