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
import { closeApp, untilNothingRuns, watchRunning } from './harness.mjs'
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
await watchRunning(app)
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

/*
 * And the composer under the strip is whole.
 *
 * The strip's share was worked out against the blocks area — the pane minus the
 * composer — and then applied as a percentage of the whole pane, which includes the
 * composer. So it always came out taller than meant, and in a pane with no blocks,
 * where it takes its ceiling, it left the running composer less room than it needs:
 * the pane clips its overflow, and the composer's last row was cut off at the
 * bottom. This is that pane — a fresh one, running its first command.
 */
const composerFit = await page.evaluate(() => {
  const pane = document.querySelector('.pane')?.getBoundingClientRect()
  const composer = document.querySelector('.composer')?.getBoundingClientRect()
  const hint = document.querySelector('.composer .composer__hint')?.getBoundingClientRect()
  return pane && composer
    ? {
        paneBottom: Math.round(pane.bottom),
        composerBottom: Math.round(composer.bottom),
        hintBottom: hint ? Math.round(hint.bottom) : null
      }
    : null
})
check(
  'the composer under a running command is not cut off',
  composerFit !== null && composerFit.composerBottom <= composerFit.paneBottom,
  JSON.stringify(composerFit)
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

/*
 * What the pane actually holds at this point, named rather than guessed at.
 *
 * Every helper in this file reads "the last block" as the command it just ran,
 * and so do ten other suites. If anything else can append a block, that
 * assumption breaks quietly and every one of those reads returns somebody else's
 * output — or nothing at all, since a folded block renders no body.
 */
const nearby = await page.evaluate(() =>
  [...document.querySelectorAll('.block')].slice(-4).map((b) => ({
    cmd: (b.querySelector('.block__cmd')?.textContent ?? '').slice(0, 44),
    open: b.querySelector('.block__head')?.getAttribute('aria-expanded') ?? '?',
    body: (b.querySelector('.block__body')?.textContent ?? '').slice(0, 40)
  }))
)
check(
  'the last block is the command that just ran',
  /WindowHeight/.test(nearby.at(-1)?.cmd ?? ''),
  JSON.stringify(nearby)
)

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
/*
 * Two lines and then all of them, the way verify-output reads its six thousand.
 *
 * This was `startsWith('line 1')`, which "line 1767" satisfies: a block that had
 * lost its first thousand-odd lines passed, and in 0.3.25 most runs did lose them.
 * textContent runs the rows together, so the second line is what makes the first
 * one a test, and the full walk is what catches a hole in the middle.
 */
check(
  'output far deeper than the box keeps its first line',
  many.trimStart().startsWith('line 1line 2'),
  many.slice(0, 60)
)
check('and its last', many.includes('line 2000'), many.slice(-60))
const seen = (many.match(/line (\d+)/g) ?? []).map((t) => Number(t.slice(5)))
const firstGap = seen.findIndex((n, i) => n !== i + 1)
check(
  'and every line in between',
  seen.length === 2000 && firstGap === -1,
  `${seen.length} lines, first ${seen[0]}, last ${seen.at(-1)}` +
    (firstGap === -1 ? '' : `, breaks at ${seen[firstGap]}`)
)

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

/*
 * Getting back to the pane that was typed in, by looking rather than by counting.
 *
 * Two ways that read as the obvious one are both wrong here. Ctrl+Tab walks the
 * session list, and by this point in the run the window holds more than two
 * sessions, so one press lands on a third. And the index of the active card,
 * taken before the new session is made, does not survive the making of it — the
 * list is not in the order it was. Either way the pane reached was one that had
 * never been typed into, and its empty composer read as a draft that had been
 * lost: the check was wrong, not the app. So: click sessions until the pane that
 * was typed in is the active one, and say so when it is never reached.
 */
const goToPane = async (wanted, tries = 8) => {
  const cards = await page.locator('.sessions__card').count()
  for (let i = 0; i < Math.min(cards, tries); i++) {
    await page.locator('.sessions__card').nth(i).click()
    await sleep(1300)
    const now = await page.evaluate(
      () => document.querySelector('.pane--active')?.getAttribute('data-pane')?.slice(0, 8) ?? null
    )
    if (now === wanted) return true
  }
  return false
}

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
 * Sessions still share one terminal host, and that is not checked here yet.
 *
 * The leaf is rendered unkeyed, so React reuses one component instance — and one
 * host element — as the session changes underneath it; xterm will not move a
 * terminal it has already opened, so each visited session leaves its own
 * `.xterm` behind in that host. Two of them were measured in one host here.
 *
 * Keying the leaf and re-parenting the element does fix the count, and also
 * changes which renderer the terminal ends up using: with the element moved
 * rather than opened, `.xterm-screen` came back transparent and the five theme
 * checks in verify.mjs — which read the palette off that element — all failed.
 * The fix needs to keep the renderer's state intact across the move, which is
 * its own piece of work rather than a line in this one.
 */

/*
 * --- output typed ahead lands in the block it belongs to ------------------------
 *
 * feedCapture runs synchronously in write(), before xterm parses the chunk, and a
 * `133;C` empties the one shared capture buffer. The previous block does not read
 * that buffer until xterm reaches its `133;D`, which happens later — up to a
 * megabyte later. So when `D(A)`, the prompt and `C(B)` arrive together, block A
 * can be handed B's bytes and block B can come back empty.
 *
 * Typing while a command runs is exactly how that sequence is produced: the line
 * editor sends the text to the pty, the shell buffers it, and it runs the instant
 * the prompt returns. This is the audit's own scenario, and the audit calls the
 * race inferred — so this check is what decides whether it is real.
 */
/*
 * Driven through the composer, which is the only door a person has.
 *
 * Writing the two commands straight at the pty would provoke the collision far
 * more reliably — but the composer is what decides whether a block is opened at
 * all, and a test that skips it would be exercising a path nobody can reach and
 * calling the result a block. That is how a suite comes to pass while the thing
 * it names stays broken.
 *
 * A race that happens sometimes is still caught by asking repeatedly, and ten
 * rounds cost seconds. Each round is a pair whose outputs must not cross: the
 * first sleeps, the second is typed into that sleep and runs the moment the
 * prompt returns, which is when `D(A)`, the prompt and `C(B)` arrive together.
 */
const crossed = []
/** Rounds where the second command never reached the shell intact. */
const missed = []
for (let round = 0; round < 6; round += 1) {
  const a = `AAA-${round}`
  const b = `BBB-${round}`
  await page.click('.composer__input')
  /*
   * Flooding, not sleeping, because the gap this is aiming at is a parsing gap.
   *
   * feedCapture runs inside write(), synchronously, while xterm parses what it
   * was given later — in short slices, with as much as a megabyte outstanding.
   * The collision needs `C(B)` to reach the splitter while xterm has still not
   * reached `D(A)`, and a command that sleeps quietly prints nothing, so xterm
   * is never behind and that window is never open. Thousands of lines put it
   * thousands of lines behind, which is the state the report describes.
   *
   * The marker is printed first so the block's own line is at the top whatever
   * happens to the flood after it.
   */
  await page.keyboard.type(
    `Write-Output "${a}"; 1..3000 | ForEach-Object { "noise $_" }`,
    { delay: 2 }
  )
  await page.keyboard.press('Enter')
  /*
   * Typed into the flood, once the line editor has the keyboard.
   *
   * At 250ms this landed during the handover — starting a command moves focus
   * into the panel that forwards keys to the running program, and the first
   * keystroke was swallowed on the way, so `Write-Output` reached the shell as
   * `rite-Output`. The flood runs for seconds, so waiting longer costs none of
   * the parser lag this is aiming at.
   */
  await sleep(700)
  await page.keyboard.type(`Write-Output "${b}"`, { delay: 2 })
  await page.keyboard.press('Enter')
  /*
   * Waited for by name, rather than by nothing being in flight.
   *
   * With one command typed into another there is a moment between them when no
   * block is running at all: the first has finished and the second has not yet
   * opened its own. A poll landing in that gap called it settled before the
   * second command existed, and the pair read out was the previous round's —
   * so the check failed for a reason with nothing to do with what it is about.
   */
  for (let i = 0; i < 80; i += 1) {
    const state = await page.evaluate((marker) => {
      const all = [...document.querySelectorAll('.block')]
      return {
        running: document.querySelectorAll('.block--running').length,
        lastCmd: all[all.length - 1]?.querySelector('.block__cmd')?.textContent ?? '',
        marker
      }
    }, b)
    if (state.running === 0 && state.lastCmd.includes(b)) break
    await sleep(250)
  }
  await sleep(600)

  const pair = await page.evaluate(
    ({ a, b }) => {
      const all = [...document.querySelectorAll('.block')]
      const last2 = all.slice(-2)
      const bodies = last2.map((el) => el.querySelector('.block__body')?.textContent ?? '')
      const cmds = last2.map((el) => el.querySelector('.block__cmd')?.textContent ?? '')
      return {
        secondCmd: cmds[1] ?? '',
        first: bodies[0] ?? '',
        second: bodies[1] ?? '',
        firstHasOwn: (bodies[0] ?? '').includes(a),
        firstHasOther: (bodies[0] ?? '').includes(b),
        secondHasOwn: (bodies[1] ?? '').includes(b),
        secondHasOther: (bodies[1] ?? '').includes(a)
      }
    },
    { a, b }
  )
  /*
   * A round counts only when the provocation actually landed.
   *
   * The second command has to reach the shell as written, and it does not
   * always: typing into a command that is already running goes through the line
   * editor, and a keystroke lost on the way turned `Write-Output` into
   * `rite-Output`, which came back as an unknown command. That is this suite
   * failing to set the situation up — condemning the code for it would be
   * reporting the test's own mistake as a defect in what it is testing.
   */
  if (!pair.secondCmd.includes(b)) {
    missed.push({ round, cmd: pair.secondCmd.slice(0, 40) })
    continue
  }
  if (!pair.firstHasOwn || pair.firstHasOther || !pair.secondHasOwn || pair.secondHasOther) {
    crossed.push({ round, ...pair })
  }
}
check(
  'output never crosses between a command and the one typed ahead of it',
  crossed.length === 0,
  JSON.stringify({ crossed: crossed.slice(0, 2), missedRounds: missed.length })
)
/*
 * And the check above was in a position to find anything.
 *
 * If every round fails to type ahead, the loop reports no crossings and proves
 * nothing whatever — a green light for a situation that never happened. Said
 * out loud rather than left to be inferred from a passing run.
 */
check(
  'the type-ahead landed in at least one round',
  missed.length < 6,
  JSON.stringify(missed)
)

/*
 * Output arriving while nothing is running is still lost, and is not checked here.
 *
 * Keeping it means putting it in a block, and a block for it can only go at the
 * end of the list — which breaks the assumption the check above pins, and which
 * every helper in this file and ten other suites rest on: that the last block is
 * the command you just ran. An attempt at it left a folded block after nearly
 * every command, and a folded block renders no body at all, so four checks here
 * began reading the most recent output as an empty string while the commands
 * themselves had worked perfectly.
 *
 * It needs somewhere to live that is not the end of the block list, which is a
 * change worth making on its own rather than bolting onto this one.
 */

/*
 * --- and a trimmed block does not promise what history cannot keep --------------
 *
 * The live copy is capped at 512 KB of rendered HTML, and history keeps 100,000
 * characters of plain text. Past that the block says "the full text is in history
 * (Ctrl+R)", which for an output this size is simply untrue: history holds a
 * seventh of it. Saying where something went is only worth doing while it is
 * where you said.
 */
const huge = await run('1..8000 | ForEach-Object { "x" * 90 }', 150_000)
check('a very long command still produces a block', huge.length > 1000, String(huge.length))
const promise = await page.evaluate(() => {
  const all = document.querySelectorAll('.block')
  return all[all.length - 1]?.querySelector('.block__body')?.textContent?.slice(0, 300) ?? ''
})
check(
  'a trimmed block does not claim history holds the full text',
  !/full text is in history/i.test(promise),
  JSON.stringify(promise.slice(0, 140))
)

/*
 * --- a program that draws a menu without taking the alternate screen -----------
 *
 * Two separate things went wrong for `ollama` run with no arguments, which draws a
 * chooser you move with the arrow keys and never switches to the alternate screen.
 *
 * It was too short to read: a running command's strip was 42% of the pane whatever
 * else was on screen, so a menu taller than that had its first items scrolled off
 * the top while half the pane sat empty. The strip is sized to what the blocks
 * actually need now — but decided while nothing is running and held for the whole
 * command, because changing it mid-command resizes the pty, a resize is a repaint,
 * and a repaint inside an open capture costs the block everything printed before
 * it. Two earlier versions of this proved that: one let the strip flex and a long
 * command came back starting at line 45, the other measured a render too late and
 * it started at line 3.
 *
 * And it could not be driven: the panel that takes the keyboard while a command
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

/*
 * In a session of its own: this suite has filled its first one with blocks, and
 * those legitimately keep their room.
 */
await page.keyboard.press('Control+Shift+T')
await sleep(3500)
await page.click('.composer__input')
await page.keyboard.type(`node "${path.join(menuDir, 'menu.mjs').replace(/\\/g, '/')}"`, { delay: 4 })
await page.keyboard.press('Enter')
await sleep(3500)

/*
 * A pane with nothing above the command gives it the room.
 *
 * The floor is what a pane with a history behind it still gets, and verify-output
 * is the other half of this: it runs a six-thousand-line command and checks the
 * block kept its first line, which is what any resize during the capture destroys.
 */
const menuGeom = await page.evaluate(() => {
  const pane = document.querySelector('.pane')
  const live = document.querySelector('.live')
  return {
    panePx: pane ? Math.round(pane.getBoundingClientRect().height) : 0,
    livePx: live ? Math.round(live.getBoundingClientRect().height) : 0
  }
})
check(
  'a program with nothing above it gets more of the pane than the floor',
  menuGeom.livePx > menuGeom.panePx * 0.6,
  JSON.stringify({ ...menuGeom, pct: Math.round((menuGeom.livePx / menuGeom.panePx) * 100) })
)

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

// --- output with no command to belong to -------------------------------------
//
// Blocks are cut between a command’s markers, and the live view is zero pixels
// tall while nothing is running — so anything printed outside a command went to a
// terminal nobody could see: a background job, a server started with
// -NoNewWindow, a profile printing after the prompt. Nothing was lost; there was
// simply nowhere it appeared.
//
// The hard half is not noticing the output, it is not crying wolf. Three things
// arrive in the same stretch of the stream and are not this: the prompt itself,
// the echo of the command you just typed, and the repaint conpty writes whenever
// the pty is resized — which replays the prompt, so it reads exactly like text
// from nowhere. All three are checked here, because a notice that appears after
// every command would be worse than the silence it replaced.
// Nothing of the section above still running: a pane with a command in it shows
// the strip for that reason, which is not the reason under test here.
const quietBy = Date.now() + 15_000
while (Date.now() < quietBy && (await page.locator('.block--running').count()) > 0) {
  await page.keyboard.press('Control+C')
  await sleep(500)
}
await sleep(800)

const liveState = () =>
  page.evaluate(() => {
    const live = document.querySelector('.live')
    return {
      idle: live?.classList.contains('live--idle') ?? null,
      px: live ? Math.round(live.getBoundingClientRect().height) : 0,
      notice: (document.querySelector('.pane__loose')?.textContent ?? '').slice(0, 48)
    }
  })

const quiet = await liveState()
check(
  'an ordinary command leaves the pane quiet afterwards',
  quiet.idle === true && quiet.notice === '',
  JSON.stringify(quiet)
)

// A child that shares this console and writes to it after its parent has gone.
await run(
  "Start-Process -NoNewWindow powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 3; Write-Host LATE-FROM-BACKGROUND'"
)
const beforeItSpeaks = await liveState()
check(
  'and starting a background writer does not by itself say anything',
  beforeItSpeaks.idle === true && beforeItSpeaks.notice === '',
  JSON.stringify(beforeItSpeaks)
)

const spokeBy = Date.now() + 25_000
let spoke = await liveState()
while (Date.now() < spokeBy && spoke.idle !== false) {
  await sleep(400)
  spoke = await liveState()
}
check(
  'what it prints afterwards is shown rather than swallowed',
  spoke.idle === false && spoke.px > 0 && /outside any command/.test(spoke.notice),
  JSON.stringify(spoke)
)

await page.locator('.pane__loose .btn').click()
await sleep(800)
const dismissed = await liveState()
check(
  'and Dismiss puts the pane back the way it was',
  dismissed.idle === true && dismissed.notice === '',
  JSON.stringify(dismissed)
)


// --- one live terminal per pane, and that pane's own --------------------------
//
// xterm builds its element the first time open() is called and every call after
// that returns having done nothing, so a terminal stays in the host it first saw.
// A session with one pane rendered its leaf unkeyed, which meant React kept the
// mounted pane across a session switch and handed it the next session's props: the
// same host div, now holding two terminals, the older one drawn over the newer.
// Splitting was the other half — both leaves move into the keyed list, so the
// original pane got a new host its terminal never followed it into, and a
// full-screen program ran in an empty box with the keystrokes going somewhere
// nobody could see.
//
// Measured on the build before the fix: a second session put two .xterm in the one
// pane and carried the first session's draft into it, and a split left the original
// pane with none at all — `{"panes":2,"perPane":[0,1]}` — then gave a full-screen
// program a 676px box with nothing in it.
const terminalsPerPane = () =>
  page.evaluate(() => ({
    panes: [...document.querySelectorAll('.pane:not(.editor)')].map((p) => {
      const own = p.getAttribute('data-pane')
      const terms = [...p.querySelectorAll('.live .xterm')]
      return {
        count: terms.length,
        mine: terms.length > 0 && terms.every((t) => t.getAttribute('data-pane') === own),
        screenPx: Math.round(p.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0)
      }
    }),
    loose: document.querySelectorAll('.live .xterm').length,
    draft: document.querySelector('.pane--active .composer__input')?.value ?? null,
    // Which pane was asked, so a failure names it rather than leaving it to be guessed.
    activePane: document.querySelector('.pane--active')?.getAttribute('data-pane')?.slice(0, 8) ?? null,
    composers: document.querySelectorAll('.composer__input').length,
    raw: document.querySelectorAll('.live--raw').length,
    running: document.querySelectorAll('.block--running').length
  }))

/*
 * Nothing from the section above is still running, because a pane with a program in
 * it gives what is typed to the program rather than to the composer — and every
 * check below is about the composer.
 *
 * Bounded, and it says so when it gives up. Waiting without an end turns one
 * program that ignored a Ctrl+C into a suite that never finishes: the menu above
 * outlived its interrupt once, and the run sat there until it was killed by hand
 * with nothing printed.
 */
const settleBlocks = async (ms = 15_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline && (await page.locator('.block--running').count()) > 0) {
    await page.keyboard.press('Control+C')
    await sleep(500)
  }
  await sleep(700)
  return (await page.locator('.block--running').count()) === 0
}
check('the pane is back at a prompt before any of this is typed', await settleBlocks())

// A line typed and left there, because it is the other thing that used to travel.
await page.fill('.pane--active .composer__input', '')
await page.click('.pane--active .composer__input')
await page.keyboard.type('echo DRAFT-BELONGS-TO-A', { delay: 4 })
await sleep(400)
const alone = await terminalsPerPane()
check(
  'a line typed into a composer is in that composer',
  alone.draft === 'echo DRAFT-BELONGS-TO-A',
  JSON.stringify({ draft: alone.draft, pane: alone.activePane, composers: alone.composers })
)
check(
  'a session draws one terminal, its own',
  alone.panes.length === 1 && alone.panes[0].count === 1 && alone.panes[0].mine,
  JSON.stringify(alone)
)

await page.keyboard.press('Control+Shift+T')
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1800)
const second = await terminalsPerPane()
check(
  'and so does the next session, rather than showing the first one as well',
  second.panes.length === 1 && second.panes[0].count === 1 && second.panes[0].mine,
  JSON.stringify(second)
)
check('with nothing left over anywhere else', second.loose === 1, JSON.stringify(second))
check(
  'whose composer is empty, not still holding what was typed next door',
  second.draft === '',
  JSON.stringify(second.draft)
)

const arrived = await goToPane(alone.activePane)
await sleep(900)
const returned = await terminalsPerPane()
check(
  'the pane that was typed in can be got back to',
  arrived && returned.activePane === alone.activePane,
  JSON.stringify({ wanted: alone.activePane, got: returned.activePane })
)
check(
  'the session switched back to has its terminal again',
  returned.panes.length === 1 && returned.panes[0].count === 1 && returned.panes[0].mine,
  JSON.stringify(back)
)
check(
  'and the line it was left in the middle of typing',
  returned.draft === 'echo DRAFT-BELONGS-TO-A',
  JSON.stringify({ draft: returned.draft, pane: returned.activePane, composers: returned.composers })
)

await page.keyboard.press('Control+Shift+D')
await sleep(2500)
const split = await terminalsPerPane()
check(
  'a split gives each pane a terminal, and each pane its own',
  split.panes.length === 2 && split.panes.every((p) => p.count === 1 && p.mine),
  JSON.stringify(split)
)

/*
 * And the pane that was split away from can still be drawn on.
 *
 * The count above is satisfied by an element; this asks the harder question, which
 * is whether the thing on screen is the terminal the program is writing to. A
 * full-screen program takes the whole pane, so a pane whose terminal was left
 * behind shows a tall empty box — which is what this did before the fix.
 */
const older = page.locator('.pane:not(.editor)').first()
await older.locator('.composer__input').fill('')
await older.locator('.composer__input').click()
await page.keyboard.type(
  '$e=[char]27; Write-Host "$e[?1049h"; Write-Host "SPLIT-ALT"; Start-Sleep -Seconds 5; Write-Host "$e[?1049l"',
  { delay: 4 }
)
await page.keyboard.press('Enter')
await sleep(2600)
const rawSplit = await page.evaluate(() => {
  const p = document.querySelector('.pane:not(.editor)')
  const live = p?.querySelector('.live')
  const screen = p?.querySelector('.live .xterm-screen')
  return {
    raw: live?.classList.contains('live--raw') ?? false,
    count: p?.querySelectorAll('.live .xterm').length ?? -1,
    mine: p?.querySelector('.live .xterm')?.getAttribute('data-pane') === p?.getAttribute('data-pane'),
    boxPx: live ? Math.round(live.getBoundingClientRect().height) : 0,
    screenPx: screen ? Math.round(screen.getBoundingClientRect().height) : 0
  }
})
check(
  'a full-screen program in that pane is drawn in it',
  rawSplit.raw && rawSplit.count === 1 && rawSplit.mine && rawSplit.screenPx > 0,
  JSON.stringify(rawSplit)
)
/*
 * Waited out by what main is told is running, not by the DOM. A program on the
 * alternate screen takes the whole pane and its block is not drawn, so
 * `.block--running` finds nothing and settleBlocks returned at once — with the
 * command above still a second or two from done. The close then asked whether
 * to end it, nobody answered, and every run on the runner sat there until the
 * gate killed it at twenty minutes with none of these checks printed. It ends
 * by itself in five seconds; this waits for that, and the close is bounded in
 * case it ever does not.
 */
await untilNothingRuns(app, 20_000)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 4).join(' | '))
console.log('live terminal:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
