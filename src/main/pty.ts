import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { ShellProfile, SpawnRequest } from '../shared/types.js'

interface Session {
  pty: IPty
  profile: ShellProfile
  /**
   * This shell's proof that a marker came from it.
   *
   * Sixteen random bytes, handed over in the environment and never written down
   * anywhere else. The renderer asks for it by pane and refuses Ember's own
   * markers that do not carry it, which is what stops a line of output moving the
   * pane or renaming a block.
   */
  nonce: string
  /** Characters sent to the renderer and not yet acknowledged as parsed. */
  pending: number
  /** Whether the pty's read side is currently held shut. */
  paused: boolean
  /**
   * The window that owned this went away — a reload, or a renderer that died.
   *
   * The shell is left running for a moment so the renderer coming up can claim it.
   * Nothing else changes: output still flows to whoever owns the pane, which is
   * how a moved session keeps its stream.
   */
  detached: boolean
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

  /**
   * The window that owned these has gone; hold their shells for whoever comes up.
   *
   * Called when a renderer navigates away or dies. Nothing is killed here: a
   * reload takes a second or two, and killing a dev server because the window
   * that was showing it blinked is exactly the behaviour this replaces.
   */
  detach(paneIds: string[]): void {
    for (const id of paneIds) {
      const session = this.sessions.get(id)
      if (session) session.detached = true
    }
  }

  /**
   * A new renderer claiming panes it found in its own saved workspace. Answers
   * with the ones that really are still running, which is what it may skip
   * spawning for.
   */
  adopt(paneIds: string[]): string[] {
    const taken: string[] = []
    for (const id of paneIds) {
      const session = this.sessions.get(id)
      if (!session) continue
      session.detached = false
      taken.push(id)
    }
    return taken
  }

  /** Every pane still holding a shell nobody has claimed. */
  orphans(): string[] {
    return [...this.sessions.entries()].filter(([, s]) => s.detached).map(([id]) => id)
  }

  /** A shell's nonce, for the window that has to check its markers. */
  nonceFor(paneId: string): string | null {
    return this.sessions.get(paneId)?.nonce ?? null
  }

  spawn(req: SpawnRequest, profile: ShellProfile, opts: { typedFallback?: boolean } = {}): void {
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
     * The nonce goes in the environment, which is the one channel a shell has that
     * its own output cannot reach. Anything already inside this process tree can
     * read it, and that is fine: something running in the shell is past every
     * boundary this could defend anyway. What it stops is the ordinary case — a
     * file, a log, a README, a git branch name printed to the screen.
     */
    const nonce = randomBytes(16).toString('hex')
    env.EMBER_NONCE = nonce

    /*
     * A Windows path that is not there falls back to home: a typo'd "Start in"
     * or a since-deleted directory should open a shell, not a dead pane. Paths
     * that are not Windows-shaped (a WSL /home) pass through untouched — they
     * are the guest shell's business, not this filesystem's.
     */
    let cwd = req.cwd && req.cwd.length > 0 ? req.cwd : app.getPath('home')
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(cwd) && !existsSync(cwd)) cwd = app.getPath('home')

    const loading = this.loadingFor(profile, opts.typedFallback === true)
    const pty = ptySpawn(profile.path, loading.args, {
      cols: Math.max(req.cols, 2),
      rows: Math.max(req.rows, 1),
      cwd,
      env,
      useConpty: true
    })

    const session: Session = {
      pty,
      profile,
      nonce,
      pending: 0,
      paused: false,
      pausedCount: 0,
      detached: false
    }
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
      /*
       * Only if this is still the session for that pane.
       *
       * A shell killed to make way for another one exits a moment later, and its
       * exit arrived addressed to the pane rather than to itself — so the pane that
       * had just started a replacement was told its shell had died, and the live
       * one was deleted from the map underneath it. The old shell's last word is
       * not about the new shell.
       */
      if (this.sessions.get(req.paneId) !== session) return
      this.sessions.delete(req.paneId)
      this.onExit(req.paneId, exitCode)
    })

    if (loading.typed) this.injectIntegration(pty, profile)
  }

  /**
   * How this shell is given its integration, and what it is started with.
   *
   * Typing `. 'x.ps1'` into the shell — which is what this did — has three faults
   * and they are all the same fault: it is input. A Restricted execution policy
   * refuses to run the file, so the machines most likely to be managed were the
   * ones with no blocks at all; the line lands in Get-History, where nobody put
   * it; and it races the first prompt, so it arrives in the middle of whatever the
   * profile was printing.
   *
   * An encoded command is none of those. It is not a file, so no policy applies to
   * it; it is not input, so no history records it; and PowerShell runs it after
   * the user's own profile, which is the order that was wanted all along.
   */
  private loadingFor(
    profile: ShellProfile,
    typedFallback: boolean
  ): { args: string[]; typed: boolean } {
    if (profile.integration === 'none') return { args: profile.args, typed: false }
    // The way out, for one release: a shell that will not take the new loading can
    // be put back on the old by a setting rather than by a new build.
    if (typedFallback) return { args: profile.args, typed: true }

    if (profile.integration === 'powershell') {
      const encoded = this.encodedScript('integration.ps1')
      if (encoded) return { args: [...profile.args, '-NoExit', '-EncodedCommand', encoded], typed: false }
      return { args: profile.args, typed: true }
    }

    /*
     * bash only where bash is what is being started. WSL's profile runs wsl.exe,
     * whose arguments are its own and not the shell's — `--rcfile` handed to it is
     * a distro name it cannot find — so that one keeps the old loading.
     */
    if (profile.integration === 'bash' && /bash(\.exe)?$/i.test(profile.path)) {
      const rc = this.bashRcFile(profile)
      if (rc) return { args: ['--rcfile', rc, '-i'], typed: false }
    }
    return { args: profile.args, typed: true }
  }

  /** The PowerShell script as an encoded command: UTF-16LE, base64, as the flag wants it. */
  private encodedScript(name: string): string | null {
    try {
      const body = readFileSync(this.resourcePath('shell-integration', name), 'utf8')
      return Buffer.from(body, 'utf16le').toString('base64')
    } catch {
      return null
    }
  }

  /**
   * An rcfile for bash that keeps everything the shell would have loaded anyway.
   *
   * `--rcfile` is ignored by a login shell, and Git Bash starts as one — so this
   * takes over the whole chain rather than adding to it: the system profile, then
   * the user's own files in the order bash reads them, then Ember's script. Doing
   * less than that would silently cost a Git Bash user their PATH.
   */
  private bashRcFile(profile: ShellProfile): string | null {
    try {
      const script = this.resourcePath('shell-integration', 'integration.bash')
      const posix = (p: string): string =>
        p.replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, '/')
      const login = profile.args.some((a) => a === '--login' || a === '-l')
      const lines = [
        '# Written by Ember for this shell only.',
        'if [ -f /etc/profile ]; then . /etc/profile; fi'
      ]
      if (login) {
        lines.push(
          'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile";',
          'elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login";',
          'elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile"; fi'
        )
      } else {
        lines.push('if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi')
      }
      lines.push(`. '${posix(script)}'`, '')
      const dir = mkdtempSync(join(tmpdir(), 'ember-rc-'))
      const file = join(dir, 'ember-bashrc')
      writeFileSync(file, lines.join('\n'), 'utf8')
      return posix(file)
    } catch {
      return null
    }
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
  /**
   * The old loading, kept as the way back for one release: the script typed into
   * the shell as a command. Reached only by the fallback setting, or by a shell
   * the new loading cannot be applied to — WSL, and anything whose script is
   * missing from the install.
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
