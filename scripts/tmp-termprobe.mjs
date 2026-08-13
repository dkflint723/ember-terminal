// Scratch probe: drives the terminal hard. Delete when done.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('termprobe')
const SHOT_DIR = path.join(APP_DIR, '.shots', 'termprobe')
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

app.process().stdout?.on('data', (d) => process.stdout.write(`[main] ${d}`))
app.process().stderr?.on('data', (d) => process.stdout.write(`[main-err] ${d}`))

const consoleErrors = []
const page = await app.firstWindow({ timeout: 90_000 })
await placeTopRight(app)
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') consoleErrors.push(`[${m.type()}] ${m.text()}`)
})
page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))

await page.waitForSelector('.app', { timeout: 20_000 })
await page.waitForSelector('.composer__input', { timeout: 20_000 })
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
log('integration ready')

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

const lastBlock = () =>
  page.evaluate(() => {
    const els = [...document.querySelectorAll('.block')]
    const el = els[els.length - 1]
    if (!el) return null
    const body = el.querySelector('.block__body')
    return {
      n: els.length,
      cls: el.className,
      cmd: el.querySelector('.block__cmd')?.textContent ?? '',
      meta: el.querySelector('.block__meta')?.textContent ?? '',
      rows: el.querySelectorAll('.block__body .row').length,
      textLen: (body?.innerText ?? '').length,
      head: (body?.innerText ?? '').slice(0, 120),
      tail: (body?.innerText ?? '').slice(-120)
    }
  })

async function waitDone(timeoutMs = 40_000) {
  const t0 = Date.now()
  for (;;) {
    const done = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.block')]
      const el = els[els.length - 1]
      return el ? !el.className.includes('block--running') : false
    })
    if (done) return true
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(300)
  }
}

async function runAndReport(label, cmd, timeout = 40_000) {
  await run(cmd)
  const ok = await waitDone(timeout)
  const b = await lastBlock()
  log(`\n### ${label}  (finished=${ok})`)
  log(JSON.stringify(b))
  return b
}

// ---- 1. lots of output ----
await runAndReport('lots of output (1..5000)', '1..5000 | ForEach-Object { "line $_" }', 90_000)

// ---- 2. no output ----
await runAndReport('no output', '$null = 1')

// ---- 3. failing command: explicit native exit code ----
await runAndReport('native exit 42', 'cmd /c exit 42')

// ---- 4. failing cmdlet after a previous non-zero native code ----
await runAndReport('native exit 7 (sets LASTEXITCODE)', 'cmd /c exit 7')
await runAndReport('failing cmdlet after exit 7', 'Get-Item C:\\definitely-not-here-xyz')

// ---- 5. success right after a failure ----
await runAndReport('success after failure', 'Write-Output ok')

// ---- 6. very long single line ----
await runAndReport('very long single line', "-join ((1..600) | ForEach-Object { 'ABCDEFGHIJ' })")

// ---- 7. ANSI colour ----
await runAndReport(
  'ansi colour',
  "$e=[char]27; Write-Host \"$e[31mRED$e[0m $e[32mGREEN$e[0m $e[1;34mBOLDBLUE$e[0m\""
)

await page.screenshot({ path: path.join(SHOT_DIR, 'a-basics.png') })

// ---- 8. cd tracking ----
await runAndReport('cd C:\\Windows', 'Set-Location C:\\Windows')
log(
  'cwd after cd →',
  JSON.stringify(
    await page.evaluate(() => ({
      composerCwd: document.querySelector('.composer__cwd')?.textContent,
      title: document.querySelector('.tab')?.textContent
    }))
  )
)
await runAndReport('back', 'Set-Location ' + JSON.stringify(APP_DIR).replace(/"/g, "'"))
log(
  'cwd after back →',
  await page.evaluate(() => document.querySelector('.composer__cwd')?.textContent)
)

log('\n--- console errors ---')
log(consoleErrors.length ? consoleErrors.slice(0, 20).join('\n') : '(none)')

await app.close()
profile.cleanup()
log('done')
