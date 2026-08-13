// Session restore, checked the only way that means anything: build a workspace,
// close the app, launch it again, and look at what came back.
//
// The app's own userData directory holds the session file, so this runs against a
// throwaway one — a verification run must not overwrite the workspace someone had
// open.
//
// Run: node scripts/verify-session.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-session-'))
const userData = path.join(work, 'userData')
const files = ['one.ts', 'two.ts'].map((name, i) => {
  const file = path.join(work, name)
  fs.writeFileSync(file, `export const n${i} = ${i}\n`, 'utf8')
  return file
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** A separate userData keeps this off the real session file. */
const launch = (args) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, `--user-data-dir=${userData}`, ...args],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const shape = (page) =>
  page.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    panes: document.querySelectorAll('.pane').length,
    terminals: document.querySelectorAll('.pane:not(.editor)').length,
    editorTabs: Array.from(document.querySelectorAll('.etab__label')).map((l) => l.textContent),
    shownPath: document.querySelector('.pane.editor')?.getAttribute('data-editor-path') ?? null,
    dirty: document.querySelector('.pane.editor')?.getAttribute('data-dirty') ?? null,
    sidebarOpen: !!document.querySelector('.sidebar'),
    sidebarView: document.querySelector('.sidebar')?.getAttribute('data-view') ?? null
  }))

// --- build a workspace worth restoring --------------------------------------
{
  const app = await launch(files)
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
  await sleep(2000)

  // Splitting acts on the active pane and only splits terminals, so the terminal
  // has to be focused first — opening files left the editor active.
  await page.click('.pane:not(.editor) .composer__input')
  await sleep(400)
  await page.keyboard.press('Control+Shift+D')
  await sleep(1500)
  await page.keyboard.press('Control+Shift+G')
  await sleep(800)

  await page.locator('.etab', { hasText: 'one.ts' }).click()
  await sleep(600)
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nconst unsavedEdit = 42\n', { delay: 8 })
  await sleep(900)

  const before = await shape(page)
  check('built two editor tabs', before.editorTabs.length === 2, JSON.stringify(before.editorTabs))
  check('with an unsaved edit', before.dirty === 'true', before.dirty)
  check('and a split', before.terminals >= 2, `${before.terminals} terminals`)
  await page.screenshot({ path: path.join(SHOT_DIR, '90-session-before.png') })

  // The debounce has to be allowed to fire before the window goes.
  await sleep(2500)
  await app.close()
  await sleep(1200)
}

const sessionFile = path.join(userData, 'session.json')
check('a session file was written', fs.existsSync(sessionFile))
if (fs.existsSync(sessionFile)) {
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  check('it is versioned', saved.version === 1, String(saved.version))
  check('and holds the unsaved text', JSON.stringify(saved).includes('unsavedEdit'))
  // Command output is deliberately not kept; a stale block would look live.
  check('but not terminal scrollback', !JSON.stringify(saved).includes('"blocks"'))
}

// --- launch again with no arguments and see what comes back -----------------
{
  const app = await launch([])
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4000)

  const after = await shape(page)
  check('the editor tabs came back', after.editorTabs.length === 2, JSON.stringify(after.editorTabs))
  check('in the same order', after.editorTabs.join(',') === 'one.ts,two.ts', after.editorTabs.join(','))
  check('showing the same file', after.shownPath === files[0], after.shownPath)
  check('the split came back', after.terminals >= 2, `${after.terminals} terminals`)
  check('the sidebar reopened', after.sidebarOpen === true)
  check('on the same view', after.sidebarView === 'scm', after.sidebarView)

  // The point of keeping unsaved text: it has to be in the buffer, not just the file.
  const text = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pane.editor .view-line'))
      .map((l) => l.textContent ?? '')
      .join('\n')
  )
  check('the unsaved edit survived', text.includes('unsavedEdit'), text.slice(0, 90))
  check('and is still marked unsaved', after.dirty === 'true', after.dirty)
  // Restoring the edit must not have written it to disk behind the user's back.
  check('without touching the file', !fs.readFileSync(files[0], 'utf8').includes('unsavedEdit'))

  await page.screenshot({ path: path.join(SHOT_DIR, '91-session-after.png') })
  await app.close()
  await sleep(800)
}

fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('session restore:', failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
