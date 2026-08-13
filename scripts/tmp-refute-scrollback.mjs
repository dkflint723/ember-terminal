// Probe: does a block lose the FRONT of a long output?
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('scrollback')
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

// Report the live terminal geometry, which drives the offscreen render width.
log(
  'live term size:',
  JSON.stringify(
    await page.evaluate(() => ({
      cols: document.querySelector('.xterm')?.getAttribute('data-cols') ?? null,
      rows: document.querySelectorAll('.xterm-rows > div').length
    }))
  )
)

async function run(label, cmd, marker, timeoutMs) {
  await page.click('.composer__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(cmd, { delay: 4 })
  await page.keyboard.press('Enter')
  log(`[${label}] sent: ${cmd}`)

  const deadline = Date.now() + timeoutMs
  let state = null
  while (Date.now() < deadline) {
    state = await page.evaluate((m) => {
      const blocks = [...document.querySelectorAll('.block')]
      const el = blocks.find((b) => (b.querySelector('.block__cmd')?.textContent ?? '').includes(m))
      if (!el) return { found: false }
      const rows = [...el.querySelectorAll('.block__body .row')]
      return {
        found: true,
        running: el.className.includes('running'),
        cls: el.className,
        rows: rows.length,
        firstLine: rows[0]?.textContent ?? null,
        second: rows[1]?.textContent ?? null,
        lastLine: rows[rows.length - 1]?.textContent ?? null,
        len: (el.querySelector('.block__body')?.textContent ?? '').length,
        // Anything that looks like a truncation marker anywhere in the block?
        marker: /earlier lines|truncat|…\s*\d|omitted/i.test(
          el.querySelector('.block__body')?.textContent ?? ''
        )
      }
    }, marker)
    if (state.found && !state.running) break
    await sleep(1000)
  }
  log(`[${label}] ->`, JSON.stringify(state))
  return state
}

// Control: comfortably under the claimed 5200-row ceiling.
await run('3k', `Get-Content ${SCRATCH}/small.txt`, 'small.txt', 120_000)

// The reported repro, as a file read (same byte stream, no brace typing).
await run('20k-file', `Get-Content ${SCRATCH}/big.txt`, 'big.txt', 300_000)

// The reporter's literal command.
await run('20k-pipeline', '1..20000 | ForEach-Object { "big $_" }', 'ForEach-Object', 300_000)

await app.close()
profile.cleanup()
log('done')
