// The Node debugger Ember ships — js-debug — driven the way people use it.
// Run: node scripts/verify-jsdebug.mjs
//
// verify-dap proves the debugger's plumbing against a fake adapter that answers
// synchronously over stdio and never starts a child session. The path every Node
// user takes is none of those: js-debug is a TCP server, it runs the program in the
// terminal through a bootloader it injects with NODE_OPTIONS, and it attaches to
// child processes by asking for a session of their own. None of that was tested,
// so any of it could break without a word (audit R16, DA-03).
//
// What it asks: a breakpoint in a .js file stops F5; the shell the program ran in
// keeps its own NODE_OPTIONS and its own directory, after the program ends and
// after Ctrl+C (DA-01); a breakpoint in a child process stops too; and Shift+F5
// ends the program and its child.
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
  console.log('js-debug: FAIL')
  process.exit(1)
}
const profile = newProfile('jsdebug')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// A token named by `${env:…}` in the arguments: resolved in main, so a secret by the time it is typed.
const ARG_TOKEN = 'ghp_' + 'EmberArgumentNotARealToken012345678'.padEnd(36, 'y')
const env = { ...process.env, EMBER_ARG_SECRET: ARG_TOKEN }
delete env.ELECTRON_RUN_AS_NODE

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-jsdebug-'))
fs.mkdirSync(path.join(dir, 'elsewhere'))
const pidFile = (name) => path.join(dir, `${name}.pid`).replace(/\\/g, '/')
fs.writeFileSync(path.join(dir, 'app.js'), "const answer = 40 + 2\nconsole.log('jsdebug-answer', answer)\n", 'utf8')
// Runs until stopped, so there is something for Ctrl+C to interrupt.
fs.writeFileSync(
  path.join(dir, 'forever.js'),
  "console.log('jsdebug-forever-started')\nsetInterval(() => {}, 1000)\n",
  'utf8'
)
fs.writeFileSync(
  path.join(dir, 'parent.js'),
  `const { spawn } = require('node:child_process')
require('node:fs').writeFileSync('${pidFile('parent')}', String(process.pid))
spawn(process.execPath, [require('node:path').join(__dirname, 'child.js')], { stdio: 'inherit' })
setInterval(() => {}, 1000)
`,
  'utf8'
)
fs.writeFileSync(
  path.join(dir, 'child.js'),
  `require('node:fs').writeFileSync('${pidFile('child')}', String(process.pid))
const inChild = 'stopped here'
setInterval(() => {}, 1000)
`,
  'utf8'
)

const TOKEN = 'ghp_' + 'EmberDebuggeeNotARealToken0123456789'.padEnd(36, 'x')
const tempBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ember-debuggee-')))
// A launch js-debug refuses: a runtime that is not there.
fs.mkdirSync(path.join(dir, '.vscode'))
fs.writeFileSync(
  path.join(dir, '.vscode', 'launch.json'),
  JSON.stringify({
    version: '0.2.0',
    configurations: [
      { name: 'Missing runtime', type: 'node', request: 'launch', program: '${workspaceFolder}/app.js', runtimeExecutable: 'no-such-runtime-ember' },
      // A token in `env`, as a launch.json holds one: the program must see it, and
      // nothing else may.
      { name: 'With a secret', type: 'node', request: 'launch', program: '${workspaceFolder}/secret.js', console: 'integratedTerminal', env: { GITHUB_TOKEN: TOKEN }, args: ['${env:EMBER_ARG_SECRET}'] }
    ]
  })
)
fs.writeFileSync(
  path.join(dir, 'secret.js'),
  "console.log(process.env.GITHUB_TOKEN ? 'secret-seen-' + process.env.GITHUB_TOKEN.length : 'secret-missing')\nconsole.log('arg-seen-' + (process.argv[2] ?? '').length)\n",
  'utf8'
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
// A trusted folder, as one opened on purpose is: F5 runs the file in front of you.
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
  // In the picker itself: with a shell block just finished, the composer can hold
  // the keyboard while the picker is open, and Enter would go to the shell.
  await page.locator('.qp__box').press('Enter')
  // The picker gone, or it is closed: a click behind it would wait forever.
  await waitFor(async () => (await page.locator('.qp__box').count()) === 0, 5_000)
  if (await page.locator('.qp__box').count()) {
    console.log(`picker still open for ${name}:`, JSON.stringify(await page.evaluate(() => ({ items: [...document.querySelectorAll('.qp__item')].map((i) => (i.textContent ?? '').slice(0, 60)).slice(0, 6), value: document.querySelector('.qp__box')?.value, focus: document.activeElement?.className }))))
    await page.keyboard.press('Escape')
  }
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
/**
 * Type a command into the shell pane, as a person would, and wait for its own block:
 * one more finished block carrying the marker than there was before. Reading the
 * newest one that carried it returned the previous reading when this one had not
 * finished yet, and a check passed on the old build for that reason alone.
 */
const blocksWith = (marker) =>
  page.evaluate(
    (m) => [...document.querySelectorAll('.block--done .block__body')].map((b) => b.textContent ?? '').filter((t) => t.includes(m)),
    marker
  )
const inShell = async (command, marker) => {
  const before = (await blocksWith(marker)).length
  await page.locator('.composer__input').first().focus()
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  let found = []
  await waitFor(async () => (found = await blocksWith(marker)).length > before, 15_000)
  return found.length > before ? found[found.length - 1] : ''
}
const shellState = async () => {
  const text = await inShell("Write-Output \"STATE[$env:NODE_OPTIONS]AT[$((Get-Location).Path)]\"", 'STATE[')
  const m = /STATE\[(.*?)\]AT\[(.*?)\]/.exec(text)
  return m ? { nodeOptions: m[1], at: m[2] } : { nodeOptions: '(unread)', at: text.slice(0, 80) }
}
/** Where things stand: the debugger's words, what has focus, and the shell's blocks. */
const probe = () =>
  page.evaluate(() => ({
    state: document.querySelector('.dbg__state')?.textContent ?? '',
    focus: `${document.activeElement?.tagName}.${document.activeElement?.className ?? ''}`.slice(0, 80),
    blocks: [...document.querySelectorAll('.block__cmd')].map((b) => (b.textContent ?? '').slice(0, 90)).slice(-3),
    output: (document.querySelector('.dbg__output')?.textContent ?? '').slice(-160)
  }))
/** Every scenario starts from nothing running: stopped, and waited for. */
const settle = async () => {
  if (!(await state()).includes('Not debugging')) {
    await page.keyboard.press('Shift+F5')
    await waitFor(async () => (await state()).includes('Not debugging'), 15_000)
  }
  await sleep(800)
}
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The shell as its owner left it: a NODE_OPTIONS of their own, and somewhere else.
// Its real name: a runner's temp folder is spelled with a short name (RUNNER~1),
// and a shell reports the long one.
const elsewhere = fs.realpathSync.native(path.join(dir, 'elsewhere'))
await inShell(`$env:NODE_OPTIONS='x'; Set-Location -LiteralPath '${elsewhere}'; Write-Output 'READY-MARK'`, 'READY-MARK')
// PowerShell's history file, and how much of it came before this run: it is the
// user's own, and only what this run typed is this run's business.
const histPath = (/HIST\[(.*?)\]/.exec(await inShell('Write-Output "HIST[$((Get-PSReadLineOption).HistorySavePath)]"', 'HIST[')) ?? [])[1] ?? ''
const histStart = histPath && fs.existsSync(histPath) ? fs.statSync(histPath).size : 0
const before = await shellState()
check('the shell starts with its own NODE_OPTIONS', before.nodeOptions === 'x', JSON.stringify(before))

// --- F5 stops at a breakpoint in a .js file ---------------------------------------
await openFile('app.js')
await breakOnLine(2)
await page.click('.activity__item[data-view="debug"]')
await sleep(600)
// The file in front of you, not the launch.json entry kept for the last scenario.
await page.locator('.dbg__launch select').selectOption({ label: 'Active file' })
await sleep(300)
await page.keyboard.press('F5')
await waitFor(async () => (await state()).includes('Paused'), 40_000)
console.log('after F5 on app.js:', JSON.stringify(await probe()))
check('F5 stops at the breakpoint in app.js', (await state()).includes('Paused'), await state())
// The editor marks the stopped line once it has the stack, a moment after the pause is
// reported: read at once, it was not there yet on a slow runner — "null" in two of
// three release gates, with the state reading "Paused: breakpoint". Waited for, as the
// child process's line below already is.
await waitFor(async () => (await stoppedLine('app.js')) !== null, 10_000)
check('on the marked line', (await stoppedLine('app.js')) === 2, String(await stoppedLine('app.js')))
await page.click('.pane.editor .view-lines')
await page.keyboard.press('F5')
const ran = await waitFor(
  () => page.evaluate(() => [...document.querySelectorAll('.block__body, .dbg__output')].some((b) => (b.textContent ?? '').includes('jsdebug-answer 42'))),
  20_000
)
check('continued, the program finishes and prints', ran)
// It runs to its end and the session with it.
await waitFor(async () => (await state()).includes('Not debugging'), 20_000)
console.log('after app.js ran:', JSON.stringify(await probe()))
await settle()

const afterRun = await shellState()
check('after the program ends, the shell keeps its own NODE_OPTIONS', afterRun.nodeOptions === 'x', JSON.stringify(afterRun))
check('and stays where it was', afterRun.at.toLowerCase() === elsewhere.toLowerCase(), JSON.stringify(afterRun))

// --- Ctrl+C in the middle of a run ------------------------------------------------
await openFile('forever.js')
await page.click('.pane.editor .view-lines')
await page.keyboard.press('F5')
// Running, and in a block of the shell's: a running block's output is not in its body yet.
const started = await waitFor(
  async () =>
    (await state()).includes('Running') &&
    // Any running block: the command names the program in the clear on the old build,
    // and runs it through an encoded child shell on the new one.
    (await page.locator('.block--running').count()) > 0,
  30_000
)
console.log('after F5 on forever.js:', JSON.stringify(await probe()))
check('a long-running program starts in the shell', started)
// To the terminal itself, where a running program's Ctrl+C goes.
await page.locator('.pane[data-integration] .xterm-helper-textarea').first().focus()
await page.keyboard.press('Control+c')
console.log('after Ctrl+C:', JSON.stringify(await probe()))
await waitFor(async () => (await state()).includes('Not debugging'), 15_000)
await settle()
const afterInterrupt = await shellState()
check('after Ctrl+C, the shell keeps its own NODE_OPTIONS', afterInterrupt.nodeOptions === 'x', JSON.stringify(afterInterrupt))
check('and stays where it was', afterInterrupt.at.toLowerCase() === elsewhere.toLowerCase(), JSON.stringify(afterInterrupt))

// --- a child process stops at its own breakpoint; Shift+F5 ends them both --------
await openFile('child.js')
await breakOnLine(2)
await openFile('parent.js')
await page.click('.pane.editor .view-lines')
console.log('before F5 on parent.js:', JSON.stringify(await probe()))
await page.keyboard.press('F5')
await waitFor(async () => (await stoppedLine('child.js')) === 2, 40_000)
if ((await stoppedLine('child.js')) !== 2) {
  // Where it stood instead: which file, which line, and what the debugger said.
  console.log(
    'child stop missed:',
    JSON.stringify({
      ...(await probe()),
      parentLine: await stoppedLine('parent.js'),
      childLine: await stoppedLine('child.js'),
      frames: await page.evaluate(() => [...document.querySelectorAll('.dbg__frame')].map((f) => (f.textContent ?? '').slice(0, 80))),
      output: await page.evaluate(() => (document.querySelector('.dbg__output')?.textContent ?? '').slice(-600))
    })
  )
}
check('a breakpoint in a child process stops it', (await stoppedLine('child.js')) === 2, `${await state()} / line ${await stoppedLine('child.js')}`)
const parentPid = Number(fs.existsSync(pidFile('parent')) ? fs.readFileSync(pidFile('parent'), 'utf8') : 0)
const childPid = Number(fs.existsSync(pidFile('child')) ? fs.readFileSync(pidFile('child'), 'utf8') : 0)
check('both processes were running', parentPid > 0 && childPid > 0 && alive(parentPid) && alive(childPid), `${parentPid} ${childPid}`)
await page.keyboard.press('Shift+F5')
await waitFor(async () => !alive(parentPid) && !alive(childPid), 10_000)
check('Shift+F5 ends the program', parentPid > 0 && !alive(parentPid), String(parentPid))
check('and its child', childPid > 0 && !alive(childPid), String(childPid))

/*
 * --- a secret in the launch configuration ----------------------------------------
 *
 * The environment used to be typed into the pane in the clear, where history, Share
 * and PSReadLine kept it; encoded, it would have been kept all the same, in a form
 * nothing recognises as a secret. It now travels in a file the program's shell reads
 * and deletes, and the block is named for the program.
 */
await settle()
await page.locator('.dbg__launch select').selectOption({ label: 'With a secret' })
await sleep(400)
await page.click('.pane.editor .view-lines')
await page.keyboard.press('F5')
const seen = await waitFor(
  () => page.evaluate(() => [...document.querySelectorAll('.block__body')].some((b) => /secret-seen-40/.test(b.textContent ?? ''))),
  30_000
)

check('the program sees the environment its configuration gives it', seen)
await waitFor(async () => (await state()).includes('Not debugging'), 15_000)
const headers = await page.evaluate(() => [...document.querySelectorAll('.block__cmd')].map((b) => (b.textContent ?? '').trim()))
check('its block is named for the program', headers.some((h) => h.startsWith('# debugging:') && h.includes('secret.js')), JSON.stringify(headers.slice(-3)))
check('not for the line typed to run it', !headers.some((h) => h.includes('EncodedCommand')), JSON.stringify(headers.slice(-3)))
const paneText = await page.evaluate(() => document.querySelector('.pane[data-integration]')?.textContent ?? '')
check('the secret is nowhere in the pane', !paneText.includes(TOKEN))
const recorded = await page.evaluate(async (token) => {
  const hits = async (text) => ((await window.ember.searchHistory({ text, limit: 50 })) ?? []).length
  return { token: await hits(token.slice(0, 12)), encoded: await hits('EncodedCommand') }
}, TOKEN)
check('nor in history', recorded.token === 0, JSON.stringify(recorded))
check('and nothing the debugger typed is in history', recorded.encoded === 0, JSON.stringify(recorded))
check('and the argument that named one reaches the program', await page.evaluate(() => [...document.querySelectorAll('.block__body')].some((b) => /arg-seen-40/.test(b.textContent ?? ''))))
/*
 * Nor in PowerShell's own history file, which keeps every line typed — encoded or
 * not, and its filter for secrets cannot see through the encoding. So each encoded
 * line in it is decoded and read.
 */
const typed = histPath && fs.existsSync(histPath) ? fs.readFileSync(histPath).subarray(histStart).toString('utf8') : ''
const decoded = [...typed.matchAll(/-EncodedCommand (\S+)/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf16le')).join('\n')
check('PowerShell keeps a history to read', typed.length > 0, histPath || '(no path)')
check('and no secret is in it, encoded or not', ![TOKEN, ARG_TOKEN].some((t) => typed.includes(t) || decoded.includes(t)), histPath)
const leftover = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ember-debuggee-') && !tempBefore.has(n))
check('the file that carried it is gone', leftover.length === 0, JSON.stringify(leftover))

/*
 * --- a launch the adapter refuses ------------------------------------------------
 *
 * Said only in the Debug view, and the session ended without a disconnect: with
 * the panel closed, F5 looked like a key that did nothing (DA-02).
 */
await settle()
await page.locator('.dbg__launch select').selectOption({ label: 'Missing runtime' })
await sleep(400)
await page.click('.pane.editor .view-lines')
await page.keyboard.press('F5')
let told = ''
await waitFor(async () => /could not start the program/.test((told = await page.evaluate(() => document.body.textContent ?? ''))), 30_000)
// The notice itself, naming the runtime: any launch that ended would say "could not start".
const notice = (told.match(/could not start the program[^\n]{0,200}/) ?? [''])[0]
check('a refused launch says so where it will be seen, and why', notice.includes('no-such-runtime-ember'), notice || '(no notice)')
check('and the debugger is idle again', await waitFor(async () => (await state()).includes('Not debugging'), 15_000), await state())

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
for (const pid of [parentPid, childPid]) if (pid > 0 && alive(pid)) process.kill(pid)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('js-debug:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
