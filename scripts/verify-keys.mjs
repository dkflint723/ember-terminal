// Global shortcuts, pressed from inside the editor.
//
// The app's shortcuts are a window-level keydown listener, so any of them can be
// swallowed by whatever has focus. Monaco has its own keybinding table and stops
// the events it recognises, which means a shortcut can work everywhere in the app
// and silently do nothing in the one pane people spend the most time in.
//
// Run: node scripts/verify-keys.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('keys')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-keys-'))
const file = path.join(work, 'sample.ts')
// Deliberately misformatted, so Format Document has something to do.
fs.writeFileSync(file, 'export  const   value=1\nconst    other =2\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, file],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await watchRunning(app)
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

/** Put the caret in the editor, so the next key is delivered to Monaco first. */
const focusEditor = async () => {
  await page.locator('.pane.editor .view-lines').first().click()
  await sleep(400)
}

/*
 * --- and the everything-search means one thing wherever the caret is ------------
 *
 * This suite exists because Monaco keeps its own keybinding table and stops the
 * events it recognises. That is exactly what happened to the merged search: its
 * first chord was Ctrl+Shift+O, which no command in this app's registry wanted —
 * and which Monaco owns as Go to Symbol in File. So the chord the title bar
 * advertised opened the search in a terminal and the symbol list in an editor.
 * Checking the registry for a conflict is not enough when half the window is
 * somebody else's keymap.
 *
 * Both halves are asserted: the search opens in the editor too, and Go to Symbol
 * is still Monaco's. Without the second, moving the chord to something Monaco also
 * owned would pass.
 */
/*
 * Waited for, not slept through. The palette renders a frame or two after the key,
 * and a fixed wait read the window just before it appeared — reporting that
 * nothing had opened while the focus was already inside the palette's own box.
 */
const opened = async () => {
  const read = () =>
    page.evaluate(() => {
      const w = document.querySelector('.quick-input-widget')
      return {
        ember: document.querySelectorAll('.qp').length > 0,
        monaco: w ? getComputedStyle(w).display !== 'none' : false
      }
    })
  const deadline = Date.now() + 8000
  let seen = await read()
  while (!seen.ember && !seen.monaco && Date.now() < deadline) {
    await sleep(200)
    seen = await read()
  }
  return seen
}

await focusEditor()
await page.keyboard.press('Control+Shift+A')
const searchInEditor = await opened()
check(
  'the everything-search opens from inside the editor too',
  searchInEditor.ember,
  JSON.stringify(searchInEditor)
)
await page.keyboard.press('Escape')
await sleep(600)

await focusEditor()
await page.keyboard.press('Control+Shift+O')
const symbols = await opened()
check(
  'and Go to Symbol is still the editor’s own',
  symbols.monaco && !symbols.ember,
  JSON.stringify(symbols)
)
await page.keyboard.press('Escape')
await sleep(500)

/**
 * Dismiss whatever a shortcut opened. The sidebar is left as it is: each case
 * looks for a selector unique to its own view, so a view that is still showing
 * cannot make the next check pass on its behalf.
 */
const reset = async () => {
  await page.keyboard.press('Escape')
  await sleep(250)
  await page.keyboard.press('Escape')
  await sleep(250)
}

const CASES = [
  { keys: 'Control+Shift+F', shows: '.find__box', label: 'Ctrl+Shift+F opens search' },
  { keys: 'Control+B', shows: '.sidebar', label: 'Ctrl+B opens the sidebar', closeFirst: true },
  { keys: 'Control+Shift+G', shows: '.scm', label: 'Ctrl+Shift+G opens source control' },
  { keys: 'Control+Shift+M', shows: '.probs', label: 'Ctrl+Shift+M opens problems' },
  { keys: 'Control+P', shows: '.qp__box', label: 'Ctrl+P opens quick open' },
  { keys: 'Control+Shift+P', shows: '.qp__box', label: 'Ctrl+Shift+P opens the palette' },
  { keys: 'Control+Comma', shows: '.modal', label: 'Ctrl+, opens settings' }
]

for (const c of CASES) {
  await focusEditor()
  /*
   * Ctrl+B is a visibility toggle, not a view selector — VS Code's own semantics,
   * which the D chrome adopted when the chord also took over the session list. A
   * toggle pressed onto an open sidebar closes it, so this case has to begin from
   * a closed one or it would be proving the opposite of its label.
   */
  if (c.closeFirst && (await page.locator(c.shows).count()) > 0) {
    await page.keyboard.press(c.keys)
    await sleep(600)
    await focusEditor()
  }
  await page.keyboard.press(c.keys)
  await sleep(1000)
  const seen = await page.locator(c.shows).count()
  check(c.label, seen > 0, `${c.shows} not shown`)
  await reset()
}

// --- Format Document ---------------------------------------------------------
// The formatting itself comes from the language server, so this is also the proof
// that a formatting provider actually registered. It is registered dynamically,
// which is exactly what a batch of registrations failing part-way through would
// have cost — silently, since an editor with no formatter simply does nothing.
await focusEditor()
const before = await page.evaluate(
  () => document.querySelector('.pane.editor .view-lines')?.textContent ?? ''
)
await page.keyboard.press('Shift+Alt+F')
await sleep(4000)
const after = await page.evaluate(
  () => document.querySelector('.pane.editor .view-lines')?.textContent ?? ''
)
check(
  'Format Document reformats through the language server',
  after !== before && !after.includes('export  const'),
  `${JSON.stringify(before.slice(0, 60))} -> ${JSON.stringify(after.slice(0, 60))}`
)

check(
  'the palette offers Format Document',
  await (async () => {
    await page.keyboard.press('Control+Shift+P')
    await page.waitForSelector('.qp__box', { timeout: 10_000 })
    await page.locator('.qp__box').fill('Format')
    await sleep(700)
    const listed = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.qp__item')).map((i) => i.textContent ?? '')
    )
    await page.keyboard.press('Escape')
    await sleep(300)
    return listed.some((l) => l.includes('Format Document'))
  })()
)

// Ctrl+K must not start a Monaco chord and eat the next keystroke: the freeze that
// looked like the app hanging. Typed text has to arrive intact afterwards.
await focusEditor()
await page.keyboard.press('Escape')
await page.keyboard.press('Control+K')
await sleep(600)
await page.keyboard.press('Escape')
await sleep(300)
await focusEditor()
await page.keyboard.press('End')
await page.keyboard.type('ZZ')
await sleep(600)
const text = await page.evaluate(
  () => document.querySelector('.pane.editor .view-lines')?.textContent ?? ''
)
check('typing still works after Ctrl+K', text.includes('ZZ'), text.slice(0, 100))


/*
 * --- the legends say what the keys actually are ---------------------------
 *
 * Every hint, legend and tooltip used to carry a chord typed by hand, which goes
 * wrong two ways. A chord that moves in keys.ts leaves its mentions behind — that
 * is how "Ctrl B files" outlived Ctrl+B becoming the session list — and someone
 * who rebinds a command is told the old key for as long as the string sits there.
 *
 * So this rebinds one and looks at what the window says afterwards. The mode
 * switch is the one with the most mentions: the welcome card, the retiring hint
 * line under an empty pane, and a palette row.
 */
const legends = async () =>
  page.evaluate(() => ({
    hints: [...document.querySelectorAll('.pane__hints span, .pane__hello-list li')]
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
      .join(' | '),
  }))

const legendsBefore = await legends()
check(
  'the hints start on the default chord',
  legendsBefore.hints.includes('Ctrl Shift I'),
  legendsBefore.hints.slice(0, 120)
)

// Rebound through the same settings path the Shortcuts page writes.
await page.evaluate(async () => {
  await window.ember.setSettings({
    keybindings: { 'mode.toggle': 'Ctrl+Shift+Y' }
  })
})
await sleep(1200)

const legendsAfter = await legends()
check(
  'and follow the command when it is rebound',
  legendsAfter.hints.includes('Ctrl Shift Y') && !legendsAfter.hints.includes('Ctrl Shift I'),
  legendsAfter.hints.slice(0, 160)
)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('shortcuts from the editor:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
