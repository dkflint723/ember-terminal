// Reopening a file that changed on disk while its tab was closed.
//
// Monaco models are keyed by file URI and outlive their tabs on purpose — that is
// what keeps undo history and the language server's view of a document intact. The
// cost is that a retained buffer can be older than the file, and the editor used to
// hand it straight back: reopening showed the text as it was, and the next Ctrl+S
// wrote that over whatever had happened to the file in between. A `git checkout` or
// a branch switch with the tab closed was enough to lose the change.
//
// The distinction that has to hold is between a buffer the file moved on from and a
// buffer the user edited. The first is brought up to date; the second is kept and
// marked unsaved, so overwriting the newer file is at least a decision. Both are
// checked here, along with the case that only works because saving records the new
// agreement, and every claim is confirmed against the bytes on disk rather than the
// editor's own account of itself.
//
// Run: node scripts/verify-reopen.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('reopen')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-reopen-'))
const note = path.join(work, 'note.ts')
const ORIGINAL = 'export const note = 1\n'
fs.writeFileSync(note, ORIGINAL, 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const read = () => fs.readFileSync(note, 'utf8')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// The folder, not the file: the tree is how a file gets opened again after its tab
// is gone, which is the whole situation being tested.
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
// Closing a tab holding unsaved work asks first. Playwright dismisses dialogs by
// default, which would read as the close being ignored.
const prompts = []
page.on('dialog', (d) => {
  prompts.push(d.message())
  void d.accept()
})

await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const shown = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane.editor')
    return {
      panes: document.querySelectorAll('.pane.editor').length,
      path: pane?.getAttribute('data-editor-path') ?? null,
      dirty: pane?.getAttribute('data-dirty') ?? null,
      // Monaco renders a non-breaking space for indentation; normalised so the
      // text can be compared to what is on disk.
      text: pane?.querySelector('.view-lines')?.textContent?.replace(/ /g, ' ') ?? ''
    }
  })

await page.click('.activity__item[data-view="explorer"]')
await page.waitForSelector('.tree', { timeout: 10_000 })
await sleep(800)

const open = async () => {
  await page.locator('.tree__row', { hasText: 'note.ts' }).first().click()
  await page.waitForSelector('.pane.editor .monaco-editor', { timeout: 20_000 })
  await sleep(1500)
}
const closeTab = async () => {
  const tab = page.locator('.etab', { hasText: 'note.ts' })
  await tab.hover()
  await tab.locator('.etab__close').click()
  await sleep(900)
}
const typeIntoEditor = async (text) => {
  await page.locator('.pane.editor .view-lines').first().click()
  await sleep(300)
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text)
  await sleep(600)
}

// --- an untouched buffer follows the file ------------------------------------
await open()
const first = await shown()
check('the file opens', first.path === note, first.path)
check('showing what is on disk', first.text.includes('note = 1'), first.text)

await closeTab()
check('and its tab can be closed', (await shown()).panes === 0)

// What a branch switch or a `git checkout` does while the tab is closed.
fs.writeFileSync(note, 'export const note = 2\n// changed on disk\n', 'utf8')
await open()

const reopened = await shown()
check(
  'reopening shows the file as it is now, not as it was',
  reopened.text.includes('note = 2') && reopened.text.includes('changed on disk'),
  reopened.text
)
check('and does not claim unsaved changes', reopened.dirty === 'false', reopened.dirty)
await page.screenshot({ path: path.join(SHOT_DIR, '80-reopen-refreshed.png') })

// The point of all of it: the save that follows must not put the old text back.
await page.locator('.pane.editor .view-lines').first().click()
await page.keyboard.press('Control+s')
await sleep(1200)
check(
  'saving after a reopen does not revert the file',
  read() === 'export const note = 2\n// changed on disk\n',
  JSON.stringify(read())
)

// --- a buffer that was saved, then the file changed --------------------------
// This only works because saving records the new agreement: without that the buffer
// looks edited ever after, and the file it was saved from stops being followed.
await typeIntoEditor('\nexport const added = 3\n')
await page.keyboard.press('Control+s')
await sleep(1200)
const afterSave = read()
check('a save writes the edit', afterSave.includes('added = 3'), JSON.stringify(afterSave))
check('and clears the unsaved mark', (await shown()).dirty === 'false')

await closeTab()
fs.writeFileSync(note, 'export const note = 4\n// changed again\n', 'utf8')
await open()
const afterSaveReopen = await shown()
check(
  'a saved buffer still follows the file when it changes later',
  afterSaveReopen.text.includes('note = 4') && !afterSaveReopen.text.includes('added = 3'),
  afterSaveReopen.text
)
check('and is not marked unsaved', afterSaveReopen.dirty === 'false', afterSaveReopen.dirty)

// --- unsaved work is kept, and says so ---------------------------------------
// The other half of the distinction. Bringing this buffer up to date would throw
// away the only copy of what the user typed.
await typeIntoEditor('\n// work in progress\n')
const promptsBefore = prompts.length
await closeTab()
check(
  'closing unsaved work asks first',
  prompts.length > promptsBefore && /unsaved/i.test(prompts[promptsBefore] ?? ''),
  JSON.stringify(prompts)
)

fs.writeFileSync(note, 'export const note = 5\n// changed underneath\n', 'utf8')
await open()
const kept = await shown()
check(
  'unsaved work survives the file changing underneath it',
  kept.text.includes('work in progress'),
  kept.text
)
check(
  'and is marked unsaved against the new content',
  kept.dirty === 'true',
  `${kept.dirty} — ${kept.text}`
)
check(
  'while the file on disk is left alone until the user decides',
  read() === 'export const note = 5\n// changed underneath\n',
  JSON.stringify(read())
)
await page.screenshot({ path: path.join(SHOT_DIR, '81-reopen-kept-edits.png') })

// --- the same thing without closing anything ---------------------------------
// The ordinary version of this: nothing is closed, something rewrites the file, and
// the user opens it again to look at the new version. Revealing an already-open tab
// threw away the text that had just been read for it, so the editor answered with
// the version from before and the next save put that back.
await page.locator('.pane.editor .view-lines').first().click()
await page.keyboard.press('Control+s')
await sleep(1200)

fs.writeFileSync(note, 'export const note = 6\n// while the tab was open\n', 'utf8')
await open()
const revisited = await shown()
check('one editor pane, not a second copy of the file', revisited.panes === 1, `${revisited.panes}`)
check(
  'opening a file whose tab is already open shows the current version',
  revisited.text.includes('note = 6') && revisited.text.includes('while the tab was open'),
  revisited.text
)
check('and does not claim unsaved changes', revisited.dirty === 'false', revisited.dirty)

await page.locator('.pane.editor .view-lines').first().click()
await page.keyboard.press('Control+s')
await sleep(1200)
check(
  'so saving cannot put the old text back',
  read() === 'export const note = 6\n// while the tab was open\n',
  JSON.stringify(read())
)

await app.close()
fs.rmSync(work, { recursive: true, force: true })

profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('reopen after an external change:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
