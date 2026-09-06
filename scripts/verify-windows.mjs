// Two windows, and a session that moves house with its shell alive.
//
// Ctrl+Shift+N opens a second window with its own shells — what runs in one
// must not appear in the other. Ctrl+Shift+U packs the active session into a
// new window: its blocks travel, its live pty is re-pointed rather than
// respawned — proven by an environment variable set before the move and read
// after it, which no fresh shell could know — and the window whose only
// session left closes behind it. A relaunch then brings every window back,
// each with its own session.
//
// Run: node scripts/verify-windows.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('windows')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// The deterministic fake, answering slowly on purpose: the move below has to
// happen while an answer is still arriving, which is the whole of the defect.
const env = { ...process.env, EMBER_FAKE_AI: '1', EMBER_FAKE_AI_SLOW: '1' }
delete env.ELECTRON_RUN_AS_NODE

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-move-'))
const dirTail = path.basename(dir).toLowerCase()

const launch = () =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const run = async (page, command, settle = 2600) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 6 })
  await page.keyboard.press('Enter')
  await sleep(settle)
}
const paneText = (page) =>
  page.evaluate(() => (document.querySelector('.pane__scroll')?.textContent ?? '').toLowerCase())
const ready = async (page) => {
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  await sleep(1500)
}
/** Poll until the app holds `count` windows; resolve them, newest included. */
const waitForWindows = async (app, count, timeoutMs = 25_000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const wins = app.windows().filter((w) => !w.isClosed())
    if (wins.length === count) return wins
    await sleep(300)
  }
  throw new Error(`never reached ${count} windows`)
}

// --- first life: two windows, separate shells ----------------------------------
let app = await launch()
const one = await app.firstWindow()
await placeTopRight(app)
await ready(one)

await run(one, `cd "${dir}"`)
await run(one, `$env:EMBER_WIN_PROOF='alive-7'`, 1800)
await run(one, 'echo win-one-marker')

await one.keyboard.press('Control+Shift+N')
const bothOpen = await waitForWindows(app, 2)
const two = bothOpen.find((w) => w !== one)
await ready(two)

await run(two, 'echo win-two-marker')
check('the second window runs its own shell', (await paneText(two)).includes('win-two-marker'))
check(
  'and its output never reaches the first',
  !(await paneText(one)).includes('win-two-marker'),
  (await paneText(one)).slice(-120)
)
check('nor the first window’s output the second', !(await paneText(two)).includes('win-one-marker'))

/*
 * --- and an answer still arriving does not travel as a ghost --------------------
 *
 * A delta is addressed twice: main sends it to the webContents that asked, and the
 * panel routes it through a map in that window's own module. So a turn still
 * streaming when its session walks out can never be finished by anybody — it
 * arrived in the new window able only to spin.
 *
 * `snapshot()` has always known this and written mid-stream turns down as cancelled
 * on the way to disk, saying so in a comment. Neither half of a move did, which is
 * why nobody ever saw it survive a restart. It is not cosmetic: the panel refuses
 * to send while anything is streaming, so its input was dead for the life of the
 * window, and Stop takes the FIRST streaming turn — so the ghost absorbed every
 * Stop from then on and a genuinely live turn behind it could never be reached.
 */
await one.click('.composer__input')
await one.keyboard.type('what is in this folder', { delay: 8 })
await one.keyboard.press('Control+Enter')
// Waited for rather than timed: the panel has to open, the request has to reach
// the fake, and the first delta has to arrive before there is anything to see.
let asking = 0
for (let i = 0; i < 30 && asking === 0; i += 1) {
  await sleep(200)
  asking = await one.evaluate(() => document.querySelectorAll('.agent__cursor').length)
}
check('an answer is still arriving when the session is moved', asking > 0, `${asking} streaming`)

// --- the move: blocks travel, the shell stays alive ----------------------------
await one.click('.composer__input')
// The window can close under the keystroke: the move empties it and it follows
// its session out, sometimes before the key-up half of the press reports back.
await one.keyboard.press('Control+Shift+U').catch(() => {})

// The moved session lands in a third window; the first, emptied, closes itself.
let adopted = null
{
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    const wins = app.windows().filter((w) => !w.isClosed() && w !== one && w !== two)
    if (wins.length === 1) {
      adopted = wins[0]
      break
    }
    await sleep(300)
  }
}
check('the move opens a window for the session', adopted !== null)
if (adopted) {
  await adopted.waitForSelector('.block', { timeout: 20_000 })
  await sleep(1500)
  check('its blocks made the trip', (await paneText(adopted)).includes('win-one-marker'))
  const statusbar = await adopted.evaluate(
    () => (document.querySelector('.statusbar')?.textContent ?? '').toLowerCase()
  )
  check('standing where the shell stood', statusbar.includes(dirTail), statusbar.slice(0, 120))

  // The proof no fresh shell could give: the variable set before the move.
  await run(adopted, 'echo $env:EMBER_WIN_PROOF', 3200)
  check(
    'and the shell is the same living process',
    (await paneText(adopted)).includes('alive-7'),
    (await paneText(adopted)).slice(-160)
  )

  /*
   * The turn that was in flight arrives settled, not spinning. Read as the absence
   * of a streaming cursor after a generous wait: if anything were still marked
   * streaming it would stay that way for ever, since nothing in this window can
   * finish it.
   */
  /*
   * The panel has to be on screen before any of this means anything. Whether it
   * travels open is not what is under test, and a closed panel renders no turns at
   * all — so a check that counted cursors without this would pass for every build,
   * fixed or not. It did, the first time it was written.
   */
  const panelOpen = await adopted.evaluate(() => document.querySelectorAll('.agent').length > 0)
  if (!panelOpen) {
    await adopted.keyboard.press('Control+Shift+B')
    await sleep(1200)
  }
  await sleep(2500)
  const carried = await adopted.evaluate(
    () => document.querySelectorAll('.agent__turn--user').length
  )
  check('the conversation made the trip', carried > 0, `${carried} user turns`)
  const ghosts = await adopted.evaluate(
    () => document.querySelectorAll('.agent__cursor').length
  )
  check('the turn that was mid-answer did not travel as a ghost', ghosts === 0, `${ghosts} still streaming`)
  /*
   * And put the panel back the way it was found. Leaving it open changes the
   * layout this window writes down, and the restart checks further on read the
   * terminal that layout decides the shape of — which is how the first version of
   * this check made a passing suite fail two scenarios later.
   */
  if (!panelOpen) {
    await adopted.keyboard.press('Control+Shift+B')
    await sleep(1000)
  }
  /*
   * And the panel can be used. This is what the ghost actually cost: `send()`
   * refuses while anything streams, so the input and the button were dead for the
   * life of the window — a check on the cursor alone would pass for a build that
   * merely hid it.
   */
  const canAsk = await adopted.evaluate(() => {
    const box = document.querySelector('.agent__input')
    return box ? !box.disabled : null
  })
  check('and the panel can be asked something else', canAsk !== false, String(canAsk))
}
{
  const until = Date.now() + 15_000
  while (Date.now() < until && !one.isClosed()) await sleep(300)
}
check('the emptied window closed behind its session', one.isClosed())

// Both survivors get a beat to write their sessions down before the app goes.
await sleep(3000)
await app.close()
await sleep(1500)

// --- second life: every window comes back --------------------------------------
app = await launch()
const revived = await waitForWindows(app, 2, 40_000)
for (const page of revived) await ready(page)
const texts = await Promise.all(revived.map((p) => paneText(p)))
check(
  'one restored window holds the moved session',
  texts.some((t) => t.includes('win-one-marker')),
  texts.map((t) => t.slice(-60)).join(' | ')
)
check(
  'the other holds its own',
  texts.some((t) => t.includes('win-two-marker') && !t.includes('win-one-marker'))
)

await app.close()
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('second window:', failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
