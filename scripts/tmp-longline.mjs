// Probe: does a single very long output line survive into a block intact?
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('longline')
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

// Record every pty resize the renderer asks for.
await page.evaluate(() => {
  window.__resizes = []
  const orig = window.ember.resize.bind(window.ember)
  window.ember.resize = (id, cols, rows) => {
    window.__resizes.push([cols, rows])
    return orig(id, cols, rows)
  }
})

async function run(cmd, label) {
  const before = await page.evaluate(() => document.querySelectorAll('.block').length)
  await page.click('.composer__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(cmd, { delay: 2 })
  await page.keyboard.press('Enter')
  for (let i = 0; i < 120; i++) {
    const done = await page.evaluate(
      (n) =>
        document.querySelectorAll('.block').length > n &&
        document.querySelectorAll('.block--running').length === 0,
      before
    )
    if (done) break
    await sleep(400)
  }
  await sleep(600)
  const res = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.block')].at(-1)
    if (!b) return null
    const body = b.querySelector('.block__body')
    const rows = body ? body.querySelectorAll('.row') : []
    const text = body ? body.innerText : ''
    return {
      cmd: b.querySelector('.block__cmd')?.textContent ?? '',
      rowCount: rows.length,
      rowLens: [...rows].map((r) => r.textContent.length),
      textLen: text.replace(/\n/g, '').length,
      head: text.slice(0, 40),
      tail: text.slice(-40),
      resizes: window.__resizes.slice(-6),
      xtermRows: document.querySelectorAll('.xterm-rows > div').length
    }
  })
  console.log(label, JSON.stringify(res))
  return res
}

// what the shell itself believes its window is
await run('$Host.UI.RawUI.WindowSize.Width.ToString() + "x" + $Host.UI.RawUI.WindowSize.Height.ToString() + " buf=" + $Host.UI.RawUI.BufferSize.Height', 'winsize   ')
await run("-join ((1..600) | ForEach-Object { 'ABCDEFGHIJ' })", 'long-6000 ')
await run("-join ((1..40) | ForEach-Object { 'ABCDEFGHIJ' })", 'ctrl-400  ')
await run("-join ((1..600) | ForEach-Object { 'ABCDEFGHIJ' })", 'long-again')

await app.close()
profile.cleanup()
