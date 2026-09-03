// The live terminal is exactly as tall as the box it is drawn in.
//
// refit() floored the row count at 120 — deep on purpose, to stop conpty scrolling
// long output away before a block could capture it. But the same number sizes the
// grid xterm lays out, and xterm gives its screen an explicit rows × cellHeight
// height that nothing clips or scrolls to fit. The only clip is
// `.live { overflow: hidden }`. A running command's strip is 42% of the pane, so
// that was 284px of box holding 2160px of terminal: eighteen rows visible, a
// hundred rendered below the fold where nothing can reach them — xterm scrolls back
// into scrollback, never down past its own screen.
//
// A user hit it running `wsl --install archlinux`: "the instance runs off below the
// screen", and a prompt that "does nothing unless I hold the enter key". Those are
// one bug. xterm advances the cursor on a newline and only scrolls when it reaches
// the last row, so with a hundred empty rows beneath it every press was delivered
// and answered somewhere invisible; holding Enter walked the cursor down far enough
// to finally scroll, which is why a hundred prompts came back on the next Ctrl+C.
//
// Both ends are pinned here, because the obvious fix trades one bug for the other:
// the grid must fit the box, AND output longer than the box must still survive
// capture. The depth turned out to protect nothing — capture is the raw byte
// stream, taken before xterm parses any of it — but that is a claim worth a test
// rather than a comment.
//
// Run: node scripts/verify-live.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('live')
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

/*
 * Measured from the DOM, so it holds whichever renderer is active: both give
 * `.xterm-screen` an explicit pixel height, and xterm parks its helper textarea on
 * the cursor cell whenever the cursor moves. That textarea is therefore where the
 * program is currently writing, in page coordinates — which is the thing the user
 * could not see.
 */
const geometry = () =>
  page.evaluate(() => {
    const wrap = document.querySelector('.live')
    const screen = wrap?.querySelector('.xterm-screen')
    if (!wrap || !screen) return null
    const box = wrap.getBoundingClientRect()
    const grid = screen.getBoundingClientRect()
    const caret = wrap.querySelector('.xterm-helper-textarea')?.getBoundingClientRect() ?? null
    return {
      boxPx: Math.round(box.height),
      gridPx: Math.round(grid.height),
      cursorBelowFoldPx: caret ? Math.round(caret.bottom - box.bottom) : null
    }
  })

const run = async (command, timeoutMs = 90_000) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 3 })
  await page.keyboard.press('Enter')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(400)
    if ((await page.locator('.block--running').count()) === 0) break
  }
  await sleep(600)
  return page.evaluate(() => {
    const all = document.querySelectorAll('.block')
    return all[all.length - 1]?.querySelector('.block__body')?.textContent ?? ''
  })
}

// --- the strip a running command is watched in --------------------------------
//
// Lines emitted unhurriedly, so the cursor has genuinely walked past the bottom
// of the strip by the time it is measured. That is the user's situation exactly: with a
// grid taller than the box the cursor keeps descending into rows nobody can see,
// and the picture on screen stops changing while the program is working fine.
await page.click('.composer__input')
// Long enough that the measurement lands nowhere near the end of it. At forty
// rows of ninety milliseconds the command outlived the probe by four hundred
// milliseconds, which a loaded machine ate: the strip had already collapsed and
// the suite reported a zero-height box as a layout fault.
await page.keyboard.type('1..70 | ForEach-Object { "row $_"; Start-Sleep -Milliseconds 120 }', {
  delay: 3
})
await page.keyboard.press('Enter')
await sleep(3200)

const strip = await geometry()
check('a running command has a strip to be drawn in', (strip?.boxPx ?? 0) > 40, JSON.stringify(strip))
check(
  'and the terminal in it is no taller than the strip',
  strip !== null && strip.gridPx <= strip.boxPx + 2,
  JSON.stringify(strip)
)
check(
  'so where the program is writing is on screen',
  strip !== null && strip.cursorBelowFoldPx !== null && strip.cursorBelowFoldPx <= 0,
  JSON.stringify(strip)
)
while ((await page.locator('.block--running').count()) > 0) await sleep(400)
await sleep(600)

// --- the whole pane a full-screen program gets --------------------------------
// The alternate screen without needing vim on the machine.
await page.click('.composer__input')
await page.keyboard.type(
  '$e=[char]27; Write-Host "$e[?1049h"; Write-Host "alt"; Start-Sleep -Seconds 6; Write-Host "$e[?1049l"',
  { delay: 3 }
)
await page.keyboard.press('Enter')
await sleep(2500)

check('a full-screen program takes the whole pane', (await page.locator('.live--raw').count()) === 1)
const full = await geometry()
check(
  'and the terminal it draws on fits that pane',
  full !== null && full.gridPx <= full.boxPx + 2,
  JSON.stringify(full)
)
while ((await page.locator('.block--running').count()) > 0) await sleep(400)
await sleep(800)

// --- the console a shell is handed is still a console -------------------------
// Read from inside the shell, so this is conpty's own screen buffer rather than
// this app's bookkeeping. Zero is the failure that matters: PSReadLine will not
// render a prompt at that size and command submission stops, silently.
const height = Number.parseInt((await run('[Console]::WindowHeight')).trim(), 10)
check('the shell gets a console with rows in it', height >= 4, String(height))

// --- and shrinking it did not cost the capture --------------------------------
// The pair verify-output.mjs pins, repeated here on purpose: fitting the grid to
// the box is exactly the change that would have lost them.
const long = await run('Write-Output ("HEAD" + ("x" * 5990) + "TAIL")')
check('a line far longer than the box keeps its beginning', long.includes('HEAD'), long.slice(0, 50))
check('and its end', long.includes('TAIL'), long.slice(-50))

const many = await run('1..2000 | ForEach-Object { "line $_" }', 120_000)
check('output far deeper than the box keeps its first line', many.trimStart().startsWith('line 1'), many.slice(0, 60))
check('and its last', many.includes('line 2000'), many.slice(-60))

// --- a command still submits once the strip has collapsed again ---------------
const after = await run('Write-Output "AFTER-COLLAPSE"')
check('a command still runs after the strip collapses', after.includes('AFTER-COLLAPSE'), after.slice(0, 60))

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 4).join(' | '))
console.log('live terminal:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
