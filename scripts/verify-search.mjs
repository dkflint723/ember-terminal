// Search across files.
//
// Run against a scratch tree with planted matches, so the expected result is known
// exactly rather than inferred from whatever happens to be in the repository.
//
// Run: node scripts/verify-search.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('search')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-search-'))
fs.mkdirSync(path.join(work, 'src'), { recursive: true })
fs.mkdirSync(path.join(work, 'node_modules', 'junk'), { recursive: true })

fs.writeFileSync(
  path.join(work, 'src', 'alpha.ts'),
  'export const needle = 1\nconst other = 2\n// needle again\n',
  'utf8'
)
fs.writeFileSync(path.join(work, 'src', 'beta.ts'), 'const NEEDLE = "upper"\n', 'utf8')
fs.writeFileSync(path.join(work, 'notes.md'), 'a needle in prose\n', 'utf8')
// Must be skipped: ripgrep honours ignore rules, which is half the reason for it.
fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n', 'utf8')
fs.writeFileSync(path.join(work, 'node_modules', 'junk', 'x.ts'), 'needle needle needle\n', 'utf8')

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

const summary = () => page.locator('.find__summary').textContent()
const results = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.find__group')).map((g) => ({
      file: g.querySelector('.find__name')?.textContent ?? '',
      hits: g.querySelectorAll('.find__hit').length,
      marks: Array.from(g.querySelectorAll('.find__preview mark')).map((m) => m.textContent)
    }))
  )

// --- reachable from the rail -------------------------------------------------
check('the rail offers search', (await page.locator('.activity__item[data-view="search"]').count()) === 1)
await page.keyboard.press('Control+Shift+F')
await page.waitForSelector('.find__box', { timeout: 10_000 })
check('Ctrl+Shift+F opens it', true)

// --- a plain search ----------------------------------------------------------
await page.locator('.find__box').first().fill('needle')
await page.waitForSelector('.find__group', { timeout: 20_000 })
await sleep(900)

const found = await results()
const files = found.map((f) => f.file).sort()
check('finds every file with a match', files.join(',') === 'alpha.ts,beta.ts,notes.md', files.join(','))
check('counts multiple hits in one file', found.find((f) => f.file === 'alpha.ts')?.hits === 2, JSON.stringify(found))
check('ignores node_modules', !files.includes('x.ts'), files.join(','))
check('highlights the match', found.every((f) => f.marks.every((m) => m?.toLowerCase() === 'needle')), JSON.stringify(found))
await page.screenshot({ path: path.join(SHOT_DIR, '98-search.png') })

// --- case sensitivity --------------------------------------------------------
await page.locator('.find__toggle', { hasText: 'Aa' }).click()
await sleep(1200)
const cased = await results()
check(
  'match case drops the uppercase one',
  !cased.map((f) => f.file).includes('beta.ts'),
  cased.map((f) => f.file).join(',')
)
await page.locator('.find__toggle', { hasText: 'Aa' }).click()
await sleep(1000)

// --- restricting by glob -----------------------------------------------------
await page.locator('.find__box--glob').fill('*.md')
await sleep(1400)
const globbed = await results()
check('a glob narrows it to one file', globbed.map((f) => f.file).join(',') === 'notes.md', globbed.map((f) => f.file).join(','))
await page.locator('.find__box--glob').fill('')
await sleep(1200)

// --- clicking a result opens the file at the match ---------------------------
await page.locator('.find__group', { hasText: 'alpha.ts' }).locator('.find__hit').nth(1).click()
await page.waitForSelector('.pane.editor', { timeout: 20_000 })
await sleep(1800)

const landed = await page.evaluate(() => {
  const pane = document.querySelector('.pane.editor')
  return {
    path: pane?.getAttribute('data-editor-path') ?? null,
    // The line the cursor sits on, as Monaco reports it in the status of the view.
    highlighted: document.querySelector('.pane.editor .current-line') !== null
  }
})
check('clicking a result opens that file', landed.path?.endsWith('alpha.ts') === true, landed.path)

// --- no results is an answer, not an error -----------------------------------
await page.locator('.find__box').first().fill('zzz-definitely-not-here-zzz')
await sleep(1500)
const empty = (await summary()) ?? ''
check('reports no results plainly', empty.includes('No results'), empty)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('search:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
