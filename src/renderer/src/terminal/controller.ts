import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalPalette } from '@shared/theme'
import { looksLikeSecretPrompt, stripAnsi } from '@shared/secrets'
import { renderBufferAsHtml } from './serialize'
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
export class TerminalController {
  readonly term: Terminal
  private fit = new FitAddon()

  /** Offscreen terminal used only to render captured output into HTML. */
  private renderTerm: Terminal

  private capture = ''
  private capturing = false
  /** Set when output was dropped, so the block can say so rather than just lose it. */
  private captureTrimmed = false
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
    this.disposers.push(this.term.onData((d) => window.ember.write(this.paneId, d)).dispose)
    this.disposers.push(
      this.term.onBinary((d) => {
        const buf = new Uint8Array(d.length)
        for (let i = 0; i < d.length; i++) buf[i] = d.charCodeAt(i) & 0xff
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
   * Home-and-erase is the giveaway: nothing a normal command prints moves the
   * cursor to the top of the screen and clears it. Everything before it in this
   * capture was overpainted on the real screen too, so the capture is restarted
   * from that point, which is what the user actually saw.
   */
  private static readonly REPAINT = /\x1b\[(?:H|1;1H|2J|3J)/g

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
      if (last > 0) this.capture = this.capture.slice(last)
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

  private handleSemanticPrompt(data: string): void {
    this.markIntegration('ready')
    const [kind, ...rest] = data.split(';')

    if (kind === 'C') {
      // Output begins. The splitter in `feedCapture` owns the buffer itself; this
      // only handles the block's lifecycle.
      this.sawAltScreen = false
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
      return
    }

    if (kind === 'D') {
      const exitCode = Number.parseInt(rest[0] ?? '0', 10)
      void this.finishBlock(Number.isNaN(exitCode) ? 0 : exitCode)
      return
    }
    // A (prompt start) and B (input start) need no handling: the prompt itself is
    // never shown, because the input editor replaces it.
  }

  private handleEmberOsc(data: string): void {
    if (data === 'Ready') {
      this.markIntegration('ready')
      return
    }

    if (data.startsWith('P;Cwd=')) {
      const cwd = unescapeOsc(data.slice('P;Cwd='.length))
      this.store().patchPane(this.paneId, { cwd, title: cwd.split(/[\\/]/).pop() || cwd })
      if (this.currentBlockId) {
        this.store().patchBlock(this.paneId, this.currentBlockId, { cwd })
      }
      return
    }

    if (data.startsWith('E;')) {
      // The shell reports the command line it is about to run. Trust it over our
      // own copy, since the user may have edited it with readline.
      const command = unescapeOsc(data.slice(2)).trim()
      if (command.length === 0) return
      if (this.currentBlockId) {
        this.store().patchBlock(this.paneId, this.currentBlockId, { command })
      } else {
        this.pendingCommand = command
      }
    }
  }

  /** Feed captured bytes through the offscreen terminal and serialize the result. */
  private async renderCapture(): Promise<string> {
    const bytes = this.capture
    if (bytes.trim().length === 0) return ''

    this.renderTerm.reset()
    this.renderTerm.resize(Math.max(this.term.cols, 20), this.renderTerm.rows)

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
        this.captureTrimmed ||
        this.renderTerm.buffer.active.length >=
          this.renderTerm.rows + TerminalController.RENDER_SCROLLBACK
      return overflowed
        ? `<span class="block__elided">… earlier output not kept</span>\n${html}`
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
    let output = interactive ? '' : await this.renderCapture()
    this.capture = ''

    /*
     * Bounded in memory the way it already is on disk. The history and session
     * layers cap what they keep, but the living copy went into the store whole —
     * a command that printed fifty megabytes parked them there for the pane's
     * lifetime. The tail is what someone scrolls back for; the cut lands on a
     * row boundary so what is kept stays valid markup.
     */
    if (output.length > LIVE_OUTPUT_CAP) {
      const cut = output.indexOf('<div', output.length - LIVE_OUTPUT_CAP)
      output =
        '<div class="row">… earlier output trimmed — the full text is in history (Ctrl+R) …</div>' +
        (cut > 0 ? output.slice(cut) : output.slice(-LIVE_OUTPUT_CAP))
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
      const el = document.createElement('div')
      el.innerHTML = output
      window.ember.recordHistory({
        command: block.command,
        cwd: block.cwd,
        shell: pane?.profileId ?? '',
        exitCode,
        durationMs,
        startedAt: block.startedAt,
        output: el.innerText
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
    const text = await window.ember.clipboardRead()
    if (text.length > 0) window.ember.write(this.paneId, text)
  }

  private startShell(): void {
    const pane = this.store().terminalPane(this.paneId)
    void window.ember
      .spawn({
        paneId: this.paneId,
        profileId: pane?.profileId ?? '',
        cwd: pane?.cwd,
        cols: this.term.cols,
        rows: this.term.rows
      })
      .then((res) => {
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
    this.term.open(container)
    this.enableWebgl()
    this.refit()

    /*
     * Right-click copies a selection, or pastes when there is none.
     *
     * The convention Windows Terminal set, and worth having here because the app
     * draws its own chrome: there is no menu bar to fall back on, and a terminal is
     * the one place people reach for the mouse to move text around.
     */
    container.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      if (!this.copySelection()) void this.paste()
    })

    if (!this.spawned) {
      this.spawned = true
      this.watchForIntegration()
      this.startShell()
    }
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
    this.detectSecretPrompt(data)
    this.term.write(data)
  }

  /**
   * Send a secret the program is waiting for. Kept separate from `send` so it is
   * obvious at the call site that this value must never reach history, the block
   * list, or a log.
   */
  sendSecret(value: string): void {
    window.ember.write(this.paneId, `${value}\r`)
    this.tail = ''
    this.store().patchPane(this.paneId, { awaitingSecret: false })
  }

  send(data: string): void {
    window.ember.write(this.paneId, data)
  }

  /** Run a command from the input editor, opening its block up front. */
  runCommand(command: string): void {
    const trimmed = command.trim()
    if (trimmed.length === 0) {
      this.send('\r')
      return
    }
    // Without integration there is no `133;D` to close a block, so opening one
    // would leave it spinning forever. Just send the text.
    if (this.store().terminalPane(this.paneId)?.integration === 'ready') {
      this.currentBlockId = this.store().beginBlock(this.paneId, trimmed)
    }
    this.send(`${trimmed}\r`)
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
      const cols = Math.max(Number.isFinite(dims?.cols) ? (dims?.cols as number) : 0, 40)
      /*
       * The floor is also the ceiling in practice, because the live view is
       * collapsed while the shell is idle — so the pty ran on a 24-row console
       * buffer almost all of the time. A single line longer than 24 wrapped rows
       * scrolled off conpty's own screen before it could be captured, and the block
       * showed only its tail. Deep enough that ordinary long lines survive.
       */
      const rows = Math.max(Number.isFinite(dims?.rows) ? (dims?.rows as number) : 0, 120)
      if (cols !== this.term.cols || rows !== this.term.rows) this.term.resize(cols, rows)
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
  }

  focus(): void {
    this.term.focus()
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
