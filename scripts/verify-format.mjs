// Formatting, in the order of who has standing to have an opinion.
//
// A workspace that installed prettier has stated how its code should look, so
// a format-on-save runs that copy — proven with a fake prettier planted in
// node_modules that stamps everything it touches. A file outside any such
// workspace falls back to the editor's own formatter, proven by Alt+Shift+F
// putting the spaces back into a crushed TypeScript line. And auto-save never
// formats: it fires mid-thought.
//
// Run: node scripts/verify-format.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('format')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// Workspace one: carries a pretend prettier that stamps what it formats.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-fmt-'))
const jsFile = path.join(dir, 'a.js')
fs.writeFileSync(jsFile, 'const x = 1\n', 'utf8')
const prettierDir = path.join(dir, 'node_modules', 'prettier')
fs.mkdirSync(prettierDir, { recursive: true })
fs.writeFileSync(
  path.join(prettierDir, 'package.json'),
  JSON.stringify({ name: 'prettier', version: '9.9.9', bin: { prettier: './bin.js' } }),
  'utf8'
)
fs.writeFileSync(
  path.join(prettierDir, 'bin.js'),
  `let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  process.stdout.write('/* fake-prettier */\\n' + input)
})
`,
  'utf8'
)

// Elsewhere: a crushed TypeScript line and no prettier anywhere above it.
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-fmt2-'))
const tsFile = path.join(dir2, 'c.ts')
fs.writeFileSync(tsFile, 'const y=1;\n', 'utf8')

/*
 * And a third workspace whose prettier is slow on purpose, for the question of
 * what happens to what you type while it is thinking: the answer used to be that
 * it was overwritten by the formatter's idea of the file, and then saved.
 */
const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-fmt3-'))
const slowFile = path.join(dir3, 'slow.js')
fs.writeFileSync(slowFile, 'const s = 1\n', 'utf8')
const slowPrettier = path.join(dir3, 'node_modules', 'prettier')
fs.mkdirSync(slowPrettier, { recursive: true })
fs.writeFileSync(
  path.join(slowPrettier, 'package.json'),
  JSON.stringify({ name: 'prettier', version: '9.9.9', bin: { prettier: './bin.js' } }),
  'utf8'
)
fs.writeFileSync(
  path.join(slowPrettier, 'bin.js'),
  `let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  setTimeout(() => process.stdout.write('/* slow-prettier */\\n' + input), 1500)
})
`,
  'utf8'
)

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, dir, jsFile, tsFile, slowFile],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await page.waitForSelector('.pane.editor .view-lines', { timeout: 20_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

await page.evaluate(() => window.ember.setSettings({ formatOnSave: true, trustedFolders: [] }))
await sleep(400)

/*
 * --- an untrusted folder does not get to run its own prettier -------------------
 *
 * A project's prettier is the project's code: it loads that project's
 * prettier.config.js, which is a JavaScript file somebody else wrote. Formatting
 * is not a gesture anyone reads as "run this repository", so a folder nobody has
 * trusted does not get to, and the sentinel this fake prettier stamps is how that
 * is visible — no stamp means it never ran.
 */
await page.locator('.etab', { hasText: 'a.js' }).click()
await sleep(600)
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('const first = 1', { delay: 8 })
await page.keyboard.press('Control+s')
await sleep(2500)
const untrusted = fs.readFileSync(jsFile, 'utf8')
check(
  'an untrusted workspace does not run its own prettier',
  !untrusted.includes('fake-prettier'),
  untrusted.slice(0, 60)
)
check('while the save itself still happens', untrusted.includes('const first = 1'), untrusted.slice(0, 80))

// --- and a trusted one behaves exactly as it did before --------------------------
await page.evaluate(
  ({ a, b }) => window.ember.setSettings({ trustedFolders: [a, b] }),
  { a: dir, b: dir3 }
)
await sleep(500)

// --- a save runs the workspace's prettier ---------------------------------------
await page.locator('.etab', { hasText: 'a.js' }).click()
await sleep(600)
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('const added = 2', { delay: 8 })
await page.keyboard.press('Control+s')
await sleep(2500)

const onDisk = fs.readFileSync(jsFile, 'utf8')
check('the save ran the workspace prettier', onDisk.startsWith('/* fake-prettier */'), onDisk.slice(0, 40))
check('and kept the edit', onDisk.includes('const added = 2'))
const buffer = await page.evaluate(() => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('a.js'))
  return model?.getValue() ?? ''
})
check('the buffer shows what disk holds', buffer === onDisk)

// --- outside that workspace, the editor's own formatter answers the chord -------
await page.locator('.etab', { hasText: 'c.ts' }).click()
await sleep(800)
await page.click('.pane.editor .view-lines')
await sleep(300)
await page.keyboard.press('Alt+Shift+F')
await sleep(2500)
const formatted = await page.evaluate(() => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('c.ts'))
  return model?.getValue() ?? ''
})
check(
  'Alt+Shift+F falls back to the language formatter',
  formatted.includes('const y = 1;'),
  JSON.stringify(formatted)
)
check('and never stamps prettier where there is none', !formatted.includes('fake-prettier'))

/*
 * --- what you type while the formatter is thinking ------------------------------
 *
 * The format goes out over IPC and comes back a moment later, and what came back
 * was applied to whatever the buffer held by then — so keystrokes typed during
 * that round trip were overwritten by the formatter's copy of the file as it was
 * before them, and then saved. The formatter's answer is about a version of the
 * document that no longer exists, and an answer about the past is not an answer.
 */
await page.locator('.etab', { hasText: 'slow.js' }).click()
await sleep(800)
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('const before = 1', { delay: 8 })
await page.keyboard.press('Control+s')
// Into the window the slow prettier leaves open: the save is waiting on it.
await sleep(300)
await page.keyboard.type('const during = 2', { delay: 8 })
await sleep(4000)
const slowBuffer = await page.evaluate(() => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('slow.js'))
  return model?.getValue() ?? ''
})
check(
  'typing while the formatter runs is not overwritten by it',
  slowBuffer.includes('const during = 2'),
  JSON.stringify(slowBuffer.slice(-120))
)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(dir2, { recursive: true, force: true })
fs.rmSync(dir3, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('formatting:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
