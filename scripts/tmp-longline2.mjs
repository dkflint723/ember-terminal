// Probe 2: where does the long line get lost — the pty stream, or Ember's
// capture/serialize? Records the raw bytes arriving from the pty alongside the
// rendered block.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('longline2')
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
console.log('integration ready')

await page.evaluate(() => {
  window.__raw = ''
  window.ember.onData((e) => {
    window.__raw += e.data
  })
})

async function run(cmd, label, note) {
  const before = await page.evaluate(() => document.querySelectorAll('.block').length)
  await page.evaluate(() => {
    window.__raw = ''
  })
  await page.click('.composer__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(cmd, { delay: 2 })
  await page.keyboard.press('Enter')
  for (let i = 0; i < 150; i++) {
    const done = await page.evaluate(
      (n) =>
        document.querySelectorAll('.block').length > n &&
        document.querySelectorAll('.block--running').length === 0,
      before
    )
    if (done) break
    await sleep(400)
  }
  await sleep(800)
  const res = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.block')].at(-1)
    const body = b?.querySelector('.block__body')
    const rows = body ? body.querySelectorAll('.row') : []
    const text = body ? body.innerText : ''
    const raw = window.__raw
    // Longest unbroken run of the payload alphabet in the raw pty stream, and the
    // total count of payload characters that arrived at all.
    const runs = raw.match(/[A-J]{20,}/g) ?? []
    return {
      rowCount: rows.length,
      renderedPayloadChars: (text.match(/[A-J]/g) ?? []).length,
      rawPayloadChars: raw.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').match(/[A-J]/g)?.length ?? 0,
      rawLen: raw.length,
      rawRuns: runs.length,
      rawRunLens: runs.map((r) => r.length).slice(0, 60),
      escSample: raw
        .slice(0, 400)
        .replace(/\x1b/g, '<ESC>')
        .replace(/\r/g, '<CR>')
        .replace(/\n/g, '<LF>')
    }
  })
  console.log(label, note ?? '', JSON.stringify(res))
  return res
}

// 6000 chars written in one shot.
await run("-join ((1..600) | ForEach-Object { 'ABCDEFGHIJ' })", 'oneshot-6000')
// Same payload, but slowly: give conpty time to paint each screenful.
await run(
  "$s = -join ((1..600) | ForEach-Object { 'ABCDEFGHIJ' }); [Console]::Out.Write($s); Start-Sleep -Milliseconds 1200; ''",
  'console-write-6000'
)
// A line that fits inside the 24-row screen: 20 rows at 146 cols = 2920.
await run("-join ((1..290) | ForEach-Object { 'ABCDEFGHIJ' })", 'fits-2900')
// 400 chars control.
await run("-join ((1..40) | ForEach-Object { 'ABCDEFGHIJ' })", 'ctrl-400')

await app.close()
profile.cleanup()
