// Change this, by saying what you want.
//
// Select code, press Ctrl+I, describe the change, and Claude rewrites the
// selection in place. This is the half of the AI story a strong model is good at —
// understanding an intent and making a coherent multi-line edit — as against the
// suggestion ahead of the caret, which is a race a small local model wins.
//
// Deliberately not a diff view, so what this has to prove instead is that the edit
// is a single undoable one: the promise made to the user is that Ctrl+Z puts the
// code back exactly, and that promise is kept by the editor's own stack rather
// than by hand.
//
// EMBER_FAKE_AI stands in for the network, the same seam the agent suites use, so
// this needs no key, no CLI sign-in and no network.
//
// Run: node scripts/verify-inline-edit.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('inline-edit')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-inline-'))
fs.writeFileSync(path.join(work, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }))
const ORIGINAL = ['export function add(a: number, b: number): number {', '  return a + b', '}', ''].join('\n')
fs.writeFileSync(path.join(work, 'math.ts'), ORIGINAL)

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env: { ...env, EMBER_FAKE_AI: '1', EMBER_FAKE_AI_SLOW: '1' },
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => {
  // Monaco's own cancellation bookkeeping — see verify-ghost.mjs for the measurement.
  if (e.message === 'Canceled') return
  errors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2500)

await page.keyboard.press('Control+p')
await page.waitForSelector('.qp', { timeout: 15_000 })
await sleep(900)
await page.keyboard.type('math.ts', { delay: 30 })
await page.waitForFunction(() => document.querySelectorAll('.qp__label').length > 0, { timeout: 30_000 })
await page.keyboard.press('Enter')
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(3500)

const text = () =>
  page.evaluate(() => window.monaco.editor.getEditors()[0]?.getModel()?.getValue() ?? '')

// --- nothing to edit, nothing to open -----------------------------------------
await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('Control+i')
await sleep(900)
check(
  'with nothing selected there is nothing to change',
  (await page.locator('.inline-edit').count()) === 0
)

// --- select a line and ask ------------------------------------------------------
await page.evaluate(() => {
  const ed = window.monaco.editor.getEditors()[0]
  ed.setSelection(new window.monaco.Range(2, 1, 2, 15))
  ed.focus()
})
await sleep(400)
await page.keyboard.press('Control+i')
await page.waitForSelector('.inline-edit', { timeout: 8_000 })
check('a selection opens the prompt', true)
check(
  'and it says how much is about to change',
  /1 lines?|1 line/.test(await page.locator('.inline-edit__hint').textContent()),
  await page.locator('.inline-edit__hint').textContent()
)

await page.keyboard.type('multiply instead of add', { delay: 20 })
await page.keyboard.press('Enter')
await sleep(3000)

const after = await text()
check('the prompt closes once it has answered', (await page.locator('.inline-edit').count()) === 0)
check('and the selection was replaced', after !== ORIGINAL, JSON.stringify(after.slice(0, 80)))
check(
  'with what came back, and nothing else touched',
  after.startsWith('export function add(a: number, b: number): number {') && after.trimEnd().endsWith('}'),
  JSON.stringify(after)
)

/*
 * The promise the design rests on. There is no diff to review, so undo has to put
 * the file back exactly — one edit, one undo, not a partial unwind.
 */
await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+z')
await sleep(800)
check('and one undo puts it back exactly', (await text()) === ORIGINAL, JSON.stringify((await text()).slice(0, 80)))

/*
 * And it is one undo of its own, not one shared with whatever was being typed a
 * moment earlier. Monaco groups nearby edits into a single undo unit by default,
 * so without a stop on each side of it the rewrite merges with the user's own
 * typing — and undoing the machine's change quietly takes their last sentence
 * with it. That is the case the explicit stops exist for, and the case the simpler
 * check above cannot tell apart.
 */
await page.click('.monaco-editor .view-lines')
// At the end of the file, on a line of its own: typing into the middle of code
// meets bracket auto-closing and the suggest widget, neither of which this is
// about.
await page.keyboard.press('Control+End')
await page.keyboard.press('Enter')
await page.keyboard.type('// mine', { delay: 40 })
await sleep(900)
const typedIn = await text()
check('a hand-typed edit landed first', typedIn.includes('// mine'), JSON.stringify(typedIn.slice(0, 70)))

await page.evaluate(() => {
  const ed = window.monaco.editor.getEditors()[0]
  ed.setSelection(new window.monaco.Range(2, 1, 2, 15))
  ed.focus()
})
await page.keyboard.press('Control+i')
await page.waitForSelector('.inline-edit', { timeout: 8_000 })
await page.keyboard.type('rewrite it', { delay: 20 })
await page.keyboard.press('Enter')
await sleep(3000)

await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+z')
await sleep(900)
const afterUndo = await text()
check(
  'undoing the rewrite leaves the typing alone',
  afterUndo.includes('// mine'),
  JSON.stringify(afterUndo.slice(0, 90))
)

// Put the file back for the checks below.
for (let i = 0; i < 6; i++) {
  await page.keyboard.press('Control+z')
  await sleep(200)
}
await sleep(500)

// --- Esc closes without changing anything ---------------------------------------
await page.evaluate(() => {
  const ed = window.monaco.editor.getEditors()[0]
  ed.setSelection(new window.monaco.Range(2, 1, 2, 15))
  ed.focus()
})
await page.keyboard.press('Control+i')
await page.waitForSelector('.inline-edit', { timeout: 8_000 })
await page.keyboard.type('something', { delay: 20 })
await page.keyboard.press('Escape')
await sleep(700)
check('Escape closes it', (await page.locator('.inline-edit').count()) === 0)
check('having changed nothing', (await text()) === ORIGINAL, JSON.stringify((await text()).slice(0, 60)))

/*
 * A second question asked while the first is still thinking.
 *
 * The widget the prompt lives in is one variable for the whole editor rather than
 * one per prompt, so the stale-answer guard — "am I still open?" — was really
 * asking "is any prompt open?". Ask for one rewrite, press Ctrl+I somewhere else
 * before it answers, and the first answer closed the second prompt and threw away
 * what had been typed into it.
 */
await page.evaluate(() => {
  const ed = window.monaco.editor.getEditors()[0]
  ed.setSelection(new window.monaco.Range(2, 1, 2, 15))
  ed.focus()
})
await sleep(400)
await page.keyboard.press('Control+i')
await page.waitForSelector('.inline-edit', { timeout: 8_000 })
await page.keyboard.type('first question', { delay: 15 })
await page.keyboard.press('Enter')
await sleep(250)

// Over the top of it, before the first has come back.
await page.evaluate(() => {
  const ed = window.monaco.editor.getEditors()[0]
  ed.setSelection(new window.monaco.Range(3, 1, 3, 10))
  ed.focus()
})
await sleep(250)
await page.keyboard.press('Control+i')
await page.waitForSelector('.inline-edit', { timeout: 8_000 })
await page.keyboard.type('second question', { delay: 15 })
await sleep(2200)

check(
  'a second question is not closed by the first one being answered',
  (await page.locator('.inline-edit').count()) === 1,
  `${await page.locator('.inline-edit').count()} prompts`
)
check(
  'and keeps what was typed into it',
  (await page.evaluate(() => document.querySelector('.inline-edit input')?.value ?? '')) ===
    'second question',
  JSON.stringify(await page.evaluate(() => document.querySelector('.inline-edit input')?.value ?? ''))
)
await page.keyboard.press('Escape')
await sleep(400)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('inline edit:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
