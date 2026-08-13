// Explorer file operations: create, rename, delete, reveal.
//
// Every result is confirmed on disk as well as in the tree. A file manager that
// only redraws itself convincingly is worse than none.
//
// Run: node scripts/verify-fileops.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('fileops')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-fileops-'))
fs.writeFileSync(path.join(work, 'existing.txt'), 'hello\n', 'utf8')
fs.mkdirSync(path.join(work, 'folder'), { recursive: true })

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
page.on('dialog', (d) => void d.accept())
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const labels = () =>
  page.evaluate(() => Array.from(document.querySelectorAll('.tree__label')).map((l) => l.textContent))

await page.click('.activity__item[data-view="explorer"]')
await page.waitForSelector('.tree', { timeout: 10_000 })
await sleep(900)
check('the tree lists what is there', (await labels()).includes('existing.txt'), JSON.stringify(await labels()))

// --- new file ----------------------------------------------------------------
await page.locator('.tree__head .icon-btn[title="New file"]').click()
await page.waitForSelector('.tree__input', { timeout: 10_000 })
await page.locator('.tree__input').fill('made.ts')
await page.keyboard.press('Enter')
await sleep(1500)

check('the file exists on disk', fs.existsSync(path.join(work, 'made.ts')))
check('and appears in the tree', (await labels()).includes('made.ts'), JSON.stringify(await labels()))
// A new file is almost always about to be edited, so it opens.
check('and opens in an editor', (await page.locator('.pane.editor').count()) === 1)

// --- new folder --------------------------------------------------------------
await page.locator('.tree__head .icon-btn[title="New folder"]').click()
await page.waitForSelector('.tree__input', { timeout: 10_000 })
await page.locator('.tree__input').fill('made-dir')
await page.keyboard.press('Enter')
await sleep(1400)
check('the folder exists on disk', fs.statSync(path.join(work, 'made-dir')).isDirectory())
check('and is listed', (await labels()).includes('made-dir'), JSON.stringify(await labels()))

// --- rename ------------------------------------------------------------------
await page.locator('.tree__row', { hasText: 'existing.txt' }).first().click({ button: 'right' })
await page.waitForSelector('.menu', { timeout: 10_000 })
await page.screenshot({ path: path.join(SHOT_DIR, '101-tree-menu.png') })
await page.locator('.menu__item', { hasText: 'Rename' }).click()
await page.waitForSelector('.tree__input', { timeout: 10_000 })
await page.locator('.tree__input').fill('renamed.txt')
await page.keyboard.press('Enter')
await sleep(1500)

check('the old name is gone from disk', !fs.existsSync(path.join(work, 'existing.txt')))
check('the new name is there', fs.existsSync(path.join(work, 'renamed.txt')))
check('with its contents intact', fs.readFileSync(path.join(work, 'renamed.txt'), 'utf8') === 'hello\n')
check('and the tree caught up', (await labels()).includes('renamed.txt'), JSON.stringify(await labels()))

// --- a name collision is refused --------------------------------------------
await page.locator('.tree__head .icon-btn[title="New file"]').click()
await page.waitForSelector('.tree__input', { timeout: 10_000 })
await page.locator('.tree__input').fill('renamed.txt')
await page.keyboard.press('Enter')
await sleep(1200)
const complaint = await page.evaluate(() => document.querySelector('.tree__error')?.textContent ?? '')
check('creating over an existing name is refused', complaint.includes('already taken'), complaint)
check('and the existing file is untouched', fs.readFileSync(path.join(work, 'renamed.txt'), 'utf8') === 'hello\n')

// --- delete goes to the recycle bin -----------------------------------------
await page.locator('.tree__row', { hasText: 'made-dir' }).first().click({ button: 'right' })
await page.waitForSelector('.menu', { timeout: 10_000 })
await page.locator('.menu__item', { hasText: 'Delete' }).click()
await sleep(2000)
check('the folder is gone from disk', !fs.existsSync(path.join(work, 'made-dir')))
check('and gone from the tree', !(await labels()).includes('made-dir'), JSON.stringify(await labels()))

await page.screenshot({ path: path.join(SHOT_DIR, '102-tree-after.png') })
await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('file operations:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
