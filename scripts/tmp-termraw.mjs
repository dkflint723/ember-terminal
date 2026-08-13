// Scratch probe: records the raw pty stream alongside the rendered blocks.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('termraw')
const SHOT_DIR = path.join(APP_DIR, '.shots', 'termraw')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const log = (...a) => console.log(...a)
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

const page = await app.firstWindow({ timeout: 90_000 })
await placeTopRight(app)
await page.waitForSelector('.app', { timeout: 20_000 })
await page.waitForSelector('.composer__input', { timeout: 20_000 })
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
log('integration ready')

await page.evaluate(() => {
  window.__raw = []
  window.ember.onData((e) => window.__raw.push(e.data))
})

async function run(text) {
  await page.click('.composer__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text, { delay: 4 })
  await page.evaluate(() => (window.__raw.length = 0))
  await page.keyboard.press('Enter')
}

async function waitDone(timeoutMs = 30_000) {
  const t0 = Date.now()
  for (;;) {
    const done = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.block')]
      const el = els[els.length - 1]
      return el ? !el.className.includes('block--running') : false
    })
    if (done) return true
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(250)
  }
}

const vis = (s) =>
  s
    .replace(/\x1b/g, '<ESC>')
    .replace(/\x07/g, '<BEL>')
    .replace(/\r/g, '<CR>')
    .replace(/\n/g, '<LF>\n')

async function step(label, cmd) {
  await run(cmd)
  await waitDone()
  await sleep(400)
  const raw = await page.evaluate(() => window.__raw.join(''))
  const block = await page.evaluate(() => {
    const els = [...document.querySelectorAll('.block')]
    const el = els[els.length - 1]
    const body = el?.querySelector('.block__body')
    return {
      cmd: el?.querySelector('.block__cmd')?.textContent,
      meta: el?.querySelector('.block__meta')?.textContent,
      rows: el?.querySelectorAll('.block__body .row').length,
      text: (body?.innerText ?? '').slice(0, 400)
    }
  })
  log(`\n===== ${label} =====`)
  log('RAW (' + raw.length + ' bytes):')
  log(vis(raw).slice(0, 1600))
  log('BLOCK:', JSON.stringify(block))
}

await step('warmup echo', 'echo one')
await step('short output', 'echo two')
await step('no output', '$null = 1')

const dims = await page.evaluate(() => {
  const t = document.querySelector('.xterm')
  const live = document.querySelector('.live')
  return {
    liveBox: live?.getBoundingClientRect().toJSON(),
    xtermBox: t?.getBoundingClientRect().toJSON(),
    rowsInDom: document.querySelectorAll('.xterm-rows > div').length
  }
})
log('\nlive dims →', JSON.stringify(dims))

await app.close()
profile.cleanup()
log('done')
