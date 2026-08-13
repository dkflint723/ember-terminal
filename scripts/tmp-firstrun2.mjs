// Scratch probe 2: palette / quick open / settings / search cost on first run.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('firstrun2')
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
await sleep(3000)
const shot = (n) => page.screenshot({ path: path.join(SHOT_DIR, `qa-firstrun-${n}.png`) })

// --- settings on first run -------------------------------------------------
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(800)
await shot('03-settings')
console.log('=== settings ===')
console.log(
  await page.evaluate(() => ({
    text: document.querySelector('.modal').innerText,
    theme: document.querySelector('.modal select')?.value,
    themeOptions: Array.from(document.querySelectorAll('.modal select')).map((s) =>
      Array.from(s.options).map((o) => o.textContent)
    )
  }))
)
await page.keyboard.press('Escape')
await sleep(400)

// --- command palette -------------------------------------------------------
await page.keyboard.press('Control+Shift+P')
await page.waitForSelector('.qp', { timeout: 10_000 })
await sleep(600)
await shot('04-palette')
console.log('=== command palette (first run) ===')
console.log(
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('.qp__item')).map((b) => b.innerText.replace(/\n/g, ' | '))
  )
)
await page.keyboard.press('Escape')
await sleep(300)

// --- quick open, timed -----------------------------------------------------
const t0 = Date.now()
await page.keyboard.press('Control+P')
await page.waitForSelector('.qp', { timeout: 10_000 })
await sleep(500)
await shot('05-quickopen-immediate')
const immediate = await page.evaluate(() => ({
  none: document.querySelector('.qp__none')?.textContent ?? null,
  count: document.querySelectorAll('.qp__item').length
}))
console.log('=== quick open at +500ms ===', JSON.stringify(immediate))

let settled = null
for (let i = 0; i < 120; i++) {
  await sleep(1000)
  const state = await page.evaluate(() => ({
    none: document.querySelector('.qp__none')?.textContent ?? null,
    count: document.querySelectorAll('.qp__item').length
  }))
  if (state.none !== 'Listing files…') {
    settled = { ...state, ms: Date.now() - t0 }
    break
  }
}
console.log('=== quick open settled ===', JSON.stringify(settled))
await shot('06-quickopen-settled')
console.log(
  'first items:',
  await page.evaluate(() =>
    Array.from(document.querySelectorAll('.qp__item'))
      .slice(0, 12)
      .map((b) => b.innerText.replace(/\n/g, ' | '))
  )
)
await page.keyboard.press('Escape')
await sleep(300)

// --- search across the implicit workspace ---------------------------------
await page.click('.activity__item[data-view="search"]')
await page.waitForSelector('.find__box', { timeout: 10_000 })
const s0 = Date.now()
await page.click('.find__box')
await page.keyboard.type('password', { delay: 10 })
await sleep(1500)
await shot('07-search-typed')
let searchState = null
for (let i = 0; i < 90; i++) {
  await sleep(1000)
  const st = await page.evaluate(() => ({
    summary: document.querySelector('.find__summary')?.innerText ?? '',
    files: Array.from(document.querySelectorAll('.find__file')).slice(0, 8).map((f) => f.title)
  }))
  if (!st.summary.includes('Searching')) {
    searchState = { ...st, ms: Date.now() - s0 }
    break
  }
}
console.log('=== search ===', JSON.stringify(searchState, null, 2))
await shot('08-search-done')

await app.close()
profile.cleanup()
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 10))
