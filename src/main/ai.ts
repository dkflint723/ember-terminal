import Anthropic from '@anthropic-ai/sdk'
import type { AiCredential, AiLimit, AiRequest, AiResponse, AiUsage } from '../shared/types.js'
import { supportsEffort } from '../shared/models.js'
import type { SettingsStore } from './settings.js'
import type { ClaudeCliService } from './claude-cli.js'

/**
 * What the schema says, said in words, for the path that cannot enforce a schema.
 *
 * The fences are called out because models add them by habit: asked for JSON, a
 * model reliably returns it wrapped in a ```json block. The parser strips them
 * anyway, since asking nicely does not actually stop it.
 */
const JSON_INSTRUCTION = [
  'Reply with a single JSON object and nothing else — no prose, no explanation around it,',
  'and no markdown code fences.',
  '',
  'Keys:',
  '  command      string   the one command line to run',
  '  note         string   one short sentence on what it does, or the risk if destructive',
  '  destructive  boolean  true when it deletes, overwrites, or is otherwise hard to undo'
].join('\n')

/*
 * Thinking is always adaptive; how much of it is the user's setting.
 *
 * Low is the default because the request this app makes most often is a single
 * command line, where the wait is the thing being felt. (Disabling thinking
 * outright on Opus 5 risks leaking `<thinking>` tags into the visible response,
 * and low effort already gets most of the token and latency saving.) The switcher
 * beside the prompt raises it for the questions that are worth waiting for.
 */

/**
 * `max_tokens` caps thinking plus response text together, so this is deliberately
 * far above the size of the answer itself — it is a ceiling, not a target.
 */
const MAX_TOKENS = 8192

const COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description:
        'A single runnable command line for the requested shell. No prose, no markdown fences, no leading prompt characters.'
    },
    note: {
      type: 'string',
      description:
        'One short sentence explaining what the command does, or naming the risk if it is destructive.'
    },
    destructive: {
      type: 'boolean',
      description:
        'True when the command deletes data, overwrites files, changes permissions, or is otherwise hard to undo.'
    }
  },
  required: ['command', 'note', 'destructive'],
  additionalProperties: false
}

function commandSystemPrompt(shell: string, cwd: string): string {
  return [
    `You translate a natural-language request into one runnable command line for ${shell} on Windows.`,
    `The user's working directory is ${cwd}.`,
    '',
    'Emit the command that a competent user of this shell would actually type: use the',
    'idioms of the target shell rather than a generic POSIX equivalent, and prefer the',
    'tools most likely to be installed over ones the user may not have.',
    '',
    'Put the whole thing on one line. If the request genuinely needs several steps, chain',
    'them with the operator this shell uses. When a request is ambiguous, pick the reading',
    'a careful colleague would and say which one you chose in the note.',
    '',
    'Set destructive to true whenever running the command could lose work — deletions,',
    'overwrites, force pushes, recursive permission changes — so the UI can warn first.'
  ].join('\n')
}

/**
 * The side panel, where the conversation is about the work rather than one command.
 *
 * Separate from the explain prompt because that one is written for a failure that
 * just happened and answers in a short paragraph — right for "why did that break",
 * wrong for "how should I structure this". This one can be asked anything,
 * including questions with no command in the answer at all.
 */
function chatSystemPrompt(shell: string, cwd: string): string {
  return [
    'You are helping someone inside their terminal and editor. They can see their',
    `files, their shell (${shell}) and their working directory (${cwd}).`,
    '',
    'Answer the question that was asked, at the length it deserves — a sentence when',
    'a sentence will do. Show commands and code in fenced blocks so they can be read',
    'and copied. Where you are unsure about their setup, say so rather than assuming.'
  ].join('\n')
}

function explainSystemPrompt(shell: string): string {
  return [
    `You explain ${shell} command failures to the person who just hit one.`,
    '',
    'Lead with the cause in one sentence, then give the fix as a command they can run.',
    'Keep it to a short paragraph: they are in the middle of something, not reading a manual.',
    'If the output does not actually say why it failed, name the most likely cause and how',
    'to confirm it rather than guessing at a fix.'
  ].join('\n')
}

/**
 * The JSON object out of a reply that may be wrapped in prose or a code fence.
 *
 * The API path returns bare JSON because the schema is enforced, so this changes
 * nothing there. The CLI path has no schema to enforce, and a model asked for JSON
 * returns it fenced regardless of being told not to — measured, not assumed.
 */
function unwrapJson(text: string): string {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = (fenced ? fenced[1] : trimmed).trim()

  // Still tolerant of a sentence either side, which fences alone would not catch.
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start !== -1 && end > start ? body.slice(start, end + 1) : body
}

function buildUserMessage(req: AiRequest): string {
  const parts: string[] = []

  if (req.recent && req.recent.length > 0) {
    parts.push('Recent commands from this session:')
    for (const r of req.recent) {
      /*
       * Cap each block: a runaway build log would otherwise dominate the request.
       *
       * The flag is read as well as the length, and it is the flag that does the
       * work — the renderer caps at this same 4000 before it sends, so nothing
       * arriving from the composer is ever longer than the test and the marker
       * would never be appended. A log that was cut has to say so, or the model
       * answers about the last thing it can see as though that were the whole of
       * it. The length still stands for callers that do not set the flag.
       */
      const cut = r.output.length > 4000
      const output = `${cut ? r.output.slice(0, 4000) : r.output}${cut || r.elided ? '\n…[truncated]' : ''}`
      /*
       * Where it ran is part of what happened, so each item says so for itself.
       * The system prompt names only the directory the question is being asked
       * from, and an attached failure need not have run there — it can predate a
       * cd, or come from another pane — so without this the model answers about
       * the wrong tree, and two failures from two directories are indistinguishable
       * from two in one.
       */
      const where = r.cwd ? ` in ${r.cwd}` : ''
      parts.push(`$ ${r.command}\n(exit ${r.exitCode}${where})\n${output}`)
    }
    parts.push('')
  }

  parts.push(req.mode === 'command' ? `Request: ${req.intent}` : req.intent)
  return parts.join('\n')
}

export class AiService {
  constructor(
    private settings: SettingsStore,
    private claude: ClaudeCliService
  ) {}

  /**
   * What the last answer's headers said was left.
   *
   * Held here rather than fetched on demand because there is nowhere to fetch it
   * from: the API reports rate limits in the headers of ordinary responses, so the
   * only way to learn the current numbers is to have just asked something. Every
   * request updates this, including the ones that came back as errors — a 429 is
   * the reading that matters most.
   */
  private lastUsage: AiUsage | null = null

  usage(): AiUsage | null {
    return this.lastUsage
  }

  private noteUsage(headers: Headers | undefined, source: AiCredential['source']): void {
    if (!headers) return
    const num = (name: string): number | null => {
      const raw = headers.get(name)
      if (raw === null) return null
      const parsed = Number(raw)
      return Number.isFinite(parsed) ? parsed : null
    }
    const limit = (kind: string): AiLimit => ({
      limit: num(`anthropic-ratelimit-${kind}-limit`),
      remaining: num(`anthropic-ratelimit-${kind}-remaining`),
      reset: headers.get(`anthropic-ratelimit-${kind}-reset`)
    })

    const usage: AiUsage = {
      at: Date.now(),
      source,
      requests: limit('requests'),
      inputTokens: limit('input-tokens'),
      outputTokens: limit('output-tokens'),
      retryAfter: num('retry-after')
    }
    // A response that carried none of them says nothing about the limits, and
    // replacing a real reading with an empty one would look like a quota of zero.
    const known =
      usage.requests.limit ??
      usage.inputTokens.limit ??
      usage.outputTokens.limit ??
      usage.retryAfter
    if (known === null) return
    this.lastUsage = usage
  }

  /**
   * Read the limits now, by making the smallest request that carries them.
   *
   * `max_tokens: 0` is the cheapest thing the messages endpoint accepts: it runs
   * the prompt and returns immediately with no content and no output tokens
   * billed. Some model and thinking combinations reject it outright, so a request
   * for a single token is the fallback — still small, and still a real reading
   * rather than a guess.
   */
  async checkUsage(): Promise<{ ok: true; usage: AiUsage } | { ok: false; error: string }> {
    const apiKey = this.settings.resolveApiKey()
    if (!apiKey) {
      const credential = await this.credential()
      return {
        ok: false,
        error:
          credential.source === 'claude-code'
            ? 'A Claude Code subscription does not report its limits outside a session. Run `claude` and use /usage.'
            : 'No API key to ask with. Add one in Settings.'
      }
    }

    const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 0 })
    const source = (await this.credential()).source
    const probe = {
      model: this.settings.get().aiModel,
      messages: [{ role: 'user' as const, content: 'ping' }]
    }

    /*
     * Compared against the reading held before this call rather than against null.
     *
     * Every exit here has to mean "this request produced these numbers". A probe
     * that fails after a previous answer left a reading behind would otherwise
     * return that one, and it would be presented as having just been taken — the
     * one thing a freshness check must never do.
     */
    const before = this.lastUsage
    const fresh = (): boolean => this.lastUsage !== null && this.lastUsage !== before

    for (const maxTokens of [0, 1]) {
      try {
        const { response } = await client.messages
          .create({ ...probe, max_tokens: maxTokens })
          .withResponse()
        this.noteUsage(response.headers, source)
        break
      } catch (err) {
        // A rejected probe still answered, and the answer had headers on it — a
        // rate limit is a reading, and the most useful one there is.
        if (err instanceof Anthropic.APIError && err.headers) this.noteUsage(err.headers, source)
        if (fresh()) break
        if (maxTokens === 1) return { ok: false, error: this.describeError(err) }
      }
    }

    if (!fresh()) {
      return { ok: false, error: 'The API answered without saying anything about limits.' }
    }
    return { ok: true, usage: this.lastUsage as AiUsage }
  }

  /** Which credential a request would use right now, for the settings dialog. */
  async credential(): Promise<AiCredential> {
    const fromSettings = this.settings.get().anthropicApiKey
    if (fromSettings && fromSettings.trim()) return { source: 'settings-key', detail: null }
    if (process.env.ANTHROPIC_API_KEY?.trim()) {
      return { source: 'environment-key', detail: 'ANTHROPIC_API_KEY' }
    }
    const access = await this.claude.access()
    if (access.installed && access.signedIn) {
      return { source: 'claude-code', detail: access.account }
    }
    return { source: 'none', detail: access.installed ? access.error : null }
  }

  /**
   * The same question, asked through the Claude Code CLI.
   *
   * Structured outputs are not available here — the CLI has no equivalent flag — so
   * the schema becomes an instruction and the answer is parsed defensively. That is
   * a genuine step down in reliability for command generation, which is why an
   * explicit API key still takes precedence over this path.
   */
  private async runThroughClaudeCode(req: AiRequest): Promise<AiResponse> {
    const access = await this.claude.access()
    if (!access.installed) {
      return {
        ok: false,
        error:
          'No API key, and Claude Code is not installed. Add a key in Settings, or install Claude Code and sign in.'
      }
    }
    if (!access.signedIn) {
      return {
        ok: false,
        error: 'Not signed in. Run `claude auth login`, or add an API key in Settings.'
      }
    }

    const system =
      req.mode === 'command'
        ? `${commandSystemPrompt(req.shell, req.cwd)}\n\n${JSON_INSTRUCTION}`
        : req.mode === 'chat'
          ? chatSystemPrompt(req.shell, req.cwd)
          : explainSystemPrompt(req.shell)

    const answer = await this.claude.ask(
      system,
      buildUserMessage(req),
      this.settings.get().aiModel
    )
    if (!answer.ok) return { ok: false, error: answer.error }
    // Anything that is not asking for a command wants the prose back as it is.
    if (req.mode !== 'command') return { ok: true, explanation: answer.text.trim() }
    return this.parseCommand(answer.text)
  }

  async run(req: AiRequest): Promise<AiResponse> {
    const apiKey = this.settings.resolveApiKey()
    // No key is no longer the end of it: the user may be signed into Claude Code,
    // which is the browser login this app can actually reuse.
    if (!apiKey) return this.runThroughClaudeCode(req)

    // Bounded on purpose. Someone waiting on a one-line command has given up long
    // before a default timeout would fire, and the composer is disabled while the
    // request is in flight — an unbounded call is indistinguishable from a hang.
    const client = new Anthropic({ apiKey, timeout: 45_000, maxRetries: 1 })
    const model = this.settings.get().aiModel

    try {
      const message = await this.create(client, model, req)

      // A terminal assistant sits close to topics the safety classifiers watch,
      // so a refusal is a normal outcome here rather than an exceptional one.
      // It arrives as a successful response with an empty or partial content
      // array, so this has to be checked before reading any block.
      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category ?? 'unspecified'
        return {
          ok: false,
          error: `Claude declined this request (${category}). Rephrasing it usually helps.`
        }
      }

      if (message.stop_reason === 'max_tokens') {
        return { ok: false, error: 'The response was cut off before it finished. Try again.' }
      }

      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim()

      if (text.length === 0) {
        return { ok: false, error: 'Claude returned an empty response.' }
      }

      if (req.mode !== 'command') return { ok: true, explanation: text }

      return this.parseCommand(text)
    } catch (err) {
      // A refusal, a rate limit, an overload: all of them answered, and the answer
      // said what was left. The reading is worth keeping even when the request was
      // not — especially a 429, which is the one someone goes looking for.
      if (err instanceof Anthropic.APIError && err.headers) {
        this.noteUsage(err.headers, this.settings.get().anthropicApiKey ? 'settings-key' : 'environment-key')
      }
      return { ok: false, error: this.describeError(err) }
    }
  }

  private async create(
    client: Anthropic,
    model: string,
    req: AiRequest
  ): Promise<Anthropic.Beta.BetaMessage> {
    const system =
      req.mode === 'command'
        ? commandSystemPrompt(req.shell, req.cwd)
        : req.mode === 'chat'
          ? chatSystemPrompt(req.shell, req.cwd)
          : explainSystemPrompt(req.shell)

    const outputConfig: Record<string, unknown> = {}
    // Sent only where it is accepted: a model that takes no effort level rejects
    // the whole request rather than ignoring the field.
    if (supportsEffort(model)) outputConfig.effort = this.settings.get().aiEffort
    if (req.mode === 'command') {
      outputConfig.format = { type: 'json_schema', schema: COMMAND_SCHEMA }
    }

    const params = {
      model,
      max_tokens: MAX_TOKENS,
      system,
      thinking: { type: 'adaptive' as const },
      output_config: outputConfig,
      messages: [{ role: 'user' as const, content: buildUserMessage(req) }]
    }

    // Route refusals to a model with broader availability rather than surfacing
    // them to the user. `fallbacks: "default"` lets the server pick the right
    // substitute per refusal category, so there is no model list to maintain.
    // Taken with the response rather than on its own, so the rate-limit headers
    // that ride along with every answer can be kept — they are the only place the
    // API says what is left.
    const source = this.settings.get().anthropicApiKey ? 'settings-key' : 'environment-key'
    try {
      const { data, response } = await client.beta.messages
        .create({
          ...params,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default'
        } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming)
        .withResponse()
      this.noteUsage(response.headers, source)
      return data
    } catch (err) {
      // If this deployment does not accept the fallback beta, the feature should
      // still work — just without the automatic retry.
      if (!this.isFallbackUnsupported(err)) throw err
      const { data, response } = await client.messages
        .create(params as unknown as Anthropic.MessageCreateParamsNonStreaming)
        .withResponse()
      this.noteUsage(response.headers, source)
      return data as unknown as Anthropic.Beta.BetaMessage
    }
  }

  private isFallbackUnsupported(err: unknown): boolean {
    if (!(err instanceof Anthropic.BadRequestError)) return false
    return /fallback|beta/i.test(err.message)
  }

  private parseCommand(text: string): AiResponse {
    try {
      const parsed = JSON.parse(unwrapJson(text)) as {
        command?: string
        note?: string
        destructive?: boolean
      }
      if (typeof parsed.command !== 'string' || parsed.command.trim().length === 0) {
        return { ok: false, error: 'Claude did not return a command.' }
      }
      const note = parsed.destructive
        ? `⚠ ${parsed.note ?? 'This command is destructive.'}`
        : parsed.note
      return { ok: true, command: parsed.command.trim(), explanation: note }
    } catch {
      // Structured outputs should make this unreachable, but a malformed body
      // must not take the whole feature down.
      return { ok: false, error: 'Could not read the command Claude returned.' }
    }
  }

  private describeError(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError) {
      return 'That API key was rejected. Check it in Settings.'
    }
    if (err instanceof Anthropic.RateLimitError) {
      return 'Rate limited. Wait a moment and try again.'
    }
    if (err instanceof Anthropic.NotFoundError) {
      return 'That model is unavailable to this key. Pick another in Settings.'
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return 'Could not reach the Anthropic API. Check your connection.'
    }
    if (err instanceof Anthropic.APIError) {
      return `Anthropic API error${err.status ? ` (${err.status})` : ''}: ${err.message}`
    }
    return err instanceof Error ? err.message : 'Unknown error contacting Claude.'
  }
}
