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

// --- an open editor follows a rename ----------------------------------------
// A document holds the path it saves to, and renaming used to leave that behind: the
// tab went on pointing at a name that no longer existed, so the next save recreated
// the old file with the edits in it while the renamed one kept the text from before.
// Auto-save made it worse by doing that without the user touching anything.
await page.locator('.tree__head .icon-btn[title="New file"]').click()
await page.waitForSelector('.tree__input', { timeout: 10_000 })
await page.locator('.tree__input').fill('notes.md')
await page.keyboard.press('Enter')
await sleep(1600)

await page.locator('.pane.editor .view-lines').first().click()
await page.keyboard.press('Control+End')
await page.keyboard.type('# notes worth keeping')
// Left sitting a moment with the cursor in it, so any language-server chatter this
// file provokes happens before the rename as well as after it.
await sleep(2500)

await page.locator('.tree__row', { hasText: 'notes.md' }).first().click({ button: 'right' })
await page.waitForSelector('.menu', { timeout: 10_000 })
await page.locator('.menu__item', { hasText: 'Rename' }).click()
await page.waitForSelector('.tree__input', { timeout: 10_000 })
await page.locator('.tree__input').fill('notes-2024.md')
await page.keyboard.press('Enter')
await sleep(1800)

// Monaco renders spaces as non-breaking ones, so the text is normalised before it
// is compared with anything a person wrote.
const editorText = () =>
  page.evaluate(
    () => document.querySelector('.pane.editor .view-lines')?.textContent?.replace(/\s+/g, ' ') ?? ''
  )

const followed = await page.evaluate(() => ({
  tabs: Array.from(document.querySelectorAll('.etab__label')).map((l) => l.textContent),
  shownPath: document.querySelector('.pane.editor')?.getAttribute('data-editor-path') ?? null,
  language: document.querySelector('.pane.editor .editor__lang')?.textContent ?? null,
  text: document.querySelector('.pane.editor .view-lines')?.textContent?.replace(/\s+/g, ' ') ?? ''
}))
check('the renamed file keeps a language of its own', followed.language === 'markdown', followed.language)
check('the open tab follows the new name', followed.tabs.includes('notes-2024.md'), JSON.stringify(followed.tabs))
check(
  'and points at the new path',
  followed.shownPath === path.join(work, 'notes-2024.md'),
  followed.shownPath
)
check('with the unsaved edit still in the buffer', followed.text.includes('notes worth keeping'), followed.text)

await page.locator('.pane.editor .view-lines').first().click()
await page.keyboard.press('Control+s')
await sleep(1600)
check(
  'saving writes to the renamed file',
  fs.existsSync(path.join(work, 'notes-2024.md')) &&
    fs.readFileSync(path.join(work, 'notes-2024.md'), 'utf8').includes('notes worth keeping'),
  fs.existsSync(path.join(work, 'notes-2024.md'))
    ? JSON.stringify(fs.readFileSync(path.join(work, 'notes-2024.md'), 'utf8'))
    : 'missing'
)
check('and does not recreate the old one', !fs.existsSync(path.join(work, 'notes.md')))

// --- a deleted file's buffer is the only copy left ---------------------------
// The text is kept deliberately, but the tab has to say it is unsaved: a tab that
// looks saved while nothing on disk backs it is how work disappears unnoticed.
await page.locator('.tree__row', { hasText: 'notes-2024.md' }).first().click({ button: 'right' })
await page.waitForSelector('.menu', { timeout: 10_000 })
await page.locator('.menu__item', { hasText: 'Delete' }).click()
await sleep(2000)
check('the deleted file is gone from disk', !fs.existsSync(path.join(work, 'notes-2024.md')))
const orphanedText = await editorText()
const orphanedDirty = await page.evaluate(
  () => document.querySelector('.pane.editor')?.getAttribute('data-dirty') ?? null
)
check('its buffer is kept', orphanedText.includes('notes worth keeping'), orphanedText)
check('and marked unsaved, since nothing on disk holds it now', orphanedDirty === 'true', orphanedDirty)

// --- delete goes to the recycle bin -----------------------------------------
await page.locator('.tree__row', { hasText: 'made-dir' }).first().click({ button: 'right' })
await page.waitForSelector('.menu', { timeout: 10_000 })
await page.locator('.menu__item', { hasText: 'Delete' }).click()
await sleep(2000)
check('the folder is gone from disk', !fs.existsSync(path.join(work, 'made-dir')))
check('and gone from the tree', !(await labels()).includes('made-dir'), JSON.stringify(await labels()))

/*
 * --- a byte-order mark survives editing ---------------------------------------
 *
 * Monaco strips a leading U+FEFF when it builds a model, so the stored copy never
 * matched the buffer — every file with a BOM opened already marked unsaved — and
 * saving wrote the stripped text back, removing a mark other Windows tools use to
 * decide a file's encoding.
 */
const bomFile = path.join(work, 'bom.txt')
fs.writeFileSync(bomFile, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hello\n')]))

await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('bom.txt')
await sleep(900)
await page.keyboard.press('Enter')
await page.waitForSelector('.pane.editor', { timeout: 20_000 })
await sleep(2000)

check(
  'a file with a byte-order mark opens clean, not already modified',
  (await page.locator('.pane.editor[data-dirty="true"]').count()) === 0,
  await page.locator('.pane.editor').first().getAttribute('data-dirty')
)

await page.locator('.pane.editor .view-lines').first().click()
await page.keyboard.press('Control+End')
await page.keyboard.type('!')
await sleep(700)
await page.keyboard.press('Control+s')
await sleep(2500)

const savedBytes = fs.readFileSync(bomFile)
check(
  'and keeps its byte-order mark when saved',
  savedBytes[0] === 0xef && savedBytes[1] === 0xbb && savedBytes[2] === 0xbf,
  savedBytes.toString('hex').slice(0, 24)
)
check(
  'without doubling it',
  savedBytes.toString('utf8').replace(/^﻿/, '').startsWith('hello'),
  JSON.stringify(savedBytes.toString('utf8').slice(0, 12))
)

await page.screenshot({ path: path.join(SHOT_DIR, '102-tree-after.png') })
await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('file operations:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
