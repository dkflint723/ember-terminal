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
import { watchPageErrors } from './harness.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('plain')
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

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('plain terminal:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
