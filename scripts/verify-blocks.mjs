// Blocks that outlive the app.
//
// Warp keeps the recent blocks of every pane in a local database and puts them back
// when it launches; this checks Ember does the same, and the two things that make
// that safe rather than merely impressive. First, the blocks have to come back
// attached to the pane that ran them, complete with exit codes — a restore that
// loses which pane a command belonged to is worse than no restore. Second, clearing
// has to be a real clear: Warp's own way out of a session full of output is a
// keystroke, and if the next launch brings it all back the keystroke was a lie.
//
// The launch cost is checked too, because that is where Warp's version of this went
// wrong — their blocks table grows without limit and every row is read before the
// first frame, so an install of a few weeks eventually opens on a hang.
//
// Run: node scripts/verify-blocks.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-blocks-'))
const userData = path.join(work, 'userData')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** The same throwaway profile every time, so launch two sees launch one's database. */
const launch = (args = []) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, `--user-data-dir=${userData}`, ...args],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const blocks = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.pane__scroll .block')).map((b) => ({
      command: b.querySelector('.block__cmd')?.textContent ?? '',
      failed: b.classList.contains('block--failed'),
      exit: b.querySelector('.block__exit')?.textContent ?? null,
      body: (b.querySelector('.block__body')?.textContent ?? '').replace(/\s+/g, ' ').trim()
    }))
  )

const run = async (page, cmd, settle = 2600) => {
  await page.click('.composer__input')
  await page.keyboard.type(cmd, { delay: 10 })
  await page.keyboard.press('Enter')
  await sleep(settle)
}

// --- a session worth keeping -------------------------------------------------
{
  const app = await launch([work])
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  await sleep(1500)

  await run(page, 'echo first-command-here')
  await run(page, 'echo second-command-here')
  await run(page, 'Get-Item .\\definitely-not-here.txt', 3200)

  const before = await blocks(page)
  check('three commands became three blocks', before.length === 3, JSON.stringify(before.map((b) => b.command)))
  check('the last one failed', before[2]?.failed === true, JSON.stringify(before[2]))
  check('and carries its exit code', (before[2]?.exit ?? '').includes('exit'), before[2]?.exit)

  // The session file has to land before the window goes, or the panes themselves
  // will not come back and the blocks would have nowhere to be.
  await sleep(2500)
  await app.close()
  await sleep(1200)
}

// --- and it is still there afterwards ----------------------------------------
{
  const started = Date.now()
  const app = await launch()
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4000)
  const launchMs = Date.now() - started

  const after = await blocks(page)
  check('the blocks came back', after.length === 3, JSON.stringify(after.map((b) => b.command)))
  check(
    'in the order they were run',
    after[0]?.command.includes('first-command-here') && after[1]?.command.includes('second-command-here'),
    JSON.stringify(after.map((b) => b.command))
  )
  check('with their output', after[0]?.body.includes('first-command-here'), after[0]?.body)
  check('and the failure is still a failure', after[2]?.failed === true, JSON.stringify(after[2]))

  // The line Warp draws between the session that came back and the one being
  // worked in — without it a pane opens holding output that reads as just-run.
  const mark = await page.evaluate(
    () => document.querySelector('.blocks__mark')?.textContent?.trim() ?? null
  )
  check('and they are marked as belonging to the last session', /^Previous session from /.test(mark ?? ''), mark)
  check('the launch is not slowed to a crawl by them', launchMs < 25_000, `${launchMs}ms`)
  await page.screenshot({ path: path.join(SHOT_DIR, '70-blocks-restored.png') })

  // A command run now belongs to this session, on the other side of the line.
  await run(page, 'echo third-command-here')
  const mixed = await blocks(page)
  check('a new command joins them', mixed.length === 4, `${mixed.length}`)
  const nowMark = await page.evaluate(
    () => document.querySelectorAll('.blocks__mark--now').length
  )
  check('and the boundary says which side is which', nowMark === 1, `${nowMark} marks`)

  // --- clearing means clearing ----------------------------------------------
  await page.click('.pane__scroll')
  await page.keyboard.press('Control+Shift+K')
  await sleep(1200)
  check('Ctrl+Shift+K empties the pane', (await blocks(page)).length === 0, JSON.stringify(await blocks(page)))

  await sleep(2500)
  await app.close()
  await sleep(1200)
}

// --- what was cleared does not come back -------------------------------------
{
  const app = await launch()
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4000)

  const after = await blocks(page)
  check('a cleared pane comes back empty', after.length === 0, JSON.stringify(after.map((b) => b.command)))
  const mark = await page.evaluate(() => document.querySelectorAll('.blocks__mark').length)
  check('with nothing to mark', mark === 0, `${mark} marks`)

  await app.close()
  await sleep(600)
}

fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('blocks across restarts:', failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
