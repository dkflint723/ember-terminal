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
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

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
check('reload rebuilds the window from the session', true)
check('and the boundary stands down', (await page.locator('.boom').count()) === 0)

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('crash boundary:', failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
