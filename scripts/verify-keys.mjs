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

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('shortcuts from the editor:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
