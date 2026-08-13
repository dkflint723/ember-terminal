// The problems view, driven by real diagnostics from a real language server.
//
// The file planted here has a genuine type error, so what shows up is whatever
// tsserver actually says rather than a fixture that agrees with itself.
//
// Run: node scripts/verify-problems.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('problems')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-problems-'))
const broken = path.join(work, 'broken.ts')
fs.writeFileSync(broken, 'export const count: number = "not a number"\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, broken],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
const BENIGN = [/textDocument\/foldingRange failed/]
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- the badge appears without the view ever being opened -------------------
await page.waitForSelector('.activity__badge--bad', { timeout: 40_000 })
const badge = await page.locator('.activity__badge--bad').textContent()
check('an error badge appears on the rail', Number(badge) >= 1, badge)

// --- the view lists it -------------------------------------------------------
await page.keyboard.press('Control+Shift+M')
await page.waitForSelector('.probs', { timeout: 10_000 })
await sleep(900)

const listed = await page.evaluate(() => ({
  summary: document.querySelector('.probs__summary')?.textContent ?? '',
  rows: Array.from(document.querySelectorAll('.probs__row')).map((r) => ({
    message: r.querySelector('.probs__message')?.textContent ?? '',
    where: r.querySelector('.probs__where')?.textContent ?? '',
    severity: r.querySelector('.probs__dot')?.className ?? ''
  })),
  file: document.querySelector('.find__name')?.textContent ?? ''
}))

check('it lists the diagnostic', listed.rows.length >= 1, JSON.stringify(listed))
check('grouped under the file', listed.file === 'broken.ts', listed.file)
check(
  'with the language server’s own message',
  listed.rows[0]?.message.includes('not assignable'),
  listed.rows[0]?.message
)
check('marked as an error', listed.rows[0]?.severity.includes('error'), listed.rows[0]?.severity)
check('and says where', /\d+:\d+/.test(listed.rows[0]?.where ?? ''), listed.rows[0]?.where)
check('the summary counts errors', listed.summary.includes('error'), listed.summary)
await page.screenshot({ path: path.join(SHOT_DIR, '103-problems.png') })

// --- clicking one goes there -------------------------------------------------
await page.locator('.probs__row').first().click()
await sleep(1200)
const landed = await page.evaluate(() => ({
  path: document.querySelector('.pane.editor')?.getAttribute('data-editor-path') ?? null,
  focused: document.querySelector('.monaco-editor.focused') !== null
}))
// Compared case-insensitively: Monaco normalises a Windows drive letter to lower
// case in its URIs, so the panel reports `c:\…` where Node produced `C:\…`. Same
// file, and Monaco treats them as the same model.
check(
  'clicking a problem opens that file',
  landed.path?.toLowerCase() === broken.toLowerCase(),
  landed.path
)

// --- fixing it clears the list ----------------------------------------------
// Edited in the buffer rather than on disk. The language server holds the open
// document in memory, so a write behind its back changes nothing it can see.
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+A')
await page.keyboard.type('export const count: number = 42', { delay: 8 })
await sleep(5000)

const cleared = await page.evaluate(() => ({
  rows: document.querySelectorAll('.probs__row').length,
  empty: document.querySelector('.probs--empty')?.textContent ?? null,
  badge: document.querySelector('.activity__badge--bad')?.textContent ?? null
}))
check('fixing the file empties the list', cleared.rows === 0, JSON.stringify(cleared))
check('and the badge goes away', cleared.badge === null, cleared.badge)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('problems:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
