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

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, dir, jsFile, tsFile],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
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

await page.evaluate(() => window.ember.setSettings({ formatOnSave: true }))
await sleep(400)

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

await app.close()
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(dir2, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('formatting:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
