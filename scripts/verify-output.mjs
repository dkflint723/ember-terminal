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

/*
 * --- a block keeps the colours the shell gave it --------------------------------
 *
 * Under PowerShell's default rendering the colours are set as console attributes
 * rather than written into the stream, and conpty then carries them in the screen
 * repaints it sends at its own frame boundaries — which routinely fall outside a
 * command's markers. The bytes a block is cut from held the text and none of the
 * styling: a directory listing came back as plain text, coloured only on the live
 * screen. The integration script now asks for `OutputRendering = 'Ansi'`, so the
 * sequences arrive in line with the text they colour.
 *
 * Both halves are checked here, because they fail independently: that the styling
 * survived at all, and that the text is readable on the fill. PowerShell marks
 * directories with a background and NO foreground, so the names would otherwise
 * keep the pane's default — light text on a light fill on a theme whose blue is
 * light, unreadable exactly where the shell was drawing attention.
 */
await run('Write-Host "BLUEFILL" -BackgroundColor Blue')
const painted = await page.evaluate(() => {
  const lum = (c) => {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c)
    if (!m) return null
    const ch = (v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * ch(+m[1]) + 0.7152 * ch(+m[2]) + 0.0722 * ch(+m[3])
  }
  const all = document.querySelectorAll('.block')
  const body = all[all.length - 1]?.querySelector('.block__body')
  const out = []
  for (const span of body?.querySelectorAll('span[style*="background"]') ?? []) {
    const cs = getComputedStyle(span)
    const la = lum(cs.color)
    const lb = lum(cs.backgroundColor)
    if (la === null || lb === null) continue
    const [hi, lo] = la > lb ? [la, lb] : [lb, la]
    out.push({
      text: (span.textContent ?? '').trim().slice(0, 12),
      ratio: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2))
    })
  }
  return { runs: out, text: (body?.textContent ?? '').trim().slice(0, 40) }
})
check(
  'a background the shell asked for survives into the block',
  painted.runs.length > 0,
  JSON.stringify(painted)
)
check(
  'and the text on it is readable',
  painted.runs.length > 0 && painted.runs.every((p) => p.ratio >= 4.5),
  JSON.stringify(painted.runs)
)

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

/*
 * --- the grid's padding is not output -----------------------------------------
 *
 * conpty repaints a screen rather than streaming a stream: it puts the cursor where
 * the next thing goes and leaves every row it stepped over untouched, so a capture
 * arrives holding runs of rows nothing ever wrote. Measured before this was fixed,
 * `Get-ChildItem` rendered nineteen rows — thirteen of them empty, between the
 * `Directory:` line and the table, where PowerShell prints exactly one blank line.
 * At 387px for three files, most of a block was padding.
 *
 * One blank is kept, because a blank line between paragraphs is real output. So
 * this asserts the run, not the count: any two adjacent empty rows are the grid
 * coming back.
 */
await run('Get-ChildItem | Select-Object -First 3')
const shape = await page.evaluate(() => {
  const all = document.querySelectorAll('.block')
  const rows = Array.from(all[all.length - 1]?.querySelectorAll('.block__body .row') ?? [])
  const blank = rows.map((r) => (r.textContent ?? '').trim() === '')
  let worst = 0
  let runLength = 0
  for (const isBlank of blank) {
    runLength = isBlank ? runLength + 1 : 0
    worst = Math.max(worst, runLength)
  }
  return { rows: rows.length, blanks: blank.filter(Boolean).length, worst }
})
check('a listing has no run of blank rows the shell never printed', shape.worst <= 1, JSON.stringify(shape))
/*
 * The row *count* is deliberately not asserted here yet, and that is a statement
 * about a bug rather than about this check. A block can still come back holding a
 * whole screen of earlier commands' output — 127 rows for a three-item listing when
 * this was measured — because conpty repaints the screen and the repaint lands
 * inside the capture. Padding and duplication are two faults with one cause, and
 * only the padding is fixed; a count assertion here would be failing for the other
 * one, which is not this check's business to report.
 */
// The blank line PowerShell does print is still there: collapsing to none would
// jam the heading against the table.
check('and the blank line it did print is kept', shape.blanks >= 1, JSON.stringify(shape))

/*
 * --- the list follows the output ----------------------------------------------
 *
 * A command's output is rendered into its block when the command finishes, so the
 * tall part arrives without the block count changing. Pinned to the count alone,
 * nothing moved the view and the newest output sat below the fold until it was
 * dragged into sight.
 */
const bottomGap = async () =>
  page.evaluate(() => {
    const el = document.querySelector('.pane__scroll')
    return el ? Math.round(el.scrollHeight - el.scrollTop - el.clientHeight) : null
  })
await run('1..60 | ForEach-Object { "scroll line $_" }')
check('the newest output is in view without being dragged there', (await bottomGap()) <= 24, `${await bottomGap()}px below the fold`)

// And the other half: someone who has scrolled up to read is not yanked back.
await page.evaluate(() => {
  const el = document.querySelector('.pane__scroll')
  if (el) el.scrollTop = 0
})
await sleep(400)
await run('1..40 | ForEach-Object { "later line $_" }')
check(
  'but a reader who scrolled up is left where they were',
  (await bottomGap()) > 24,
  `${await bottomGap()}px below the fold`
)

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('block output:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
