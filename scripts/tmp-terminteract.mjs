// Scratch probe: interactive / signal / resize behaviour of the terminal.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('terminteract')
const SHOT_DIR = path.join(APP_DIR, '.shots', 'terminteract')
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

const snap = () =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll('.block')]
    const el = els[els.length - 1]
    const body = el?.querySelector('.block__body')
    const live = document.querySelector('.live')
    const xterm = document.querySelector('.live .xterm')
    return {
      blocks: els.length,
      cls: el?.className,
      cmd: el?.querySelector('.block__cmd')?.textContent,
      meta: el?.querySelector('.block__meta')?.textContent,
      body: (body?.innerText ?? '').slice(0, 200),
      paneMode: document.querySelector('.pane')?.className,
      raw: !!document.querySelector('.live--raw'),
      runningComposer: !!document.querySelector('.composer__row .composer__input[placeholder="send to process…"]'),
      secretRow: !!document.querySelector('.composer__row--secret'),
      liveH: Math.round(live?.getBoundingClientRect().height ?? -1),
      xtermH: Math.round(xterm?.getBoundingClientRect().height ?? -1),
      termRows: document.querySelectorAll('.live .xterm-rows > div').length,
      liveText: (document.querySelector('.live .xterm-rows')?.innerText ?? '')
        .split('\n')
        .filter((l) => l.trim())
        .slice(-6)
    }
  })

async function type(text) {
  await page.click('.composer__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text, { delay: 4 })
}
async function run(text) {
  await type(text)
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

// ------- 1. Ctrl+C on a long-running command -------
log('\n### 1. Ctrl+C on Start-Sleep 30')
await run('Start-Sleep -Seconds 30')
await sleep(2500)
log('while running →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '1a-running.png') })
const t0 = Date.now()
await page.keyboard.press('Control+c')
const closed = await waitDone(15_000)
log(`ctrl+c closed block=${closed} after ${Date.now() - t0}ms`)
log('after ctrl+c →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '1b-after-ctrlc.png') })

// ------- 2. Read-Host prompt -------
log('\n### 2. Read-Host prompt')
await run('$n = Read-Host "Your name"; "hello $n"')
await sleep(2500)
log('at prompt →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '2a-readhost.png') })
await page.click('.composer__input')
await page.keyboard.type('Ada', { delay: 20 })
await page.keyboard.press('Enter')
await waitDone(15_000)
log('after answer →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '2b-readhost-done.png') })

// ------- 3. interactive python -------
log('\n### 3. python REPL')
await run('python -i -q')
await sleep(3500)
log('python running →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '3a-python.png') })
await page.click('.composer__input')
await page.keyboard.type('print(6*7)', { delay: 20 })
await page.keyboard.press('Enter')
await sleep(2000)
log('after print →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '3b-python-out.png') })
await page.click('.composer__input')
await page.keyboard.type('exit()', { delay: 20 })
await page.keyboard.press('Enter')
log('python exited block=', await waitDone(15_000))
log('after exit →', JSON.stringify(await snap()))

// ------- 4. full-screen vim -------
log('\n### 4. vim')
await run('vim')
await sleep(4000)
log('vim →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '4a-vim.png') })
await page.keyboard.type(':q!')
await page.keyboard.press('Enter')
await sleep(2500)
log('after :q! →', JSON.stringify(await snap()))
await page.screenshot({ path: path.join(SHOT_DIR, '4b-after-vim.png') })

// ------- 5. resize mid-command -------
log('\n### 5. resize while a command runs')
await run('1..40 | ForEach-Object { "row $_"; Start-Sleep -Milliseconds 120 }')
await sleep(1500)
const before = await snap()
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  w.setBounds({ width: 700, height: 500 })
})
await sleep(2500)
await page.screenshot({ path: path.join(SHOT_DIR, '5a-resized.png') })
await waitDone(40_000)
const after = await snap()
log('before resize →', JSON.stringify(before))
log('after  resize →', JSON.stringify(after))
await page.screenshot({ path: path.join(SHOT_DIR, '5b-resized-done.png') })
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0].setBounds({ width: 1180, height: 760 })
})
await sleep(1200)

await app.close()
profile.cleanup()
log('done')
