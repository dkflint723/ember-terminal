import type {
  GhostProvider,
  GhostRequest,
  GhostResult,
  GhostTest,
  Settings
} from '../shared/types.js'

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

/**
 * The fragment the Test button asks about.
 *
 * Small, unambiguous, and the same every time, so what comes back says something
 * about the setup rather than about the question.
 */
const PROBE: GhostRequest = {
  prefix: 'function add(a, b) {\n  return ',
  suffix: '\n}\n',
  language: 'javascript'
}

/**
 * The fill-in-the-middle sentinels, in the dialect the model was trained on.
 *
 * This is chosen by name rather than discovered, and that is deliberate: the
 * wrong dialect does not fail. A model handed another family's sentinels reads
 * them as ordinary text and answers confidently with nonsense — asked to finish a
 * function, one returned a README and an MIT licence — so there is nothing for a
 * fallback to catch. Trying them in turn cannot work; the choice has to be made
 * up front.
 *
 * Measured against both families locally: Qwen answers correctly with its own and
 * produces prose with StarCoder's; Mellum and StarCoder2 do the reverse.
 */
type Dialect = 'qwen' | 'starcoder'

const STARCODER_FAMILIES = /starcoder|mellum|codegemma|santacoder|stable-?code/i

function dialectFor(model: string): Dialect {
  return STARCODER_FAMILIES.test(model) ? 'starcoder' : 'qwen'
}

function sentinelPrompt(model: string, request: GhostRequest): string {
  if (dialectFor(model) === 'starcoder') {
    return `<fim_prefix>${request.prefix}<fim_suffix>${request.suffix}<fim_middle>`
  }
  return `<|fim_prefix|>${request.prefix}<|fim_suffix|>${request.suffix}<|fim_middle|>`
}

/** Every family's end markers, since one prompt only ever uses one family's. */
const STOPS = [
  '<|fim_pad|>',
  '<|endoftext|>',
  '<|file_separator|>',
  '<file_sep>',
  '<fim_prefix>',
  '<|fim_prefix|>'
]

/** Just enough of AiService to ask it one short question. */
type OneShot = (
  system: string,
  prompt: string,
  maxTokens: number,
  model?: string
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>

/** The three ways a local server will take a fill-in-the-middle request. */
type LocalShape = 'ollama' | 'infill' | 'completions'

/**
 * Which shape each model turned out to want, so it is worked out once.
 *
 * Keyed by address *and* model, because one server serves many models and they do
 * not agree. Ollama answers `/api/generate` for a model it has a template for and
 * refuses outright for one it does not — so remembering the answer against the
 * address alone meant the second model inherited the first one's shape and failed
 * on it. Measured: Qwen settled the address on `ollama`, and Mellum at the same
 * address was then never asked any other way.
 */
const shapes = new Map<string, LocalShape>()

function shapeKey(base: string, model: string): string {
  return `${base}|${model}`
}

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
   * One deliberate request, so a setup can be checked rather than guessed at.
   *
   * Suggestions fail silently by design — nothing appears, which is also what
   * happens when the model simply has nothing to say — so there is no way to tell
   * a wrong address from a quiet moment by watching. This is the way: press it,
   * and it says what answered, how long it took, and which shape the server spoke.
   */
  async test(): Promise<GhostTest> {
    const s = this.settings()
    const started = Date.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const text =
        s.ghostProvider === 'claude'
          ? await this.viaClaude(
              PROBE,
              s
            )
          : s.ghostProvider === 'local'
            ? await this.viaLocal(
                PROBE,
                s,
                controller.signal
              )
            : await this.viaChat(
                PROBE,
                s,
                controller.signal
              )
      const ms = Date.now() - started
      const cleaned = clean(text, PROBE.suffix)
      if (!cleaned.trim()) {
        return {
          ok: false,
          error: 'The endpoint answered, but with nothing. Check the model name.',
          ms
        }
      }
      return { ok: true, ms, sample: cleaned.slice(0, 80), shape: shapes.get(shapeKey(s.ghostBaseUrl.replace(/\/+$/, ''), s.ghostModel)) ?? null }
    } catch (err) {
      return {
        ok: false,
        error: describe(err, s.ghostProvider, s.ghostBaseUrl),
        ms: Date.now() - started
      }
    } finally {
      clearTimeout(timeout)
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
   * endpoint and returned a fenced copy of the prefix through the
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
    const key = shapeKey(base, s.ghostModel)
    const known = shapes.get(key)

    /*
     * The remembered shape first, then the others — rather than the remembered one
     * alone. A memo can go stale (the model changed, the server was upgraded), and
     * a stale one should cost a wasted request, not the feature.
     */
    const all: LocalShape[] = ['ollama', 'infill', 'completions']
    const order = known ? [known, ...all.filter((shape) => shape !== known)] : all

    let last: unknown = null
    for (const shape of order) {
      try {
        const text = await this.askLocal(shape, root, base, request, s, signal)
        if (text !== null) {
          shapes.set(key, shape)
          return text
        }
      } catch (err) {
        // A shape this server does not implement is a 404, not a failure worth
        // reporting — unless every shape fails, in which case the last thing that
        // went wrong is the useful thing to say. Swallowing them all and returning
        // nothing made a dead port and a wrong model name give the same sentence:
        // "answered, but with nothing".
        if (signal.aborted) throw err
        shapes.delete(key)
        last = err
      }
    }
    if (last) throw last
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
        prompt: sentinelPrompt(s.ghostModel, request),
        max_tokens: MAX_TOKENS,
        temperature: 0.1,
        stop: STOPS
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

  /*
   * Where the answer has run into text already on the other side of the caret,
   * cut it there. A fill-in-the-middle model is supposed to stop at the suffix
   * and often does not: asked to finish `return ` before a closing brace, one
   * obligingly wrote the brace and then three more functions.
   *
   * Matched at the start of a line, at any length. The first version wanted four
   * characters to avoid matching noise, which meant the commonest suffix line in
   * any language — a lone `}` — never matched at all.
   */
  const head = suffix.trimStart().split('\n')[0]?.trim()
  if (head) {
    const lines = out.split('\n')
    /*
     * Opening with it means the model reproduced what was already there and then
     * carried on inventing — there is no completion in front of the repeat to
     * keep, so the honest answer is none. Measured on starcoder2, which answered a
     * closing brace and then wrote the whole function again.
     */
    if (lines[0]?.trim() === head) return ''
    const stop = lines.findIndex((line, i) => i > 0 && line.trim() === head)
    if (stop > 0) out = lines.slice(0, stop).join('\n')
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
