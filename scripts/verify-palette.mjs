// Quick open (Ctrl+P) and the command palette (Ctrl+Shift+P).
//
// Run: node scripts/verify-palette.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('palette')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-palette-'))
fs.mkdirSync(path.join(work, 'src', 'components'), { recursive: true })
fs.mkdirSync(path.join(work, 'node_modules', 'junk'), { recursive: true })
fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules/\n', 'utf8')
fs.writeFileSync(path.join(work, 'src', 'components', 'EditorPane.tsx'), 'export const a = 1\n', 'utf8')
fs.writeFileSync(path.join(work, 'src', 'index.ts'), 'export const b = 2\n', 'utf8')
fs.writeFileSync(path.join(work, 'readme.md'), '# hi\n', 'utf8')
fs.writeFileSync(path.join(work, 'node_modules', 'junk', 'EditorPane.tsx'), 'nope\n', 'utf8')

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
const rows = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.qp__item')).map((i) => ({
      label: i.querySelector('.qp__label')?.textContent ?? '',
      detail: i.querySelector('.qp__detail')?.textContent ?? '',
      on: i.classList.contains('qp__item--on')
    }))
  )

// --- quick open --------------------------------------------------------------
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(1500)

const all = await rows()
check('lists workspace files', all.length >= 3, `${all.length} rows`)
check('and skips ignored ones', !all.some((r) => r.detail.includes('node_modules')), JSON.stringify(all.slice(0, 6)))

// Initials should find the file, which is the whole point of a fuzzy match.
await page.locator('.qp__box').fill('edpane')
await sleep(500)
const fuzzy = await rows()
check('matches on a subsequence', fuzzy[0]?.label === 'EditorPane.tsx', JSON.stringify(fuzzy.slice(0, 3)))
check('the first row is selected', fuzzy[0]?.on === true)
await page.screenshot({ path: path.join(SHOT_DIR, '99-quick-open.png') })

// Enter opens it.
await page.keyboard.press('Enter')
await page.waitForSelector('.pane.editor', { timeout: 20_000 })
await sleep(1200)
const opened = await page.evaluate(
  () => document.querySelector('.pane.editor')?.getAttribute('data-editor-path') ?? null
)
check('Enter opens the highlighted file', opened?.endsWith('EditorPane.tsx') === true, opened)
check('and the overlay closes', (await page.locator('.qp').count()) === 0)

// --- arrow keys move the selection ------------------------------------------
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(1200)
await page.keyboard.press('ArrowDown')
await sleep(300)
const moved = await rows()
check('arrow down moves the selection', moved[1]?.on === true, JSON.stringify(moved.slice(0, 3)))
await page.keyboard.press('Escape')
await sleep(400)
check('Escape closes it', (await page.locator('.qp').count()) === 0)

// --- command palette ---------------------------------------------------------
await page.keyboard.press('Control+Shift+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(500)
const commands = await rows()
check('the palette lists commands', commands.length >= 8, `${commands.length}`)
check(
  'including the views',
  commands.some((c) => c.label.includes('Source Control')),
  commands.map((c) => c.label).slice(0, 6).join(' | ')
)

// Running one has to actually do the thing.
await page.locator('.qp__box').fill('source control')
await sleep(400)
await page.keyboard.press('Enter')
await sleep(900)
check('running a command performs it', (await page.locator('.scm').count()) === 1)
check('and closes the palette', (await page.locator('.qp').count()) === 0)
await page.screenshot({ path: path.join(SHOT_DIR, '100-palette.png') })

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('quick open + palette:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
