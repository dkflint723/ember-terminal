// Rebinding: a chord changed in Settings changes what the window answers to.
//
// The mode switch moves from Ctrl+Shift+I to Ctrl+Shift+Y by pressing it into
// the capture button, and then both sides of the promise are held: the old
// chord must do nothing, the new one must flip the mode, the override must be
// in settings.json, and the reset must give the default back.
//
// Run: node scripts/verify-rebind.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('rebind')
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
const modeNow = () =>
  page.evaluate(() => document.querySelector('.workspace')?.getAttribute('data-mode'))
const row = () => page.locator('.keyrow', { hasText: 'Terminal ↔ IDE' })

// --- capture a new chord ------------------------------------------------------
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal', { timeout: 8_000 })
check('the row shows its default', (await row().locator('.keyrow__chord').textContent()) === 'Ctrl+Shift+I')

await row().locator('.keyrow__chord').click()
await sleep(200)
check(
  'clicking the chord starts listening',
  (await row().locator('.keyrow__chord').textContent()) === 'press keys…'
)
await page.keyboard.press('Control+Shift+Y')
await sleep(300)
check('the press becomes the chord', (await row().locator('.keyrow__chord').textContent()) === 'Ctrl+Shift+Y')
check('and a way back to the default appears', (await row().locator('[title="Back to the default"]').count()) === 1)

await page.locator('.modal .btn', { hasText: 'Save' }).click()
await sleep(1000)

// --- both sides of the promise ------------------------------------------------
await page.keyboard.press('Control+Shift+I')
await sleep(500)
check('the old chord no longer answers', (await modeNow()) === 'terminal', await modeNow())
await page.keyboard.press('Control+Shift+Y')
await sleep(500)
check('the new chord flips the mode', (await modeNow()) === 'ide', await modeNow())
await page.keyboard.press('Control+Shift+Y')
await sleep(500)

const stored = JSON.parse(fs.readFileSync(path.join(profile.dir, 'settings.json'), 'utf8'))
check(
  'the override is written down',
  stored.keybindings?.['mode.toggle'] === 'Ctrl+Shift+Y',
  JSON.stringify(stored.keybindings)
)

// --- and the way back ---------------------------------------------------------
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal', { timeout: 8_000 })
await row().locator('[title="Back to the default"]').click()
await sleep(200)
check('reset restores the spelling', (await row().locator('.keyrow__chord').textContent()) === 'Ctrl+Shift+I')
await page.locator('.modal .btn', { hasText: 'Save' }).click()
await sleep(1000)
await page.keyboard.press('Control+Shift+I')
await sleep(500)
check('and the default answers again', (await modeNow()) === 'ide', await modeNow())

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('key rebinding:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
