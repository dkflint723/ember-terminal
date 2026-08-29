// The update actually downloads, and says so.
//
// This exists because every release for four versions was un-installable and
// nothing noticed: the feed named `Ember-Setup-<version>.exe`, the build
// produced `Ember Setup <version>.exe`, GitHub stored a third spelling, and the
// installer fetch 404'd in silence while the app cheerfully announced an update
// was available. scripts/check-release-assets.mjs now guards the publish side;
// this guards the app side — that a real packaged Ember, told a newer version
// exists, fetches it, verifies it, stages it under the name the feed declared,
// and reports every step to the window rather than promising and going quiet.
//
// A local feed, because the public one can only ever say "up to date" to a build
// cut from the same commit. The payload is a dummy file and the updater cache is
// a throwaway directory, so the installed Ember's own pending update is never
// touched and nothing can install over anything.
//
// Run: node scripts/verify-update.mjs   (needs a packaged build: npm run package)
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const UNPACKED = path.join(APP_DIR, 'release', 'win-unpacked')
const EXE = path.join(UNPACKED, 'Ember.exe')
const FEED_CONFIG = path.join(UNPACKED, 'resources', 'app-update.yml')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!fs.existsSync(EXE) || !fs.existsSync(FEED_CONFIG)) {
  console.log('update download: SKIP — no packaged build in release/win-unpacked')
  process.exit(0)
}

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/*
 * The name is the point. It is spelled the way electron-builder spells it in a
 * real feed — hyphens, no spaces — and the staged file must come back spelled
 * exactly so, because the whole outage was three spellings of one filename.
 */
const payloadName = 'Ember-Setup-99.9.9.exe'
const payload = crypto.randomBytes(64 * 1024)
const sha512 = crypto.createHash('sha512').update(payload).digest('base64')
const feed = `version: 99.9.9
files:
  - url: ${payloadName}
    sha512: ${sha512}
    size: ${payload.length}
path: ${payloadName}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`

const served = []
const server = http.createServer((req, res) => {
  // electron-updater appends a cache-busting query; route on the path alone.
  const route = (req.url ?? '').split('?')[0]
  served.push(route)
  if (route === '/latest.yml') {
    res.writeHead(200, { 'content-type': 'text/yaml' })
    res.end(feed)
    return
  }
  if (route === `/${payloadName}`) {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(payload.length)
    })
    res.end(payload)
    return
  }
  // Everything else — the blockmap it tries first — is honestly absent, which
  // is the same answer a real release with no differential data gives.
  res.writeHead(404)
  res.end('absent')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const CACHE_NAME = 'ember-updater-selftest'
const cache = path.join(os.homedir(), 'AppData', 'Local', CACHE_NAME)
fs.rmSync(cache, { recursive: true, force: true })

const originalFeed = fs.readFileSync(FEED_CONFIG, 'utf8')
fs.writeFileSync(
  FEED_CONFIG,
  `provider: generic\nurl: http://127.0.0.1:${port}/\nupdaterCacheDirName: ${CACHE_NAME}\n`,
  'utf8'
)

const profile = newProfile('update')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

let statuses = []
let note = ''
let installButton = false
const errors = []
try {
  const app = await electron.launch({
    executablePath: EXE,
    args: [profile.arg],
    cwd: UNPACKED,
    env,
    timeout: 60_000
  })
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.pane', { timeout: 40_000 })
  await sleep(2500)

  await page.evaluate(() => {
    window.__updateStatuses = []
    window.ember.onUpdateStatus((s) => window.__updateStatuses.push(s))
  })
  await page.evaluate(() => window.ember.setSettings({ autoUpdate: true }))
  await sleep(600)

  note = await page.evaluate(() => window.ember.checkForUpdates())
  for (let i = 0; i < 60; i++) {
    await sleep(500)
    statuses = await page.evaluate(() => window.__updateStatuses ?? [])
    if (statuses.some((s) => s.stage === 'ready' || s.stage === 'error')) break
  }
  /*
   * And the button that acts on it is actually there. This is the bug this
   * check exists for: the status text said "choose Install now" while no such
   * button was rendered, because its visibility was matched against the
   * message's wording and the wording had changed.
   */
  await page.keyboard.press('Control+Comma')
  await page.waitForSelector('.modal--settings', { timeout: 10_000 })
  await sleep(900)
  installButton = await page.evaluate(() =>
    [...document.querySelectorAll('.modal--settings .btn')].some((b) =>
      (b.textContent ?? '').trim().toLowerCase().startsWith('install now')
    )
  )

  await app.close()
} finally {
  fs.writeFileSync(FEED_CONFIG, originalFeed, 'utf8')
  server.close()
  profile.cleanup()
}

check('the check finds the newer version', /99\.9\.9/.test(note), note)
check('the feed is fetched', served.includes('/latest.yml'), JSON.stringify(served))
check('the installer the feed names is fetched', served.includes(`/${payloadName}`), JSON.stringify(served))
check(
  'progress is reported while it downloads',
  statuses.some((s) => s.stage === 'progress'),
  JSON.stringify(statuses)
)
/*
 * The stage is what the Install now button keys off, and it is checked as a
 * stage rather than as words: driving that button by matching the message text
 * is exactly how it once vanished — the wording changed a release later and
 * the button silently stopped appearing while the words still said to press it.
 */
check(
  'and the finish is carried as a stage, not as prose',
  statuses.some((s) => s.stage === 'ready' && /ready to install/i.test(s.text)),
  JSON.stringify(statuses)
)
check('nothing reported a failure', !statuses.some((s) => s.stage === 'error'), JSON.stringify(statuses))

check('Settings offers Install now once an update is ready', installButton)

// Staged under the feed's own spelling, ready for the quit that installs it.
const staged = fs.existsSync(cache) ? fs.readdirSync(cache, { recursive: true }).map(String) : []
check(
  'the installer is staged under the name the feed declared',
  staged.some((f) => f.endsWith(payloadName)),
  JSON.stringify(staged)
)
check(
  'with the update-info the quit-time install reads',
  staged.some((f) => /update-info\.json$/.test(f)),
  JSON.stringify(staged)
)

/*
 * --- a promise already kept stops being offered ---------------------------------
 *
 * The note that an update is waiting is cleared by comparing the promised
 * version with the running one, and comparing them for equality alone left it
 * stuck: land on a version PAST the promise — two updates in a row, or a newer
 * installer taken by hand — and the running version never equals it, so Ember
 * went on offering to install something it was already ahead of, for ever.
 */
const pendingAfterLaunch = async (stored, label) => {
  const scratch = newProfile(`pending-${label}`)
  fs.writeFileSync(
    path.join(scratch.dir, 'settings.json'),
    JSON.stringify({ autoUpdate: false, pendingUpdateVersion: stored }),
    'utf8'
  )
  const scratchApp = await electron.launch({
    executablePath: EXE,
    args: [scratch.arg],
    cwd: UNPACKED,
    env,
    timeout: 60_000
  })
  const scratchPage = await scratchApp.firstWindow()
  await scratchPage.waitForSelector('.pane', { timeout: 40_000 })
  // The check runs a couple of seconds after the window appears.
  await sleep(5000)
  const held = await scratchPage.evaluate(
    () => window.ember.getSettings().then((s) => s.pendingUpdateVersion)
  )
  await scratchApp.close()
  scratch.cleanup()
  return held
}

const stale = await pendingAfterLaunch('0.0.1', 'stale')
check('a version already passed stops being offered', stale === null, String(stale))
const future = await pendingAfterLaunch('99.9.9', 'future')
check('one genuinely still waiting is kept', future === '99.9.9', String(future))

fs.rmSync(cache, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('update download:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
