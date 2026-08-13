// Scratch probe 3: quick open + search cost with the implicit home-directory root.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('firstrun3')
const SHOT_DIR = path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
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
await page.waitForSelector('.app', { timeout: 40_000 })
await sleep(4000)
const shot = (n) => page.screenshot({ path: path.join(SHOT_DIR, `qa-firstrun-${n}.png`) })

// --- quick open, timed -----------------------------------------------------
const t0 = Date.now()
await page.keyboard.press('Control+P')
await page.waitForSelector('.qp', { timeout: 10_000 })
await sleep(600)
console.log('=== quick open at +600ms ===', JSON.stringify(await page.evaluate(() => ({
  none: document.querySelector('.qp__none')?.textContent ?? null,
  count: document.querySelectorAll('.qp__item').length
}))))

for (let i = 0; i < 120; i++) {
  await sleep(1000)
  const st = await page.evaluate(() => document.querySelector('.qp__none')?.textContent ?? null)
  if (st !== 'Listing files…') break
}
console.log('=== quick open settled at ms ===', Date.now() - t0)
await shot('06-quickopen')
const items = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.qp__item'))
    .slice(0, 25)
    .map((b) => b.innerText.replace(/\n/g, ' | '))
)
console.log('first 25 quick-open items:')
for (const i of items) console.log('   ', i)
await page.keyboard.press('Escape')
await sleep(400)

// --- search across the implicit workspace ---------------------------------
await page.click('.activity__item[data-view="search"]')
await page.waitForSelector('.find__box', { timeout: 10_000 })
const s0 = Date.now()
await page.click('.find__box')
await page.keyboard.type('password', { delay: 10 })
await sleep(1200)
await shot('07-search-typed')
console.log('search summary at +1.2s:', await page.evaluate(() => document.querySelector('.find__summary')?.innerText ?? ''))

let searchState = null
for (let i = 0; i < 120; i++) {
  await sleep(1000)
  const st = await page.evaluate(() => ({
    summary: document.querySelector('.find__summary')?.innerText ?? '',
    files: Array.from(document.querySelectorAll('.find__file')).slice(0, 10).map((f) => f.title)
  }))
  if (st.summary && !st.summary.includes('Searching')) {
    searchState = { ...st, ms: Date.now() - s0 }
    break
  }
}
console.log('=== search ===', JSON.stringify(searchState, null, 2))
await shot('08-search-done')

// --- settings, with a deliberate click first so focus is in the document ---
await page.click('.activity__item[data-view="settings"]')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(600)
await shot('03-settings')

await app.close()
profile.cleanup()
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 10))
