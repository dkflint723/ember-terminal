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
const env = { ...process.env }
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
