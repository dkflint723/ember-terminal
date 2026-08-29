// Flow control: a command that floods stdout must not drown the renderer.
//
// Without a valve, pty output queues in the renderer faster than xterm can
// parse it and the whole window crawls. Main now pauses the pty once a window
// of output is in flight unacknowledged and resumes it as the renderer keeps
// up. The window is shrunk through EMBER_FLOW_HIGH so a five-megabyte flood
// engages the valve here deterministically; the suite then watches the
// book-keeping while the flood runs, and proves the app is still itself after.
//
// Run: node scripts/verify-flood.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('flood')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, EMBER_FLOW_HIGH: '65536' }
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

// ~5 MB in one burst: thirty thousand lines of one hundred and sixty x's.
await page.click('.composer__input')
await page.keyboard.type("1..30000 | ForEach-Object { 'flood-' + ('x' * 160) }", { delay: 3 })
await page.keyboard.press('Enter')

/*
 * Watch the valve while the flood runs: the pty must actually be paused at some
 * point (the whole feature), and the unacknowledged window must stay bounded
 * near the configured high-water mark rather than growing with the output.
 */
let engaged = 0
let maxPending = 0
const start = Date.now()
for (;;) {
  const stats = await page.evaluate(() => window.ember.ptyFlowStats())
  for (const s of Object.values(stats)) {
    engaged = Math.max(engaged, s.pausedCount)
    maxPending = Math.max(maxPending, s.pending)
  }
  const done = await page.evaluate(() => {
    const heads = [...document.querySelectorAll('.block__head')]
    const last = heads[heads.length - 1]
    return last ? !last.textContent?.includes('running') : false
  })
  const finished = await page.evaluate(
    () => [...document.querySelectorAll('.block__status--done, .block__status--failed')].length
  )
  if ((done && finished > 0 && Date.now() - start > 4000) || Date.now() - start > 90_000) break
  await sleep(250)
}

check('the valve engaged during the flood', engaged >= 1, `pausedCount ${engaged}`)
check(
  'and the unparsed window stayed bounded',
  maxPending > 0 && maxPending < 65536 * 4,
  `${maxPending} chars pending at worst`
)

await sleep(1500)
const after = await page.evaluate(() => window.ember.ptyFlowStats())
const drained = Object.values(after).every((s) => s.pending === 0 && !s.paused)
check('the window drains to nothing when the flood ends', drained, JSON.stringify(after))

/*
 * The living copy of that output is bounded — the ceiling is the guarantee.
 * How SMALL it ends up is conpty's business: conpty repaints a screen rather
 * than scrolling one, so a flood's block legitimately keeps only the final
 * repaint, and three belts (conpty's own repainting, the terminal's scrollback,
 * LIVE_OUTPUT_CAP) each stand between the five megabytes and the store.
 */
const kept = await page.evaluate(() =>
  [...document.querySelectorAll('.block__body')].reduce(
    (n, b) => n + (b.textContent ?? '').length,
    0
  )
)
check('the block keeps a bounded copy, not the whole flood', kept < 2_000_000, `${kept} chars kept`)

// And the terminal is still a terminal.
await page.click('.composer__input')
await page.keyboard.type('echo alive-after-flood', { delay: 4 })
await page.keyboard.press('Enter')
await sleep(2500)
const alive = await page.evaluate(() =>
  [...document.querySelectorAll('.block__body .row')].some((r) =>
    r.textContent?.includes('alive-after-flood')
  )
)
check('a command after the flood runs normally', alive)

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('flood control:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
