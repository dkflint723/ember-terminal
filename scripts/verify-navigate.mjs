// Go to Definition, within a file and across files.
//
// Two things had to be true and neither was. Models are keyed by file URI, and the
// transport canonicalises every URI crossing it to lower case, so a model keyed by
// the path as Windows spells it could never be found from a server's reply — F12
// failed even within a single file. And Monaco navigates by asking the host for a
// model, so a definition in a file with no editor open had nowhere to go at all.
//
// Run: node scripts/verify-navigate.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('navigate')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-nav-'))

// A definition in another file, and one in the same file, both reachable from main.
fs.writeFileSync(
  path.join(work, 'helper.ts'),
  'export function helperFunction(n: number): number {\n  return n * 2\n}\n',
  'utf8'
)
// The declaration sits far below the usage, so jumping to it has to scroll — which
// is what makes the jump observable at all. A short file renders whole, so "the
// declaration is on screen" would be true whether or not anything happened.
fs.writeFileSync(
  path.join(work, 'main.ts'),
  [
    "import { helperFunction } from './helper'",
    'export const a = localFunction(1)',
    'export const b = helperFunction(2)',
    ...Array.from({ length: 120 }, (_, i) => `const filler${i} = ${i}`),
    'export function localFunction(x: number): number {',
    '  return x + 1',
    '}',
    ''
  ].join('\n'),
  'utf8'
)
fs.writeFileSync(
  path.join(work, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true, target: 'ES2020', module: 'ESNext' } }),
  'utf8'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, path.join(work, 'main.ts')],
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
// The language server has to be up before a definition can be resolved.
await sleep(12_000)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const shown = () =>
  page.evaluate(() => ({
    path: document.querySelector('.pane.editor')?.getAttribute('data-editor-path') ?? null,
    paths: Array.from(document.querySelectorAll('.pane.editor')).map((p) =>
      p.getAttribute('data-editor-path')
    )
  }))

/** Put the cursor on the first occurrence of a word, then press F12. */
const goToDefinition = async (word) => {
  const token = page.locator(`.view-line span:text-is("${word}")`).first()
  if ((await token.count()) === 0) return false
  await token.click()
  await sleep(500)
  await page.keyboard.press('F12')
  await sleep(3500)
  return true
}

// --- within one file ----------------------------------------------------------
const visible = () =>
  page.evaluate(() => document.querySelector('.pane.editor .view-lines')?.textContent ?? '')

const beforeLocal = await visible()
check(
  'the declaration starts off screen',
  !beforeLocal.includes('function localFunction'),
  beforeLocal.slice(0, 80)
)

const clickedLocal = await goToDefinition('localFunction')
check('the symbol is on screen to click', clickedLocal)
const afterLocal = await visible()
/*
 * How far it jumped, rather than exactly which rows are on screen.
 *
 * Monaco only renders the lines it is showing, and how many that is depends on the
 * window size, so "the declaration is among them" is a check about the harness's
 * window rather than about navigation. The declaration is the last thing in a
 * 124-line file, so landing in the last third is the part that means anything.
 */
const firstFiller = Number(/filler(\d+)/.exec(afterLocal)?.[1] ?? -1)
check(
  'F12 within a file jumps to the end of the file, where the declaration is',
  firstFiller >= 60,
  `first visible filler: ${firstFiller}`
)
check(
  'and away from where it started',
  !afterLocal.includes('helperFunction(2)'),
  afterLocal.slice(0, 120)
)

// --- into a file that is not open ---------------------------------------------
// Back to the top: the jump above scrolled the import out of view, and a symbol
// that is not rendered cannot be clicked.
await page.keyboard.press('Control+Home')
await sleep(800)

const before = await shown()
check('only one file is open to start with', before.paths.length === 1, JSON.stringify(before))

const clickedHelper = await goToDefinition('helperFunction')
check('the imported symbol is on screen', clickedHelper)
await sleep(2500)
const after = await shown()
check(
  'F12 into another file opens it',
  after.paths.some((p) => (p ?? '').endsWith('helper.ts')),
  JSON.stringify(after)
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('go to definition:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
