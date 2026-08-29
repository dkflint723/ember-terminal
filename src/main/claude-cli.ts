import { execFile } from 'node:child_process'
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

  private exec(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      /*
       * A deliberately narrowed environment.
       *
       * CLAUDE_CODE_SSE_PORT is how a Claude Code started inside one of Ember's
       * terminals finds Ember's IDE server. It is injected per-pty on purpose, but
       * this process may still carry one, and a headless call that connected back
       * would be able to drive the user's editor as a side effect of being asked
       * for a shell command. Removed rather than relied upon.
       *
       * ANTHROPIC_API_KEY is removed because this path exists precisely for people
       * who have not got one; if a key is present, Ember uses the API directly and
       * never gets here.
       */
      const env = { ...process.env }
      delete env.CLAUDE_CODE_SSE_PORT
      delete env.ANTHROPIC_API_KEY
      delete env.ELECTRON_RUN_AS_NODE

      const child = execFile(
        'claude',
        args,
        { env, timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
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
  }

  /**
   * One prompt, one answer, nothing else.
   *
   * Every flag past `--output-format` exists to stop a one-shot text generation
   * turning into a Claude Code session: no MCP servers, no project settings or
   * CLAUDE.md, no session file left behind, and above all no tools — Ember is asking
   * what command to suggest, and an agent that went and ran it, or edited a file on
   * the way, would be doing something the user never asked for.
   */
  async ask(system: string, prompt: string, model: string): Promise<AskResult> {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'json',
      '--model',
      model,
      '--system-prompt',
      system,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--disallowed-tools',
      'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite'
    ]

    let stdout: string
    try {
      // Longer than the API path allows itself: this starts a process and carries a
      // large system prompt before it begins.
      ;({ stdout } = await this.exec(args, 90_000))
    } catch (err) {
      if (missing(err)) {
        return { ok: false, error: 'Claude Code is not installed, so there is nothing to sign in to.' }
      }
      return { ok: false, error: describe(err) }
    }

    try {
      const envelope = JSON.parse(stdout) as {
        type?: string
        subtype?: string
        is_error?: boolean
        result?: string
      }
      if (envelope.is_error || envelope.subtype !== 'success' || typeof envelope.result !== 'string') {
        return { ok: false, error: envelope.result || 'Claude Code returned no answer.' }
      }
      return { ok: true, text: envelope.result }
    } catch {
      return { ok: false, error: 'Could not read what Claude Code returned.' }
    }
  }

  /**
   * ask(), but the answer arrives as it is written.
   *
   * `--output-format stream-json` turns the CLI's print mode into JSONL events,
   * and `--include-partial-messages` puts the model's own text deltas among
   * them — the same stream the API path gets, one process further away. Falls
   * back gracefully: an older CLI that rejects the flags, or a stream with no
   * partials in it, still resolves with the final result text, delivered late
   * but whole.
   */
  askStream(
    system: string,
    prompt: string,
    model: string,
    onDelta: (text: string) => void
  ): AskStream {
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--model',
      model,
      '--system-prompt',
      system,
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      '',
      '--no-session-persistence',
      '--disallowed-tools',
      'Bash,Read,Write,Edit,Glob,Grep,WebFetch,WebSearch,Task,NotebookEdit,TodoWrite'
    ]

    const env = { ...process.env }
    delete env.CLAUDE_CODE_SSE_PORT
    delete env.ANTHROPIC_API_KEY
    delete env.ELECTRON_RUN_AS_NODE

    let cancelled = false
    let child: ReturnType<typeof execFile> | null = null

    const done = new Promise<AskResult | { ok: false; cancelled: true }>((resolve) => {
      let streamedAny = false
      let finalText = ''
      let finalError: string | null = null
      let carry = ''

      child = execFile(
        'claude',
        args,
        { env, timeout: 180_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
        (error) => {
          if (cancelled) {
            resolve({ ok: false, cancelled: true })
            return
          }
          if (error && !finalText) {
            resolve({
              ok: false,
              error: missing(error)
                ? 'Claude Code is not installed, so there is nothing to sign in to.'
                : describe(error)
            })
            return
          }
          if (finalError) resolve({ ok: false, error: finalError })
          else if (finalText) {
            // A CLI without partials delivered nothing along the way; the
            // whole answer goes out as one late delta so the caller need not
            // care which kind of CLI answered.
            if (!streamedAny) onDelta(finalText)
            resolve({ ok: true, text: finalText })
          } else resolve({ ok: false, error: 'Claude Code returned no answer.' })
        }
      )
      child.stdin?.end()

      child.stdout?.on('data', (chunk: string | Buffer) => {
        carry += chunk.toString()
        for (;;) {
          const nl = carry.indexOf('\n')
          if (nl === -1) return
          const line = carry.slice(0, nl).trim()
          carry = carry.slice(nl + 1)
          if (!line) continue
          try {
            const event = JSON.parse(line) as {
              type?: string
              subtype?: string
              is_error?: boolean
              result?: string
              event?: { type?: string; delta?: { type?: string; text?: string } }
            }
            if (event.type === 'stream_event') {
              const delta = event.event?.delta
              if (event.event?.type === 'content_block_delta' && delta?.type === 'text_delta' && delta.text) {
                streamedAny = true
                onDelta(delta.text)
              }
            } else if (event.type === 'result') {
              if (event.is_error || event.subtype !== 'success') {
                finalError = event.result || 'Claude Code returned an error.'
              } else {
                finalText = event.result ?? ''
              }
            }
          } catch {
            // A malformed line loses itself; the stream stays aligned.
          }
        }
      })
    })

    return {
      done,
      cancel: () => {
        cancelled = true
        child?.kill()
      }
    }
  }
}

export type AskResult = { ok: true; text: string } | { ok: false; error: string }

export interface AskStream {
  /** Resolves when the CLI finishes, however it finishes. */
  done: Promise<AskResult | { ok: false; cancelled: true }>
  cancel: () => void
}

/** Whether the failure was "there is no such program" rather than a real error. */
function missing(err: unknown): boolean {
  const e = err as { code?: string; stderr?: string; message?: string }
  if (e?.code === 'ENOENT') return true
  const text = `${e?.stderr ?? ''} ${e?.message ?? ''}`
  return /is not recognized|not found|ENOENT/i.test(text)
}

function describe(err: unknown): string {
  const e = err as { killed?: boolean; stderr?: string; message?: string }
  if (e?.killed) return 'Claude Code took too long to answer.'
  const stderr = (e?.stderr ?? '').trim()
  if (stderr) return stderr.split('\n')[0].slice(0, 200)
  return e?.message ?? 'Claude Code failed.'
}
