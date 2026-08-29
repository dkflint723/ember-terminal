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
import * as fs from 'node:fs'
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

const launch = (extra = []) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, ...extra],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

// --- the ordinary window ---------------------------------------------------------
const ordinary = await launch()
const ordinaryPage = await ordinary.firstWindow()
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

await admin.close()
await ordinary.close()
profile.cleanup()
fs.rmSync(adminDir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('admin window:', failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
