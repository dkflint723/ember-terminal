import { execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeAccess } from '../shared/types.js'

/**
 * Ask Claude through the Claude Code CLI, using the login the user already has.
 *
 * The same bargain as `gh` in github.ts: the CLI already holds the credential,
 * already refreshes it, and already knows how the user signed in. Reimplementing
 * that here would mean owning a token, and owning a token badly — Claude Code's
 * grant is short-lived, and two processes refreshing the same one is how a user
 * ends up mysteriously logged out of the tool they were using.
 *
 * It is also the only honest answer to "let me sign in with a browser": there is no
 * per-application OAuth client to register for, so the browser login that exists is
 * `claude auth login`, and this reuses its result.
 *
 * The cost is real and worth stating: a CLI call carries Claude Code's own system
 * prompt, so it is slower and bills against the user's Claude subscription rather
 * than API credits. An explicit API key still wins when there is one, because it
 * also buys structured outputs, which this path cannot have.
 */
export class ClaudeCliService {
  /** Resolved once per launch. Looking for a binary on every keystroke is waste. */
  private cached: ClaudeAccess | null = null

  /** The CLI, and anything before its own arguments: a test runs a stand-in through node. */
  private command: string
  private prefix: string[]

  constructor(command = 'claude', prefix: string[] = []) {
    this.command = command
    this.prefix = prefix
    sweepLeftovers()
  }

  private exec(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.command,
        [...this.prefix, ...args],
        { env: cliEnv(), timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(error, { stdout, stderr }))
          else resolve({ stdout, stderr })
        }
      )

      /*
       * Nothing is being piped in, so say so immediately.
       *
       * execFile leaves stdin an open pipe that is never written to. The CLI waits
       * three seconds for something to arrive on it, gives up, and prints a warning
       * about the wait — into the same stream this reads the answer from. So every
       * request through this path came back as that warning: asking Claude while
       * signed in through the browser, rather than with a key, failed outright and
       * blamed the model for not returning a command.
       */
      child.stdin?.end()
    })
  }

  /** Who the CLI thinks it is, or why it cannot say. */
  async access(refresh = false): Promise<ClaudeAccess> {
    if (this.cached && !refresh) return this.cached

    let result: ClaudeAccess
    try {
      const { stdout } = await this.exec(['auth', 'status'], 20_000)
      const parsed = JSON.parse(stdout) as {
        loggedIn?: boolean
        authMethod?: string
        email?: string
        subscriptionType?: string
      }
      result = {
        installed: true,
        signedIn: parsed.loggedIn === true,
        account: parsed.email ?? null,
        plan: parsed.subscriptionType ?? null,
        error: parsed.loggedIn === true ? null : 'Signed out of Claude Code.'
      }
    } catch (err) {
      result = missing(err)
        ? { installed: false, signedIn: false, account: null, plan: null, error: null }
        : {
            installed: true,
            signedIn: false,
            account: null,
            plan: null,
            error: describe(err)
          }
    }

    this.cached = result
    return result
  }

  /** Drop the memoised answer, after the user has signed in or out. */
  forget(): void {
    this.cached = null
    // A sign-in can come with an updated CLI.
    this.flagsKnown = null
  }

  /**
   * What this installation of the CLI can be told, read once from its --help.
   *
   * `--tools ""` turns every built-in tool off, which is what Ember wants and says
   * directly; the list of tools to disallow it passed before fell behind with every
   * CLI release that added one. `--system-prompt-file` keeps the system prompt — which
   * carries the attached blocks and the open file — off the command line too.
   */
  private flags(): Promise<{ tools: boolean; systemPromptFile: boolean }> {
    this.flagsKnown ??= this.exec(['--help'], 20_000)
      .then(({ stdout }) => ({
        // The flag, whatever its placeholder; not --allowed-tools or --disallowed-tools.
        tools: /(^|\s)--tools\b/m.test(stdout),
        systemPromptFile: /--system-prompt-file|--system-prompt\[-file\]/.test(stdout)
      }))
      .catch(() => {
        // Not kept: a --help that failed once — a first run scanned by antivirus, a
        // slow start — would otherwise refuse every ask until Ember was restarted.
        this.flagsKnown = null
        return { tools: false, systemPromptFile: false }
      })
    return this.flagsKnown
  }
  private flagsKnown: Promise<{ tools: boolean; systemPromptFile: boolean }> | null = null

  /**
   * One prompt, one answer, delivered as it is written, and nothing else.
   *
   * `--output-format stream-json` turns the CLI's print mode into JSONL events, and
   * `--include-partial-messages` puts the model's own text deltas among them. The
   * flags past those stop a one-shot text generation becoming a Claude Code session:
   * no MCP servers, no settings or CLAUDE.md, no session file left behind, and above
   * all no tools — an agent that went and ran the command it was asked to suggest,
   * or edited a file on the way, would be doing something nobody asked for.
   *
   * No tools is checked, not assumed (audit R26, SE-08): the CLI's first event lists
   * the tools it started with, and a run that lists any is stopped before it answers,
   * whatever flags this CLI took. It runs in an empty folder of its own, and the
   * prompt and the system prompt go to it over stdin and a file — on the command
   * line they met Windows' 32,767-character limit, and a long conversation or a
   * large attachment failed to start.
   */
  askStream(system: string, prompt: string, model: string, onDelta: (text: string) => void): AskStream {
    let cancelled = false
    let child: ChildProcess | null = null
    const done = this.run(system, prompt, model, onDelta, (c) => {
      child = c
      if (cancelled) c.kill()
    }).catch((err: unknown) => ({ ok: false as const, error: `Claude Code could not be started: ${err instanceof Error ? err.message : String(err)}` }))
    return {
      done: done.then((res) => (cancelled ? { ok: false as const, cancelled: true as const } : res)),
      cancel: () => {
        cancelled = true
        child?.kill()
      }
    }
  }

  private async run(
    system: string,
    prompt: string,
    model: string,
    onDelta: (text: string) => void,
    started: (child: ChildProcess) => void
  ): Promise<AskResult> {
    const flags = await this.flags()
    const room = mkdtempSync(join(tmpdir(), 'ember-claude-'))
    const systemFile = join(tmpdir(), `ember-claude-system-${randomUUID()}.txt`)
    try {
      if (flags.systemPromptFile) writeFileSync(systemFile, system, { encoding: 'utf8', mode: 0o600 })
      const args = [
        ...this.prefix,
        '-p',
        '--output-format',
        'stream-json',
        '--include-partial-messages',
        '--verbose',
        '--model',
        model,
        ...(flags.systemPromptFile ? ['--system-prompt-file', systemFile] : ['--system-prompt', system]),
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--setting-sources',
        '',
        '--no-session-persistence',
        ...(flags.tools ? ['--tools', ''] : []),
        // Kept for a CLI too old for --tools; the init check below is what holds.
        '--disallowed-tools',
        'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite'
      ]
      return await new Promise<AskResult>((resolve) => {
        let streamedAny = false
        let finalText = ''
        let finalError: string | null = null
        let carry = ''
        let stderr = ''
        let refused = false

        const child = execFile(
          this.command,
          args,
          { env: cliEnv(), cwd: room, timeout: 180_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
          (error) => {
            if (finalError) resolve({ ok: false, error: finalError })
            else if (finalText) {
              // A CLI without partials delivered nothing along the way; the whole
              // answer goes out as one late delta, so the caller need not care.
              if (!streamedAny) onDelta(finalText)
              resolve({ ok: true, text: finalText })
            } else if (error && missing(error)) resolve({ ok: false, error: 'Claude Code is not installed, so there is nothing to sign in to.' })
            else if (error) resolve({ ok: false, error: describe(error, stderr) })
            else resolve({ ok: false, error: 'Claude Code returned no answer.' })
          }
        )
        started(child)
        child.stderr?.on('data', (chunk: string | Buffer) => {
          if (stderr.length < 64 * 1024) stderr += chunk.toString()
        })
        // The prompt, and then the end of it: without the end the CLI waits three
        // seconds for more, then writes a warning about waiting into its answer.
        child.stdin?.on('error', () => {})
        child.stdin?.end(prompt)

        child.stdout?.on('data', (chunk: string | Buffer) => {
          // Once stopped for its tools, nothing more it says is read.
          if (refused) return
          carry += chunk.toString()
          for (;;) {
            const nl = carry.indexOf('\n')
            if (nl === -1) return
            const line = carry.slice(0, nl).trim()
            carry = carry.slice(nl + 1)
            if (!line) continue
            let event: CliEvent
            try {
              event = JSON.parse(line) as CliEvent
            } catch {
              // A malformed line loses itself; the stream stays aligned.
              continue
            }
            if (event.type === 'system' && event.subtype === 'init') {
              const tools = Array.isArray(event.tools) ? event.tools : []
              if (tools.length > 0) {
                finalError = `Claude Code started with tools it could use (${tools.slice(0, 6).join(', ')}${tools.length > 6 ? ', …' : ''}), so Ember stopped it before it answered.${flags.tools ? '' : ' This Claude Code is too old to be run without tools; updating it should fix this.'}`
                refused = true
                child.kill()
                return
              }
            } else if (event.type === 'stream_event') {
              const delta = event.event?.delta
              if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
                streamedAny = true
                onDelta(delta.text)
              }
            } else if (event.type === 'result') {
              if (event.is_error || event.subtype !== 'success') finalError = event.result || 'Claude Code returned an error.'
              else finalText = event.result ?? ''
            }
          }
        })
      })
    } finally {
      rmSync(systemFile, { force: true })
      rmSync(room, { recursive: true, force: true })
    }
  }
}

interface CliEvent {
  type?: string
  subtype?: string
  is_error?: boolean
  result?: string
  tools?: unknown[]
  event?: { type?: string; delta?: { type?: string; text?: string } }
}

/*
 * A deliberately narrowed environment.
 *
 * CLAUDE_CODE_SSE_PORT is how a Claude Code started inside one of Ember's terminals
 * finds Ember's IDE server. It is injected per-pty on purpose, but this process may
 * still carry one, and a headless call that connected back would be able to drive
 * the user's editor as a side effect of being asked for a shell command. Removed
 * rather than relied upon.
 *
 * ANTHROPIC_API_KEY is removed because this path exists precisely for people who
 * have not got one; if a key is present, Ember uses the API directly and never gets
 * here.
 */
function cliEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.CLAUDE_CODE_SSE_PORT
  delete env.ANTHROPIC_API_KEY
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

/*
 * What an Ember that was killed mid-ask left in the temp folder: the system-prompt
 * file, which holds the attached blocks and the open file, and the empty folder the
 * CLI ran in. An ask takes minutes at most, so anything older than this outlived the
 * Ember that made it; not every one at once, since another Ember may be asking now.
 */
function sweepLeftovers(): void {
  try {
    const dir = tmpdir()
    const stale = Date.now() - 10 * 60_000
    for (const name of readdirSync(dir)) {
      if (!/^ember-claude-(system-[0-9a-f-]+\.txt|[A-Za-z0-9]{6})$/.test(name)) continue
      const target = join(dir, name)
      if (statSync(target).mtimeMs < stale) rmSync(target, { recursive: true, force: true })
    }
  } catch {
    // A temp folder that cannot be read is not a reason to have no Claude.
  }
}

export type AskResult ={ ok: true; text: string } | { ok: false; error: string }

export interface AskStream {
  /** Resolves when the CLI finishes, however it finishes; never rejects. */
  done: Promise<AskResult | { ok: false; cancelled: true }>
  cancel: () => void
}

/**
 * Whether the failure was "there is no such program". Only that: a CLI that is there
 * and failed saying "not found" about a file or a model was reported as not installed.
 */
function missing(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === 'ENOENT'
}

/**
 * The reason, from what the CLI itself said. Never execFile's own message, which is
 * "Command failed: " and the whole command line — the prompt included, when it was
 * there, and the system prompt still, on an older CLI.
 */
function describe(err: unknown, stderr = ''): string {
  const e = err as { killed?: boolean; code?: unknown; stderr?: string }
  if (e?.killed) return 'Claude Code took too long to answer.'
  const said = (stderr || e?.stderr || '').trim()
  if (said) return said.split('\n')[0].slice(0, 200)
  return typeof e?.code === 'number' ? `Claude Code stopped without answering (exit code ${e.code}).` : 'Claude Code stopped without answering.'
}
