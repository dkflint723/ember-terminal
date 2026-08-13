// Probe: does the running live strip clip the bottom rows of the xterm grid?
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('stripclip')
const SHOTS = path.join(APP_DIR, '.shots', 'stripclip')
fs.mkdirSync(SHOTS, { recursive: true })

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
await page.waitForSelector('.pane', { timeout: 30_000 })
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const winSize = await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()[0].getSize()
)
console.log('window size:', JSON.stringify(winSize))

// Geometry probe: measures the live strip box against the xterm grid box, and
// reports which rendered rows fall below the clipping edge.
const measure = () =>
  page.evaluate(() => {
    const live = document.querySelector('.live')
    const xterm = live?.querySelector('.xterm')
    const screen = live?.querySelector('.xterm-screen')
    const rowsEl = live?.querySelector('.xterm-rows')
    if (!live || !xterm || !screen || !rowsEl) return { error: 'missing elements' }
    const liveBox = live.getBoundingClientRect()
    const rows = Array.from(rowsEl.children)
    const visible = []
    const clipped = []
    for (const r of rows) {
      const b = r.getBoundingClientRect()
      const text = (r.textContent || '').trim()
      const entry = { text, top: Math.round(b.top - liveBox.top), h: Math.round(b.height) }
      if (b.bottom <= liveBox.bottom + 0.5) visible.push(entry)
      else clipped.push(entry)
    }
    return {
      liveH: Math.round(liveBox.height),
      liveClass: live.className,
      liveInlineHeight: live.style.height,
      xtermH: Math.round(xterm.getBoundingClientRect().height),
      screenH: Math.round(screen.getBoundingClientRect().height),
      gridRows: rows.length,
      hiddenPx: Math.round(xterm.getBoundingClientRect().bottom - liveBox.bottom),
      visibleCount: visible.length,
      clippedCount: clipped.length,
      lastVisible: visible.filter((v) => v.text).slice(-3),
      clippedWithText: clipped.filter((c) => c.text)
    }
  })

const type = async (cmd) => {
  await page.locator('.pane .composer').click()
  await sleep(400)
  await page.keyboard.type(cmd)
  await sleep(300)
  await page.keyboard.press('Enter')
}

// --- Case 1: steady stream of numbered lines -------------------------------
await type('1..24 | ForEach-Object { "L$_ ------------------"; Start-Sleep -Milliseconds 250 }')
await sleep(4000)
const m1 = await measure()
console.log('CASE1 mid-command:', JSON.stringify(m1, null, 1))
await page.screenshot({ path: path.join(SHOTS, '1-running.png') })
await sleep(4000)

// --- Case 2: pager prompt on the last row ----------------------------------
await sleep(2000)
await type('1..200 | ForEach-Object { "m $_" } | more')
await sleep(4000)
const m2 = await measure()
console.log('CASE2 more:', JSON.stringify(m2, null, 1))
await page.screenshot({ path: path.join(SHOTS, '2-more.png') })

// Where is the cursor? If it sits below the clip edge it is invisible.
const cur = await page.evaluate(() => {
  const live = document.querySelector('.live')
  const c = live?.querySelector('.xterm-cursor-layer, .xterm-cursor')
  const rowsEl = live?.querySelector('.xterm-rows')
  const cursorRow = rowsEl?.querySelector('.xterm-cursor')
  if (!live) return { error: 'no live' }
  const liveBox = live.getBoundingClientRect()
  const b = cursorRow?.getBoundingClientRect()
  return {
    haveCursorEl: !!cursorRow,
    cursorTopRelLive: b ? Math.round(b.top - liveBox.top) : null,
    liveH: Math.round(liveBox.height),
    cursorBelowClip: b ? b.top > liveBox.bottom : null
  }
})
console.log('cursor:', JSON.stringify(cur))

await page.keyboard.press('q')
await sleep(1500)

await app.close()
profile.cleanup()
console.log('shots in', SHOTS)
