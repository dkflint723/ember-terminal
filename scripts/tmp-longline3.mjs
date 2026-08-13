// Probe 3: isolate where the long line is lost.
//  - drive the shell by writing straight to the pty (no composer/PSReadLine noise)
//  - slice the raw stream exactly the way controller.feedCapture does
//  - compare: payload chars in the capture slice vs payload chars in the block
//  - then repeat with a tall pty, which is the reporter's proposed fix
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('longline3')
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
await page.waitForSelector('.composer__input', { timeout: 30_000 })
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })

await page.evaluate(() => {
  window.__raw = ''
  window.__pane = null
  window.ember.onData((e) => {
    window.__pane = e.paneId
    window.__raw += e.data
  })
})
await sleep(1500)
const pane = await page.evaluate(() => window.__pane)
console.log('paneId', pane)

// PSReadLine's prediction popup repaints the screen and muddies the stream.
await page.evaluate((p) => window.ember.write(p, 'Set-PSReadLineOption -PredictionSource None\r'), pane)
await sleep(2000)

async function run(cmd, label) {
  const before = await page.evaluate(() => document.querySelectorAll('.block').length)
  await page.evaluate(() => {
    window.__raw = ''
  })
  await page.evaluate(([p, c]) => window.ember.write(p, c + '\r'), [pane, cmd])
  for (let i = 0; i < 150; i++) {
    const done = await page.evaluate(
      (n) =>
        document.querySelectorAll('.block').length > n &&
        document.querySelectorAll('.block--running').length === 0,
      before
    )
    if (done) break
    await sleep(300)
  }
  await sleep(900)
  const res = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.block')].at(-1)
    const body = b?.querySelector('.block__body')
    const rows = body ? body.querySelectorAll('.row') : []
    const text = body ? body.innerText : ''
    const raw = window.__raw

    // Same slicing rule as controller.feedCapture: bytes between OSC 133;C and
    // OSC 133;D, skipping the start marker's terminator.
    let capture = ''
    const START = '\x1b]133;C'
    const END = '\x1b]133;D'
    let i = raw.indexOf(START)
    while (i !== -1) {
      const rest = raw.slice(i + START.length)
      const bel = rest.indexOf('\x07')
      const st = rest.indexOf('\x1b\\')
      const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st)
      if (end === -1) break
      const body2 = rest.slice(end + (end === st ? 2 : 1))
      const j = body2.indexOf(END)
      capture = j === -1 ? body2 : body2.slice(0, j)
      const next = raw.indexOf(START, i + 1)
      i = next
    }
    const runs = capture.match(/[A-J]{20,}/g) ?? []
    return {
      cmd: b?.querySelector('.block__cmd')?.textContent?.slice(0, 46) ?? '',
      rowCount: rows.length,
      blockPayload: (text.match(/[A-J]/g) ?? []).length,
      capturePayload: (capture.match(/[A-J]/g) ?? []).length,
      captureLen: capture.length,
      captureRuns: runs.map((r) => r.length),
      captureEsc: (capture.match(/\x1b\[[0-9;]*[A-Za-z]/g) ?? []).slice(0, 14),
      rawPayload: (raw.match(/[A-J]/g) ?? []).length
    }
  })
  console.log(label, JSON.stringify(res))
  return res
}

const CMD6000 = "-join ((1..600) | ForEach-Object { 'ABCDEFGHIJ' })"
const CMD400 = "-join ((1..40) | ForEach-Object { 'ABCDEFGHIJ' })"

await run(CMD400, 'A ctrl-400  24rows')
await run(CMD6000, 'B long-6000 24rows')
await run(CMD6000, 'C long-6000 24rows')

// The reporter's proposed fix: hand the pty a screen tall enough for the line.
await page.evaluate((p) => window.ember.resize(p, 146, 120), pane)
await sleep(1500)
await run('$Host.UI.RawUI.WindowSize.Height.ToString()', 'D rows-after-resize')
await run(CMD6000, 'E long-6000 120rows')
await run(CMD6000, 'F long-6000 120rows')

await app.close()
profile.cleanup()
