// The window comes back the way you left it: size, place, and zoom.
//
// Ctrl+= / Ctrl+- / Ctrl+0 drive the interface scale and persist it; moving or
// resizing the window writes its bounds down after a debounce. Neither promise
// means anything without a relaunch, so this closes the app and opens it again
// on the same profile: the second window must stand where the first one stood,
// at the zoom it was left at.
//
// Run: node scripts/verify-window.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('window')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const launch = () =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const near = (a, b, tolerance) => Math.abs(a - b) <= tolerance

// --- first life -----------------------------------------------------------------
let app = await launch()
let page = await app.firstWindow()
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

// Zoom: the chords change the scale on screen and write it down.
const width = () => page.evaluate(() => document.documentElement.clientWidth)
const uiZoom = async () => (await page.evaluate(() => window.ember.getSettings())).uiZoom

const restWidth = await width()
await page.click('.composer__input')
await page.keyboard.press('Control+=')
await sleep(400)
await page.keyboard.press('Control+=')
await sleep(700)
check('Ctrl+= raises the stored scale', near(await uiZoom(), 1.2, 0.011), String(await uiZoom()))
const zoomedWidth = await width()
check(
  'and the interface actually draws larger',
  zoomedWidth < restWidth - 20,
  `${restWidth} → ${zoomedWidth}`
)
await page.keyboard.press('Control+0')
await sleep(700)
check('Ctrl+0 returns to 100', near(await uiZoom(), 1, 0.011), String(await uiZoom()))
check('on screen too', near(await width(), restWidth, 4), `${restWidth} → ${await width()}`)

// Leave a mark for the next life: one step up, and a deliberate spot on screen.
await page.keyboard.press('Control+=')
await sleep(700)
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.setBounds({ x: 80, y: 60, width: 1000, height: 660 })
})
// The remember runs on a 400ms debounce; give it room before asking settings.
await sleep(1200)
const written = await page.evaluate(() => window.ember.getSettings())
check(
  'the moved window writes its bounds down',
  written.windowBounds !== null &&
    near(written.windowBounds.x, 80, 2) &&
    near(written.windowBounds.width, 1000, 2),
  JSON.stringify(written.windowBounds)
)
await app.close()

// --- second life ----------------------------------------------------------------
app = await launch()
page = await app.firstWindow()
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const revived = await app.evaluate(({ BrowserWindow }) => {
  const win = BrowserWindow.getAllWindows()[0]
  return { bounds: win?.getNormalBounds() ?? null, zoom: win?.webContents.getZoomFactor() ?? 0 }
})
check(
  'the window comes back where it was left',
  revived.bounds !== null &&
    near(revived.bounds.x, 80, 2) &&
    near(revived.bounds.y, 60, 2) &&
    near(revived.bounds.width, 1000, 2) &&
    near(revived.bounds.height, 660, 2),
  JSON.stringify(revived.bounds)
)
check('at the zoom it was left at', near(revived.zoom, 1.1, 0.011), String(revived.zoom))

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('window memory:', failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
