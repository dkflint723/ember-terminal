// A second Ember, standing beside the first, that knows it is the elevated one.
//
// The elevation itself is a UAC prompt no test can answer, so what is checked
// here is everything around it: that an --admin-window instance is exempt from
// the single-instance lock (an ordinary second Ember still defers, which is
// what the lock is for), that it keeps its own user-data directory rather than
// fighting the first one over the session, settings and history it would
// otherwise share, that it seeds its settings from the ordinary window so it
// looks the same, and that it says what it is where a person cannot miss it.
//
// Run: node scripts/verify-admin.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('admin')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// Every window of every launch below reports its uncaught page errors here.
const pageErrors = []
const launch = (extra = []) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, ...extra],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }).then((app) => watchPageErrors(app, pageErrors))

// --- the ordinary window ---------------------------------------------------------
const ordinary = await launch()
const ordinaryPage = await ordinary.firstWindow()
await watchRunning(ordinary)
await placeTopRight(ordinary)
await ordinaryPage.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)
check(
  'an ordinary window wears no administrator badge',
  (await ordinaryPage.locator('.titlebar__admin').count()) === 0
)
check(
  'and does not believe it is elevated',
  (await ordinaryPage.evaluate(() => window.ember.isAdmin)) === false
)

// --- the admin twin, alongside it -------------------------------------------------
const admin = await launch(['--admin-window'])
const adminPage = await admin.firstWindow()
await watchRunning(admin)
await adminPage.waitForSelector('.pane', { timeout: 40_000 })
await sleep(1500)

// It got a window at all: the single-instance lock let it through.
check('an admin window opens beside the ordinary one', (await adminPage.title()) !== null)
check(
  'it knows it is the elevated one',
  (await adminPage.evaluate(() => window.ember.isAdmin)) === true
)
check(
  'and says so in the title bar',
  (await adminPage.locator('.titlebar__admin').count()) === 1,
  await adminPage.locator('.titlebar__admin').textContent().catch(() => 'absent')
)

/*
 * And says what that costs, where somebody would ask.
 *
 * Keeping its own settings, session and history is deliberate — a file written by
 * an administrator is one the ordinary Ember may no longer be able to replace — but
 * it means two windows that look identical do not share what you change in them.
 * Nothing said so, so a preference set in one and missing from the other read as a
 * bug rather than as the design, and the six-day drift found on this machine had
 * nothing on screen to explain it.
 */
const badgeTitle = await adminPage.locator('.titlebar__admin').getAttribute('title')
check(
  'the badge says the elevated window keeps its own settings',
  /own settings/i.test(badgeTitle ?? ''),
  JSON.stringify(badgeTitle)
)
check(
  'and that changes made in it stay in it',
  /stay here|copied across/i.test(badgeTitle ?? ''),
  JSON.stringify(badgeTitle)
)

// Its own user-data directory, seeded from the ordinary one.
const adminDir = path.join(profile.dir, 'admin-window')
check('it keeps its own user-data directory', fs.existsSync(adminDir), adminDir)
check(
  'seeded with the settings the ordinary window uses',
  fs.existsSync(path.join(adminDir, 'settings.json'))
)
// The thing that matters most: it must not be writing the ordinary session.
await sleep(2500)
check(
  'and writes its session there, not over the ordinary one',
  !fs.existsSync(path.join(adminDir, 'session.json')) ||
    fs.existsSync(path.join(profile.dir, 'session.json')),
  'sessions must not be shared'
)

// The ordinary window is still alive and its own self.
check('the ordinary window survived', (await ordinaryPage.locator('.pane').count()) >= 1)

/*
 * --- and only one of it ---------------------------------------------------------
 *
 * The lock line read `!isAdminWindow && !app.requestSingleInstanceLock()`, above a
 * comment claiming the elevated window held a lock of its own. It held none: `&&`
 * short-circuits, so an elevated process never asked, and a lock nobody requests is
 * a lock nobody holds. The earlier test that "proved removing the exemption changes
 * nothing" was run with one elevated window, which is the only case where that is
 * true.
 *
 * What it cost was two elevated Embers on one fixed directory, each rewriting the
 * whole session file from its own private map every second or so — so each erased
 * the other's windows continuously, and a session snapshot carries unsaved editor
 * buffers. It did not need this button either: any elevated launch is an admin
 * window, so Run as administrator from the taskbar beside an open twin got there.
 *
 * A second one must quit of its own accord. Proved by the first one still being
 * there afterwards, which is the half that matters: a lock that turned away the
 * wrong process would satisfy a check that only counted windows.
 */
/*
 * Spawned as a plain child process, not through Playwright.
 *
 * This used to launch through Playwright and score a thrown launch as the process
 * "taking the lock's answer and going". But every failure to launch throws — a twin
 * that crashed on start, or never started at all, passed just the same. A child
 * process has an exit code, and the lock's answer is a specific one: app.quit()
 * before any window, which is a quick, clean exit 0. Anything still running after
 * fifteen seconds got past the lock.
 */
const second = await new Promise((resolve) => {
  const child = spawn(
    path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    [APP_DIR, profile.arg, '--admin-window'],
    { cwd: APP_DIR, env, stdio: 'ignore', windowsHide: true }
  )
  const timer = setTimeout(() => {
    child.kill()
    resolve({ exited: false })
  }, 15_000)
  child.on('exit', (code) => {
    clearTimeout(timer)
    resolve({ exited: true, code })
  })
  child.on('error', (err) => {
    clearTimeout(timer)
    resolve({ exited: false, error: String(err) })
  })
})
check(
  'a second elevated Ember turns itself away cleanly',
  second.exited && second.code === 0,
  JSON.stringify(second)
)
check(
  'and the one already open is untouched',
  (await adminPage.evaluate(() => window.ember.isAdmin)) === true,
  'the existing admin window went away instead'
)
/*
 * --- the twin keeps up with the settings, rather than photographing them once ----
 *
 * The seed was one copy guarded by "only if nothing is there yet", so the elevated
 * window looked like the settings on the day it was first opened and drifted from
 * that moment on. On the machine this was found on, six days later, the twin still
 * had a different default shell and a different suggestion model, with nothing on
 * screen to say why. Seeding exists so the two look the same; it held for one launch.
 */
await ordinaryPage.evaluate(() =>
  window.ember.setSettings({
    fontSize: 19,
    themeId: 'user:acme',
    // Not a shared key. Its job here is to be left behind.
    recentFolders: ['ordinary-window-only']
  })
)
fs.mkdirSync(path.join(profile.dir, 'themes'), { recursive: true })
fs.writeFileSync(path.join(profile.dir, 'themes', 'acme.json'), '{"name":"Acme"}')
await sleep(800)
const adminUnclosed = await closeApp(admin)
if (adminUnclosed) failures.push(`the admin window, first launch: ${adminUnclosed}`)
await sleep(1200)

const again = await launch(['--admin-window'])
const againPage = await again.firstWindow()
await watchRunning(again)
await againPage.waitForSelector('.pane', { timeout: 40_000 })
await sleep(2000)
const carried = await againPage.evaluate(() => window.ember.getSettings())
check(
  'a preference changed since it was seeded reaches the elevated window',
  carried.fontSize === 19,
  `fontSize ${carried.fontSize}`
)
/*
 * And the file the themeId points at. A theme id is a reference: carrying the name
 * without the file it names leaves the elevated window falling back to the default,
 * which is the single difference a person notices the instant the window opens.
 */
check(
  'along with the theme file its themeId names',
  fs.existsSync(path.join(adminDir, 'themes', 'acme.json')),
  path.join(adminDir, 'themes', 'acme.json')
)
/*
 * But only the keys that are meant to be shared.
 *
 * The seed is a merge of a whitelist, not a copy of the file, because several
 * things in there are honestly the elevated window's own — its rectangle, the
 * chords it has learned, and the update it is specifically not allowed to install.
 *
 * Checked on a key that is deliberately NOT on the list. `windowBounds` cannot
 * carry this: the elevated window writes its own on close, so finding a value
 * there says nothing about where the value came from.
 */
const adminSettings = JSON.parse(fs.readFileSync(path.join(adminDir, 'settings.json'), 'utf8'))
check(
  'while a setting that is not shared stays behind',
  !JSON.stringify(adminSettings.recentFolders ?? []).includes('ordinary-window-only'),
  JSON.stringify(adminSettings.recentFolders)
)
const againUnclosed = await closeApp(again)
if (againUnclosed) failures.push(`the admin window, relaunched: ${againUnclosed}`)

/*
 * --- what is NOT checked here, and why -------------------------------------------
 *
 * Two things in this path have no check, and both are the same wall: a consent
 * prompt is drawn by Windows on the secure desktop and no test can answer one.
 *
 * The first is telling a declined prompt from a failure that is not a decline —
 * which the code now does on ERROR_CANCELLED rather than on "PowerShell exited
 * non-zero", so a machine whose elevation is broken stops being told it dismissed
 * something it never saw. Reaching either branch means raising a real prompt.
 *
 * The second is spawn failing outright, where Node emits `error` and never `exit`,
 * so the notice and the watchdog both sat in a branch that never ran and the press
 * produced total silence. It is provoked by making PowerShell unfindable, and the
 * only lever for that is SystemRoot — which Electron itself needs to start, so both
 * a missing directory and an empty one take the harness down before the app is up.
 * Tried, both ways, and abandoned rather than left as a check that proves the
 * harness died. That fix ships unverified and is the one to be suspicious of.
 */

const unclosed = await closeApp(ordinary)
if (unclosed) failures.push(`the ordinary window: ${unclosed}`)
profile.cleanup()
fs.rmSync(adminDir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('admin window:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
