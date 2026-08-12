import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SerializeAddon } from '@xterm/addon-serialize'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import type { TerminalPalette } from '@shared/theme'
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
  private serialize = new SerializeAddon()

  /** Offscreen terminal used only to render captured output into HTML. */
  private renderTerm: Terminal
  private renderSerialize = new SerializeAddon()

  private capture = ''
  private capturing = false
  /** Holds back a few bytes so a marker split across pty chunks is still found. */
  private carry = ''
  private currentBlockId: string | null = null
  private pendingCommand: string | null = null
  private sawAltScreen = false
  private disposers: (() => void)[] = []
  private spawned = false

  constructor(
    private paneId: string,
    fontFamily: string,
    fontSize: number,
    palette: TerminalPalette = DEFAULT_THEME.terminal
  ) {
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
    this.term.loadAddon(this.serialize)
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
    this.renderTerm.loadAddon(this.renderSerialize)

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

  private handleSemanticPrompt(data: string): void {
    const [kind, ...rest] = data.split(';')

    if (kind === 'C') {
      // Output begins. The splitter in `feedCapture` owns the buffer itself; this
      // only handles the block's lifecycle.
      this.sawAltScreen = false

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
      this.store().patchPane(this.paneId, { integrationReady: true })
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

  /**
   * The serializer emits one `<div>` per terminal row, every row padded with
   * spaces out to the full width and the unused rows of the grid included. Trim
   * that back to the rows that actually hold output so blocks size themselves to
   * their content and "copy output" yields clean text.
   */
  private tidyRows(html: string): string {
    const wrap = document.createElement('div')
    wrap.innerHTML = html

    const rows = Array.from(wrap.children) as HTMLElement[]
    let first = 0
    let last = rows.length - 1
    while (first <= last && !rows[first].textContent?.trim()) first++
    while (last >= first && !rows[last].textContent?.trim()) last--
    if (last < first) return ''

    const kept = rows.slice(first, last + 1)
    for (const row of kept) {
      // Right-trim only the final span, so interior alignment is preserved.
      const spans = row.querySelectorAll('span')
      const tail = spans[spans.length - 1]
      if (tail?.textContent) tail.textContent = tail.textContent.replace(/\s+$/, '')
    }

    return kept.map((r) => r.outerHTML).join('')
  }

  /** Feed captured bytes through the offscreen terminal and serialize the result. */
  private async renderCapture(): Promise<string> {
    const bytes = this.capture
    if (bytes.trim().length === 0) return ''

    this.renderTerm.reset()
    this.renderTerm.resize(Math.max(this.term.cols, 20), this.renderTerm.rows)

    await new Promise<void>((resolve) => this.renderTerm.write(bytes, resolve))

    try {
      const html = this.renderSerialize.serializeAsHTML({ onlySelection: false })
      // Keep only the inner markup; the addon wraps output in its own container
      // whose styling would fight the block layout.
      const match = html.match(/<div[^>]*>([\s\S]*)<\/div>/)
      return this.tidyRows(match ? match[1] : html)
    } catch {
      // If HTML serialization is unavailable, fall back to plain text so the
      // block still shows something useful.
      const plain = this.renderSerialize.serialize()
      return `<span>${escapeHtml(plain)}</span>`
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

    this.store().patchBlock(this.paneId, blockId, {
      output,
      interactive,
      status: exitCode === 0 ? 'done' : 'failed',
      exitCode,
      durationMs: block ? Date.now() - block.startedAt : null
    })

    // Reset the live view so the next command starts on a clean screen. Deferred
    // out of the parser callback to avoid writing while the stream is mid-parse.
    queueMicrotask(() => {
      this.term.write('\x1b[H\x1b[2J\x1b[3J')
    })
  }

  attach(container: HTMLElement): void {
    this.term.open(container)
    this.refit()

    if (!this.spawned) {
      this.spawned = true
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

  /** Called from the pane's pty data subscription. */
  write(data: string): void {
    // Order matters: the capture must be sliced before xterm parses the markers
    // and fires finishBlock.
    this.feedCapture(data)
    this.term.write(data)
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
    this.currentBlockId = this.store().beginBlock(this.paneId, trimmed)
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
  useStore.getState().patchPane(paneId, { exited: true, exitCode, mode: 'blocks' })
})
