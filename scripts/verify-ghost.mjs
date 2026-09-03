// The suggestion ahead of the caret, and the rules about when not to ask for one.
//
// This is the one feature in the app that spends something every time it runs —
// money at a paid endpoint, a subscription through Claude, a GPU locally — so the
// checks are as much about restraint as about the suggestion appearing at all:
// that it is off until asked for, that it does not fire while the language
// server's own completion list is on screen, and that a provider key never
// reaches the window that renders command output as HTML.
//
// A stub server stands in for the model, so this is repeatable and needs no GPU,
// no key and no network — the same trick verify-blocks uses for Anthropic.
//
// Run: node scripts/verify-ghost.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('ghost')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- a model that is only a promise -------------------------------------------
/*
 * The stub answers both shapes a local server can offer, because which one Ember
 * reaches for is the thing this most needs to pin.
 *
 * "OpenAI-compatible" turned out not to be enough. Ollama runs the prompt of
 * `/v1/completions` through the model's chat template, so fill-in-the-middle
 * sentinels arrive as literal text and the model echoes the prefix back in a code
 * fence — measured against qwen2.5-coder:1.5b, which answered `a + b;` correctly
 * through `/api/generate` and returned "```typescript
function add(..." through
 * the other. A released version shipped preferring the wrong one.
 */
/*
 * What a fill-in-the-middle model actually returns when it does not stop at the
 * suffix: the answer, then the line that was already there, then more besides.
 * Asked to finish `return ` before a closing brace, one wrote the brace and three
 * further functions.
 */
const OVERRUN = "STUB_SUGGESTION\n}\n\nfunction extra() {}"

/*
 * A completion that opens a block and closes it again. Its last line is a lone
 * `}` — the same line as the one already on the far side of the caret, and the
 * commonest suffix line in any curly-braced language. Cutting there because the
 * text matches leaves the buffer holding an opening brace with no partner.
 */
const BALANCED = ['{', "    name: 'x'", '  }'].join('\n')

const seen = []
/** Requests whose client went away before the answer was written. */
const calledOff = []
const sentBack = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const sent = JSON.parse(body || '{}')
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: sent })

    /*
     * A model this server has no fill-in-the-middle template for is refused, which
     * is what Ollama does and what the fall-through is for. Refused only for the
     * `suffix` field, because that is precisely what it cannot do: the same model
     * takes sentinels perfectly well in raw mode, where no template is applied.
     * Measured against qwen3-coder:30b, which answers "does not support insert" to
     * one and `return a + b;` to the other.
     */
    if (
      req.url === '/api/generate' &&
      String(sent.model).includes('no-template') &&
      sent.suffix !== undefined
    ) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: `${sent.model} does not support insert` }))
      return
    }

    /*
     * No /infill here, because Ollama has none — that endpoint is llama.cpp's, and
     * a stub that answers everything cannot show which one is preferred or what
     * happens when the preferred one is refused.
     */
    if (req.url === '/infill') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    /*
     * A model that takes its time, so a request can still be in flight when the
     * next keystroke supersedes it — and which notices when the client gives up
     * waiting. Cancellation is invisible from the asking side: the only place it
     * can be observed is here, at the server that was asked.
     */
    if (String(sent.model).includes('slow')) {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ response: OVERRUN }))
      }, 3000)
      res.on('close', () => {
        if (!res.writableFinished) {
          clearTimeout(timer)
          calledOff.push(req.url)
        }
      })
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    if (req.url === '/api/generate') {
      const answer = String(sent.model).includes('balanced') ? BALANCED : OVERRUN
      sentBack.push({ model: sent.model, answer, gotSuffix: sent.suffix })
      res.end(JSON.stringify({ response: answer }))
    } else {
      res.end(JSON.stringify({ choices: [{ text: 'STUB_COMPLETIONS' }] }))
    }
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ghost-'))
fs.writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
fs.writeFileSync(
  path.join(work, 'sample.ts'),
  ['export const AI_MODELS = [1, 2, 3]', 'export const AI_MODES = 4', ''].join('\n')
)

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env: { ...env, EMBER_FAKE_AI: '1' },
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
/*
 * Monaco's own cancellation bookkeeping is not this app's defect.
 *
 * Starting an inline-suggest session has exactly one public entry —
 * `editor.action.inlineSuggest.trigger` — and it supersedes whatever request is in
 * flight, leaving the superseded one as an unhandled `Canceled` inside Monaco's
 * emitter. Measured across three designs: none at all without the trigger (and
 * then nothing is ever drawn), three with it called plainly, one with it deferred
 * and fired only to open a session that is not already open. The last is what
 * ships. Every other page error is still fatal here.
 */
page.on('pageerror', (e) => {
  if (e.message === 'Canceled') return
  errors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2500)

/*
 * --- off, for everybody, until it is asked for -------------------------------
 *
 * The first thing checked, because it is the one that costs someone money if it
 * is ever wrong. A default that quietly bills a keystroke is not a default.
 */
const fresh = await page.evaluate(() => window.ember.getSettings())
check('suggestions are off in a fresh profile', fresh.ghostEnabled === false, String(fresh.ghostEnabled))

// Quick open needs the file list before it can match anything, so it is given
// room rather than a guess.
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp', { timeout: 15_000 })
await sleep(1200)
await page.keyboard.type('sample.ts', { delay: 30 })
await page.waitForFunction(() => document.querySelectorAll('.qp__label').length > 0, {
  timeout: 30_000
})
await sleep(400)
await page.keyboard.press('Enter')
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(4000)

const typeAtEnd = async (text) => {
  await page.click('.monaco-editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(text, { delay: 80 })
  await sleep(3500)
}

await typeAtEnd('// note ')
check('and nothing is asked of anyone while they are off', seen.length === 0, `${seen.length} requests`)
check(
  'so no suggestion is drawn',
  (await page.locator('.ghost-text-decoration').count()) === 0
)

// --- turned on, against the stub ----------------------------------------------
await page.evaluate(
  (p) =>
    window.ember.setSettings({
      ghostEnabled: true,
      ghostProvider: 'local',
      ghostBaseUrl: `http://127.0.0.1:${p}/v1`,
      ghostModel: 'stub',
      ghostDebounceMs: 100
    }),
  port
)
await sleep(1200)
await typeAtEnd('// note ')

const shown = await page.evaluate(() => {
  const el = document.querySelector('.ghost-text-decoration')
  return el ? el.textContent.trim() : ''
})
check('a suggestion is drawn once they are on', shown.includes('STUB_SUGGESTION'), JSON.stringify(shown))
check('and something was actually asked', seen.length > 0, `${seen.length} requests`)

/*
 * Asked as a fill-in-the-middle model, not in prose. A local code model has that
 * objective and answering it in the wrong shape is both slower and worse; the
 * sentinels are the difference between the two.
 */
const first = seen[0]
check(
  'the native fill-in-the-middle endpoint is preferred',
  first?.url === '/api/generate',
  `${first?.url} — a server offering /api/generate must not be asked through /v1/completions`
)
check(
  'with the text before the caret and the text after it as separate fields',
  typeof first?.body?.prompt === 'string' && typeof first?.body?.suffix === 'string',
  JSON.stringify({ prompt: typeof first?.body?.prompt, suffix: typeof first?.body?.suffix })
)
check(
  'and the suggestion is the one that endpoint gave',
  shown.includes('STUB_SUGGESTION') && !shown.includes('STUB_COMPLETIONS'),
  JSON.stringify(shown)
)
check(
  'cut where it ran back into the code that follows the caret',
  !shown.includes('function extra'),
  JSON.stringify(shown)
)
check('and no key sent to a local server', first?.auth === null, String(first?.auth))

/*
 * --- and it stays out of the way of the language server ----------------------
 *
 * Ember's own completion already answers here. Two popups over each other — one a
 * list, one a ghost — is the state where neither can be read and Tab means two
 * different things.
 */
seen.length = 0
await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.type('AI_MO', { delay: 90 })
await sleep(3000)

const widget = await page.evaluate(() => {
  const w = document.querySelector('.suggest-widget')
  return !!w && getComputedStyle(w).display !== 'none' && w.getBoundingClientRect().height > 4
})
if (widget) {
  check('nothing is asked while the completion list is open', seen.length === 0, `${seen.length} requests`)
} else {
  // Not a failure of the app: this machine's server may not have answered in time.
  console.log('note: the suggest widget did not open, so the deferral check was skipped')
}
await page.keyboard.press('Escape')

/*
 * --- the suppressions, which are where the quality is -------------------------
 *
 * A raw model dropped into an editor is accepted about eighteen per cent of the
 * time; the shipped products reach roughly thirty by deciding when *not* to ask.
 * These are the cheap versions of that, and each one also declines to spend
 * whatever the chosen provider charges.
 */
seen.length = 0
await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('End')
// The caret now sits at the end of line 1, which has code after it on line 2 but
// nothing after it on its own line — so this one is allowed to ask.
await sleep(2000)
const allowedAtLineEnd = seen.length

seen.length = 0
await page.keyboard.press('Control+Home')
// Home puts the caret before `export`, so the rest of the line is code. Completing
// in front of existing text is the shape people reject fastest.
await sleep(2500)
check(
  'nothing is asked with code still ahead of the caret',
  seen.length === 0,
  `${seen.length} requests (line-end asked ${allowedAtLineEnd})`
)

seen.length = 0
await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.type('someIdentifier', { delay: 60 })
await sleep(2500)
check(
  'nor part-way through an identifier, which the language server owns',
  seen.length === 0,
  `${seen.length} requests`
)

/*
 * The same question twice is the same answer twice, and the second one is paid
 * for. Asked once, then arrowed away and back to the identical position.
 */
await page.keyboard.press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.type('// twice ', { delay: 60 })
await sleep(2500)
const asked = seen.length
await page.keyboard.press('ArrowUp')
await sleep(600)
await page.keyboard.press('ArrowDown')
await page.keyboard.press('End')
await sleep(2500)
check(
  'and a question already answered is not asked again',
  seen.length === asked,
  `${asked} then ${seen.length}`
)

/*
 * --- Claude answers through whichever door is open ----------------------------
 *
 * The first version read the API key field directly and gave up when it was
 * empty — which is the normal state for anyone signed in through the Claude Code
 * CLI, so choosing Claude here failed with "no credential" while the panel beside
 * it worked perfectly. It goes through the app's own Claude access now, and this
 * profile has no key at all, so a plain refusal would be the old bug returning.
 *
 * EMBER_FAKE_AI stands in for the network, the same seam the agent suites use.
 */
seen.length = 0
await page.evaluate(() => window.ember.setSettings({ ghostProvider: 'claude', ghostModel: '' }))
await sleep(800)
const viaClaude = await page.evaluate(() =>
  window.ember.ghostComplete(4242, {
    prefix: 'const total = ',
    suffix: '\n',
    language: 'typescript'
  })
)
check(
  'choosing Claude does not fail for want of a pasted key',
  viaClaude.ok || !/no credential|add an API key/i.test(String(viaClaude.error)),
  JSON.stringify(viaClaude)
)
check('and it asks nothing of the local server', seen.length === 0, `${seen.length} requests`)

/*
 * --- and there is a way to find out why nothing is appearing -------------------
 *
 * Suggestions fail quietly by design: nothing appears, which is also what happens
 * when the model has nothing to say. So a wrong address and a quiet moment look
 * identical from the outside, and the only way to tell them apart is to ask.
 *
 * The first version of this reported "the endpoint answered, but with nothing" for
 * a dead port, a wrong model and an empty answer alike — every local shape was
 * tried, each failure swallowed, and an empty string returned. Which is the least
 * useful thing a diagnostic can do.
 */
await page.evaluate(() => window.ember.setSettings({ ghostProvider: 'local', ghostBaseUrl: 'http://127.0.0.1:9/v1' }))
await sleep(600)
const dead = await page.evaluate(() => window.ember.ghostTest())
check(
  'a dead address is named as one',
  !dead.ok && /nothing is listening/i.test(String(dead.error)),
  JSON.stringify(dead)
)

await page.evaluate((p) => window.ember.setSettings({ ghostBaseUrl: `http://127.0.0.1:${p}/v1` }), port)
await sleep(600)
const good = await page.evaluate(() => window.ember.ghostTest())
check('and a working one answers with what it said', good.ok, JSON.stringify(good))

/*
 * --- the sentinels are the model's own dialect --------------------------------
 *
 * A model handed another family's fill-in-the-middle tokens does not fail. It
 * reads them as ordinary text and answers confidently with nonsense — asked to
 * finish a function, one returned a README and an MIT licence. So there is
 * nothing for a fallback to catch, and the dialect has to be chosen up front from
 * the model's name rather than discovered by trying.
 */
seen.length = 0
await page.evaluate(
  (p) =>
    window.ember.setSettings({
      ghostProvider: 'local',
      ghostBaseUrl: `http://127.0.0.1:${p}/v1`,
      ghostModel: 'no-template'
    }),
  port
)
await sleep(600)
const refused = await page.evaluate(() => window.ember.ghostTest())
check('a server that refuses the native endpoint still gets an answer', refused.ok, JSON.stringify(refused))

const fellBack = seen.filter((r) => r.url === '/api/generate' && r.body?.raw === true).pop()
check(
  'by falling through to sentinels with the template switched off',
  fellBack !== undefined,
  JSON.stringify(seen.map((r) => `${r.url}${r.body?.raw ? ' raw' : ''}`))
)
/*
 * And not to `/v1/completions`, which is the endpoint that applies the chat
 * template even to a base model. That fall-through is why a released version
 * offered "```typescript" as its suggestion, and it is one place below raw mode
 * in the ladder for exactly that reason.
 */
check(
  'rather than to the endpoint that would wrap the answer in a code fence',
  !seen.some((r) => r.url === '/v1/completions'),
  JSON.stringify(seen.map((r) => r.url))
)
check(
  "in the model's own dialect",
  String(fellBack?.body?.prompt ?? '').includes('<|fim_prefix|>'),
  JSON.stringify(String(fellBack?.body?.prompt ?? '').slice(0, 40))
)

seen.length = 0
await page.evaluate(() => window.ember.setSettings({ ghostModel: 'starcoder2-no-template' }))
await sleep(600)
await page.evaluate(() => window.ember.ghostTest())
const asStarcoder = seen.filter((r) => r.url === '/api/generate' && r.body?.raw === true).pop()
check(
  'and a StarCoder-family name gets StarCoder tokens instead',
  String(asStarcoder?.body?.prompt ?? '').includes('<fim_prefix>') &&
    !String(asStarcoder?.body?.prompt ?? '').includes('<|fim_prefix|>'),
  JSON.stringify(String(asStarcoder?.body?.prompt ?? '').slice(0, 40))
)

/*
 * And what worked is remembered against the model, not the address. One server
 * serves many models and they do not agree: remembering it against the address
 * alone meant the second model inherited the first one's shape and simply failed.
 */
seen.length = 0
await page.evaluate(() => window.ember.setSettings({ ghostModel: 'stub' }))
await sleep(600)
const afterSwitch = await page.evaluate(() => window.ember.ghostTest())
check(
  'a second model at the same address is asked its own way',
  afterSwitch.ok,
  JSON.stringify(afterSwitch)
)
check(
  'through the endpoint that suits it',
  seen.some((r) => r.url === '/api/generate'),
  JSON.stringify(seen.map((r) => r.url))
)

// --- the key stays in main ------------------------------------------------------
await page.evaluate(() =>
  window.ember.setSettings({ ghostProvider: 'openai', ghostApiKey: 'sk-secret-value-here' })
)
await sleep(1000)
const readBack = await page.evaluate(() => window.ember.getSettings())
check('a provider key is never handed to the renderer', readBack.ghostApiKey === null, String(readBack.ghostApiKey))
check('though the window is told one exists', readBack.hasGhostKey === true, String(readBack.hasGhostKey))

const onDisk = fs.readFileSync(path.join(profile.dir, 'settings.json'), 'utf8')
check('and it is not sitting in the settings file in the clear', !onDisk.includes('sk-secret-value-here'))

/*
 * A superseded request is called off.
 *
 * The design says so in three places — main holds an abort controller per request,
 * the bridge carries a `ghostCancel`, and the comments on both say the caller
 * cancels on every keystroke. Nothing called it. So every abandoned request ran to
 * completion: billed in full on a paid provider, and on a local one queued ahead
 * of the only answer still wanted, which is why typing at speed produced no
 * suggestion rather than a late one.
 */
calledOff.length = 0
seen.length = 0
await page.evaluate(
  (p) =>
    window.ember.setSettings({
      ghostBaseUrl: `http://127.0.0.1:${p}/v1`,
      ghostModel: 'slow',
      ghostDebounceMs: 100
    }),
  port
)
await sleep(800)
await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.type('const total = ', { delay: 60 })
// Past the debounce, so the slow request is now in flight and unanswered.
await sleep(900)
await page.keyboard.type('1', { delay: 60 })
await sleep(1800)
check(
  'a superseded request is called off rather than left to finish',
  calledOff.length >= 1,
  JSON.stringify({ calledOff: calledOff.length, asked: seen.length })
)

/*
 * A suggestion that balances itself keeps its closing line.
 *
 * The rule that stops a model running past the caret cuts the answer at the first
 * line matching the text already on the far side. It was matched at any length on
 * purpose, so that the commonest suffix line of all — a lone `}` — would match at
 * all. But a completion that opens a block closes it with that same line, and
 * cutting there hands the buffer an opening brace with no partner.
 *
 * Checked on the buffer rather than on the drawn text, because an unbalanced file
 * is the actual harm.
 */
await page.evaluate(
  (p) =>
    window.ember.setSettings({
      // Named explicitly: an earlier case leaves the provider elsewhere, and a
      // chat provider answers this probe with an empty string rather than a
      // truncated one, which would look like the very bug being checked for.
      ghostProvider: 'local',
      ghostBaseUrl: `http://127.0.0.1:${p}/v1`,
      ghostModel: 'balanced',
      ghostDebounceMs: 100
    }),
  port
)
await sleep(700)
/*
 * Asked directly rather than through the editor, because the claim is about what
 * comes back and not about how Monaco draws it.
 */
const balanced = await page.evaluate(() =>
  window.ember.ghostComplete(9901, {
    prefix: 'export function make() {\n  return ',
    suffix: '\n}\n',
    language: 'typescript'
  })
)
check(
  'a suggestion that closes what it opened keeps its closing line',
  balanced?.ok === true && balanced.text.trim().endsWith('}'),
  JSON.stringify({ balanced, asked: sentBack[sentBack.length - 1] })
)
const netBraces =
  (String(balanced?.text ?? '').match(/{/g) ?? []).length -
  (String(balanced?.text ?? '').match(/}/g) ?? []).length
check(
  'so inserting it cannot leave the file unbalanced',
  netBraces === 0,
  JSON.stringify({ net: netBraces, text: balanced?.text })
)

await app.close()
profile.cleanup()
server.close()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('ghost text:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
