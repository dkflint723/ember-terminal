// Custom shells: taught in Settings, served with the detected ones, spawnable.
//
// The five detected shells were the whole world; anything else — a specific WSL
// distro, a dev shell, powershell with flags — was unreachable. This teaches
// Ember one by hand and then actually runs it: a PowerShell with -NoProfile,
// declared as speaking the powershell dialect, whose pane must reach full
// shell integration like any built-in.
//
// Run: node scripts/verify-profiles.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('profiles')
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
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- teach it a shell ---------------------------------------------------------
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal', { timeout: 8_000 })
await page.locator('.btn', { hasText: 'Add shell…' }).click()
await sleep(300)
await page.locator('.shellrow__name').last().fill('NoProfile PS')
await page.locator('.shellrow__path').last().fill('powershell.exe')
await page.locator('.shellrow__args').last().fill('-NoProfile')
await page.locator('.shellrow__dialect').last().selectOption('powershell')
await page.locator('.modal .btn', { hasText: 'Save' }).click()
await sleep(1200)

const served = await page.evaluate(async () => {
  const all = await window.ember.listProfiles()
  return all.map((p) => p.name)
})
check('the taught shell is served with the detected ones', served.includes('NoProfile PS'), JSON.stringify(served))

// --- and it actually runs -----------------------------------------------------
await page.click('.sessions__new')
await sleep(500)
const entry = page.locator('.sessions__menu .titlebar__menu-item', { hasText: 'NoProfile PS' })
check('the + menu offers it', (await entry.count()) === 1, `${await entry.count()}`)
await entry.click()
await sleep(1500)

check('choosing it opens a session', (await page.locator('.sessions__card').count()) === 2)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 30_000 })
const readiness = await page.evaluate(() =>
  [...document.querySelectorAll('.pane[data-integration]')].map((p) =>
    p.getAttribute('data-integration')
  )
)
// Only the active session's panes are mounted, so the one pane on screen IS
// the custom shell — the built-in it replaced went with its tab.
check(
  'and the custom shell reaches full integration',
  readiness.length === 1 && readiness[0] === 'ready',
  JSON.stringify(readiness)
)

// --- it survives in settings, not just in memory ------------------------------
const stored = await page.evaluate(async () => (await window.ember.getSettings()).customProfiles)
check('the shell is written down', stored.length === 1 && stored[0].args.includes('-NoProfile'), JSON.stringify(stored))

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('custom shells:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
