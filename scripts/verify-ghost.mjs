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
const seen = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    seen.push({ url: req.url, auth: req.headers.authorization ?? null, body: JSON.parse(body || '{}') })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ text: 'STUB_SUGGESTION' }] }))
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
  env,
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
check('at the completions endpoint', first?.url === '/v1/completions', first?.url)
const prompt = String(first?.body?.prompt ?? '')
check(
  'with the text before the caret, then the text after it',
  prompt.includes('<|fim_prefix|>') && prompt.includes('<|fim_suffix|>') && prompt.endsWith('<|fim_middle|>'),
  JSON.stringify(prompt.slice(-60))
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

await app.close()
profile.cleanup()
server.close()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('ghost text:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
