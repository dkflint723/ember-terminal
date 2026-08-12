import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import type { TerminalPalette } from '@shared/theme'
import { looksLikeSecretPrompt, stripAnsi } from '@shared/secrets'
import { renderBufferAsHtml } from './serialize'
import { useStore } from '../state/store'
import { DEFAULT_THEME, toXtermTheme } from './theme'

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
      scrollback: 5000,
      theme: toXtermTheme(palette),
      // Reported to programs so they enable colour and mouse handling.
      windowsPty: { backend: 'conpty' }
    })

    this.term.loadAddon(this.fit)
    this.term.loadAddon(new WebLinksAddon())

    const unicode = new Unicode11Addon()
    this.term.loadAddon(unicode)
    this.term.unicode.activeVersion = '11'

    this.renderTerm = new Terminal({
      allowProposedApi: true,
      cols: 120,
      rows: 200,
      scrollback: 5000,
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

  private appendCapture(chunk: string): void {
    if (chunk.length === 0) return
    this.capture += chunk
    // Bound one command's output; a huge log would blow up the serialize pass.
    if (this.capture.length > 2_000_000) this.capture = this.capture.slice(-2_000_000)
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
      return renderBufferAsHtml(this.renderTerm, this.palette)
    } catch {
      // Rendering must never lose the block; fall back to plain text.
      return `<span>${escapeHtml(this.renderTerm.buffer.active.getLine(0)?.translateToString(true) ?? '')}</span>`
    }
  }

  private async finishBlock(exitCode: number): Promise<void> {
    this.capturing = false
    const blockId = this.currentBlockId
    this.currentBlockId = null
    if (!blockId) return

    const interactive = this.sawAltScreen
    const output = interactive ? '' : await this.renderCapture()
    this.capture = ''

    const pane = this.store().terminalPane(this.paneId)
    const block = pane?.blocks.find((b) => b.id === blockId)

    const durationMs = block ? Date.now() - block.startedAt : null

    this.store().patchBlock(this.paneId, blockId, {
      output,
      interactive,
      status: exitCode === 0 ? 'done' : 'failed',
      exitCode,
      durationMs
    })

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
    }

    // Reset the live view so the next command starts on a clean screen. Deferred
    // out of the parser callback to avoid writing while the stream is mid-parse.
    queueMicrotask(() => {
      this.term.write('\x1b[H\x1b[2J\x1b[3J')
    })
  }

  attach(container: HTMLElement): void {
    this.term.open(container)
    this.enableWebgl()
    this.refit()

    if (!this.spawned) {
      this.spawned = true
      this.watchForIntegration()
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
            this.term.write(`\r\n\x1b[31m${res.error ?? 'Failed to start shell.'}\x1b[0m\r\n`)
          }
        })
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
      const rows = Math.max(Number.isFinite(dims?.rows) ? (dims?.rows as number) : 0, 24)
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
const registry = new Map<string, TerminalController>()

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
  // here rather than leaving it running for the life of the window.
  const running = store.terminalPane(paneId)?.blocks.find((b) => b.status === 'running')
  if (running) {
    store.patchBlock(paneId, running.id, {
      status: 'failed',
      exitCode,
      durationMs: Date.now() - running.startedAt
    })
  }
})
