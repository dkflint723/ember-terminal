// An ssh session says it is remote, and comes back when its connection is lost.
// Run: node scripts/verify-ssh-remote.mjs
//
// An ssh pane looked like any other: the status bar named a folder on this machine,
// nothing said the pane was somewhere else, and a dropped connection left a dead pane
// (audit R31). There is no ssh server here to drop a connection from, so the session
// is pointed at a port nothing listens on: ssh fails at once with status 255, which is
// the status a lost connection ends with too, and is what the reconnect keys on.
//
// What it asks: the pane, the status bar and the session card each say remote and
// name the host; the lost connection is said, with a countdown; it is tried again on
// its own, the count going up; Now tries at once; and Stop leaves the pane to Restart.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, seedDirs } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('ssh')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const HOST = '127.0.0.1'
for (const d of seedDirs(profile.dir)) {
  fs.writeFileSync(
    path.join(d, 'settings.json'),
    JSON.stringify({
      customProfiles: [
        { id: 'remote-test', name: 'Lab box', path: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=3', '-p', '1', HOST], integration: 'none' }
      ]
    }),
    'utf8'
  )
}

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
    await sleep(200)
  }
  return test()
}
const notice = () => page.evaluate(() => document.querySelector('.pane__notice')?.textContent ?? '')

await page.click('.sessions__new')
await sleep(500)
await page.locator('.sessions__menu .titlebar__menu-item', { hasText: 'Lab box' }).click()
await waitFor(async () => /remote/i.test(await notice()), 20_000)

check('the pane says it is remote, and where', (await page.locator('.pane__remote').count()) === 1 && (await notice()).includes(HOST), await notice())
const chip = await page.evaluate(() => document.querySelector('[data-status="remote"]')?.textContent ?? '')
check('the status bar names the host, not a folder here', chip.includes(HOST) && (await page.locator('[data-status="cwd"]').count()) === 0, chip)
const card = await page.evaluate(() => [...document.querySelectorAll('.sessions__branch')].map((b) => b.textContent ?? '').join(' | '))
check('and so does its card', card.includes(`remote · ${HOST}`), card)

// --- the connection lost, and tried again --------------------------------------------------
await waitFor(async () => /Reconnecting in/.test(await notice()), 20_000)
check('a lost connection is said, with a countdown', /connection to 127\.0\.0\.1 was lost\. Reconnecting in \d+s — try 1 of/.test(await notice()), await notice())
await waitFor(async () => /try 2 of/.test(await notice()), 15_000)
check('and it is tried again on its own', /try 2 of/.test(await notice()), await notice())
await page.locator('[data-reconnect="now"]').click()
await waitFor(async () => /try 3 of/.test(await notice()), 15_000)
check('Now tries at once', /try 3 of/.test(await notice()), await notice())
await page.locator('[data-reconnect="stop"]').click()
await sleep(800)
check('Stop stops, and leaves Restart', !/Reconnecting/.test(await notice()) && (await page.locator('[data-restart="shell"]').count()) === 1, await notice())

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('ssh sessions:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
