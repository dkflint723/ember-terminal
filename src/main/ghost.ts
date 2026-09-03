import type { GhostProvider, GhostRequest, GhostResult, Settings } from '../shared/types.js'

/**
 * The suggestion that appears ahead of the caret, from whoever the user chose.
 *
 * Three backends, two protocols. `local` and `openai` both speak the
 * OpenAI-compatible HTTP shape, which is why Ollama, llama.cpp, LM Studio,
 * OpenRouter and OpenAI itself all arrive here as one implementation; `claude`
 * goes through the credential the app already holds.
 *
 * They are asked in two different ways, because they are two different kinds of
 * model. A local code model is usually trained to fill in the middle — given the
 * text before the caret and the text after it, produce what belongs between — and
 * asking it in that form is both faster and far more accurate than asking it in
 * prose. A chat model has no such objective, so it is given instructions and its
 * answer is then cleaned up.
 *
 * Nothing here is on by default. See Settings.ghostEnabled for why.
 */

/** Long enough for a slow first token, short enough that a stall is not a hang. */
const TIMEOUT_MS = 10_000

/** A suggestion is a line or a few, never an essay. Also a cost ceiling. */
const MAX_TOKENS = 96

/** Just enough of AiService to ask it one short question. */
type OneShot = (
  system: string,
  prompt: string,
  maxTokens: number,
  model?: string
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>

/** The three ways a local server will take a fill-in-the-middle request. */
type LocalShape = 'ollama' | 'infill' | 'completions'

/** Which one each address turned out to speak, so it is worked out once. */
const shapes = new Map<string, LocalShape>()

export class GhostService {
  constructor(
    private settings: () => Settings,
    /** The app's own Claude access, so every door it knows about counts here too. */
    private ai: () => { oneShot: OneShot }
  ) {}

  /**
   * `signal` is not optional in spirit: the caller cancels on every keystroke, and
   * a request nobody is waiting for is one that still costs money.
   */
  async complete(request: GhostRequest, signal: AbortSignal): Promise<GhostResult> {
    const s = this.settings()
    if (!s.ghostEnabled) return { ok: false, error: 'Suggestions are turned off.' }

    try {
      const text =
        s.ghostProvider === 'claude'
          ? await this.viaClaude(request, s)
          : s.ghostProvider === 'local'
            ? await this.viaLocal(request, s, signal)
            : await this.viaChat(request, s, signal)
      return { ok: true, text: clean(text, request.suffix) }
    } catch (err) {
      if (signal.aborted) return { ok: false, error: 'cancelled' }
      return { ok: false, error: describe(err, s.ghostProvider, s.ghostBaseUrl) }
    }
  }

  /**
   * A local server, asked in whatever shape it actually understands.
   *
   * "OpenAI-compatible" is not enough here, and finding that out cost a released
   * version. Ollama's `/v1/completions` runs the prompt through the model's chat
   * template, so fill-in-the-middle sentinels arrive as literal text and the model
   * politely echoes the prefix back inside a code fence — measured against
   * qwen2.5-coder:1.5b, which answered `a + b;` correctly through Ollama's own
   * endpoint and returned "```typescript
function add(..." through the
   * OpenAI-compatible one.
   *
   * So the three shapes that exist are tried in turn, and the one that answers is
   * remembered for that address. Ollama's `/api/generate` takes prefix and suffix
   * as separate fields; llama.cpp's `/infill` does the same under different names;
   * and a plain `/v1/completions` with sentinels is the fallback for servers that
   * pass a prompt through untouched.
   */
  private async viaLocal(request: GhostRequest, s: Settings, signal: AbortSignal): Promise<string> {
    const base = s.ghostBaseUrl.replace(/\/+$/, '')
    const root = base.replace(/\/v1$/, '')
    const known = shapes.get(base)

    for (const shape of known ? [known] : (['ollama', 'infill', 'completions'] as LocalShape[])) {
      try {
        const text = await this.askLocal(shape, root, base, request, s, signal)
        if (text !== null) {
          shapes.set(base, shape)
          return text
        }
      } catch (err) {
        // A shape this server does not implement is a 404, not a failure worth
        // reporting — unless it was the one that worked before, or the last one.
        if (signal.aborted) throw err
        if (known) shapes.delete(base)
      }
    }
    return ''
  }

  private async askLocal(
    shape: LocalShape,
    root: string,
    base: string,
    request: GhostRequest,
    s: Settings,
    signal: AbortSignal
  ): Promise<string | null> {
    const headers = { 'content-type': 'application/json' }

    if (shape === 'ollama') {
      const res = (await post(
        `${root}/api/generate`,
        headers,
        {
          model: s.ghostModel || undefined,
          prompt: request.prefix,
          suffix: request.suffix,
          stream: false,
          options: { temperature: 0.1, num_predict: MAX_TOKENS }
        },
        signal
      )) as { response?: string }
      return typeof res.response === 'string' ? res.response : null
    }

    if (shape === 'infill') {
      const res = (await post(
        `${root}/infill`,
        headers,
        {
          input_prefix: request.prefix,
          input_suffix: request.suffix,
          n_predict: MAX_TOKENS,
          temperature: 0.1
        },
        signal
      )) as { content?: string }
      return typeof res.content === 'string' ? res.content : null
    }

    const res = (await post(
      `${base}/completions`,
      headers,
      {
        model: s.ghostModel || undefined,
        prompt: `<|fim_prefix|>${request.prefix}<|fim_suffix|>${request.suffix}<|fim_middle|>`,
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
        stop: ['<|fim_pad|>', '<|endoftext|>', '<|file_separator|>']
      },
      signal
    )) as { choices?: { text?: string }[] }
    const text = res.choices?.[0]?.text
    return typeof text === 'string' ? text : null
  }

  /** A chat model has no fill-in-the-middle objective, so it is told the job. */
  private async viaChat(request: GhostRequest, s: Settings, signal: AbortSignal): Promise<string> {
    const base = s.ghostBaseUrl.replace(/\/+$/, '')
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (s.ghostApiKey) headers.authorization = `Bearer ${s.ghostApiKey}`

    const chat = (await post(
      `${base}/chat/completions`,
      headers,
      {
        model: s.ghostModel || 'gpt-4o-mini',
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userTurn(request) }
        ]
      },
      signal
    )) as { choices?: { message?: { content?: string } }[] }
    return chat.choices?.[0]?.message?.content ?? ''
  }

  /**
   * Through whichever Claude credential is actually available — a key here, a key
   * in the environment, or the Claude Code CLI sign-in. Reading the key field
   * directly, which is what this did at first, fails for everyone who signed in
   * through the browser rather than pasting a key.
   */
  private async viaClaude(request: GhostRequest, s: Settings): Promise<string> {
    const res = await this.ai().oneShot(
      SYSTEM,
      userTurn(request),
      MAX_TOKENS,
      s.ghostModel || 'claude-haiku-4-5-20251001'
    )
    if (!res.ok) throw new Error(res.error)
    return res.text
  }
}

const SYSTEM = [
  'You complete code at a cursor.',
  'Reply with the code that belongs at the cursor and nothing else:',
  'no explanation, no commentary, and no code fences.',
  'Continue the prefix exactly — do not repeat any of it, and do not repeat the suffix.',
  'Prefer a short completion. One line is usually right.'
].join(' ')

function userTurn(request: GhostRequest): string {
  return [
    `Language: ${request.language}`,
    '',
    'Code before the cursor:',
    request.prefix,
    '',
    'Code after the cursor:',
    request.suffix
  ].join('\n')
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal
): Promise<unknown> {
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, timeout])
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`)
  return res.json()
}

/**
 * What a model returns is not always what can be inserted.
 *
 * Chat models fence their answers however firmly they are told not to, and both
 * kinds sometimes carry on into text that is already on the other side of the
 * caret — which would appear as the next few lines written twice.
 */
function clean(text: string, suffix: string): string {
  let out = text.replace(/^\s*```[a-zA-Z0-9+-]*\n?/, '').replace(/```\s*$/, '')

  // Never a leading newline: the suggestion starts where the caret is.
  out = out.replace(/^\n+/, '')

  const head = suffix.trimStart().split('\n')[0]?.trim()
  if (head && head.length > 3) {
    const at = out.indexOf(head)
    if (at > 0) out = out.slice(0, at)
  }
  return out.replace(/\s+$/, '')
}

function describe(err: unknown, provider: GhostProvider, baseUrl: string): string {
  const message = err instanceof Error ? err.message : String(err)
  // AiService already words the credential case, and it knows about all three
  // doors rather than only the key. Its sentence is better than one made here.
  if (/ECONNREFUSED|fetch failed|Failed to fetch/i.test(message)) {
    return provider === 'local'
      ? `Nothing is listening at ${baseUrl}. Start your model server, or change the address in Settings.`
      : `Could not reach ${baseUrl}.`
  }
  if (/\b401\b|\b403\b/.test(message)) return 'The endpoint refused the key.'
  if (/timed? ?out|AbortError/i.test(message)) return 'The suggestion took too long and was dropped.'
  return message.slice(0, 200)
}
