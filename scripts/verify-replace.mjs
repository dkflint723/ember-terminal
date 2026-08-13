// Replace across files.
//
// The interesting part is not that text changes — it is what the replacement
// refuses to touch: a file with unsaved edits open in an editor, and a result that
// has gone out of date since it was found.
//
// Run: node scripts/verify-replace.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('replace')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-replace-'))
fs.mkdirSync(path.join(work, 'src'), { recursive: true })

const alpha = path.join(work, 'src', 'alpha.ts')
const beta = path.join(work, 'src', 'beta.ts')
const held = path.join(work, 'src', 'held.ts')

// CRLF on purpose: rejoining split lines is where a replacement quietly rewrites
// every line ending in a file it was only meant to edit one line of.
fs.writeFileSync(alpha, 'const needle = 1\r\nconst other = 2\r\nlet needle2 = needle\r\n', 'utf8')
fs.writeFileSync(beta, 'export const needle = "b"\n', 'utf8')
fs.writeFileSync(held, 'const needle = "held"\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

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
const BENIGN = [/textDocument\/foldingRange failed/]
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const read = (f) => fs.readFileSync(f, 'utf8')
const summary = () => page.locator('.find__summary').textContent()

const search = async (term) => {
  await page.locator('.find__box').first().fill(term)
  await sleep(1600)
}

await page.keyboard.press('Control+Shift+F')
await page.waitForSelector('.find__box', { timeout: 10_000 })

// --- a file with unsaved edits is left alone ---------------------------------
// Opened and edited first, so the replacement below has something to refuse.
await search('needle')
await page.locator('.find__group', { hasText: 'held.ts' }).locator('.find__hit').first().click()
await page.waitForSelector('.pane.editor', { timeout: 20_000 })
await sleep(1500)
await page.locator('.pane.editor .view-lines').first().click()
await page.keyboard.type('// edited')
await sleep(1200)
check(
  'the edited file is marked unsaved',
  (await page.locator('.pane.editor[data-dirty="true"]').count()) === 1,
  await page.locator('.pane.editor').first().getAttribute('data-dirty')
)

// The search panel is still open — pressing its shortcut again would collapse it.
await search('needle')

// --- replace all -------------------------------------------------------------
await page.locator('.find__box').nth(1).fill('pin')
await page.locator('.find__replace').first().click()
await sleep(2500)

check('every plain match is replaced', !read(alpha).includes('needle'), JSON.stringify(read(alpha)))
check('other files are replaced too', read(beta).includes('pin'), JSON.stringify(read(beta)))
check('line endings survive', read(alpha).includes('\r\n'), JSON.stringify(read(alpha)))
check(
  'unrelated text is untouched',
  read(alpha).includes('const other = 2'),
  JSON.stringify(read(alpha))
)
check(
  'a file with unsaved edits is not written',
  read(held) === 'const needle = "held"\n',
  JSON.stringify(read(held))
)

const said = (await summary()) ?? ''
check('it says what it did', /Replaced \d+ match/.test(said), said)
check('and says what it skipped', said.includes('unsaved'), said)

// --- an open, saved file is refreshed rather than left stale -----------------
// alpha.ts is open in the editor from the click above only if it was opened; the
// held file was. Open alpha now and confirm the editor shows the replaced text.
await search('pin')
await page.locator('.find__group', { hasText: 'alpha.ts' }).locator('.find__hit').first().click()
await sleep(2000)
const shown = await page.evaluate(
  () => document.querySelector('.pane.editor .view-lines')?.textContent ?? ''
)
check('the editor shows the replaced text', shown.includes('pin'), shown.slice(0, 120))

// --- regex with a capture group ---------------------------------------------
await page.locator('.find__toggle', { hasText: '.*' }).click()
await search('const (\\w+)')
await page.locator('.find__box').nth(1).fill('let $1')
await page.locator('.find__replace').first().click()
await sleep(2500)
check(
  'a capture group is expanded, not written literally',
  read(alpha).includes('let pin = 1') && !read(alpha).includes('$1'),
  JSON.stringify(read(alpha))
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('replace in files:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
