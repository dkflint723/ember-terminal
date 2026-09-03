import Anthropic from '@anthropic-ai/sdk'
import type {
  AiChatEvent,
  AiChatRequest,
  AiCredential,
  AiLimit,
  AiUsage
} from '../shared/types.js'
import type { SettingsStore } from './settings.js'
import type { ClaudeCliService } from './claude-cli.js'


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


  /** Live chat streams, by request id, so a cancel can find its stream. */
  private chatStreams = new Map<string, { abort: () => void }>()

  /*
   * The conversational path: the panel's threads, streamed a few characters at
   * a time. Distinct from run() on purpose — run() bargains for one command
   * line in JSON, while a thread wants prose with fenced proposals in it.
   *
   * EMBER_FAKE_AI is the verification suite's seam: with it set, the reply is a
   * deterministic function of the last message and streams through the same
   * sink, cancel and all, so the panel can be driven without a key or a network.
   */
  async chat(req: AiChatRequest, sink: (e: AiChatEvent) => void): Promise<void> {
    if (process.env.EMBER_FAKE_AI) return this.fakeChat(req, sink)

    const apiKey = this.settings.resolveApiKey()
    if (!apiKey) return this.chatThroughClaudeCode(req, sink)

    const client = new Anthropic({ apiKey, maxRetries: 1 })
    const system = [
      chatSystemPrompt(req.shell, req.cwd),
      'When you propose changing a file, put its complete new content in a fenced',
      'block whose info string is `lang path=<path>`. When you propose a shell',
      'command to run, put it alone in a fenced block whose info string is `run`.',
      req.activeFile
        ? 'The user is editing ' + req.activeFile.path + ':\n' + req.activeFile.text
        : '',
      ...(req.attached ?? []).map((a) => 'Attached terminal output:\n' + a)
    ]
      .filter(Boolean)
      .join('\n\n')

    try {
      const stream = client.messages.stream({
        model: this.settings.get().aiModel,
        max_tokens: 4096,
        system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.text }))
      })
      this.chatStreams.set(req.requestId, { abort: () => stream.controller.abort() })
      stream.on('text', (delta) => sink({ requestId: req.requestId, delta }))
      await stream.finalMessage()
      sink({ requestId: req.requestId, done: 'complete' })
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError'
      sink(
        aborted
          ? { requestId: req.requestId, done: 'cancelled' }
          : {
              requestId: req.requestId,
              done: 'error',
              error: this.describeError(err)
            }
      )
    } finally {
      this.chatStreams.delete(req.requestId)
    }
  }

  /**
   * One short answer, through whichever door is open.
   *
   * chat() is the panel's shape — streamed, threaded, and full of instructions
   * about fenced proposals. Two things want neither: the suggestion ahead of the
   * caret, and an edit made to a selection. Both want a single string back.
   *
   * It matters that this resolves the credential the same way chat() does. The
   * first version of the suggestion provider read `anthropicApiKey` directly and
   * gave up when it was empty — which is the normal state for anyone signed in
   * through the Claude Code CLI, so choosing Claude there failed with "no
   * credential" while the panel beside it worked perfectly.
   */
  async oneShot(
    system: string,
    prompt: string,
    maxTokens: number,
    model?: string
  ): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    if (process.env.EMBER_FAKE_AI) {
      return { ok: true, text: `FAKE:${prompt.slice(-40)}` }
    }

    const chosen = model || this.settings.get().aiModel
    const apiKey = this.settings.resolveApiKey()

    if (apiKey) {
      try {
        const client = new Anthropic({ apiKey, maxRetries: 1 })
        const message = await client.messages.create({
          model: chosen,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: prompt }]
        })
        const text = message.content
          .map((part) => (part.type === 'text' ? part.text : ''))
          .join('')
        return { ok: true, text }
      } catch (err) {
        return { ok: false, error: this.describeError(err) }
      }
    }

    const access = await this.claude.access()
    if (!access.installed || !access.signedIn) {
      return { ok: false, error: 'No API key, and Claude Code is not signed in. Settings has both doors.' }
    }
    let out = ''
    const stream = this.claude.askStream(system, prompt, chosen, (delta) => {
      out += delta
    })
    const res = await stream.done
    if ('cancelled' in res) return { ok: false, error: 'cancelled' }
    return res.ok ? { ok: true, text: out } : { ok: false, error: res.error }
  }

  cancelChat(requestId: string): void {
    this.chatStreams.get(requestId)?.abort()
  }

  /** The CLI path has no streaming yet: one answer, delivered as one delta. */
  private async chatThroughClaudeCode(
    req: AiChatRequest,
    sink: (e: AiChatEvent) => void
  ): Promise<void> {
    const access = await this.claude.access()
    if (!access.installed || !access.signedIn) {
      sink({
        requestId: req.requestId,
        done: 'error',
        error: 'No API key, and Claude Code is not signed in. Settings has both doors.'
      })
      return
    }
    const transcript = req.messages
      .map((m) => (m.role === 'user' ? 'User: ' : 'Claude: ') + m.text)
      .join('\n\n')
    const system = [
      chatSystemPrompt(req.shell, req.cwd),
      'When you propose changing a file, put its complete new content in a fenced',
      'block whose info string is `lang path=<path>`. When you propose a shell',
      'command to run, put it alone in a fenced block whose info string is `run`.',
      'Continue the conversation below; reply as Claude, in plain markdown.'
    ].join('\n\n')

    const stream = this.claude.askStream(system, transcript, this.settings.get().aiModel, (delta) =>
      sink({ requestId: req.requestId, delta })
    )
    this.chatStreams.set(req.requestId, { abort: stream.cancel })
    try {
      const res = await stream.done
      if ('cancelled' in res) sink({ requestId: req.requestId, done: 'cancelled' })
      else if (res.ok) sink({ requestId: req.requestId, done: 'complete' })
      else sink({ requestId: req.requestId, done: 'error', error: res.error })
    } finally {
      this.chatStreams.delete(req.requestId)
    }
  }

  /** See chat(). Deterministic, so a suite can hold every promise to account. */
  private async fakeChat(req: AiChatRequest, sink: (e: AiChatEvent) => void): Promise<void> {
    const last = req.messages[req.messages.length - 1]?.text ?? ''
    const attachedHead = (req.attached?.[0] ?? '').split(String.fromCharCode(10))[0].slice(0, 120)
    let reply = `fake-reply(turns=${req.messages.length}, attached=${req.attached?.length ?? 0}, head="${attachedHead}"): ${last}`
    const file = last.match(/make-file:(\S+)/)
    if (file) {
      reply =
        'Writing it now.\n\n```ts path=' +
        file[1] +
        '\nexport const planted = true\n```\n\nDone.'
    }
    if (last.includes('run-echo')) {
      reply = 'Run this:\n\n```run\necho panel-ran-this\n```'
    }
    if (last.includes('markdown-me')) {
      reply = [
        '# A heading',
        '',
        'Some **bold words** and `inline code` and a [link](https://example.com/docs).',
        '',
        '- first item',
        '- second item'
      ].join('\n')
    }

    let cancelled = false
    this.chatStreams.set(req.requestId, { abort: () => (cancelled = true) })
    const pace = process.env.EMBER_FAKE_AI_SLOW ? 60 : 5
    try {
      for (let i = 0; i < reply.length; i += 8) {
        if (cancelled) {
          sink({ requestId: req.requestId, done: 'cancelled' })
          return
        }
        sink({ requestId: req.requestId, delta: reply.slice(i, i + 8) })
        await new Promise((r) => setTimeout(r, pace))
      }
      sink({ requestId: req.requestId, done: 'complete' })
    } finally {
      this.chatStreams.delete(req.requestId)
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
