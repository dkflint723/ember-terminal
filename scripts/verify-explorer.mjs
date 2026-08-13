// Explorer integration: launching Ember on a folder, and the context-menu entry
// that does the launching.
//
// The registry half is checked against the registry itself rather than the
// checkbox, because the whole point of the feature is a change outside this app —
// a toggle that only convinced its own UI would be worthless.
//
// Run: node scripts/verify-explorer.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const KEY = 'HKCU\\Software\\Classes\\Directory\\shell\\Ember'

if (process.platform !== 'win32') {
  console.log('explorer integration: SKIP — Windows only')
  process.exit(0)
}

const regQuery = (key) => {
  try {
    // stderr discarded: a missing key is the expected answer half the time here,
    // and reg.exe writes a scary line about it that would make a pass look broken.
    return execFileSync('reg', ['query', key], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore']
    })
  } catch {
    return null
  }
}

// Refuse to run if the entry already exists: this test registers and unregisters,
// and it must not remove something the user set up themselves.
if (regQuery(KEY)) {
  console.log('explorer integration: SKIP — the menu entry already exists; not touching it')
  process.exit(0)
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-explorer-'))
fs.writeFileSync(path.join(work, 'inside.txt'), 'hello\n', 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// Launched on a folder, exactly as the context-menu command does it.
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)

const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- a folder argument roots the workspace and the shell --------------------
await page.click('.activity__item[data-view="explorer"]')
await page.waitForSelector('.tree', { timeout: 10_000 })
await sleep(800)

const rooted = await page.evaluate(() => ({
  root: document.querySelector('.tree__root')?.textContent ?? null,
  entries: Array.from(document.querySelectorAll('.tree__label')).map((l) => l.textContent)
}))
check('the sidebar is rooted at the folder', rooted.root === path.basename(work), rooted.root)
check('and lists what is in it', rooted.entries.includes('inside.txt'), JSON.stringify(rooted.entries))

// The shell has to start there too, or "open here" is only half true.
await page.click('.composer__input')
await page.keyboard.type('(Get-Location).Path', { delay: 6 })
await page.keyboard.press('Enter')
await sleep(2500)
const cwdShown = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.block'))
    .map((b) => b.textContent ?? '')
    .join(' ')
)
check('the shell starts in that folder', cwdShown.includes(work), work)
await page.screenshot({ path: path.join(SHOT_DIR, '70-opened-folder.png') })

// --- the context-menu entry, checked against the registry ------------------
const registered = await page.evaluate(() => window.ember.explorerRegister())
check('registering reports success', registered.ok, registered.error)

const entry = regQuery(KEY)
check('the key exists', entry !== null)
check('and is labelled', (entry ?? '').includes('Open in Ember'), (entry ?? '').trim().slice(0, 80))

const command = regQuery(`${KEY}\\command`) ?? ''
check('with a command that passes the folder', command.includes('%V'), command.trim().slice(0, 120))
check('pointing at this executable', command.toLowerCase().includes('electron.exe'), command.trim().slice(0, 120))

// Both of Explorer's other right-click targets have to be covered too, or the
// entry appears in some places and not others.
for (const extra of ['Directory\\Background', 'Drive']) {
  const key = `HKCU\\Software\\Classes\\${extra}\\shell\\Ember`
  check(`${extra} is covered`, regQuery(key) !== null)
}

const status = await page.evaluate(() => window.ember.explorerStatus())
check('status reads back as registered', status === true, String(status))

// --- and removing it leaves nothing behind ---------------------------------
const removed = await page.evaluate(() => window.ember.explorerUnregister())
check('unregistering reports success', removed.ok, removed.error)
check('the key is gone', regQuery(KEY) === null)
check(
  'as are the others',
  ['Directory\\Background', 'Drive'].every(
    (extra) => regQuery(`HKCU\\Software\\Classes\\${extra}\\shell\\Ember`) === null
  )
)

await app.close()
fs.rmSync(work, { recursive: true, force: true })

// Belt and braces: never leave the user's shell modified by a test run.
for (const key of [
  KEY,
  'HKCU\\Software\\Classes\\Directory\\Background\\shell\\Ember',
  'HKCU\\Software\\Classes\\Drive\\shell\\Ember'
]) {
  if (regQuery(key)) {
    try {
      execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore', windowsHide: true })
    } catch {
      console.log(`  ! left behind: ${key}`)
    }
  }
}

for (const f of failures) console.log(`  - ${f}`)
console.log('explorer integration:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
