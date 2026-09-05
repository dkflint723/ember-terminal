// Step debugging, end to end, against an adapter with nothing to hide.
//
// The fake adapter speaks real DAP over stdio and is taught through settings
// the way a user would teach one — so this drives the whole surface: F9 puts a
// dot in the margin, F5 starts and stops at it, the panel shows the stack, the
// threads, and the variables (children fetched on expand), the console
// evaluates in the paused frame, F10 walks a line, restart runs it all again,
// exception filters pause a crash, pause interrupts a hang, launch.json (with
// comments and trailing commas) feeds the F5 picker, an attach config
// attaches, runInTerminal stands the program up as a real block, breakpoints
// ride buffer edits and survive a relaunch, and a click on the dot takes the
// breakpoint away.
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
/*
 * Where the adapter records being asked to let go. A launched debuggee is the
 * adapter's child and Ember's grandchild, so nothing Ember holds can reach it —
 * `disconnect` with terminateDebuggee is the only thing that ends it.
 */
const dapLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-dap-log-')), 'disconnects.txt')

const env = { ...process.env, EMBER_DAP_LOG: dapLog }
delete env.ELECTRON_RUN_AS_NODE

// A pretend workspace with its own extension, so no detected adapter outbids
// the fake one on real .js files. Three programs, three scenarios.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-dap-'))
const programFile = path.join(dir, 'app.fake')
fs.writeFileSync(programFile, 'line one\nline two\nline three\nline four\n', 'utf8')
fs.writeFileSync(path.join(dir, 'crash.fake'), 'a\nb\nc\nthrows-late here\n', 'utf8')
fs.writeFileSync(path.join(dir, 'spin.fake'), 'hang-forever\n', 'utf8')
fs.mkdirSync(path.join(dir, '.vscode'))
fs.writeFileSync(
  path.join(dir, '.vscode', 'launch.json'),
  `{
  // Comments and trailing commas are launch.json's dialect, not JSON's.
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Fake config",
      "type": "fake",
      "request": "launch",
      "program": "\${workspaceFolder}/app.fake",
      "magic": "from-launch-json",
      "console": "integratedTerminal",
    },
    {
      "name": "Fake attach",
      "type": "fake",
      "request": "attach",
      "program": "\${workspaceFolder}/app.fake",
    },
  ],
}
`,
  'utf8'
)

const launch = () =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, dir, programFile],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

let app = await launch()
let page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await page.waitForSelector('.pane.editor .view-lines', { timeout: 20_000 })
await sleep(1500)

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

const state = () => page.evaluate(() => document.querySelector('.dbg__state')?.textContent ?? '')
const outputText = () =>
  page.evaluate(() => document.querySelector('.dbg__output')?.textContent ?? '')
const waitForState = async (fragment, timeoutMs = 12_000) => {
  const until = Date.now() + timeoutMs
  for (;;) {
    const now = await state()
    if (now.includes(fragment)) return now
    if (Date.now() > until) return now
    await sleep(300)
  }
}
/** The line the stopped decoration stands on, straight from the model. */
const stoppedLine = (file) =>
  page.evaluate((name) => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes(name))
    if (!model) return null
    const hit = model
      .getAllDecorations()
      .find((d) => (d.options.className ?? '').includes('dbg-stopped-line'))
    return hit?.range.startLineNumber ?? null
  }, file)
const openFile = async (needle) => {
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.qp__box', { timeout: 8_000 })
  await page.locator('.qp__box').fill(needle)
  await sleep(500)
  await page.keyboard.press('Enter')
  await sleep(1200)
}

// --- F9 puts a dot where the caret stands --------------------------------------
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('ArrowDown')
await sleep(300)
await page.keyboard.press('F9')
await sleep(500)
check('F9 sets a breakpoint on the caret line', (await page.locator('.dbg-breakpoint').count()) === 1)

// --- the picker offers the workspace's configurations --------------------------
await page.click('.activity__item[data-view="debug"]')
await sleep(800)
const options = await page.evaluate(() =>
  [...document.querySelectorAll('.dbg__launch option')].map((o) => o.textContent)
)
check('the F5 picker offers the active file', options.includes('Active file'), JSON.stringify(options))
check('and the launch.json entries, comments and all', options.includes('Fake config') && options.includes('Fake attach'), JSON.stringify(options))

// --- F5 runs to the breakpoint -------------------------------------------------
await page.keyboard.press('F5')
await waitForState('Paused: breakpoint')
check('the run pauses at the breakpoint', (await state()).includes('Paused: breakpoint'), await state())
check('standing on the marked line', (await stoppedLine('app.fake')) === 2, String(await stoppedLine('app.fake')))
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
check(
  'the status bar says so',
  (await page.locator('.statusbar__debug', { hasText: 'paused' }).count()) === 1
)

// --- threads: two stories, switchable -------------------------------------------
check('both threads are offered', (await page.locator('.dbg__thread').count()) === 2)
await page.locator('.dbg__thread', { hasText: 'worker' }).click()
await sleep(1000)
check(
  'the worker thread has its own stack',
  (await page.locator('.dbg__frame', { hasText: 'workerFrame' }).count()) === 1
)
await page.locator('.dbg__thread', { hasText: 'main' }).click()
await sleep(1000)

// --- children arrive when a branch opens ----------------------------------------
await page.locator('.dbg__var-row', { hasText: 'box' }).click()
await sleep(800)
check(
  'expanding an object fetches its children',
  (await page.locator('.dbg__var-name', { hasText: 'inner' }).count()) === 1
)

// --- the console evaluates in the paused frame ----------------------------------
await page.locator('.dbg__console-input').fill('answer*2')
await page.keyboard.press('Enter')
await sleep(1000)
check(
  'the console answers',
  (await page.locator('.dbg__repl-result', { hasText: '84' }).count()) === 1
)

// --- F10 walks one line ----------------------------------------------------------
await page.keyboard.press('F10')
await waitForState('Paused: step')
check('a step lands as a pause', (await state()).includes('Paused: step'), await state())
check('one line further on', (await stoppedLine('app.fake')) === 3, String(await stoppedLine('app.fake')))

// --- restart runs the same thing again -------------------------------------------
await page.keyboard.press('Control+Shift+F5')
await waitForState('Paused: breakpoint', 15_000)
check('restart runs back to the breakpoint', (await state()).includes('Paused: breakpoint'), await state())
await page.keyboard.press('F5')
await waitForState('Not debugging')
check('and continuing runs the program out', (await state()).includes('Not debugging'), await state())

// --- a condition travels to the adapter ------------------------------------------
await page.locator('.dbg__bp .icon-btn[title="Condition and log message"]').first().click()
await sleep(300)
await page.locator('.dbg__bp-input').first().fill('x > 1')
await page.keyboard.press('Enter')
await sleep(600)
check(
  'the dot turns conditional',
  (await page.locator('.dbg-breakpoint--conditional').count()) === 1
)
await page.keyboard.press('F5')
await waitForState('Paused: breakpoint')
check(
  'and the condition crosses the wire',
  (await outputText()).includes('"condition":"x > 1"'),
  (await outputText()).slice(0, 200)
)
await page.keyboard.press('Shift+F5')
await waitForState('Not debugging')

// --- an uncaught exception pauses when asked -------------------------------------
await openFile('crash')
await page.locator('.dbg__exc input').check()
await sleep(400)
await page.keyboard.press('F5')
await waitForState('Paused: exception')
check('the crash pauses instead of ending the run', (await state()).includes('Paused: exception'), await state())
await page.keyboard.press('Shift+F5')
await waitForState('Not debugging')
await page.locator('.dbg__exc input').uncheck()
await sleep(400)

// --- pause interrupts a run that never stops -------------------------------------
await openFile('spin')
await page.keyboard.press('F5')
await sleep(1500)
check('the hang is running', (await state()).includes('Running'), await state())
await page.locator('.dbg__ctl[aria-label="Pause"]').click()
await waitForState('Paused: pause')
check('pause interrupts it', (await state()).includes('Paused: pause'), await state())
await page.keyboard.press('Shift+F5')
await waitForState('Not debugging')

// --- launch.json config: variables substituted, terminal stood up ----------------
await page.locator('.dbg__launch select').selectOption({ label: 'Fake config' })
await sleep(300)
await page.keyboard.press('F5')
await waitForState('Paused: breakpoint', 15_000)
check(
  'the config reaches the adapter, magic and all',
  (await outputText()).includes('"magic":"from-launch-json"'),
  (await outputText()).slice(0, 200)
)
check(
  'the adapter heard its terminal is standing',
  (await outputText()).includes('terminal-standing:true'),
  (await outputText()).slice(-200)
)
const blockProof = await page.evaluate(() =>
  [...document.querySelectorAll('.block')].some((b) =>
    (b.textContent ?? '').includes('dap-terminal-proof')
  )
)
check('and the program ran as a real block', blockProof)
await page.keyboard.press('Shift+F5')
await waitForState('Not debugging')

// --- an attach config attaches ----------------------------------------------------
await page.locator('.dbg__launch select').selectOption({ label: 'Fake attach' })
await sleep(300)
await page.keyboard.press('F5')
await waitForState('Paused: breakpoint', 15_000)
check('the attach request lands', (await outputText()).includes('attached-ok'), (await outputText()).slice(0, 200))
await page.keyboard.press('Shift+F5')
await waitForState('Not debugging')
await page.locator('.dbg__launch select').selectOption({ label: 'Active file' })

// --- the marks ride the buffer -----------------------------------------------------
await openFile('app.fake')
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('End')
await page.keyboard.press('Enter')
await sleep(800)
check(
  'an edit above the mark moves it',
  (await page.locator('.dbg__bp-name', { hasText: 'app.fake:3' }).count()) === 1
)
await page.keyboard.press('Control+z')
await sleep(800)
check(
  'and the undo brings it home',
  (await page.locator('.dbg__bp-name', { hasText: 'app.fake:2' }).count()) === 1
)

// --- the posture survives a relaunch -----------------------------------------------
await sleep(2500)
await app.close()
await sleep(1200)
app = await launch()
page = await app.firstWindow()
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2000)
// The restored session may already be standing on the Debug view — clicking
// the rail then would toggle it closed, not open.
if ((await page.locator('.dbg').count()) === 0) {
  await page.click('.activity__item[data-view="debug"]')
  await sleep(800)
}
check(
  'breakpoints come back with the workspace',
  (await page.locator('.dbg__bp-name', { hasText: 'app.fake:2' }).count()) === 1
)
check(
  'condition included',
  (await page.locator('.dbg__bp-dot--conditional').count()) === 1
)

// --- a click on the dot takes it away ----------------------------------------------
await openFile('app.fake')
await sleep(800)
await page.locator('.dbg-breakpoint').click({ force: true })
await sleep(500)
check('clicking the dot removes the breakpoint', (await page.locator('.dbg-breakpoint').count()) === 0)

/*
 * --- quitting lets go of the debuggee rather than killing the adapter over it ---
 *
 * `stop` has always asked politely, and its comment states the rule the design
 * rests on: a launched debuggee dies with its session. But the two paths that run
 * when the app actually goes away — a window closing and the app quitting — went
 * straight to killing the adapter. On Windows that is TerminateProcess, so no
 * teardown runs, and the program the adapter launched is orphaned: a debugged
 * server still holding its port, invisible to Ember and unkillable from it, with
 * the next F5 failing on the address being in use.
 *
 * The pty side has always walked its owners on window close for exactly this
 * reason. Debug sessions had no equivalent.
 */
/*
 * Stopped at a breakpoint, so there is a live session at the moment the app goes.
 * The check above this one takes the last breakpoint away, and without one F5 runs
 * to the end and the session is over before quitting can let go of anything.
 */
await page.click('.monaco-editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('F9')
await sleep(600)
await page.keyboard.press('F5')
await sleep(3000)
check(
  'a session is stopped at a breakpoint before the app goes',
  (await page.locator('.dbg-breakpoint').count()) > 0,
  `${await page.locator('.dbg-breakpoint').count()} breakpoints`
)
const beforeQuit = fs.existsSync(dapLog) ? fs.readFileSync(dapLog, 'utf8') : ''

await app.close()
await sleep(1500)
const whole = fs.existsSync(dapLog) ? fs.readFileSync(dapLog, 'utf8') : ''
const disconnects = whole.slice(beforeQuit.length).trim()
check(
  'quitting asks the adapter to let go of what it launched',
  disconnects.includes('disconnect:true'),
  JSON.stringify(disconnects)
)

profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('step debugging:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
