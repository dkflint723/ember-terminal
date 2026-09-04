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
import * as fs from 'node:fs'
import * as os from 'node:os'
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

// --- and a pane with no box keeps the width it had ----------------------------
// Height is held across the stretches when the live view has no size. Width was
// not: a pane that cannot be measured proposes no dimensions at all, which fell
// through the same clamp that gives a genuinely narrow split its floor, and came
// out as forty columns. So collapsing the terminal region under a running command
// resized conpty to forty and made it rewrap everything still to come.
//
// Read from inside the shell while it happens, because the damage is done to
// conpty rather than to this app's bookkeeping, and it is over by the time the
// pane can be measured again.
await page.click('.composer__input')
await page.keyboard.type(
  '1..12 | ForEach-Object { [Console]::WindowWidth; Start-Sleep -Milliseconds 300 }',
  { delay: 3 }
)
await page.keyboard.press('Enter')
await sleep(1200)

// Hidden the way a collapsed panel hides it: still running, but with no box.
await page.evaluate(() => {
  const live = document.querySelector('.live')
  if (live) live.style.display = 'none'
  window.dispatchEvent(new Event('resize'))
})
await sleep(1800)
await page.evaluate(() => {
  const live = document.querySelector('.live')
  if (live) live.style.display = ''
  window.dispatchEvent(new Event('resize'))
})

while ((await page.locator('.block--running').count()) > 0) await sleep(400)
await sleep(600)
// Row by row: a block body's textContent runs the rows together with no
// separator, so splitting it on newlines yields one very long number.
const widths = (
  await page.evaluate(() => {
    const all = document.querySelectorAll('.block')
    const body = all[all.length - 1]?.querySelector('.block__body')
    if (!body) return []
    const rows = body.querySelectorAll('.row')
    return [...(rows.length ? rows : [body])].map((row) => row.textContent ?? '')
  })
)
  .map((line) => Number.parseInt(line.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)

check(
  'and hiding the pane does not rewrap the command running in it',
  widths.length >= 4 && widths.every((w) => w === widths[0]),
  JSON.stringify(widths)
)

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

/*
 * Coming back to a pane does not stack up renderers.
 *
 * Only the active session is rendered, so switching away unmounts the pane and
 * switching back mounts it again — onto the same controller, which is cached by
 * pane id and outlives the element. Each attach loaded another WebGL addon onto
 * the same terminal without disposing the last.
 *
 * Counting canvases does not show it: xterm rebuilds its screen on open and the
 * count moves for its own reasons. What does show it is the browser running out.
 * A page gets a fixed number of live GL contexts, and past that Chromium drops the
 * oldest and says so — which is both the proof and the symptom, since the context
 * it drops belongs to a terminal somebody is looking at.
 */
const gl = []
page.on('console', (m) => {
  const t = m.text()
  if (/webgl|context/i.test(t)) gl.push(t)
})

await page.keyboard.press('Control+Shift+T')
await sleep(3000)
for (let i = 0; i < 18; i += 1) {
  await page.locator('.sessions__card').first().click()
  await sleep(320)
  await page.locator('.sessions__card').last().click()
  await sleep(320)
}
await page.locator('.sessions__card').first().click()
await sleep(1200)

check(
  'coming back to a session many times does not exhaust the GPU contexts',
  !gl.some((t) => /too many|context lost|will be lost/i.test(t)),
  JSON.stringify(gl.slice(0, 3))
)

/*
 * --- a program that draws a menu without taking the alternate screen -----------
 *
 * Two separate things went wrong for `ollama` run with no arguments, which draws a
 * chooser you move with the arrow keys and never switches to the alternate screen.
 *
 * It is still too short to read comfortably — a running command's strip is 42% of
 * the pane whatever else is on screen, so a menu taller than that has its first
 * items scrolled off the top. Growing the strip was tried and reverted: changing
 * its height mid-command resizes the pty, a resize is a repaint, and a repaint
 * inside an open capture costs the block everything printed before it. A long
 * command came back starting at its forty-fifth line. A cramped menu is a smaller
 * problem than lost output.
 *
 * What is fixed here is that it could not be driven: the panel that takes the keyboard while a command
 * runs is a line editor — it buffers what you type and sends it on Enter, which is
 * right for a REPL and wrong for a program reading one key at a time. The arrows
 * moved a caret in that box while the highlight in the menu never moved. It worked
 * only if you clicked into the terminal first, which is how the person who
 * reported it found out.
 *
 * A stand-in rather than ollama, so this runs on a machine that has never heard of
 * it. It writes each selection to a file, because the terminal draws on a canvas
 * and there is no text in the DOM to read.
 */
const menuDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-menu-'))
const menuLog = path.join(menuDir, 'picked.txt')
fs.writeFileSync(
  path.join(menuDir, 'menu.mjs'),
  [
    "import * as fs from 'node:fs'",
    `const log = ${JSON.stringify(menuLog)}`,
    "const items = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA']",
    'let sel = 0',
    'const paint = (first) => {',
    "  if (!first) process.stdout.write('\\u001b[4A')",
    '  for (let n = 0; n < items.length; n++) {',
    "    process.stdout.write('\\u001b[2K' + (n === sel ? '> ' : '  ') + items[n] + '\\r\\n')",
    '  }',
    '}',
    'process.stdin.setRawMode(true)',
    'process.stdin.resume()',
    'paint(true)',
    "process.stdin.on('data', (buf) => {",
    '  const key = buf.toString()',
    "  if (key === '\\u001b') { fs.appendFileSync(log, 'ESC\\n'); process.exit(0) }",
    "  if (key === '\\u001b[B') sel = Math.min(sel + 1, items.length - 1)",
    "  if (key === '\\u001b[A') sel = Math.max(sel - 1, 0)",
    "  fs.appendFileSync(log, items[sel] + '\\n')",
    '  paint(false)',
    '})'
  ].join('\n')
)

await page.click('.composer__input')
await page.keyboard.type(`node "${path.join(menuDir, 'menu.mjs').replace(/\\/g, '/')}"`, { delay: 4 })
await page.keyboard.press('Enter')
await sleep(3500)

/*
 * Driven from where the keyboard actually is. Starting a command moves focus into
 * that panel deliberately, so this is the ordinary case and not a contrived one —
 * and clicking the terminal first, which is the workaround, is exactly what must
 * stop being necessary.
 */
const focused = await page.evaluate(() => document.activeElement?.className ?? '')
check('the keyboard is in the composer, not the terminal', focused.includes('composer'), focused)

await page.keyboard.press('ArrowDown')
await sleep(500)
await page.keyboard.press('ArrowDown')
await sleep(800)
// Absent when nothing ever reached the program, which is the failure this is for —
// so it reads as an empty list rather than as a crash that hides the other checks.
const picked = () =>
  fs.existsSync(menuLog)
    ? fs.readFileSync(menuLog, 'utf8').trim().split('\n').filter(Boolean)
    : []
const walked = picked()
check(
  'the arrow keys reach the program without clicking into the terminal',
  walked.at(-1) === 'CHARLIE',
  JSON.stringify(walked)
)

await page.keyboard.press('ArrowUp')
await sleep(700)
const back = picked()
check('and go back up again', back.at(-1) === 'BRAVO', JSON.stringify(back.slice(-3)))

/*
 * But a line being typed keeps its own keys. Nothing typed means there is nothing
 * for an arrow to do here, so the program gets it; once there is a line in
 * progress the arrows edit that line, which is what anybody typing expects.
 */
await page.keyboard.type('hello', { delay: 20 })
await page.keyboard.press('ArrowUp')
await sleep(700)
const afterTyping = picked()
check(
  'while an arrow inside a line being typed stays in the line',
  afterTyping.at(-1) === 'BRAVO',
  JSON.stringify(afterTyping.slice(-3))
)

// Escape ends it, which also proves the key arrived rather than being swallowed.
await page.evaluate(() => {
  const el = document.querySelector('.composer__running, .composer textarea')
  if (el) el.value = ''
})
await page.keyboard.press('Control+C')
await sleep(1200)
fs.rmSync(menuDir, { recursive: true, force: true })

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 4).join(' | '))
console.log('live terminal:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
