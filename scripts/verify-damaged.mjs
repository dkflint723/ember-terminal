// Starting from files that a crash or a newer Ember left behind. Run: node scripts/verify-damaged.mjs
//
// Every file Ember keeps could be torn by an interrupted write, and each one used
// to be lost in its own quiet way: unreadable settings were reset, an unreadable or
// newer session was dropped and then overwritten by the first save, and a history
// database that would not open switched history off for good, with nothing said.
//
// This launches on a profile holding all three, damaged, and checks that the app
// starts anyway, that each file is kept aside rather than destroyed, that settings
// come back from the copy kept before the last write, and that one notice says
// what happened.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
// The profile's own audit still runs: damaged files are something to recover
// from, not a fault in the app, so main should report none.
const profile = newProfile('damaged')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const at = (name) => path.join(profile.dir, name)
const exists = (name) => fs.existsSync(at(name))

// Settings: torn mid-write, with the previous generation beside it.
fs.writeFileSync(at('settings.json.bak'), JSON.stringify({ fontSize: 17, restoreSession: true }, null, 2))
fs.writeFileSync(at('settings.json'), '{\n  "fontSize": 17,\n  "restoreSe')
// The workspace: written by a version from the future.
fs.writeFileSync(at('session.json'), JSON.stringify({ version: 3, windows: [{ someday: true }] }))
// History: not a database at all.
fs.writeFileSync(at('history.db'), 'SQLite format 3\0' + 'x'.repeat(200))

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const started = await page
  .waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  .then(() => true)
  .catch(() => false)
check('the app starts and reaches a prompt', started)
await sleep(1500)

// --- each file is kept aside, not destroyed -----------------------------------
check('the torn settings are kept as settings.json.bad', exists('settings.json.bad'))
check('the unreadable workspace is kept as session.json.bad', exists('session.json.bad'))
check(
  'and it is the file that was there, untouched',
  exists('session.json.bad') && fs.readFileSync(at('session.json.bad'), 'utf8').includes('"version":3')
)
check('the broken history is kept as history.db.bad', exists('history.db.bad'))

// --- and recovered from, where there is something to recover ------------------
const fontSize = await page.evaluate(() => window.ember.getSettings().then((s) => s.fontSize))
check('settings come back from the copy kept before the last write', fontSize === 17, String(fontSize))

// --- one notice says all of it ------------------------------------------------
const notice = (await page.locator('.notice__text').textContent().catch(() => '')) ?? ''
check('a notice says the settings were restored', /settings/i.test(notice) && /previous copy/i.test(notice), notice)
check('and that the workspace could not be read', /workspace/i.test(notice) && /session\.json\.bad/.test(notice), notice)
check('and that history was started again', /history/i.test(notice) && /history\.db\.bad/.test(notice), notice)

// --- history works again, rather than being off for good ----------------------
await page.click('.composer__input')
await page.keyboard.type('echo after-the-damage', { delay: 5 })
await page.keyboard.press('Enter')
await sleep(3000)
const found = await page.evaluate(() =>
  window.ember.searchHistory({ text: 'after-the-damage', limit: 5 }).then((rows) => rows.length)
)
check('a new command is recorded in the new history', found > 0, `${found} rows`)

// --- and what is written from now on keeps a previous generation ---------------
await page.evaluate(() => window.ember.setSettings({ fontSize: 15 }))
await sleep(300)
const written = fs.existsSync(at('settings.json')) ? fs.readFileSync(at('settings.json'), 'utf8') : ''
check('settings are written whole', (() => { try { return JSON.parse(written).fontSize === 15 } catch { return false } })(), written.slice(0, 80))
check(
  'with the copy before it kept as .bak',
  exists('settings.json.bak') && JSON.parse(fs.readFileSync(at('settings.json.bak'), 'utf8')).fontSize === 17
)
check(
  'and no temporary file left beside them',
  fs.readdirSync(profile.dir).filter((f) => f.endsWith('.tmp')).length === 0,
  fs.readdirSync(profile.dir).filter((f) => f.endsWith('.tmp')).join(', ')
)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
check('the workspace is written on the way out', exists('session.json'))
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('damaged files:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
