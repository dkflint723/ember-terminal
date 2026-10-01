// The drop-down window: summoned, sent away, and kept warm in between.
// Run: node scripts/verify-dropdown.mjs
//
// A terminal brought down over everything by a global shortcut is what many terminal
// users expect (audit R34), and Ember had none. The shortcut itself is a key pressed in
// another program, which a suite cannot press; the palette's Toggle drop-down window
// runs the same toggle, and the shortcut's registration is read from main.
//
// What it asks: choosing a shortcut registers it and clearing it unregisters it; the
// toggle brings down an always-on-top, borderless strip across the top of the screen,
// out of the taskbar; the toggle sends it away; and brought back, its shell still holds
// what it ran.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('dropdown')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
// Unlikely to be held by anything on a machine running the suite.
const SHORTCUT = 'Control+Alt+Shift+F12'

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
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(800)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const waitFor = async (test, ms) => {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (await test()) return true
    await sleep(250)
  }
  return test()
}
const registered = () => app.evaluate(({ globalShortcut }, s) => globalShortcut.isRegistered(s), SHORTCUT)
/** What main says of the drop-down: the always-on-top window, if there is one. */
const dropdown = () =>
  app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.isAlwaysOnTop())
    if (!win) return null
    const area = screen.getDisplayMatching(win.getBounds()).workArea
    return { visible: win.isVisible(), bounds: win.getBounds(), area }
  })
const palette = async (target, label) => {
  await target.keyboard.press('Control+Shift+P')
  await target.waitForSelector('.qp__box', { timeout: 10_000 })
  await target.locator('.qp__box').fill(label)
  await sleep(400)
  await target.locator('.qp__box').press('Enter')
}

// --- the shortcut follows the setting ------------------------------------------------------
check('no shortcut is registered by default', !(await registered()))
await page.evaluate((s) => window.ember.setSettings({ dropdownShortcut: s }), SHORTCUT)
await sleep(500)
check('choosing one registers it', await registered())

// --- brought down ------------------------------------------------------------------------------
await page.click('.composer__input')
await palette(page, 'Toggle drop-down window')
await waitFor(async () => (await dropdown())?.visible === true, 20_000)
const down = await dropdown()
check('the toggle brings down an always-on-top window', down?.visible === true, JSON.stringify(down))
if (down) {
  check('across the top of the screen', down.bounds.y === down.area.y && Math.abs(down.bounds.width - down.area.width) <= 2, JSON.stringify(down))
  check('over less than the whole of it', down.bounds.height < down.area.height, JSON.stringify(down))
}
// The rest needs the drop-down to have come down at all.
if (down) {
  const strip = app.windows().find((w) => w !== page) ?? (await app.waitForEvent('window', { timeout: 20_000 }))
  await strip.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  await strip.locator('.composer__input').first().focus()
  await strip.keyboard.type('Write-Output ("warm-" + "kept")', { delay: 4 })
  await strip.keyboard.press('Enter')
  await waitFor(() => strip.evaluate(() => (document.body.textContent ?? '').includes('warm-kept')), 15_000)

  // --- sent away, and brought back as it was ---------------------------------------------------------
  await palette(strip, 'Toggle drop-down window')
  await waitFor(async () => (await dropdown())?.visible === false, 10_000)
  check('the toggle sends it away again', (await dropdown())?.visible === false, JSON.stringify(await dropdown()))
  await page.bringToFront()
  await page.click('.composer__input')
  await palette(page, 'Toggle drop-down window')
  await waitFor(async () => (await dropdown())?.visible === true, 10_000)
  check('and brings it back', (await dropdown())?.visible === true)
  const kept = await strip.evaluate(() => (document.body.textContent ?? '').includes('warm-kept'))
  check('with its shell as it left it', kept)
  check('one drop-down, not two', (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isAlwaysOnTop()).length)) === 1)
}

// --- clearing the shortcut lets it go ----------------------------------------------------------------
await page.evaluate(() => window.ember.setSettings({ dropdownShortcut: '' }))
await sleep(500)
check('clearing the shortcut unregisters it', !(await registered()))

/*
 * --- closing the main window still quits ------------------------------------------------
 *
 * The drop-down, hidden and out of the taskbar, kept Ember running invisibly after
 * the last real window closed, and that window's tabs were dropped from the next
 * launch as though it were one of several. Closing it now closes Ember.
 */
const exited = new Promise((resolve) => app.process().once('exit', () => resolve(true)))
await page.evaluate(() => window.close())
const gone = await Promise.race([exited, sleep(20_000).then(() => false)])
check('closing the main window with the drop-down about quits Ember', gone)
const unclosed = gone ? null : await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('drop-down window:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
