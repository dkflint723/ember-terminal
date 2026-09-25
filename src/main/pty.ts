import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { unsupportedShellOf } from '../shared/quote.js'
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
    // Whatever the loading needs in the environment — today only WSLENV, which is
    // how anything at all crosses into a distro.
    if (loading.env) Object.assign(env, loading.env)
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
      this.unreaped.delete(pty.pid)
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
  ): { args: string[]; typed: boolean; env?: Record<string, string> } {
    if (profile.integration === 'none') return { args: profile.args, typed: false }
    // A shell there is no script for gets no script: bash typed into zsh is at
    // best ignored by its own guard and at worst a screen of syntax errors.
    if (unsupportedShellOf(profile)) return { args: profile.args, typed: false }

    /*
     * The nonce has to be told to cross into a distro.
     *
     * WSL does not hand the Windows environment to the guest: only the variables
     * named in WSLENV go over. EMBER_NONCE was not one of them, so every signed
     * marker a WSL pane sent was dropped on arrival for carrying no nonce — which
     * is why WSL has only ever reached "integrated" on the unsigned OSC 133
     * markers, with its directory and its command line discarded in silence.
     *
     * Decided before the fallback below returns, because the old typed loading
     * needs the nonce across just as much as the new one does: a rollback to
     * something that never worked is not a rollback.
     */
    const isWsl = profile.integration === 'bash' && /wsl(\.exe)?$/i.test(profile.path)
    const wslEnv = (extra: Record<string, string>): Record<string, string> => {
      const names = ['EMBER_NONCE']
      // `/p` is WSL's own path translation: the guest sees /mnt/c/... for what
      // this side wrote to C:\, spaces and all.
      if ('EMBER_RC' in extra) names.push('EMBER_RC/p')
      const already = process.env.WSLENV
      return { ...extra, WSLENV: already ? `${already}:${names.join(':')}` : names.join(':') }
    }

    // The way out, for one release: a shell that will not take the new loading can
    // be put back on the old by a setting rather than by a new build.
    if (typedFallback) {
      return { args: profile.args, typed: true, env: isWsl ? wslEnv({}) : undefined }
    }

    if (profile.integration === 'powershell') {
      const encoded = this.encodedScript('integration.ps1')
      if (encoded) return { args: [...profile.args, '-NoExit', '-EncodedCommand', encoded], typed: false }
      return { args: profile.args, typed: true }
    }

    // bash where bash is what is being started: the rc file is the shell's own
    // argument, and the path it is handed is the one MSYS understands.
    if (profile.integration === 'bash' && /bash(\.exe)?$/i.test(profile.path)) {
      const rc = this.bashRcFile(profile, {
        login: profile.args.some((a) => a === '--login' || a === '-l'),
        guest: 'msys'
      })
      if (rc) return { args: ['--rcfile', rc.guestPath, '-i'], typed: false }
    }

    /*
     * WSL, which reaches a shell through wsl.exe rather than being one.
     *
     * `wsl.exe -- <command>` is not the way in. It runs the command through the
     * distro's login shell, so the string is parsed twice: a variable reference
     * or a bracket in it arrives mangled, or — worse, because it reads as having
     * worked — silently emptied. `-e` execs the argv it is given and nothing else.
     *
     * The boot picks the shell rather than assuming one. A distro whose user runs
     * zsh or fish gets that shell, as a login shell, exactly as a bare `wsl.exe`
     * would have given them: losing integration, which they never had, rather than
     * losing their shell. And the rc file is tested before it is used, because
     * bash starts silently and successfully with an unreadable `--rcfile` — and
     * what it starts is a shell with none of the user's aliases, prompt or
     * completions in it.
     */
    if (isWsl) {
      const rc = this.bashRcFile(profile, { login: true, guest: 'wsl' })
      if (rc) {
        const boot =
          'shell="$(getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7)"; ' +
          'case "$shell" in ' +
          '*/bash|"") [ -r "$EMBER_RC" ] && exec bash --rcfile "$EMBER_RC" -i ;; ' +
          '*) [ -x "$shell" ] && exec "$shell" -l ;; ' +
          'esac; exec bash -l'
        return {
          args: [...profile.args, '-e', 'sh', '-c', boot],
          typed: false,
          env: wslEnv({ EMBER_RC: rc.hostPath })
        }
      }
    }

    return { args: profile.args, typed: true, env: isWsl ? wslEnv({}) : undefined }
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
  private bashRcFile(
    profile: ShellProfile,
    opts: { login: boolean; guest: 'msys' | 'wsl' }
  ): { hostPath: string; guestPath: string } | null {
    try {
      const script = this.resourcePath('shell-integration', 'integration.bash')
      /*
       * The same drive, spelled the way this guest spells it. Git Bash's MSYS root
       * puts C: at /c; a WSL distro mounts it at /mnt/c. A path in the other one's
       * shape is not a path the guest can open, and `.` on a file that is not
       * there is a silent no-op — the shell would come up looking perfectly
       * ordinary with no integration in it whatsoever.
       */
      const mount = opts.guest === 'wsl' ? '/mnt/' : '/'
      const posix = (p: string): string =>
        p
          .replace(/^([A-Za-z]):/, (_m, d: string) => `${mount}${d.toLowerCase()}`)
          .replace(/\\/g, '/')
      const lines = [
        '# Written by Ember for this shell only.',
        'if [ -f /etc/profile ]; then . /etc/profile; fi'
      ]
      if (opts.login) {
        /*
         * The chain a login shell reads — and then the file it does not.
         *
         * bash stops at the first of these that exists, so a user whose only file
         * is .bashrc, which the login chain never reads, got a shell with none of
         * their own setup in it. That is the ordinary shape on a distro where
         * something else has always been starting the login shell.
         */
        lines.push(
          'if [ -f "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile";',
          'elif [ -f "$HOME/.bash_login" ]; then . "$HOME/.bash_login";',
          'elif [ -f "$HOME/.profile" ]; then . "$HOME/.profile";',
          'elif [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi'
        )
      } else {
        lines.push('if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi')
      }
      lines.push(`. '${posix(script)}'`, '')
      const dir = mkdtempSync(join(tmpdir(), 'ember-rc-'))
      const file = join(dir, 'ember-bashrc')
      // Written LF and without a byte-order mark. The guest reads this as a shell
      // script, and a stray CR or a BOM is syntax to it.
      writeFileSync(file, lines.join('\n'), { encoding: 'utf8' })
      return { hostPath: file, guestPath: posix(file) }
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
    // Remembered until its exit arrives: see endEveryShell.
    if (s.pty.pid > 0) this.unreaped.add(s.pty.pid)
    try {
      s.pty.kill()
    } catch {
      // Already gone.
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id)
  }

  /**
   * Shells told to end whose exit has not yet arrived, by process id. An id leaves
   * this set when the exit does, about a second after the process ends — node-pty
   * waits that long for the last of its output.
   */
  private unreaped = new Set<number>()

  /** How many shells are running, or were told to end and have not been heard to. */
  get shellsLeft(): number {
    return this.sessions.size + this.unreaped.size
  }

  /*
   * Every shell ended, and heard to end, while there is still someone to hear it.
   *
   * node-pty waits for each shell on a thread of its own and reports the exit to
   * JavaScript. Quitting ended the shells and let the process go at once, so the
   * exits were still in flight when node tore itself down, and the runner caught
   * both ways that goes wrong. A shell that had not died yet — Command Prompt, in
   * one quit in eleven or so — kept main joining that thread in node's teardown for
   * as long as it lived: the window gone, and Ember running on with nothing to
   * show for it and the single-instance lock still held, so it could not even be
   * opened again. A shell that died a moment too late had its exit delivered once
   * JavaScript could no longer run, and node-pty threw from inside the delivery:
   * about one quit in eight with bash and PowerShell open ended in a crash dump.
   *
   * So quitting stops here first. Every shell still running is killed, every one
   * already told to end is ended outright, not left to its console closing, and
   * quitting waits until each exit has arrived. Bounded, because this is the one
   * step of quitting that must never be what waits.
   */
  async endEveryShell(ms = 3_000): Promise<void> {
    this.killAll()
    for (const pid of this.unreaped) {
      try {
        process.kill(pid)
      } catch {
        // Gone already; its exit is on the way.
      }
    }
    const until = Date.now() + ms
    while (this.unreaped.size > 0 && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}
