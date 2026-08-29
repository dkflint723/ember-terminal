// Change bars in the editor margin, against HEAD, live from the buffer.
//
// A committed file is opened, edited without saving, and the margin must say
// so: blue on the changed line, green on the new one, and Alt+click on a mark
// must put that hunk back the way HEAD has it. An untracked file must show
// nothing — there is no HEAD to disagree with.
//
// Run: node scripts/verify-gutters.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('gutters')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-gutters-'))
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'verify@example.invalid')
git('config', 'user.name', 'Verify')
const tracked = path.join(repo, 'tracked.ts')
fs.writeFileSync(tracked, 'const one = 1\nconst two = 2\nconst three = 3\n', 'utf8')
git('add', '-A')
git('commit', '-qm', 'initial')
const loose = path.join(repo, 'loose.ts')
fs.writeFileSync(loose, 'export const untracked = true\n', 'utf8')

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, tracked],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const marks = () =>
  page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('tracked.ts'))
    if (!model) return null
    const all = model
      .getAllDecorations()
      .map((d) => ({
        cls: d.options.linesDecorationsClassName ?? '',
        line: d.range.startLineNumber
      }))
      .filter((d) => d.cls.startsWith('gutter-'))
    return all
  })

// --- an unsaved edit shows immediately -----------------------------------------
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('Shift+End')
await page.keyboard.type('const one = 100', { delay: 8 })
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst four = 4', { delay: 8 })
await sleep(1200)

const dirty = await marks()
check('marks exist for an unsaved edit', (dirty?.length ?? 0) >= 2, JSON.stringify(dirty))
check(
  'the changed line wears blue',
  dirty?.some((d) => d.cls === 'gutter-modified' && d.line === 1) === true,
  JSON.stringify(dirty)
)
check(
  'the new line wears green',
  dirty?.some((d) => d.cls === 'gutter-added') === true,
  JSON.stringify(dirty)
)

// --- Alt+click puts the hunk back ----------------------------------------------
const mark = page.locator('.gutter-modified').first()
await page.keyboard.down('Alt')
await mark.click({ force: true })
await page.keyboard.up('Alt')
await sleep(800)
const reverted = await page.evaluate(() => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('tracked.ts'))
  return model?.getLineContent(1) ?? ''
})
check('Alt+click restores the committed line', reverted === 'const one = 1', reverted)
const afterRevert = await marks()
check(
  'and its mark goes with it',
  afterRevert?.some((d) => d.cls === 'gutter-modified') === false,
  JSON.stringify(afterRevert)
)

// --- untracked files stay quiet -------------------------------------------------
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('loose')
await sleep(600)
await page.keyboard.press('Enter')
await sleep(1500)
const looseMarks = await page.evaluate(() => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('loose.ts'))
  if (!model) return null
  return model
    .getAllDecorations()
    .filter((d) => (d.options.linesDecorationsClassName ?? '').startsWith('gutter-')).length
})
check('an untracked file shows no marks', looseMarks === 0, String(looseMarks))

await app.close()
profile.cleanup()
fs.rmSync(repo, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('git gutters:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
