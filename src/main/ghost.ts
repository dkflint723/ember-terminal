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

/**
 * How long a local server is asked to hold the model in memory.
 *
 * Ollama drops a model a few minutes after the last request, and picking it up
 * again is not free: measured on this machine, qwen3-coder:30b answers in 115 ms
 * warm, takes 8.6 s to come back from the page cache, and 42 s from a cold disk.
 * A suggestion cannot wait for any of that, so the model is asked to stay rather
 * than being fetched again every time somebody pauses to think.
 */
const KEEP_ALIVE = '30m'

/**
 * How long loading is allowed to take, which is nothing like how long a suggestion
 * is allowed to take. Eighteen gigabytes off a cold disk is minutes, and the whole
 * point of doing it separately is that nobody is waiting on it.
 */
const LOAD_MS = 300_000

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

/** The four ways a local server will take a fill-in-the-middle request. */
type LocalShape = 'ollama' | 'infill' | 'ollama-raw' | 'completions'

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

/**
 * Loads in flight, so a run of keystrokes asks once — and so that anyone else who
 * wants the model can wait for the load already happening rather than starting a
 * second one or, worse, carrying on as though it were ready.
 *
 * A map of promises rather than a set of keys, which is the difference between
 * "somebody is loading this" and "here is the loading, join it". With a set, the
 * Test button found a load already running, returned immediately, and timed its
 * probe against a model still being read off the disk: nine seconds reported for
 * something that answers in a tenth of one.
 *
 * Keyed like the shape memo, because one server holds several models and loading
 * one says nothing about another.
 */
const warming = new Map<string, Promise<void>>()

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

      /*
       * A local model that has not answered in ten seconds is almost always one
       * that is not in memory yet, and no keystroke should be the thing that waits
       * for eighteen gigabytes to be read off a disk. So the loading is started
       * here and left to finish on its own, and the next keystroke finds it ready.
       * Saying "took too long and was dropped" for this described the symptom and
       * hid the cause — the cause being that nothing had asked for the model yet.
       */
      if (s.ghostProvider === 'local' && isTimeout(err)) {
        void this.warm()
        return {
          ok: false,
          error: 'The model is not in memory yet. Loading it now — suggestions start once it is ready.'
        }
      }
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
  /**
   * The models this server already has, so a name can be chosen rather than typed.
   *
   * A model name is exact, unforgiving and easy to get subtly wrong — `qwen3-coder`
   * without its tag, a colon where a slash belongs — and the failure is an endpoint
   * answering "model not found" for something the user can see is installed. Both
   * kinds of server say what they hold: Ollama at `/api/tags`, anything
   * OpenAI-shaped at `/v1/models`. Both are asked, because one address can be both.
   *
   * An empty list is not an error. It means "nothing to offer here", and the field
   * stays a field somebody can type into — which is what it has to remain anyway,
   * since a server that lists nothing may still answer perfectly well.
   */
  async models(baseUrl?: string): Promise<string[]> {
    /*
     * The address the caller is asking about, which is not always the saved one.
     *
     * Settings edits a draft and writes nothing until Save, so reading the stored
     * address here answered every question about the server the user was leaving.
     * Retype the address, press Refresh, and the list stayed the old server's —
     * offered as installed, because the "not installed" mark is judged against the
     * same wrong list. Picking one then produced "model not found" for a name Ember
     * had just shown as present: the exact failure this feature exists to prevent.
     */
    const s = this.settings()
    const configured = (baseUrl ?? s.ghostBaseUrl).trim()
    if (!configured) return []
    const base = configured.replace(/\/+$/, '')
    const root = base.replace(/\/v1$/, '')
    const found = new Set<string>()

    const read = async (url: string, pick: (json: unknown) => string[]): Promise<void> => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
        if (!res.ok) return
        for (const name of pick(await res.json())) if (name) found.add(name)
      } catch {
        // A server that does not answer this is a server with nothing to say.
      }
    }

    await Promise.all([
      read(`${root}/api/tags`, (json) => {
        const list = (json as { models?: { name?: string; model?: string }[] }).models ?? []
        return list.map((m) => m.name ?? m.model ?? '')
      }),
      read(`${base}/models`, (json) => {
        const list = (json as { data?: { id?: string }[] }).data ?? []
        return list.map((m) => m.id ?? '')
      })
    ])

    return [...found].sort((a, b) => a.localeCompare(b))
  }

  /**
   * Ask a local server to load the model and hold on to it.
   *
   * Sent with no prompt, which Ollama reads as "load this and keep it" — so the
   * waiting happens once, in the background, instead of inside a suggestion nobody
   * is going to want by the time it arrives. A server that does not understand the
   * request is a server that does not need it, so a failure here is silence.
   */
  async warm(): Promise<void> {
    const s = this.settings()
    // Not for a feature that is switched off: loading eighteen gigabytes for
    // suggestions nobody asked for is worse than the wait it saves.
    if (!s.ghostEnabled || s.ghostProvider !== 'local' || !s.ghostModel.trim()) return

    const root = s.ghostBaseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
    const key = shapeKey(root, s.ghostModel)

    const already = warming.get(key)
    if (already) return already

    const load = (async (): Promise<void> => {
      try {
        await post(
          `${root}/api/generate`,
          { 'content-type': 'application/json' },
          { model: s.ghostModel, keep_alive: KEEP_ALIVE },
          AbortSignal.timeout(LOAD_MS + 30_000),
          LOAD_MS
        )
      } catch {
        // Nothing to report: whoever asked has already been told something better.
      } finally {
        warming.delete(key)
      }
    })()
    warming.set(key, load)
    return load
  }

  async test(): Promise<GhostTest> {
    const s = this.settings()

    /*
     * Loaded first, and not counted.
     *
     * "Check it works" is the one moment where waiting is the right answer, and a
     * large local model is not in memory until something asks for it. Timing the
     * probe from after the load is what makes the number mean what it says: how
     * long a suggestion takes once the thing is running, not how long a disk took
     * once.
     */
    if (s.ghostProvider === 'local') await this.warm()

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
   * So the shapes that exist are tried in turn, and the one that answers is
   * remembered for that address. Ollama's `/api/generate` takes prefix and suffix
   * as separate fields; llama.cpp's `/infill` does the same under different names;
   * the same Ollama endpoint in raw mode takes sentinels with no template applied;
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
    const all: LocalShape[] = ['ollama', 'infill', 'ollama-raw', 'completions']
    const order = known ? [known, ...all.filter((shape) => shape !== known)] : all

    /*
     * One deadline for the whole ladder rather than one per rung.
     *
     * Each shape carried its own ten-second timeout, and there are four of them,
     * so a server that hangs rather than refusing could hold a single suggestion
     * for forty seconds — and a local server that answers one request at a time
     * spends all forty unable to answer the request the caret is actually waiting
     * on. Nobody wants a suggestion that arrives forty seconds after they typed.
     */
    const deadline = AbortSignal.timeout(TIMEOUT_MS)
    const bounded = AbortSignal.any([signal, deadline])

    let last: unknown = null
    for (const shape of order) {
      try {
        const text = await this.askLocal(shape, root, base, request, s, bounded)
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
        // Out of time is not "try the next shape": there is no time to try it in.
        if (signal.aborted || deadline.aborted) throw err
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
          keep_alive: KEEP_ALIVE,
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

    /*
     * Sentinels through Ollama's own endpoint, with the chat template switched off.
     *
     * For a model trained to fill in the middle that ships no infill template —
     * Qwen3-Coder is the one to hand, which refuses the suffix field outright with
     * "does not support insert" and then answers sentinels perfectly well. Ordered
     * ahead of `/v1/completions` because that endpoint applies the template even
     * on a base model: asked to complete `add(a, b)`, the measured answer there is
     * a fenced code block, so the line offered as a suggestion was ```typescript.
     */
    if (shape === 'ollama-raw') {
      const res = (await post(
        `${root}/api/generate`,
        headers,
        {
          model: s.ghostModel || undefined,
          prompt: sentinelPrompt(s.ghostModel, request),
          raw: true,
          stream: false,
          keep_alive: KEEP_ALIVE,
          options: { temperature: 0.1, num_predict: MAX_TOKENS, stop: STOPS }
        },
        signal
      )) as { response?: string }
      return typeof res.response === 'string' ? res.response : null
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
  signal: AbortSignal,
  timeoutMs: number = TIMEOUT_MS
): Promise<unknown> {
  const timeout = AbortSignal.timeout(timeoutMs)
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
/**
 * How many brackets a stretch of text leaves open.
 *
 * Crude by design — string bodies and line comments are dropped first, which is
 * enough for the line or two a suggestion spans and far cheaper than parsing it.
 * It exists to answer one question: is a closing line the completion's own, or is
 * it the one that was already on the far side of the caret?
 */
function openDepth(text: string): number {
  const bare = text
    .replace(/\\./g, '')
    .replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
    .replace(/\/\/.*$/gm, '')
  let depth = 0
  for (const ch of bare) {
    if (ch === '{' || ch === '[' || ch === '(') depth++
    else if (ch === '}' || ch === ']' || ch === ')') depth--
  }
  return depth
}

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
    /*
     * Only where the completion has nothing of its own still open.
     *
     * A lone `}` is both the commonest suffix line in any curly-braced language
     * and the way a completion closes a block it just opened. Cutting on the text
     * alone therefore took the closing line off any suggestion that balanced
     * itself — asked to finish `return ` before a closing brace, a model answered
     * an ordinary object literal and had its last line removed, leaving an opening
     * brace with no partner to be inserted into the file.
     */
    const stop = lines.findIndex(
      (line, i) => i > 0 && line.trim() === head && openDepth(lines.slice(0, i).join('\n')) <= 0
    )
    if (stop > 0) out = lines.slice(0, stop).join('\n')
  }
  return out.replace(/\s+$/, '')
}

/** Whether this is the deadline rather than a refusal or a dead port. */
function isTimeout(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /timed? ?out|AbortError|The operation was aborted/i.test(message)
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
