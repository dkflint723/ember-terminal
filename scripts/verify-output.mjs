// What a block actually keeps.
//
// Three ways output was being lost, all silently, all leaving a block that looked
// complete: a single line longer than conpty's screen buffer lost its beginning; a
// long command lost everything past the offscreen terminal's scrollback; and a
// mid-command repaint from conpty painted earlier commands over the block.
//
// Run: node scripts/verify-output.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('output')
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
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** Run a command and wait for its block to stop running. */
const run = async (command, timeoutMs = 60_000) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    if ((await page.locator('.block--running').count()) === 0) break
  }
  await sleep(700)
  return page.evaluate(
    () => document.querySelectorAll('.block')[document.querySelectorAll('.block').length - 1]
      ?.querySelector('.block__body')?.textContent ?? ''
  )
}

// --- a line longer than the screen -------------------------------------------
// 6000 characters wraps to far more rows than conpty's console buffer used to
// hold, so the start of the line scrolled away before it could be captured.
const long = await run('Write-Output ("HEAD" + ("x" * 5990) + "TAIL")')
check('a very long line keeps its beginning', long.includes('HEAD'), long.slice(0, 60))
check('and its end', long.includes('TAIL'), long.slice(-60))

// --- more lines than the old scrollback --------------------------------------
const many = await run('1..6000 | ForEach-Object { "line $_" }', 120_000)
// textContent runs the rows together, so the first line is a prefix rather than a
// line of its own.
check('a long command keeps its first line', many.trimStart().startsWith('line 1'), many.slice(0, 80))
check('and its last', many.includes('line 6000'), many.slice(-80))

// --- output belongs to the block that produced it ------------------------------
// A marker unique to this command: if a repaint dragged an earlier command's
// screen into this capture, the earlier marker turns up here too.
await run('Write-Output "MARKER-ONE"')
const second = await run('Write-Output "MARKER-TWO"')
check('a block shows its own output', second.includes('MARKER-TWO'), second.slice(0, 80))
check(
  'and not the previous command output',
  !second.includes('MARKER-ONE'),
  second.slice(0, 200)
)

/*
 * --- a failing cmdlet reports its own failure ---------------------------------
 *
 * PowerShell never resets $LASTEXITCODE — it only holds the last *native* process's
 * code — so after a native command exited 7, every failing cmdlet reported 7 as
 * though it were its own result. A wrong exit code is worse than none, because the
 * block presents it as fact.
 */
const statusOf = () =>
  page.evaluate(() => {
    const blocks = document.querySelectorAll('.block')
    const last = blocks[blocks.length - 1]
    return {
      status: last?.querySelector('.block__status')?.getAttribute('title') ?? null,
      meta: last?.querySelector('.block__meta')?.textContent ?? last?.textContent?.slice(-40) ?? ''
    }
  })

await run('cmd /c exit 7')
const native = await statusOf()
check('a native command reports its own exit code', /7/.test(native.meta), JSON.stringify(native))

await run('Get-Item C:\\definitely-not-here-xyz')
const cmdlet = await statusOf()
check(
  'and a failing cmdlet does not inherit it',
  !/\b7\b/.test(cmdlet.meta),
  JSON.stringify(cmdlet)
)

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('block output:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
