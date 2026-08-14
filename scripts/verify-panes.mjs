// Pane bookkeeping across tabs.
//
// Several pane operations find a pane by searching every pane rather than the
// tab's own, then mark it active in a tab whose layout does not contain it. The
// observable result is that opening a file already open elsewhere appears to do
// nothing at all.
//
// Run: node scripts/verify-panes.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('panes')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-panes-'))
const shared = path.join(work, 'shared.ts')
fs.writeFileSync(shared, 'export const value = 1\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, shared],
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
await sleep(2000)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const view = () =>
  page.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    editors: document.querySelectorAll('.pane.editor').length,
    panes: document.querySelectorAll('.pane').length,
    shown: Array.from(document.querySelectorAll('.pane.editor')).map((p) =>
      p.getAttribute('data-editor-path')
    )
  }))

const first = await view()
check('the file opened in the first tab', first.editors === 1, JSON.stringify(first))

// A second tab, then open the file that is already open in the first one.
await page.keyboard.press('Control+Shift+T')
await sleep(2500)
const fresh = await view()
check('the new tab starts without an editor', fresh.editors === 0, JSON.stringify(fresh))

await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(1800)
await page.locator('.qp__box').fill('shared')
await sleep(700)
await page.keyboard.press('Enter')
await sleep(2500)

const opened = await view()
// Either the file appears here, or the app switches to the tab already showing it.
// What must not happen is the click doing nothing visible at all.
check(
  'opening a file already open elsewhere shows it somewhere',
  opened.editors >= 1 && opened.shown.some((p) => p?.endsWith('shared.ts')),
  JSON.stringify(opened)
)

// The tab the request came from must be left intact. It is the one the bug
// corrupted: it was given an active pane out of another tab's layout, and a tab
// whose active pane is not its own cannot act on it. Splitting is the cheapest
// observable proof, since a split is made from whatever pane is active — and this
// tab holds only a terminal, which is the simplest form of it.
await page.locator('.tab').nth(1).click()
await sleep(1200)
const before = (await view()).panes
await page.keyboard.press('Control+Shift+D')
await sleep(2000)
const after = (await view()).panes
check('the requesting tab is still intact and can split', after > before, `${before} → ${after}`)

/*
 * --- splitting an editor gives you an editor ----------------------------------
 *
 * A split used to mean "another shell" whatever had focus, so asking for one from
 * an editor moved a terminal somewhere else in the tab and there was no way to put
 * two files side by side at all. Two views of one file are safe: the buffer is a
 * model keyed by URI, so they are the same text, not a copy of it.
 */
// Back to the tab that has the file open; the checks above left us on the other one.
await page.locator('.tab').first().click()
await sleep(1500)
await page.locator('.pane.editor').first().click()
await sleep(600)
const beforeSplit = await view()
await page.keyboard.press('Control+Shift+D')
await sleep(1500)
const split = await view()
check(
  'splitting from an editor makes a second editor',
  split.editors === beforeSplit.editors + 1,
  `${beforeSplit.editors} → ${split.editors}`
)
check(
  'and it is showing the same file',
  split.shown.filter((p) => p && p.endsWith('shared.ts')).length === 2,
  JSON.stringify(split.shown)
)

// One buffer, not two copies of one: typing in the new half must show in the old.
await page.locator('.pane.editor').last().locator('.view-lines').click()
await sleep(400)
await page.keyboard.press('Control+End')
await page.keyboard.type('// typed in the split')
await sleep(900)
const bothDirty = await page.locator('.pane.editor[data-dirty="true"]').count()
check('an edit in one half is an edit in the file', bothDirty === 2, String(bothDirty))

await page.keyboard.press('Control+s')
await sleep(2000)
check(
  'and saving settles both halves',
  (await page.locator('.pane.editor[data-dirty="true"]').count()) === 0
)
check(
  'the edit reached disk once',
  fs.readFileSync(shared, 'utf8').match(/typed in the split/g)?.length === 1,
  JSON.stringify(fs.readFileSync(shared, 'utf8'))
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('pane bookkeeping:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
