// Scratch probe: does a conpty repaint land inside a block's capture?
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'
import * as fs from 'node:fs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('conpty')
const OUT = path.join(APP_DIR, '.shots')
fs.mkdirSync(OUT, { recursive: true })

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

const page = await app.firstWindow()
await placeTopRight(app)
await page.waitForSelector('.app', { timeout: 20_000 })
await page.waitForSelector('.composer__input', { timeout: 20_000 })
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
log('integration ready')

// Second raw-data listener, so we see exactly the bytes the controller sees.
await page.evaluate(() => {
  window.__raw = []
  window.ember.onData((e) => window.__raw.push(e.data))
})

async function run(cmd, waitMs = 90_000, during) {
  const before = await page.evaluate(() => document.querySelectorAll('.block').length)
  await page.click('.composer__input')
  await page.keyboard.type(cmd, { delay: 5 })
  await page.evaluate(() => (window.__raw = []))
  await page.keyboard.press('Enter')
  if (during) await during()
  const t0 = Date.now()
  for (;;) {
    const st = await page.evaluate(
      (n) => {
        const els = [...document.querySelectorAll('.block')]
        if (els.length <= n) return { ready: false }
        const el = els[els.length - 1]
        return { ready: !el.className.includes('running') }
      },
      before
    )
    if (st.ready) break
    if (Date.now() - t0 > waitMs) {
      log('TIMEOUT waiting for', cmd)
      break
    }
    await sleep(200)
  }
  await sleep(600)
  return page.evaluate(() => {
    const els = [...document.querySelectorAll('.block')]
    const el = els[els.length - 1]
    const body = el.querySelector('.block__body')?.innerText ?? ''
    const lines = body.split('\n')
    return {
      cmd: el.querySelector('.block__cmd')?.textContent ?? '',
      cls: el.className,
      lineCount: lines.length,
      head: lines.slice(0, 6),
      tail: lines.slice(-6),
      raw: window.__raw.join('')
    }
  })
}

function analyse(raw) {
  const START = '\x1b]133;C'
  const END = '\x1b]133;D'
  const i = raw.indexOf(START)
  const j = raw.indexOf(END, i === -1 ? 0 : i)
  const slice = i === -1 || j === -1 ? '' : raw.slice(i, j)
  const homeJumps = (slice.match(/\x1b\[H/g) || []).length
  const absCursor = (slice.match(/\x1b\[\d*;\d*H/g) || []).length
  const clears = (slice.match(/\x1b\[[0-3]?J/g) || []).length
  return {
    len: slice.length,
    homeJumps,
    absCursor,
    clears,
    head: JSON.stringify(slice.slice(0, 220)),
    hasAlpha: slice.includes('alpha')
  }
}

const results = {}

results.bulk = await run('1..5000 | ForEach-Object { "alpha $_" }')
log('--- bulk ---', JSON.stringify({ ...results.bulk, raw: undefined }, null, 1))
log('bulk capture:', JSON.stringify(analyse(results.bulk.raw)))

results.solo = await run('echo SOLO')
log('--- solo ---', JSON.stringify({ ...results.solo, raw: undefined }, null, 1))
log('solo capture:', JSON.stringify(analyse(results.solo.raw)))
fs.writeFileSync(path.join(OUT, 'raw-solo.txt'), results.solo.raw, 'utf8')

results.nul = await run('$null = 1')
log('--- $null ---', JSON.stringify({ ...results.nul, raw: undefined }, null, 1))
log('$null capture:', JSON.stringify(analyse(results.nul.raw)))

// Control: 25 slow rows, no resize.
results.ctrl = await run('1..25 | ForEach-Object { "row $_"; Start-Sleep -Milliseconds 150 }')
log('--- control rows ---', JSON.stringify({ ...results.ctrl, raw: undefined }, null, 1))
log('control capture:', JSON.stringify(analyse(results.ctrl.raw)))

// Same command, window resized while it runs.
results.resized = await run(
  '1..25 | ForEach-Object { "row $_"; Start-Sleep -Milliseconds 150 }',
  90_000,
  async () => {
    await sleep(1200)
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const [width, height] = w.getSize()
      w.setSize(Math.max(700, width - 260), Math.max(500, height - 200))
    })
    await sleep(800)
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      const [width, height] = w.getSize()
      w.setSize(width + 260, height + 200)
    })
  }
)
log('--- resized rows ---', JSON.stringify({ ...results.resized, raw: undefined }, null, 1))
log('resized capture:', JSON.stringify(analyse(results.resized.raw)))
fs.writeFileSync(path.join(OUT, 'raw-resized.txt'), results.resized.raw, 'utf8')

const all = await page.evaluate(() =>
  [...document.querySelectorAll('.block')].map((el) => ({
    cmd: el.querySelector('.block__cmd')?.textContent ?? '',
    body: (el.querySelector('.block__body')?.innerText ?? '').slice(0, 120).replace(/\n/g, ' | ')
  }))
)
log('--- all blocks ---')
for (const b of all) log(JSON.stringify(b))

await page.screenshot({ path: path.join(OUT, 'conpty-probe.png') })
await app.close()
profile.cleanup()
