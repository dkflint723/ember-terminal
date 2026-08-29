import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ShellProfile, SpawnRequest } from '../shared/types.js'

interface Session {
  pty: IPty
  profile: ShellProfile
  /** Characters sent to the renderer and not yet acknowledged as parsed. */
  pending: number
  /** Whether the pty's read side is currently held shut. */
  paused: boolean
  /** How many times the valve has closed — read by the flood verification. */
  pausedCount: number
}

/*
 * Flow control between a shell that can write megabytes a second and a renderer
 * that has to parse every byte of it. Without a valve, a flooding command just
 * queues its output in the renderer until typing and painting crawl. The pty is
 * paused once a window of output is in flight unparsed, and resumed when the
 * renderer has chewed back below half of it — the shell blocks on its own
 * stdout for the difference, which is exactly what a slow physical terminal
 * has always made programs do.
 *
 * The window is overridable from the environment so the verification suite can
 * make a modest flood engage the valve deterministically; real runs never set it.
 */
const FLOW_HIGH = Math.max(16_384, Number(process.env.EMBER_FLOW_HIGH) || 1_048_576)
const FLOW_LOW = Math.floor(FLOW_HIGH / 2)

type DataSink = (paneId: string, data: string) => void
type ExitSink = (paneId: string, exitCode: number) => void

/**
 * Owns every live pty. Panes are addressed by id so the renderer never holds a
 * handle to a native object.
 */
export class PtyManager {
  private sessions = new Map<string, Session>()

  constructor(
    private onData: DataSink,
    private onExit: ExitSink,
    /**
     * Extra environment for every shell. Used to tell a Claude Code CLI started in
     * one of these panes which IDE it is inside — read lazily, because the port is
     * only known once the server is listening, and panes outlive a restart of it.
     */
    private extraEnv: () => Record<string, string> = () => ({})
  ) {}

  private resourcePath(...parts: string[]): string {
    // Packaged builds put `resources/` next to the asar; dev runs from source.
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    return join(base, 'resources', ...parts)
  }

  spawn(req: SpawnRequest, profile: ShellProfile): void {
    this.kill(req.paneId)

    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') env[k] = v
    }
    // Advertise capabilities the way a modern xterm would, so programs enable
    // colour and hyperlinks without extra configuration.
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Ember'
    env.TERM_PROGRAM_VERSION = app.getVersion()
    Object.assign(env, this.extraEnv())

    /*
     * A Windows path that is not there falls back to home: a typo'd "Start in"
     * or a since-deleted directory should open a shell, not a dead pane. Paths
     * that are not Windows-shaped (a WSL /home) pass through untouched — they
     * are the guest shell's business, not this filesystem's.
     */
    let cwd = req.cwd && req.cwd.length > 0 ? req.cwd : app.getPath('home')
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd) && !existsSync(cwd)) cwd = app.getPath('home')

    const pty = ptySpawn(profile.path, profile.args, {
      cols: Math.max(req.cols, 2),
      rows: Math.max(req.rows, 1),
      cwd,
      env,
      useConpty: true
    })

    const session: Session = { pty, profile, pending: 0, paused: false, pausedCount: 0 }
    this.sessions.set(req.paneId, session)

    pty.onData((d) => {
      session.pending += d.length
      if (!session.paused && session.pending > FLOW_HIGH) {
        session.paused = true
        session.pausedCount += 1
        pty.pause()
      }
      this.onData(req.paneId, d)
    })
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(req.paneId)
      this.onExit(req.paneId, exitCode)
    })

    this.injectIntegration(pty, profile)
  }

  /** The renderer has parsed this many more characters; maybe reopen the valve. */
  ack(paneId: string, parsed: number): void {
    const session = this.sessions.get(paneId)
    if (!session || !Number.isFinite(parsed) || parsed <= 0) return
    session.pending = Math.max(0, session.pending - parsed)
    if (session.paused && session.pending < FLOW_LOW) {
      session.paused = false
      session.pty.resume()
    }
  }

  /** The valve's book-keeping, per pane — the flood suite's only window in. */
  flowStats(): Record<string, { pending: number; paused: boolean; pausedCount: number }> {
    const out: Record<string, { pending: number; paused: boolean; pausedCount: number }> = {}
    for (const [paneId, s] of this.sessions) {
      out[paneId] = { pending: s.pending, paused: s.paused, pausedCount: s.pausedCount }
    }
    return out
  }

  /**
   * Source the integration script inside the freshly started shell. We write a
   * dot-source command rather than passing init flags so the user's own profile
   * still loads normally.
   */
  private injectIntegration(pty: IPty, profile: ShellProfile): void {
    if (profile.integration === 'none') return

    const file =
      profile.integration === 'powershell'
        ? this.resourcePath('shell-integration', 'integration.ps1')
        : this.resourcePath('shell-integration', 'integration.bash')

    // Give the shell a beat to finish printing its first prompt, otherwise the
    // injected line can interleave with startup output.
    setTimeout(() => {
      try {
        if (profile.integration === 'powershell') {
          pty.write(`. '${file.replace(/'/g, "''")}'\r`)
        } else {
          // Inline the script: a Git Bash pty sees Windows paths that its own
          // `source` cannot always resolve, so feed the body through stdin.
          const body = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
          const b64 = Buffer.from(body, 'utf8').toString('base64')
          pty.write(`eval "$(echo ${b64} | base64 -d)"\n`)
        }
      } catch {
        // A missing integration script is not fatal; the pane still works, it
        // just falls back to a plain stream with no command blocks.
      }
    }, 250)
  }

  write(paneId: string, data: string): void {
    this.sessions.get(paneId)?.pty.write(data)
  }

  resize(paneId: string, cols: number, rows: number): void {
    const s = this.sessions.get(paneId)
    if (!s) return
    try {
      s.pty.resize(Math.max(cols, 2), Math.max(rows, 1))
    } catch {
      // Resizing a pty that exited between the check and the call throws; the
      // exit handler will clean the session up momentarily.
    }
  }

  kill(paneId: string): void {
    const s = this.sessions.get(paneId)
    if (!s) return
    this.sessions.delete(paneId)
    try {
      s.pty.kill()
    } catch {
      // Already gone.
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }
}
