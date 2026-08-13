// Scratch probe 4: why does Settings sometimes not open on first run?
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('firstrun4')
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

const probe = () =>
  page.evaluate(() => {
    const scrim = document.querySelector('.modal-scrim')
    const modal = document.querySelector('.modal')
    const gear = document.querySelector('.activity__item[data-view="settings"]')
    const gr = gear?.getBoundingClientRect()
    return {
      scrim: !!scrim,
      modal: !!modal,
      modalRect: modal ? modal.getBoundingClientRect().toJSON() : null,
      gearRect: gr ? { x: gr.x, y: gr.y, w: gr.width, h: gr.height } : null,
      windowInner: [window.innerWidth, window.innerHeight],
      activeEl: document.activeElement?.className ?? document.activeElement?.tagName
    }
  })

console.log('before:', JSON.stringify(await probe()))
const timed = await page.evaluate(async () => {
  const t = Date.now()
  const s = await window.ember.getSettings()
  return { ms: Date.now() - t, ok: !!s }
})
console.log('getSettings ipc:', JSON.stringify(timed))

for (let attempt = 1; attempt <= 4; attempt++) {
  await page.click('.activity__item[data-view="settings"]')
  await sleep(1500)
  const after = await probe()
  console.log(`attempt ${attempt} click gear ->`, JSON.stringify(after))
  await page.screenshot({ path: path.join(SHOT_DIR, `qa-firstrun-09-settings-attempt${attempt}.png`) })
  if (after.modal) {
    await page.keyboard.press('Escape')
    await sleep(600)
    console.log(`  after escape ->`, JSON.stringify(await probe()))
  }
}

console.log('--- via Ctrl+, ---')
for (let attempt = 1; attempt <= 3; attempt++) {
  await page.keyboard.press('Control+,')
  await sleep(1200)
  const after = await probe()
  console.log(`ctrl+, attempt ${attempt} ->`, JSON.stringify(after))
  if (after.modal) {
    await page.keyboard.press('Escape')
    await sleep(500)
  }
}

await app.close()
profile.cleanup()
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 10))
