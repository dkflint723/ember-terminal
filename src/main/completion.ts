import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  CompletionItem,
  CompletionRequest,
  CompletionResult,
  ShellProfile
} from '../shared/types.js'

const EMPTY: CompletionResult = { replaceIndex: 0, replaceLength: 0, items: [], source: 'none' }

/** How long to wait for a backend before giving up on a keystroke. */
const TIMEOUT_MS = 1500

interface Pending {
  resolve: (r: CompletionResult) => void
  timer: NodeJS.Timeout
}

/**
 * Keeps a PowerShell process alive to answer completion queries.
 *
 * A fresh `pwsh` per keystroke costs several hundred milliseconds of startup,
 * which is far too slow to sit behind the Tab key, so the process is long-lived
 * and speaks a line-delimited JSON protocol.
 */
class PowerShellCompleter {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private buffer = ''
  private nextId = 1
  private pending = new Map<number, Pending>()
  private failed = false

  constructor(private exePath: string) {}

  private scriptPath(): string {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    return join(base, 'resources', 'completion', 'pwsh-completer.ps1')
  }

  private start(): void {
    if (this.child || this.failed) return
    try {
      this.child = spawn(
        this.exePath,
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          this.scriptPath()
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }
      )
    } catch {
      this.failed = true
      return
    }

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.onData(chunk))

    // Never let a dead helper strand callers; fail them and allow a restart.
    const die = (): void => {
      this.child = null
      this.ready = false
      this.buffer = ''
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer)
        p.resolve(EMPTY)
        this.pending.delete(id)
      }
    }
    this.child.on('exit', die)
    this.child.on('error', () => {
      this.failed = true
      die()
    })
    // Drain stderr so a chatty helper cannot fill its pipe buffer and block.
    this.child.stderr.resume()
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > 0) this.onLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  private onLine(line: string): void {
    let msg: {
      type?: string
      id?: number
      replaceIndex?: number
      replaceLength?: number
      matches?: { text?: string; label?: string; type?: string; tip?: string }[]
      error?: string
    }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }

    if (msg.type === 'ready') {
      this.ready = true
      return
    }
    if (typeof msg.id !== 'number') return

    const pending = this.pending.get(msg.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(msg.id)

    const items: CompletionItem[] = (msg.matches ?? [])
      .filter((m): m is { text: string } & typeof m => typeof m.text === 'string')
      .map((m) => ({
        text: m.text,
        label: m.label && m.label.length > 0 ? m.label : m.text,
        type: m.type ?? 'Text',
        tip: m.tip
      }))

    pending.resolve({
      replaceIndex: msg.replaceIndex ?? 0,
      replaceLength: msg.replaceLength ?? 0,
      items,
      source: 'powershell',
      error: msg.error
    })
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.start()
    if (!this.child || this.failed) return EMPTY

    // The helper announces readiness; wait briefly on a cold start.
    if (!this.ready) {
      const readyAt = Date.now() + 4000
      while (!this.ready && Date.now() < readyAt && this.child) {
        await new Promise((r) => setTimeout(r, 40))
      }
      if (!this.ready) return EMPTY
    }

    const id = this.nextId++
    const payload = JSON.stringify({ id, cwd: req.cwd, input: req.input, cursor: req.cursor })

    return new Promise<CompletionResult>((resolveResult) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolveResult(EMPTY)
      }, TIMEOUT_MS)
      this.pending.set(id, { resolve: resolveResult, timer })

      try {
        this.child?.stdin.write(`${payload}\n`)
      } catch {
        clearTimeout(timer)
        this.pending.delete(id)
        resolveResult(EMPTY)
      }
    })
  }

  dispose(): void {
    try {
      this.child?.stdin.end()
      this.child?.kill()
    } catch {
      // Already gone.
    }
    this.child = null
  }
}

/**
 * Shell-agnostic completion for panes with no native backend (bash, cmd, wsl).
 * Covers the two cases that dominate real use — paths and executable names —
 * without pretending to know a shell's parameter grammar.
 */
class GenericCompleter {
  private commandCache: string[] | null = null

  private async executables(): Promise<string[]> {
    if (this.commandCache) return this.commandCache

    const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
      .split(';')
      .filter(Boolean)
      .map((e) => e.toLowerCase())
    const dirs = (process.env.PATH ?? '').split(';').filter(Boolean)
    const found = new Set<string>()

    await Promise.all(
      dirs.map(async (dir) => {
        try {
          for (const name of await readdir(dir)) {
            const lower = name.toLowerCase()
            const ext = exts.find((e) => lower.endsWith(e))
            if (ext) found.add(name.slice(0, name.length - ext.length))
          }
        } catch {
          // Unreadable PATH entries are normal; skip them.
        }
      })
    )

    this.commandCache = [...found].sort((a, b) => a.localeCompare(b))
    return this.commandCache
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const upToCursor = req.input.slice(0, req.cursor)
    // Split on whitespace that is not inside quotes, crudely: last unquoted space.
    const match = /(^|\s)("[^"]*|'[^']*|[^\s]*)$/.exec(upToCursor)
    const token = match ? match[2] : ''
    const replaceIndex = req.cursor - token.length
    const quote = token.startsWith('"') || token.startsWith("'") ? token[0] : ''
    const bare = quote ? token.slice(1) : token

    // The first token on the line is a command; anything later is likely a path.
    const isFirstToken = upToCursor.slice(0, replaceIndex).trim().length === 0
    const items: CompletionItem[] = []

    if (isFirstToken && !bare.includes('/') && !bare.includes('\\')) {
      const lower = bare.toLowerCase()
      for (const name of await this.executables()) {
        if (name.toLowerCase().startsWith(lower)) {
          items.push({ text: name, label: name, type: 'Command' })
        }
        if (items.length >= 200) break
      }
    }

    // Path completion, relative to the pane's directory.
    try {
      const hasSep = /[\\/]/.test(bare)
      const dirPart = hasSep ? bare.slice(0, Math.max(bare.lastIndexOf('\\'), bare.lastIndexOf('/')) + 1) : ''
      const namePart = hasSep ? bare.slice(dirPart.length) : bare
      const searchDir = isAbsolute(dirPart || bare)
        ? dirPart || dirname(bare)
        : resolve(req.cwd, dirPart)

      const entries = await readdir(searchDir, { withFileTypes: true })
      const lower = namePart.toLowerCase()
      for (const entry of entries) {
        if (!entry.name.toLowerCase().startsWith(lower)) continue
        let isDir = entry.isDirectory()
        if (entry.isSymbolicLink()) {
          try {
            isDir = (await stat(join(searchDir, entry.name))).isDirectory()
          } catch {
            isDir = false
          }
        }
        const text = `${dirPart}${entry.name}${isDir ? '\\' : ''}`
        items.push({
          text,
          label: `${entry.name}${isDir ? '\\' : ''}`,
          type: isDir ? 'ProviderContainer' : 'ProviderItem'
        })
        if (items.length >= 400) break
      }
    } catch {
      // Not a readable directory; command matches alone are still useful.
    }

    return {
      replaceIndex: replaceIndex - (quote ? 1 : 0),
      replaceLength: token.length + (quote ? 1 : 0),
      items,
      source: 'generic'
    }
  }
}

/** Routes a completion request to the best backend for the pane's shell. */
export class CompletionService {
  private powershell = new Map<string, PowerShellCompleter>()
  private generic = new GenericCompleter()

  constructor(private profiles: ShellProfile[]) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const profile = this.profiles.find((p) => p.id === req.profileId)

    if (profile && profile.integration === 'powershell') {
      let completer = this.powershell.get(profile.id)
      if (!completer) {
        completer = new PowerShellCompleter(profile.path)
        this.powershell.set(profile.id, completer)
      }
      const result = await completer.complete(req)
      // Fall through to the generic backend if the helper could not answer, so
      // Tab still does something useful.
      if (result.items.length > 0) return result
    }

    return this.generic.complete(req)
  }

  dispose(): void {
    for (const c of this.powershell.values()) c.dispose()
    this.powershell.clear()
  }
}
