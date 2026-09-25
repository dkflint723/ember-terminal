// A terminal with no shell integration, which is the shape several shells arrive in.
//
// cmd.exe reports no command boundaries, so there are no blocks to draw and no
// composer to type into: the pane hands itself to the terminal and says why. That
// fallback has existed for a long time with nothing gated asserting it — the one
// check that opened such a pane read the notice's text into a variable and then
// left it out of the pass expression, so the notice could have said anything.
//
// What was actually missing is the way out. A pane whose shell exited kept saying
// `exited 0` and nothing else: no composer, so no restart chip, and the only thing
// left to do with it was close the session. The notice offers Restart now, on the
// same hook the composer's own chip uses, because it is the same action.
//
// Proof of life without reading the screen: a shell that has restarted can be told
// to exit again. Only a running one can do that, and the live terminal's text is
// not reliably in the DOM — the WebGL renderer draws the rows rather than building
// them.
//
// Run: node scripts/verify-plain.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
// The reload below runs with session restore off, so the shell that was open before
// it is adopted by nobody and main kills it ten seconds later, logging that it did.
// That is the sweep doing its job on a shell this suite abandoned on purpose — but
// the audit fails a suite for any fault it was not told to expect, and whether the
// sweep had fired by the time the run ended depended on how long the run took.
const profile = newProfile('plain', { expectFaults: [/shell left behind by a reload/] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const pageErrors = []
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
await page.waitForSelector('.pane[data-integration]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- a pane that knows it has no integration ------------------------------------
const hasCmd = await page.evaluate(async () =>
  (await window.ember.listProfiles()).some((p) => p.id === 'cmd')
)
check('Command Prompt is offered as a profile', hasCmd)

if (hasCmd) {
  await page.evaluate(() =>
    window.ember.setSettings({ defaultProfileId: 'cmd', restoreSession: false })
  )
  await page.reload()
  await page.waitForSelector('.pane[data-integration="absent"]', { timeout: 40_000 })
  await sleep(2500)

  const view = () =>
    page.evaluate(() => ({
      integration: document.querySelector('.pane')?.getAttribute('data-integration') ?? null,
      paneId: document.querySelector('.pane')?.getAttribute('data-pane') ?? null,
      composers: document.querySelectorAll('.composer__input').length,
      fullPaneTerminal: document.querySelectorAll('.live--raw').length,
      stranded: document.querySelectorAll('.block--running').length,
      notice: document.querySelector('.pane__notice')?.textContent ?? '',
      restarts: document.querySelectorAll('[data-restart="shell"]').length
    }))

  const alive = await view()
  check('the pane settles as having no integration', alive.integration === 'absent', alive.integration)
  check('and says so, naming the shell', /has no shell integration/i.test(alive.notice) && /command prompt/i.test(alive.notice), JSON.stringify(alive.notice))
  check('there is no composer to type into', alive.composers === 0, String(alive.composers))
  check('the terminal has the whole pane', alive.fullPaneTerminal === 1, String(alive.fullPaneTerminal))
  check('and no block is left running forever', alive.stranded === 0, String(alive.stranded))
  // The half that keeps the offer honest: nothing to restart while it is alive.
  check('nothing offers to restart a shell that is running', alive.restarts === 0, String(alive.restarts))

  // --- and a way out when it dies -------------------------------------------------
  // Typed into the terminal itself, because that is the only input this pane has.
  const type = async (text) => {
    await page.locator('.xterm').first().click({ force: true })
    await page.keyboard.type(text, { delay: 12 })
    await page.keyboard.press('Enter')
  }
  const waitFor = async (want, ms = 20_000) => {
    for (let i = 0; i < ms / 250; i++) {
      if (await want()) return true
      await sleep(250)
    }
    return false
  }
  const exited = () => page.evaluate(() => /exited/i.test(document.querySelector('.pane__notice')?.textContent ?? ''))

  await type('exit')
  const noticed = await waitFor(exited)
  const dead = await view()
  check('the notice reports the shell exiting', noticed, JSON.stringify(dead.notice))
  check('and offers to start another', dead.restarts === 1, String(dead.restarts))
  check('the pane is still the same pane', dead.paneId === alive.paneId, `${alive.paneId} -> ${dead.paneId}`)

  if (dead.restarts === 1) {
    await page.locator('[data-restart="shell"]').click()
    const cleared = await waitFor(async () => !(await exited()))
    const back = await view()
    check('restarting clears the exit', cleared, JSON.stringify(back.notice))
    check('and takes the offer away with it', back.restarts === 0, String(back.restarts))
    check('the pane is plain again rather than waiting for blocks', back.integration === 'absent', back.integration)
    check('in the same pane, not a new one', back.paneId === alive.paneId, `${alive.paneId} -> ${back.paneId}`)
    check('and still no composer appeared', back.composers === 0, String(back.composers))

    /*
     * The assertion that matters. Everything above would hold for a pane that
     * merely redrew itself; only a shell that is actually running can be told to
     * exit, so the second exit is what proves the restart started one.
     */
    await sleep(1500)
    await type('exit')
    const exitedAgain = await waitFor(exited)
    check('the restarted shell is a real one, and exits when told', exitedAgain, JSON.stringify((await view()).notice))
  }
}

// --- a shell Ember has no script for says so, and says so at once -----------------
//
// zsh and fish were started as though they spoke bash, and the pane spent six
// seconds waiting for markers that were never coming before admitting it had none —
// with a toast, gone by then, as the only thing that ever named the reason. The
// reason rides back on the spawn now, the pane settles the moment it arrives, and
// the notice names the shell.
//
// Tested with a cmd.exe renamed zsh.exe: what is under test is what Ember says
// about an executable called zsh, not zsh itself, which is not on this machine.
const pretend = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-zsh-'))
const pretendZsh = path.join(pretend, 'zsh.exe')
fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), pretendZsh)

const paneBefore = await page.evaluate(() => document.querySelector('.pane')?.getAttribute('data-pane') ?? null)
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal', { timeout: 8_000 })
await page.locator('.btn', { hasText: 'Add shell…' }).click()
await sleep(400)
await page.locator('.shellrow__name').last().fill('Pretend zsh')
await page.locator('.shellrow__path').last().fill(pretendZsh)
// Deliberately the wrong dialect, which is how a zsh user who wanted blocks would
// have set it up — and the case that used to spin for six seconds.
await page.locator('.shellrow__dialect').last().selectOption('bash')
await page.locator('.modal .btn', { hasText: 'Save' }).click()
await sleep(1400)
await page.click('.sessions__new')
await sleep(500)
const zshEntry = page.locator('.sessions__menu .titlebar__menu-item', { hasText: 'Pretend zsh' })
check('the taught shell is offered', (await zshEntry.count()) === 1, String(await zshEntry.count()))
if ((await zshEntry.count()) === 1) {
  await zshEntry.click()
  // Timed from the new pane existing, not from the click.
  const opened = await page.waitForFunction(
    (was) => {
      const now = document.querySelector('.pane')?.getAttribute('data-pane') ?? null
      return now !== null && now !== was
    },
    paneBefore,
    { timeout: 15_000 }
  ).then(() => Date.now(), () => null)
  check('a new pane opens for it', opened !== null)
  if (opened !== null) {
    let settledIn = null
    for (let i = 0; i < 80; i++) {
      const state = await page.evaluate(() => document.querySelector('.pane')?.getAttribute('data-integration'))
      if (state === 'absent') {
        settledIn = Date.now() - opened
        break
      }
      await sleep(100)
    }
    check('the pane settles as plain', settledIn !== null)
    // Well inside the six seconds the old build spent waiting; well outside noise.
    check('and does so at once rather than after the grace period', settledIn !== null && settledIn < 4000, `${settledIn} ms`)
    const said = await page.evaluate(() => document.querySelector('.pane__notice')?.textContent ?? '')
    check('and the notice names the shell it has no script for', /no shell integration for zsh/i.test(said), JSON.stringify(said))
    check('with no composer offered', (await page.locator('.composer__input').count()) === 0)
  }
}
const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
// Only once the shells are dead. A running zsh.exe is a locked file, and removing
// its directory from under it fails with EPERM — and, worse, throws past the
// verdict, so a build that failed every check reported nothing at all.
fs.rmSync(pretend, { recursive: true, force: true })
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('plain terminal:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
