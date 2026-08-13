// Probe 2: is the ceiling on grid rows (so wrapped output is lost far sooner)?
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('scrollback2')
const SCRATCH =
  'C:/Users/dkfli/AppData/Local/Temp/claude/d--git-projects-terminal/86a9d00f-2b19-46d6-80dc-ce142256f9ae/scratchpad'

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
await page.waitForSelector('.app', { timeout: 20_000 })
await page.waitForSelector('.composer__input', { timeout: 20_000 })
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
log('integration ready')

await page.click('.composer__input')
await page.keyboard.type(`Get-Content ${SCRATCH}/wide.txt`, { delay: 4 })
await page.keyboard.press('Enter')

const deadline = Date.now() + 240_000
let state = null
while (Date.now() < deadline) {
  state = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.block')].find((b) =>
      (b.querySelector('.block__cmd')?.textContent ?? '').includes('wide.txt')
    )
    if (!el) return { found: false }
    const rows = [...el.querySelectorAll('.block__body .row')]
    return {
      found: true,
      running: el.className.includes('running'),
      logicalLines: rows.length,
      firstLine: (rows[0]?.textContent ?? '').slice(0, 40),
      firstIsFragment: !/^LINE\d+-/.test(rows[0]?.textContent ?? ''),
      secondLine: (rows[1]?.textContent ?? '').slice(0, 20),
      lastLine: (rows[rows.length - 1]?.textContent ?? '').slice(0, 20)
    }
  })
  if (state.found && !state.running) break
  await sleep(1000)
}
log('wide ->', JSON.stringify(state))

// Also report the live terminal's real column count.
log(
  'term cols (from live xterm row width):',
  await page.evaluate(() => {
    const r = document.querySelector('.xterm-rows > div')
    return r ? r.textContent.length : null
  })
)

await app.close()
profile.cleanup()
log('done')
