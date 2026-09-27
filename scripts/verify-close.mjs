// Closing a window that is asking about a command, when the command ends by itself.
//
// A window with a command running asks before it closes. It asked synchronously,
// which stops main until somebody answers — and while main is stopped no shell's
// output reaches any window, so a command that finished a moment after the question
// went up could never be seen to have finished. Its block said "running…" behind a
// dialog asking whether to end it, for as long as nobody answered. That is how a
// close was found hanging on the maintainer's machine, over a `pnpm run build` whose
// error was already on the screen, and how verify-scripts hung on the runner in
// fifteen closes of a hundred and ten: a script pressed, the window closed a few
// hundred milliseconds later.
//
// The question is asked without stopping main now, and it is withdrawn when its
// reason goes: the command ends, nothing is left to lose, and the window closes,
// which is what was asked for. Both halves are checked with the real dialog, which
// nobody here answers — a command that ends lets the window close, and a command
// that does not end keeps it asking.
//
// Run: node scripts/verify-close.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, runningNow, watchPageErrors, watchRunning } from './harness.mjs'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const pageErrors = []

/**
 * An Ember with one command running in it, and every close question it asks
 * written to a file — the real dialog is still shown, since that is the thing
 * that used to stop main. A file, because the questions have to be read after the
 * process has gone.
 */
const launchRunning = async (label, command) => {
  const profile = newProfile(label)
  const asked = path.join(profile.dir, 'asked.txt')
  const app = watchPageErrors(
    await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
      args: [APP_DIR, profile.arg],
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
  await sleep(1500)
  await app.evaluate(({ dialog }, file) => {
    const fs = process.getBuiltinModule('node:fs')
    const note = (options) => fs.appendFileSync(file, `${String(options?.message ?? '')}\n`)
    const sync = dialog.showMessageBoxSync.bind(dialog)
    const async = dialog.showMessageBox.bind(dialog)
    dialog.showMessageBoxSync = (win, options) => (note(options), sync(win, options))
    dialog.showMessageBox = (win, options) => (note(options), async(win, options))
  }, asked)
  await page.locator('.composer__input').first().focus()
  await page.keyboard.type(command, { delay: 5 })
  await page.keyboard.press('Enter')
  const until = Date.now() + 15_000
  let running = await runningNow(app)
  while (Date.now() < until && !(running && running.length)) {
    await sleep(100)
    running = await runningNow(app)
  }
  const questions = () => (fs.existsSync(asked) ? fs.readFileSync(asked, 'utf8').split('\n').filter(Boolean) : [])
  return { app, profile, running, questions }
}

// --- a command that ends: the question withdraws itself ------------------------------
{
  const { app, profile, running, questions } = await launchRunning('close-ends', 'Start-Sleep -Seconds 4')
  check('a command is running to be asked about', (running ?? []).some((c) => c.includes('Start-Sleep')), JSON.stringify(running))
  const began = Date.now()
  // Twenty seconds is five times the command; the window should go about when it ends.
  const unclosed = await closeApp(app, { ms: 20_000 })
  const took = Date.now() - began
  check('the window is asked about the command first', questions().some((q) => /still running/.test(q) && /Start-Sleep/.test(q)), JSON.stringify(questions()))
  check('and closes once the command it was asked about has ended', unclosed === null, unclosed)
  // Not before: the question has to have been a question, not a formality.
  check('but not before it ended', unclosed !== null || took >= 2_500, `${took} ms`)
  profile.cleanup()
}

// --- a command that does not end: the question stays --------------------------------
{
  const { app, profile, running, questions } = await launchRunning('close-stays', 'ping -t 127.0.0.1')
  check('a command that does not end is running', (running ?? []).some((c) => c.includes('ping')), JSON.stringify(running))
  const proc = app.process()
  const exited = new Promise((resolve) => proc.once('exit', () => resolve(true)))
  app.close().catch(() => {})
  const gone = await Promise.race([exited, sleep(8_000).then(() => false)])
  check('a window still running something is not closed without an answer', !gone)
  check('and is asked about it', questions().some((q) => /ping/.test(q)), JSON.stringify(questions()))
  // Nobody answers, so it is ended from outside, the way the harness ends any stuck close.
  spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
  await Promise.race([exited, sleep(10_000)])
  profile.cleanup()
}

/*
 * --- shells asked for as the app quits ---------------------------------------------
 *
 * node-pty starts a shell a moment after it is asked to, and until then the shell
 * has no process id. Quitting waited only for shells with one, so a shell killed
 * while still starting was never waited for: node-pty killed it once it was up and
 * reported its exit — by then, sometimes, to a node already tearing itself down,
 * which it cannot report to. The process then dies with an uncaught C++ exception
 * (0xe06d7363), or waits on the shell for as long as it lives. Found by crash dump:
 * the exception escapes node-addon-api's ThreadSafeFunction::CallJS in conpty.node.
 * Measured on the runner: 6 of 15 such quits on the build before this failed.
 */
{
  const outcomes = []
  for (let round = 0; round < 5; round += 1) {
    const profile = newProfile(`close-race-${round}`)
    const app = watchPageErrors(
      await electron.launch({
        executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
        args: [APP_DIR, profile.arg],
        cwd: APP_DIR,
        env,
        timeout: 60_000
      }),
      pageErrors
    )
    const page = await app.firstWindow()
    await watchRunning(app)
    await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
    await sleep(800)
    const proc = app.process()
    const exited = new Promise((resolve) => proc.once('exit', (code) => resolve(code)))
    // Three shells asked for and not waited on, then the quit, at once.
    await page.evaluate(() => {
      for (let i = 0; i < 3; i += 1) {
        void window.ember.spawn({ paneId: `late-${Date.now()}-${i}`, profileId: '', cols: 80, rows: 24 }).catch(() => {})
      }
    })
    await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {})
    const code = await Promise.race([exited, sleep(30_000).then(() => 'still running after 30 s')])
    if (typeof code !== 'number') spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true })
    outcomes.push(typeof code === 'number' ? `0x${(code >>> 0).toString(16)}` : code)
    profile.cleanup()
  }
  check(
    'shells asked for as it quits: every quit of five exits cleanly',
    outcomes.every((o) => o === '0x0'),
    outcomes.join(', ')
  )
}

for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('closing while asking:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
