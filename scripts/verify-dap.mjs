// Step debugging, end to end, against an adapter with nothing to hide.
//
// The fake adapter speaks real DAP over stdio and is taught through settings
// the way a user would teach one — so this drives the whole surface: F9 puts a
// dot in the margin, F5 starts and stops at it, the panel shows the stack and
// the variables (children fetched on expand), F10 walks a line, F5 runs to the
// end, and a click on the dot takes the breakpoint away.
//
// Run: node scripts/verify-dap.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('dap')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// A pretend program with its own extension, so no detected adapter outbids the
// fake one on real .js files.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-dap-'))
const programFile = path.join(dir, 'app.fake')
fs.writeFileSync(programFile, 'line one\nline two\nline three\nline four\n', 'utf8')

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, programFile],
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

// Teach the adapter, as a user would.
await page.evaluate(
  ({ node, script }) =>
    window.ember.setSettings({
      debugAdapters: [
        {
          id: 'fake',
          name: 'Fake adapter',
          command: node,
          args: [script],
          transport: 'stdio',
          extensions: ['.fake']
        }
      ]
    }),
  { node: process.execPath, script: path.join(APP_DIR, 'scripts', 'dap-fake-adapter.mjs') }
)
await sleep(400)

/** The line the stopped decoration stands on, straight from the model. */
const stoppedLine = () =>
  page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('app.fake'))
    if (!model) return null
    const hit = model
      .getAllDecorations()
      .find((d) => (d.options.className ?? '').includes('dbg-stopped-line'))
    return hit?.range.startLineNumber ?? null
  })

// --- F9 puts a dot where the caret stands --------------------------------------
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('ArrowDown')
await sleep(300)
await page.keyboard.press('F9')
await sleep(500)
check('F9 sets a breakpoint on the caret line', (await page.locator('.dbg-breakpoint').count()) === 1)

// --- F5 runs to it ---------------------------------------------------------------
await page.click('.activity__item[data-view="debug"]')
await sleep(400)
await page.keyboard.press('F5')
await sleep(3000)

const paused = await page.evaluate(
  () => document.querySelector('.dbg__state')?.textContent ?? ''
)
check('the run pauses at the breakpoint', paused.includes('Paused: breakpoint'), paused)
check('standing on the marked line', (await stoppedLine()) === 2, String(await stoppedLine()))
check(
  'the breakpoint is verified by the adapter',
  (await page.locator('.dbg-breakpoint:not(.dbg-breakpoint--wish)').count()) === 1
)
check(
  'the stack names the frame',
  (await page.locator('.dbg__frame', { hasText: 'fakeMain' }).count()) === 1
)
check(
  'the locals are on screen',
  (await page.locator('.dbg__var-name', { hasText: 'answer' }).count()) === 1 &&
    (await page.locator('.dbg__var-value', { hasText: '42' }).count()) >= 1
)

// --- children arrive when a branch opens ----------------------------------------
await page.locator('.dbg__var-row', { hasText: 'box' }).click()
await sleep(800)
check(
  'expanding an object fetches its children',
  (await page.locator('.dbg__var-name', { hasText: 'inner' }).count()) === 1
)

// --- F10 walks one line ----------------------------------------------------------
await page.keyboard.press('F10')
await sleep(1500)
const afterStep = await page.evaluate(
  () => document.querySelector('.dbg__state')?.textContent ?? ''
)
check('a step lands as a pause', afterStep.includes('Paused: step'), afterStep)
check('one line further on', (await stoppedLine()) === 3, String(await stoppedLine()))

// --- F5 runs to the end ----------------------------------------------------------
await page.keyboard.press('F5')
await sleep(2000)
const done = await page.evaluate(() => ({
  state: document.querySelector('.dbg__state')?.textContent ?? '',
  output: document.querySelector('.dbg__output')?.textContent ?? ''
}))
check('continuing runs the program out', done.state.includes('Not debugging'), done.state)
check('and its output was kept', done.output.includes('fake-run-done'), done.output.slice(0, 80))

// --- a click on the dot takes it away -------------------------------------------
await page.locator('.dbg-breakpoint').click({ force: true })
await sleep(500)
check('clicking the dot removes the breakpoint', (await page.locator('.dbg-breakpoint').count()) === 0)

await app.close()
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('step debugging:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
