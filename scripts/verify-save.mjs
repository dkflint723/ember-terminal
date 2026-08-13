// Auto save and Save All.
//
// Both write to disk without being asked to on the spot, so what matters is that
// they write the right thing, and that auto save stays off until it is turned on.
//
// Run: node scripts/verify-save.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('save')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-save-'))
const one = path.join(work, 'one.ts')
const two = path.join(work, 'two.ts')
fs.writeFileSync(one, 'const one = 1\n', 'utf8')
fs.writeFileSync(two, 'const two = 2\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, one],
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
await sleep(2500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const read = (f) => fs.readFileSync(f, 'utf8')

const typeInEditor = async (text) => {
  await page.locator('.pane.editor .view-lines').first().click()
  await sleep(300)
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
  await sleep(500)
}

/** Set a numeric setting the way a person would, through the dialog. */
const setNumber = async (labelText, value) => {
  await page.keyboard.press('Control+Comma')
  await page.waitForSelector('.modal', { timeout: 10_000 })
  await page.locator('.field', { hasText: labelText }).locator('input').fill(String(value))
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('.modal__actions .btn')].find((b) =>
      b.textContent?.includes('Save')
    )
    save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(900)
}

// --- off by default ----------------------------------------------------------
await typeInEditor('// waiting')
await sleep(4000)
check(
  'nothing is written while auto save is off',
  read(one) === 'const one = 1\n',
  JSON.stringify(read(one))
)

// --- on --------------------------------------------------------------------
await setNumber('Auto save after', 1)
await typeInEditor('// saved by itself')
await sleep(4000)
check(
  'auto save writes after typing stops',
  read(one).includes('// saved by itself'),
  JSON.stringify(read(one))
)
check(
  'and the editor no longer reads as unsaved',
  (await page.locator('.pane.editor[data-dirty="true"]').count()) === 0
)

// --- Save All ----------------------------------------------------------------
await setNumber('Auto save after', 0)
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('two')
await sleep(800)
await page.keyboard.press('Enter')
await sleep(2500)

await typeInEditor('// two edited')
const dirtyBefore = await page.locator('.pane.editor[data-dirty="true"]').count()
check('the second file is edited and unsaved', dirtyBefore === 1, String(dirtyBefore))

await page.keyboard.press('Control+Alt+S')
await sleep(2500)
check('Save All writes the edited file', read(two).includes('// two edited'), JSON.stringify(read(two)))
check(
  'Save All leaves nothing unsaved',
  (await page.locator('.pane.editor[data-dirty="true"]').count()) === 0
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('auto save + save all:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
