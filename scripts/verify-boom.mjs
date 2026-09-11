// The last thing between a render error and a blank window, proven to stand.
//
// React unmounts the whole tree when a render throws uncaught, so before the
// boundary a single bad component left an empty black rectangle over live
// shells. This detonates a deliberate render failure through the Detonator
// seam and requires the boundary to say so, keep the message on screen, and
// offer the reload that actually rebuilds the window.
//
// Run: node scripts/verify-boom.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('boom')
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
await placeTopRight(app)
const pageErrors = []
page.on('pageerror', (e) => {
  // The detonation itself is the one error this suite causes on purpose.
  if (!e.message.includes('ember:boom')) pageErrors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/*
 * A check for a bug that is known and not yet fixed.
 *
 * The honest alternative to `check(label, true)`, which is what the reload check
 * used to be: it runs the real assertion every time, reports the failure as known
 * rather than failing the gate, and turns into a failure the moment it passes — so a
 * fix cannot go unnoticed and the marker cannot outlive the bug it names.
 */
const known = []
const knownBug = (label, ok, detail, finding) => {
  if (ok) failures.push(`${label} — passes now, so ${finding} looks fixed: make this an ordinary check`)
  else known.push(`${label} (${finding})${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- a workspace worth getting back -------------------------------------------------
// A block in the first session and a second session beside it: what a reload that
// really rebuilt the window from the saved workspace would have to bring back.
await page.click('.composer__input')
await page.keyboard.type('echo boom-before-crash', { delay: 8 })
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => [...document.querySelectorAll('.block--done .block__body')].some((b) => b.textContent?.includes('boom-before-crash')),
  undefined,
  { timeout: 20_000 }
)
await page.keyboard.press('Control+Shift+KeyT')
await page.waitForFunction(() => document.querySelectorAll('.sessions__card').length === 2, undefined, {
  timeout: 10_000
})
// Past the autosave's debounce, so the snapshot on disk holds both sessions.
await sleep(2600)

// --- the crash ------------------------------------------------------------------
await page.evaluate(() => window.dispatchEvent(new CustomEvent('ember:boom')))
await sleep(800)

const boom = await page.evaluate(() => ({
  shown: !!document.querySelector('.boom'),
  alert: document.querySelector('.boom')?.getAttribute('role') ?? null,
  title: document.querySelector('.boom__title')?.textContent ?? '',
  error: document.querySelector('.boom__error')?.textContent ?? '',
  appGone: !document.querySelector('.pane')
}))
check('the boundary catches the render crash', boom.shown, JSON.stringify(boom))
check('and announces itself as an alert', boom.alert === 'alert', String(boom.alert))
check('saying what happened', boom.title.includes('stopped drawing'), boom.title)
check('with the actual error on screen', boom.error.includes('ember:boom'), boom.error)
check('while the broken tree is down', boom.appGone === true, String(boom.appGone))

// --- the way back ---------------------------------------------------------------
await page.locator('.boom .btn', { hasText: 'Reload the window' }).click()
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2000)
check('and the boundary stands down', (await page.locator('.boom').count()) === 0)

/*
 * What the reload brought back. The boundary's own copy promises "the workspace is
 * still saved — reloading rebuilds the window from it". It does not yet: main hands
 * each window its saved snapshot once, at creation, so the reloaded renderer asks
 * for it and gets nothing, starts a fresh tab, and the shells it had keep running
 * where nothing can reach them. Both are asserted for real and carried as known.
 */
const back = await page.evaluate(async () => {
  const stats = await window.ember.ptyFlowStats()
  return {
    sessions: document.querySelectorAll('.sessions__card').length,
    marker: [...document.querySelectorAll('.block__body')].some((b) => b.textContent?.includes('boom-before-crash')),
    shells: Object.keys(stats).length
  }
})
knownBug('reload brings back both sessions', back.sessions === 2, `${back.sessions} session(s)`, 'RE-02')
knownBug('and the first session’s blocks', back.marker, JSON.stringify(back), 'RE-02')
// Each session here has one pane, so a window that adopted its shells owns exactly
// one per session; anything more is a shell still running behind the reload.
knownBug(
  'and no shell is left running behind it',
  back.shells === back.sessions,
  `${back.shells} shells for ${back.sessions} session(s)`,
  'PT-04'
)

await app.close()
profile.cleanup()
for (const k of known) console.log(`  ~ KNOWN BUG ${k}`)
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('crash boundary:', passed ? 'PASS' : 'FAIL', known.length ? `(${known.length} known bug${known.length === 1 ? '' : 's'})` : '')
process.exit(passed ? 0 : 1)
