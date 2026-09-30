// What a launch.json asks of F5, with the Node debugger Ember ships.
// Run: node scripts/verify-debug-launch.mjs
//
// launch.json support was narrow and its gaps were silent (audit R16, DA-05): five
// variables were filled in and the rest reached the program as text; preLaunchTask
// was ignored, so a project that builds first launched its last build. The panel
// did not follow the adapter and had no hit counts or watches (DA-04), and
// breakpoints kept the adapter's first word on them and stayed on a renamed file's
// old name (DA-06).
//
// What it asks: variables are filled in, `${env:…}` from Ember's environment; one
// that cannot be is refused by name; a preLaunchTask runs first, in its own block,
// and a failing one stops the launch; a hit count and a watch work; a breakpoint js-debug
// verifies late is shown verified; and a breakpoint follows its file's rename.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const JS_DEBUG = path.join(APP_DIR, 'resources', 'js-debug', 'src', 'dapDebugServer.js')
if (!fs.existsSync(JS_DEBUG)) {
  console.log('js-debug is not fetched: run node scripts/fetch-js-debug.mjs')
  console.log('debug launch: FAIL')
  process.exit(1)
}
const profile = newProfile('debuglaunch')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, EMBER_VAR_PROBE: 'probe-from-env' }
delete env.ELECTRON_RUN_AS_NODE

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-debuglaunch-'))
const write = (name, text) => fs.writeFileSync(path.join(dir, name), text, 'utf8')
write('vars.js', "console.log('VARS[' + process.argv.slice(2).join('|') + ']')\n")
write('build.js', "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'built.txt'), 'BUILT-' + 'OK')\n")
write('built.js', "console.log('RAN-WITH-' + require('node:fs').readFileSync(require('node:path').join(__dirname, 'built.txt'), 'utf8'))\n")
write('fail.js', 'process.exit(3)\n')
// Records each start, then stays running in the terminal for a restart to end.
write(
  'stays.js',
  "const fs = require('node:fs'), p = require('node:path')\nfs.appendFileSync(p.join(__dirname, 'runs.txt'), fs.readFileSync(p.join(__dirname, 'built.txt'), 'utf8') + '\\n')\nsetInterval(() => {}, 1000)\n"
)
write('unbuilt.js', "console.log('SHOULD-NOT-' + 'RUN')\n")
write('loop.js', "let total = 0\nfor (let i = 0; i < 5; i++) {\n  total += i\n}\nconsole.log('loop-done', total)\n")
// A module loaded only after a pause: js-debug cannot place its breakpoint until then.
write('late.js', "setTimeout(() => require('./lib.js').run(), 1500)\n")
write('lib.js', "exports.run = () => {\n  const late = 'loaded late'\n  console.log(late)\n}\n")
write('moving.js', "const a = 1\nconsole.log(a)\n")
fs.mkdirSync(path.join(dir, '.vscode'))
fs.writeFileSync(
  path.join(dir, '.vscode', 'launch.json'),
  JSON.stringify({
    version: '0.2.0',
    configurations: [
      {
        name: 'Variables',
        type: 'node',
        request: 'launch',
        program: '${workspaceFolder}/vars.js',
        args: ['${env:EMBER_VAR_PROBE}', '${userHome}', '${fileBasenameNoExtension}'],
        console: 'internalConsole',
        outputCapture: 'std'
      },
      { name: 'Asks a question', type: 'node', request: 'launch', program: '${workspaceFolder}/${input:which}.js' },
      {
        name: 'With a build',
        type: 'node',
        request: 'launch',
        program: '${workspaceFolder}/built.js',
        preLaunchTask: 'build',
        console: 'internalConsole',
        outputCapture: 'std'
      },
      {
        name: 'Build, in the terminal',
        type: 'node',
        request: 'launch',
        program: '${workspaceFolder}/stays.js',
        preLaunchTask: 'build',
        console: 'integratedTerminal'
      },
      {
        name: 'Broken build',
        type: 'node',
        request: 'launch',
        program: '${workspaceFolder}/unbuilt.js',
        preLaunchTask: 'broken',
        console: 'internalConsole',
        outputCapture: 'std'
      }
    ]
  })
)
fs.writeFileSync(
  path.join(dir, '.vscode', 'tasks.json'),
  // With a comment and a trailing comma, as tasks.json files are written.
  `{
  // The build this folder's launch runs first.
  "version": "2.0.0",
  "tasks": [
    { "label": "build", "type": "shell", "command": "node build.js" },
    { "label": "broken", "type": "shell", "command": "node fail.js" },
  ]
}
`
)

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, dir],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await page.evaluate((root) => window.ember.setSettings({ trustedFolders: [root] }), dir)
await sleep(600)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const state = () => page.evaluate(() => document.querySelector('.dbg__state')?.textContent ?? '')
const waitFor = async (test, ms) => {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (await test()) return true
    await sleep(300)
  }
  return test()
}
const output = () => page.evaluate(() => document.querySelector('.dbg__output')?.textContent ?? '')
const bodyText = () => page.evaluate(() => document.body.textContent ?? '')
const stoppedLine = (name) =>
  page.evaluate((needle) => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.toLowerCase().endsWith(`/${needle}`))
    const hit = model?.getAllDecorations().find((d) => (d.options.className ?? '').includes('dbg-stopped-line'))
    return hit?.range.startLineNumber ?? null
  }, name)
const openFile = async (name) => {
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.qp__box', { timeout: 8_000 })
  await page.locator('.qp__box').fill(name)
  await sleep(500)
  await page.locator('.qp__box').press('Enter')
  await waitFor(async () => (await page.locator('.qp__box').count()) === 0, 5_000)
  if (await page.locator('.qp__box').count()) await page.keyboard.press('Escape')
  await waitFor(
    () =>
      page.evaluate(
        (needle) => window.monaco?.editor.getEditors().some((e) => e.getModel()?.uri.path.toLowerCase().endsWith(`/${needle}`)),
        name
      ),
    15_000
  )
  await sleep(400)
}
const breakOnLine = async (line) => {
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+Home')
  for (let i = 1; i < line; i += 1) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('F9')
  await sleep(300)
}
const choose = async (label) => {
  await page.locator('.dbg__launch select').selectOption({ label })
  await sleep(300)
}
const f5 = async () => {
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('F5')
}
const settle = async () => {
  if (!(await state()).includes('Not debugging')) {
    await page.keyboard.press('Shift+F5')
    await waitFor(async () => (await state()).includes('Not debugging'), 15_000)
  }
  await sleep(800)
}
/** The breakpoints panel's rows: name and whether the dot is solid. */
const breakpointRows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.dbg__bp')].map((row) => ({
      name: row.querySelector('.dbg__bp-name')?.textContent ?? '',
      verified: !row.querySelector('.dbg__bp-dot')?.classList.contains('dbg__bp-dot--wish')
    }))
  )

await page.click('.activity__item[data-view="debug"]')
await sleep(600)

// --- every variable, and ${env:…} from Ember's environment ---------------------------
await openFile('vars.js')
await choose('Variables')
await f5()
let said = ''
await waitFor(async () => /VARS\[/.test((said = await output())), 30_000)
const vars = (/VARS\[(.*?)\]/.exec(said) ?? ['', ''])[1].split('|')
check('${env:…} is read from the environment', vars[0] === 'probe-from-env', JSON.stringify(vars))
check('${userHome} is the home folder', vars[1]?.toLowerCase() === os.homedir().toLowerCase(), JSON.stringify(vars))
check('${fileBasenameNoExtension} is the file in front of you', vars[2] === 'vars', JSON.stringify(vars))
await settle()

// --- one Ember cannot fill in is refused, by name -------------------------------------
await choose('Asks a question')
await f5()
// Ember's own refusal, naming it: js-debug failing on the literal path names it too.
const refusal = () => bodyText().then((t) => (t.match(/uses [^.]*which Ember cannot fill in/) ?? [''])[0])
await waitFor(async () => (await refusal()).length > 0, 10_000)
check('a variable Ember cannot fill in is named, and the launch refused', (await refusal()).includes('${input:which}'), (await refusal()) || (await state()).slice(0, 80))
check('and the debugger stays idle', await waitFor(async () => (await state()).includes('Not debugging'), 5_000), await state())
await settle()

// --- a preLaunchTask runs first --------------------------------------------------------
await choose('With a build')
await f5()
await waitFor(async () => /RAN-WITH-/.test(await output()), 45_000)
check('the task runs before the program, which sees what it built', (await output()).includes('RAN-WITH-BUILT-OK'), (await output()).slice(-160))
const headers = await page.evaluate(() => [...document.querySelectorAll('.block__cmd')].map((b) => (b.textContent ?? '').trim()))
check('in a block named for the task', headers.includes('# preLaunchTask: build'), JSON.stringify(headers.slice(-3)))
await settle()

/*
 * --- and runs again on restart, once the terminal it shares is back at its prompt ---
 *
 * The restart comes the moment the old session ends, while its program is still
 * being taken down in the terminal the task needs; it was refused for want of a
 * pane at its prompt.
 */
const runsFile = path.join(dir, 'runs.txt')
const runs = () => (fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8').trim().split(/\r?\n/).length : 0)
const taskBlocks = () =>
  page.evaluate(() => [...document.querySelectorAll('.block__cmd')].filter((b) => (b.textContent ?? '').trim() === '# preLaunchTask: build').length)
await choose('Build, in the terminal')
await f5()
await waitFor(async () => runs() === 1 && (await state()).includes('Running'), 45_000)
check('a program with a task runs in the terminal', runs() === 1, `${runs()} / ${await state()}`)
const tasksBefore = await taskBlocks()
await page.keyboard.press('Control+Shift+F5')
await waitFor(async () => runs() === 2, 45_000)
check(
  'restart runs the task again, and the program',
  runs() === 2 && (await taskBlocks()) === tasksBefore + 1,
  `runs ${runs()}, task blocks ${tasksBefore} -> ${await taskBlocks()}, ${await state()}`
)
check('without being refused a terminal', !(await bodyText()).includes('none at its prompt'))
await settle()

// --- and a failing one stops the launch -------------------------------------------------
await choose('Broken build')
await f5()
await waitFor(async () => /exit code 3/.test(await bodyText()), 30_000)
check('a task that fails is said to have, with its exit code', (await bodyText()).includes('exit code 3'))
await sleep(2_000)
check('and the program is not started', !(await output()).includes('SHOULD-NOT-RUN') && !(await bodyText()).includes('SHOULD-NOT-RUN'))
check('the debugger is idle', (await state()).includes('Not debugging'), await state())
await settle()

// --- a hit count and a watch ----------------------------------------------------------------
await choose('Active file')
await openFile('loop.js')
await breakOnLine(3)
await page.locator('.dbg__bp .icon-btn[aria-label^="Edit breakpoint"]').first().click()
await sleep(300)
const hitBox = page.locator('.dbg__bp-input[aria-label="Breakpoint hit count"]')
const hasHitBox = (await hitBox.count()) === 1
check('a breakpoint can be given a hit count', hasHitBox)
if (hasHitBox) {
  await hitBox.fill('3')
  await hitBox.press('Enter')
}
await sleep(400)
const watchBox = page.locator('[aria-label="Add watch expression"]')
const hasWatch = (await watchBox.count()) === 1
check('there is a Watch panel', hasWatch)
if (hasWatch) {
  await watchBox.fill('i')
  await watchBox.press('Enter')
}
await f5()
await waitFor(async () => (await state()).includes('Paused'), 40_000)
const watched = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.dbg__watch-row')].map((r) => ({
      name: r.querySelector('.dbg__var-name')?.textContent ?? '',
      value: r.querySelector('.dbg__var-value, .dbg__repl-err')?.textContent ?? ''
    }))
  )
await waitFor(async () => (await watched()).some((w) => w.name === 'i' && w.value === '2'), 10_000)
check('it stops on the third hit, and the watch says so', (await watched()).some((w) => w.name === 'i' && w.value === '2'), JSON.stringify(await watched()))
await settle()
if (hasWatch) await page.locator('[aria-label="Remove watch i"]').click()
// The loop's breakpoint off again, so it does not stop the next scenario.
await page.locator('[aria-label="Remove breakpoint at line 3"]').first().click()
await sleep(400)

// --- a breakpoint js-debug verifies late is shown verified -----------------------------------
await openFile('lib.js')
await breakOnLine(3)
await openFile('late.js')
await f5()
await waitFor(async () => (await stoppedLine('lib.js')) === 3, 40_000)
check('it stops in the module loaded late', (await stoppedLine('lib.js')) === 3, await state())
const lateRow = (await breakpointRows()).find((r) => r.name === 'lib.js:3')
check('and its breakpoint is shown verified, as the adapter said later', lateRow?.verified === true, JSON.stringify(await breakpointRows()))
await settle()

// --- a breakpoint follows its file's rename ------------------------------------------------
await openFile('moving.js')
await breakOnLine(2)
await page.click('.activity__item[data-view="explorer"]')
await sleep(600)
await page.locator('.tree__row', { hasText: 'moving.js' }).first().click({ button: 'right' })
await page.waitForSelector('.menu', { timeout: 10_000 })
await page.locator('.menu__item', { hasText: 'Rename' }).click()
await page.waitForSelector('.tree__input', { timeout: 10_000 })
await page.locator('.tree__input').fill('moved.js')
await page.keyboard.press('Enter')
await sleep(1500)
await page.click('.activity__item[data-view="debug"]')
await sleep(600)
const names = (await breakpointRows()).map((r) => r.name)
check('the breakpoint is on the renamed file', names.includes('moved.js:2'), JSON.stringify(names))
check('and not on the old name', !names.includes('moving.js:2'), JSON.stringify(names))

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('debug launch:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
