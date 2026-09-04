// Ask Claude with no API key, using the browser sign-in the user already has.
//
// This one makes a REAL request through the Claude Code CLI, because the whole
// point is that the credential works — a stub would prove nothing about it. The
// model is pinned to Haiku in the throwaway profile to keep that cheap, since every
// CLI call carries Claude Code's own system prompt.
//
// Skips rather than fails when the CLI is absent or signed out: that is a fact
// about the machine, not a defect.
//
// Run: node scripts/verify-claude-login.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')

let signedIn = false
try {
  const out = execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', timeout: 30_000 })
  signedIn = JSON.parse(out).loggedIn === true
} catch {
  signedIn = false
}
if (!signedIn) {
  console.log('claude login: SKIP — Claude Code is not installed or not signed in')
  process.exit(0)
}

const profile = newProfile('claude-login')
// Pinned before launch: a cheap model, and no API key, so the CLI path is the only
// one available and the run costs almost nothing.
fs.writeFileSync(
  path.join(profile.dir, 'settings.json'),
  JSON.stringify({ aiModel: 'claude-haiku-4-5-20251001', anthropicApiKey: null }),
  'utf8'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.ANTHROPIC_API_KEY

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- what main says it would use ---------------------------------------------
const credential = await page.evaluate(() => window.ember.aiCredential())
check(
  'with no key, the sign-in is what gets used',
  credential.source === 'claude-code',
  JSON.stringify(credential)
)

// --- and what the dialog tells the user ---------------------------------------
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await page.waitForSelector('.access', { timeout: 15_000 })
await sleep(1200)
const shown = (await page.locator('.access__state').textContent()) ?? ''
check('the dialog says so plainly', /signed in through claude code/i.test(shown), shown)
check(
  'and marks it as working',
  (await page.locator('.access--ok').count()) === 1,
  await page.locator('.access').getAttribute('class')
)
// The key field is still reachable, just not the first thing offered.
check('an API key is still offered as an alternative', (await page.locator('details.field').count()) >= 1)

await page.keyboard.press('Escape')
await sleep(600)

// --- a real request through the CLI -------------------------------------------
// Questions stream into the Claude panel now; what this proves is the thing the
// suite exists for — that the sign-in credential actually answers — so settling
// means the newest assistant turn stopped streaming with words and no error.
// Command *shape* is the schema'd API path's promise, tested where a schema can
// hold it; a real chat model here is only asked to answer at all.
await page.click('.composer__input')
await page.keyboard.press('Control+K')
await sleep(600)
await page.keyboard.type('list files in the current directory', { delay: 5 })
await page.keyboard.press('Enter')

let settled = null
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  settled = await page.evaluate(() => {
    const turns = document.querySelectorAll('.agent__turn--assistant')
    const turn = turns[turns.length - 1]
    if (!turn) return null
    return {
      streaming: !!turn.querySelector('.agent__cursor'),
      error: turn.querySelector('.agent__error')?.textContent ?? null,
      text: (turn.querySelector('.agent__text')?.textContent ?? '').trim()
    }
  })
  if (settled && !settled.streaming && (settled.text.length > 0 || settled.error)) break
}
check(
  'the sign-in answers without any API key',
  settled !== null && !settled.streaming && settled.text.length > 0,
  JSON.stringify(settled)
)
check('and it is not an error', settled?.error == null, String(settled?.error))

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('claude login:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
