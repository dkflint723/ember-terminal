// Editor tabs: several files in one pane, switching between them, dirty marks and
// closing. Driven through the UI, because the thing being checked is that a pane
// holds more than one file without the terminal beside it losing any space.
//
// Run: node scripts/verify-tabs.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('tabs')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-tabs-'))
const files = ['alpha.ts', 'beta.ts', 'gamma.ts'].map((name, i) => {
  const file = path.join(work, name)
  fs.writeFileSync(file, `export const value${i} = ${i}\n`, 'utf8')
  return file
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// All three named on the command line: the first opens a split, the rest must
// become tabs in it rather than splitting the workspace three ways.
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, ...files],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)

const errors = []
const BENIGN = [/textDocument\/foldingRange failed/]
// Closing a tab with unsaved changes asks first, so the prompts are recorded and
// accepted. Playwright dismisses them by default, which reads as the close being
// ignored.
const prompts = []
page.on('dialog', (d) => {
  prompts.push(d.message())
  void d.accept()
})
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(2500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const state = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane.editor')
    return {
      panes: document.querySelectorAll('.pane').length,
      editorPanes: document.querySelectorAll('.pane.editor').length,
      tabs: Array.from(document.querySelectorAll('.etab')).map((t) => ({
        label: t.querySelector('.etab__label')?.textContent ?? '',
        active: t.classList.contains('etab--active'),
        // Read from the dot the tab actually shows rather than from a modifier
        // class. There used to be an `.etab--dirty` as well, which nothing styled —
        // so this check was passing on a hook that had no consequence on screen,
        // and would have gone on passing if the dot had stopped being drawn.
        dirty: !!t.querySelector('.editor__dirty')
      })),
      shownPath: pane?.getAttribute('data-editor-path') ?? null,
      shownDirty: pane?.getAttribute('data-dirty') ?? null,
      firstLine:
        document.querySelector('.pane.editor .view-line')?.textContent?.replace(/ /g, ' ') ??
        null,
      terminalStillThere: !!document.querySelector('.composer__input')
    }
  })

const opened = await state()
check('three files became three tabs', opened.tabs.length === 3, JSON.stringify(opened.tabs))
check('in a single editor pane', opened.editorPanes === 1, `saw ${opened.editorPanes}`)
check('beside the terminal, not instead of it', opened.terminalStillThere)
check('the workspace is two panes, not four', opened.panes === 2, `saw ${opened.panes}`)
check('the last opened file is showing', opened.shownPath === files[2], opened.shownPath)
check('its tab is the active one', opened.tabs[2]?.active === true, JSON.stringify(opened.tabs))
await page.screenshot({ path: path.join(SHOT_DIR, '40-editor-tabs.png') })

// --- switching ------------------------------------------------------------
await page.locator('.etab', { hasText: 'alpha.ts' }).click()
await sleep(900)
const switched = await state()
check('clicking a tab shows that file', switched.shownPath === files[0], switched.shownPath)
check('and its content', switched.firstLine?.includes('value0'), switched.firstLine)
check('and marks it active', switched.tabs[0]?.active === true, JSON.stringify(switched.tabs))

// --- per-tab dirty state ---------------------------------------------------
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst edited = true\n', { delay: 8 })
await sleep(900)
const dirtied = await state()
check('editing marks only that tab dirty', dirtied.tabs.filter((t) => t.dirty).length === 1, JSON.stringify(dirtied.tabs))
check('and it is the edited one', dirtied.tabs[0]?.dirty === true, JSON.stringify(dirtied.tabs))

// Switching away and back must keep the edit — each file has its own model.
await page.locator('.etab', { hasText: 'beta.ts' }).click()
await sleep(700)
const onBeta = await state()
check('the other tab is not dirty', onBeta.shownDirty === 'false', onBeta.shownDirty)
check('and shows its own content', onBeta.firstLine?.includes('value1'), onBeta.firstLine)

await page.locator('.etab', { hasText: 'alpha.ts' }).click()
await sleep(700)
const backOnAlpha = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.pane.editor .view-line'))
    .map((l) => l.textContent?.replace(/ /g, ' ') ?? '')
    .join('\n')
)
check('the unsaved edit survived the round trip', backOnAlpha.includes('const edited = true'), backOnAlpha.slice(0, 80))

// --- reordering -------------------------------------------------------------
// Last, because it renumbers the tabs and the checks above are written by index.
// The active index points at a position rather than at a document, so a reorder
// that failed to carry it would quietly switch which file is on screen.
const beforeMove = (await state()).tabs.map((t) => t.label)
await page
  .locator('.etab', { hasText: 'gamma.ts' })
  .dragTo(page.locator('.etab', { hasText: 'alpha.ts' }))
await sleep(1200)
const afterMove = await state()
check(
  'a tab can be dragged to a new position',
  afterMove.tabs[0]?.label.includes('gamma') === true,
  `${beforeMove.join(',')} -> ${afterMove.tabs.map((t) => t.label).join(',')}`
)
/*
 * Picking a tab up selects it, as it does in VS Code, so the dragged file is the
 * one that should be on screen when it lands. This is the check that tells a
 * working reorder from a broken one: the active index points at a position, so an
 * implementation that left it alone would still show whatever ended up at index 2
 * — beta — rather than the tab the user was holding.
 */
check(
  'the dragged file is the one still on screen',
  afterMove.shownPath === files[2],
  `expected gamma, got ${afterMove.shownPath}`
)
check(
  'and its tab is the active one',
  afterMove.tabs.find((t) => t.active)?.label.includes('gamma') === true,
  JSON.stringify(afterMove.tabs)
)

// --- closing ---------------------------------------------------------------
// The × is revealed on hover, as in VS Code, so an inactive tab has to be pointed
// at before its close control can be clicked.
const closeTab = async (name) => {
  const tab = page.locator('.etab', { hasText: name })
  if ((await tab.count()) === 0) return
  await tab.hover()
  await tab.locator('.etab__close').click()
  await sleep(800)
}

await closeTab('gamma.ts')
const closed = await state()
check('closing a tab removes it', closed.tabs.length === 2, JSON.stringify(closed.tabs))
check('and leaves the pane', closed.editorPanes === 1, `saw ${closed.editorPanes}`)

// Closing the last tab should take the pane with it, leaving the terminal alone.
// alpha.ts still holds the unsaved edit from earlier, so this also exercises the
// prompt: closing unsaved work without being asked is how work disappears.
const promptsBefore = prompts.length
for (const name of ['alpha.ts', 'beta.ts']) await closeTab(name)
check(
  'closing a tab with unsaved changes asks first',
  prompts.length > promptsBefore && /unsaved/i.test(prompts[promptsBefore] ?? ''),
  JSON.stringify(prompts)
)
const emptied = await state()
check('closing the last tab closes the pane', emptied.editorPanes === 0, `saw ${emptied.editorPanes}`)
check('the terminal is still there', emptied.terminalStillThere)
await page.screenshot({ path: path.join(SHOT_DIR, '41-tabs-closed.png') })

await app.close()
fs.rmSync(work, { recursive: true, force: true })

profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('editor tabs:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
