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

export class GhostService {
  constructor(private settings: () => Settings) {}

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
          ? await this.viaClaude(request, s, signal)
          : await this.viaOpenAiCompatible(request, s, signal)
      return { ok: true, text: clean(text, request.suffix) }
    } catch (err) {
      if (signal.aborted) return { ok: false, error: 'cancelled' }
      return { ok: false, error: describe(err, s.ghostProvider, s.ghostBaseUrl) }
    }
  }

  /**
   * The completions endpoint rather than the chat one, because this is where a
   * fill-in-the-middle model can be addressed as what it is.
   *
   * The sentinels are Qwen's and DeepSeek's spelling, which llama.cpp and Ollama
   * both pass through untouched. A server that does not understand them still sees
   * the prefix, so the worst case is an ordinary continuation rather than an error.
   */
  private async viaOpenAiCompatible(
    request: GhostRequest,
    s: Settings,
    signal: AbortSignal
  ): Promise<string> {
    const base = s.ghostBaseUrl.replace(/\/+$/, '')
    const local = s.ghostProvider === 'local'

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (!local && s.ghostApiKey) headers.authorization = `Bearer ${s.ghostApiKey}`

    const body = local
      ? {
          model: s.ghostModel || undefined,
          prompt: `<|fim_prefix|>${request.prefix}<|fim_suffix|>${request.suffix}<|fim_middle|>`,
          max_tokens: MAX_TOKENS,
          temperature: 0.1,
          // A suggestion stops at the end of what it was completing; without this a
          // model happily writes the rest of the file.
          stop: ['<|fim_pad|>', '<|endoftext|>', '<|file_separator|>']
        }
      : {
          model: s.ghostModel || 'gpt-4o-mini',
          prompt: undefined,
          max_tokens: MAX_TOKENS,
          temperature: 0.1
        }

    if (local) {
      const res = await post(`${base}/completions`, headers, body, signal)
      const choice = (res as { choices?: { text?: string }[] }).choices?.[0]
      return choice?.text ?? ''
    }

    // A chat model has no fill-in-the-middle objective, so it is told the job.
    const chat = await post(
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
    )
    const message = (chat as { choices?: { message?: { content?: string } }[] }).choices?.[0]
    return message?.message?.content ?? ''
  }

  /** Through the credential the app already has, so it needs no second key. */
  private async viaClaude(
    request: GhostRequest,
    s: Settings,
    signal: AbortSignal
  ): Promise<string> {
    const key = s.anthropicApiKey
    if (!key) throw new Error('no-credential')

    const res = await post(
      'https://api.anthropic.com/v1/messages',
      {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      {
        model: s.ghostModel || 'claude-haiku-4-5-20251001',
        max_tokens: MAX_TOKENS,
        temperature: 0,
        system: SYSTEM,
        messages: [{ role: 'user', content: userTurn(request) }]
      },
      signal
    )
    const content = (res as { content?: { text?: string }[] }).content
    return content?.map((c) => c.text ?? '').join('') ?? ''
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
  if (message === 'no-credential') {
    return 'Claude has no credential here — add an API key in Settings, or pick another provider.'
  }
  if (/ECONNREFUSED|fetch failed|Failed to fetch/i.test(message)) {
    return provider === 'local'
      ? `Nothing is listening at ${baseUrl}. Start your model server, or change the address in Settings.`
      : `Could not reach ${baseUrl}.`
  }
  if (/\b401\b|\b403\b/.test(message)) return 'The endpoint refused the key.'
  if (/timed? ?out|AbortError/i.test(message)) return 'The suggestion took too long and was dropped.'
  return message.slice(0, 200)
}
