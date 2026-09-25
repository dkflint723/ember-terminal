// What Ember does while nobody is using it. Run: node scripts/verify-idle.mjs
//
// Two things the audit found it doing that it should not. Monaco was in the startup
// bundle, so a window that was only ever a terminal loaded and parsed an editor
// before it could show a prompt. And the session file was rewritten about every
// three seconds while the app sat still: a git poll replaced an identical status
// object, every subscriber heard "the store changed", and the autosave — listening
// to all of it — wrote the whole workspace on the main process's thread.
//
// So this watches a window do nothing, in a git repository where the poll is live,
// and counts.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('idle')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

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

/*
 * When the first prompt appeared and when the editor arrived, on the page's own
 * clock, both watched from here rather than read afterwards: the preload is meant
 * to follow the prompt within moments, and reading the times late could put them
 * in either order. The editor announces itself as `window.monaco` when its module
 * is evaluated. (Resource timing was the first idea, and has no entries for the
 * app's own file:// chunks.)
 */
await page.evaluate(() => {
  const tick = () => {
    const now = performance.now()
    if (window.__firstPrompt === undefined &&
        document.querySelector('.pane[data-integration="ready"], .pane[data-integration="absent"]')) {
      window.__firstPrompt = now
    }
    if (window.__editorAt === undefined && window.monaco) window.__editorAt = now
    if (window.__firstPrompt === undefined || window.__editorAt === undefined) setTimeout(tick, 20)
  }
  tick()
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })

// --- the editor is not what the prompt waits for ------------------------------
const times = async () =>
  page.evaluate(() => ({ prompt: window.__firstPrompt ?? null, editor: window.__editorAt ?? null }))
let seen = await times()
const deadline = Date.now() + 20_000
while (seen.editor === null && Date.now() < deadline) {
  await sleep(500)
  seen = await times()
}
check(
  'the editor arrives only after the first prompt',
  seen.prompt !== null && (seen.editor === null || seen.editor >= seen.prompt),
  JSON.stringify(seen)
)
check('and it does arrive, so the first switch to the IDE does not wait', seen.editor !== null, JSON.stringify(seen))

// --- a window doing nothing writes nothing ------------------------------------
// Into a repository, so the git status poll that used to set off every write is
// running, and the working tree has something to report.
await page.click('.composer__input')
await page.keyboard.type(`cd "${APP_DIR}"`, { delay: 5 })
await page.keyboard.press('Enter')
await sleep(8000)

const sessionFile = path.join(profile.dir, 'session.json')
const stamp = () => {
  try {
    return fs.statSync(sessionFile).mtimeMs
  } catch {
    return null
  }
}
let last = stamp()
let writes = 0
const IDLE_MS = 30_000
const until = Date.now() + IDLE_MS
while (Date.now() < until) {
  await sleep(250)
  const now = stamp()
  if (now !== last) {
    writes += 1
    last = now
  }
}
check(
  `at most one session write in ${IDLE_MS / 1000} idle seconds`,
  writes <= 1,
  `${writes} writes`
)

// And the write still happens when there is something to write.
const before = stamp()
await page.keyboard.press('Control+Shift+T')
await sleep(4000)
check('a real change is still written down', stamp() !== before, `${before} -> ${stamp()}`)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('idle:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
