import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { ShellProfile, SpawnRequest } from '../shared/types.js'

interface Session {
  pty: IPty
  profile: ShellProfile
}

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
    private onExit: ExitSink
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

    const pty = ptySpawn(profile.path, profile.args, {
      cols: Math.max(req.cols, 2),
      rows: Math.max(req.rows, 1),
      cwd: req.cwd && req.cwd.length > 0 ? req.cwd : app.getPath('home'),
      env,
      useConpty: true
    })

    const session: Session = { pty, profile }
    this.sessions.set(req.paneId, session)

    pty.onData((d) => this.onData(req.paneId, d))
    pty.onExit(({ exitCode }) => {
      this.sessions.delete(req.paneId)
      this.onExit(req.paneId, exitCode)
    })

    this.injectIntegration(pty, profile)
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
