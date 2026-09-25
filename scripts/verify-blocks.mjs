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
// Conversations are kept the same way and checked here too, for a reason particular
// to them: they reach the database on a different clock from commands. A command is
// written the instant it finishes, an exchange only when the workspace autosave next
// fires, so the order the rows were written in is not the order the things happened
// in — and a restored list that gets that wrong is not a record, it is a
// plausible-looking fiction.
//
// Run: node scripts/verify-blocks.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import { auditProfileDir, userDataOf } from './profile.mjs'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-blocks-'))
const userData = path.join(work, 'userData')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * A stub Anthropic, so asking something is as repeatable as running echo.
 *
 * The point here is what survives a restart, not what the model says, and a real
 * request would make the answer — and therefore every assertion about the block
 * holding it — different on every run.
 */
const ANSWER = 'Lists every log file below here.'
const PROPOSED = 'Get-ChildItem -Recurse -Filter *.log'
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          {
            type: 'text',
            text: JSON.stringify({ command: PROPOSED, note: ANSWER, destructive: false })
          }
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    )
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_API_KEY: 'sk-ant-stub-key-for-verification'
}
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** The same throwaway profile every time, so launch two sees launch one's database. */
// Every window of every launch below reports its uncaught page errors here.
const pageErrors = []
const launch = (args = []) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, `--user-data-dir=${userData}`, ...args],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }).then((app) => watchPageErrors(app, pageErrors))

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

/**
 * Every block in the pane as one list, commands and conversations together.
 *
 * Read in document order and labelled by kind, because the thing being checked is
 * the sequence itself: which happened first, not what each one holds.
 */
const timeline = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.pane__scroll .block')).map((b) => ({
      kind: b.classList.contains('block--agent') ? 'agent' : 'command',
      text: (
        b.querySelector('.block__cmd')?.textContent ??
        b.querySelector('.block__prompt')?.textContent ??
        ''
      ).trim()
    }))
  )

// Filled in from the first launch: the directory the app chose, which an elevated
// process makes one level further down than the one it was handed.
let liveUserData = userData

// --- a session worth keeping -------------------------------------------------
{
  const app = await launch([work])
  const page = await app.firstWindow()
  await watchRunning(app)
  liveUserData = await userDataOf(app)
  await placeTopRight(app)
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  await sleep(1500)

  /*
   * Clearing the screen does not tidy away a command that is still going.
   *
   * Two things hang off a running block being in the list. Its output is written
   * into it when it finishes, so removing it means the output arrives for a block
   * that is not there and is dropped. And while it is there, the composer hands the
   * keyboard to the program rather than to the shell — including the masked field
   * for a password prompt. Clearing under a live `ssh` therefore put its password
   * prompt back in the ordinary composer, typed in the clear and on its way to the
   * history database.
   */
  /*
   * A command that outlasts any stall, and an assertion about the clear rather
   * than about the clock.
   *
   * This ran `Start-Sleep -Seconds 8` and asserted about 1.6 s after the block
   * appeared. That is a budget, and on a loaded machine the budget ran out: the
   * sleep finished before the assertion, and "0 running blocks" read as the clear
   * having removed the command when nothing had removed anything. The command now
   * runs until it is interrupted, so there is nothing to outrun; and the counts are
   * taken on both sides of the keystroke, so what is compared is what the clear
   * changed.
   */
  const running = async () => ({
    blocks: await page.locator('.block--running').count(),
    panels: await page.locator('.composer__badge--warn').count()
  })
  await page.click('.composer__input')
  await page.keyboard.type('Start-Sleep -Seconds 300', { delay: 8 })
  await page.keyboard.press('Enter')
  // Waited for rather than slept through: a fixed pause here is a race with how
  // long the shell takes to start the command, and clearing before it has begun
  // tests nothing at all.
  await page.waitForSelector('.block--running', { timeout: 20_000 })
  await sleep(400)
  const beforeClear = await running()
  await page.keyboard.press('Control+Shift+K')
  await sleep(1200)
  const afterClear = await running()
  check(
    'a command is running, and has the keyboard, as the screen is cleared',
    beforeClear.blocks === 1 && beforeClear.panels === 1,
    JSON.stringify(beforeClear)
  )
  check(
    'clearing the screen keeps the command still running in it',
    afterClear.blocks === 1 && afterClear.blocks === beforeClear.blocks,
    `${beforeClear.blocks} running before the clear, ${afterClear.blocks} after`
  )
  check(
    'so the keyboard still belongs to the program',
    afterClear.panels === 1 && afterClear.panels === beforeClear.panels,
    `${beforeClear.panels} running panels before the clear, ${afterClear.panels} after`
  )
  // Stopped by hand, through the live terminal, which is where a running command's
  // keys go. Bounded, and sent again if once was not heard: a wait with no end is
  // how a suite that should have failed once sat for twenty minutes instead.
  await page.locator('.xterm').first().click({ force: true })
  await page.keyboard.press('Control+c')
  let stopped = false
  for (let i = 0; i < 40; i++) {
    if ((await page.locator('.block--running').count()) === 0) {
      stopped = true
      break
    }
    if (i === 12) await page.keyboard.press('Control+c')
    await sleep(500)
  }
  check('and the command stops when interrupted', stopped, 'still running after 20 s')
  await sleep(800)

  // And once it has finished it is history like anything else, so a second clear
  // takes it — which is also the ordinary case working as it always did.
  await page.keyboard.press('Control+Shift+K')
  await sleep(1000)
  check(
    'and clears it once it has finished',
    (await blocks(page)).length === 0,
    JSON.stringify((await blocks(page)).map((b) => b.command))
  )

  /*
   * --- a block says where it ran, when that is not where the last one ran -------
   *
   * Warp prints the directory over every command, which is the right information —
   * scrolled back, a block otherwise cannot say where it happened, and the status
   * bar only ever knows about now. Printing it every time spends a line on an
   * answer that is usually identical to the one above, so it is shown where it
   * changes, which is where it is news.
   */
  await run(page, 'New-Item -ItemType Directory -Force inner | Out-Null')
  await run(page, 'cd inner')
  await run(page, 'echo moved-here')
  const wheres = await page.evaluate(() =>
    [...document.querySelectorAll('.block__where')].map((e) => e.textContent ?? '')
  )
  check(
    'the directory is named when a command runs somewhere new',
    wheres.some((w) => w.endsWith('inner')),
    JSON.stringify(wheres)
  )
  check(
    'and not again for the next command in the same place',
    wheres.filter((w) => w.endsWith('inner')).length === 1,
    JSON.stringify(wheres)
  )
  await run(page, 'cd ..')
  await page.keyboard.press('Control+Shift+K')
  await sleep(1200)

  await run(page, 'echo first-command-here')
  await run(page, 'echo second-command-here')
  await run(page, 'Get-Item .\definitely-not-here.txt', 3200)

  const before = await blocks(page)
  check('three commands became three blocks', before.length === 3, JSON.stringify(before.map((b) => b.command)))
  check('the last one failed', before[2]?.failed === true, JSON.stringify(before[2]))
  check('and carries its exit code', (before[2]?.exit ?? '').includes('exit'), before[2]?.exit)

  /*
   * --- the ground reaches the blocks --------------------------------------------
   *
   * The window is painted with one vertical ramp on `.workspace`, and the blocks are
   * meant to sit on it. `.region--shells` was made transparent for exactly that, with
   * a comment saying so — but `.pane`, one level further down, had carried
   * `background: var(--bg)` since the first commit and nobody followed the chain. So
   * the ramp was covered by a flat fill over the whole scrollback, and the only place
   * it ever showed was a thirty-pixel band under the composer.
   *
   * Checked as the chain rather than as one selector, because that is the actual
   * invariant and the actual way it broke: any opaque fill between a block and the
   * ground hides the ground, and it does not matter which element introduces it. A
   * check naming `.pane` would have to be rewritten by whoever breaks it next.
   */
  const covering = await page.evaluate(() => {
    const ground = document.querySelector('.workspace')
    /*
     * Two starting points, because the scrollback is not the only thing standing on
     * the ground: the overview ruler is a twelve-pixel column down the right of the
     * same scroll area, and it was the last opaque one — invisible while the pane
     * was flat too, a seam the moment the ground came through.
     */
    const starts = [document.querySelector('.block'), document.querySelector('.ruler')]
    if (!ground || starts.some((el) => el === null)) return null
    const opaque = []
    for (const start of starts) {
      for (let el = start; el && el !== ground; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor
        // rgba(...,0) and the keyword transparent both resolve to this.
        if (bg && bg !== 'rgba(0, 0, 0, 0)') opaque.push(`${el.className || el.tagName}: ${bg}`)
      }
    }
    return opaque
  })
  /*
   * Null, not empty, when there was nothing to walk. The first version of this ran
   * straight after Ctrl+Shift+K, found no block to start from, walked nothing and
   * reported a clean chain — it passed with the covering fill still in place, which
   * is the only way a check like this can be wrong.
   */
  check('there is a block and a ruler to look at', covering !== null, String(covering))
  check(
    'nothing standing on the ground paints over it',
    covering !== null && covering.length === 0,
    JSON.stringify(covering)
  )


  // The session file has to land before the window goes, or the panes themselves
  // will not come back and the blocks would have nowhere to be.
  await sleep(2500)
  const unclosed = await closeApp(app)
  if (unclosed) failures.push(`the launch that kept a session: ${unclosed}`)
  await sleep(1200)
}

// --- and it is still there afterwards ----------------------------------------
{
  const started = Date.now()
  const app = await launch()
  const page = await app.firstWindow()
  await watchRunning(app)
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

  /*
   * --- clearing means clearing the screen -----------------------------------
   *
   * It used to mean deleting the pane's rows from the history database, which is
   * one fair reading of the word and the wrong reading of the key: Ctrl+L is a
   * reflex, people press it to tidy up, and nothing brought the blocks back. So
   * what is checked here is both halves — the pane empties, the notice says how
   * many went and offers them back, and Undo is taken up on that offer.
   */
  await page.click('.pane__scroll')
  const beforeClear = (await blocks(page)).length
  await page.keyboard.press('Control+Shift+K')
  await sleep(1200)
  check('Ctrl+Shift+K empties the pane', (await blocks(page)).length === 0, JSON.stringify(await blocks(page)))
  const cleared = await page.evaluate(
    () => document.querySelector('.notice, .notice__text')?.textContent ?? ''
  )
  check(
    'and says how many it took',
    /Cleared [0-9]+ blocks?/.test(cleared),
    JSON.stringify(cleared.slice(0, 60))
  )
  const undo = page.locator('.notice button', { hasText: 'Undo' }).first()
  check('and offers them back', (await undo.count()) === 1, cleared.slice(0, 60))
  if ((await undo.count()) === 1) {
    await undo.click()
    await sleep(1000)
    check(
      'which puts every one of them back',
      (await blocks(page)).length === beforeClear,
      `${(await blocks(page)).length} of ${beforeClear}`
    )
  }

  // Cleared again, for the relaunch below: what a clear hides has to stay hidden.
  await page.keyboard.press('Control+Shift+K')
  await sleep(1200)
  check('and clears again', (await blocks(page)).length === 0, JSON.stringify(await blocks(page)))

  await sleep(2500)
  const unclosed = await closeApp(app)
  if (unclosed) failures.push(`the relaunch that cleared it: ${unclosed}`)
  await sleep(1200)
}

// --- what was cleared does not come back -------------------------------------
{
  const app = await launch()
  const page = await app.firstWindow()
  await watchRunning(app)
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4000)

  const after = await blocks(page)
  check('a cleared pane comes back empty', after.length === 0, JSON.stringify(after.map((b) => b.command)))
  const mark = await page.evaluate(() => document.querySelectorAll('.blocks__mark').length)
  check('with nothing to mark', mark === 0, `${mark} marks`)

  /*
   * --- a command now, and an exchange from before ----------------------------
   *
   * Questions stream into the Claude panel these days, so inline conversation
   * blocks are something installs already carry rather than something the
   * composer makes. The command runs here; the exchange is planted next launch
   * through the same write path the app persists conversations by, stamped a
   * minute EARLIER — so the database holds them in the wrong order on purpose,
   * and a restore that reads rows by write order returns them backwards.
   */
  await run(page, 'echo after-the-question')

  await sleep(2500)
  const unclosed = await closeApp(app)
  if (unclosed) failures.push(`the launch that checked what was cleared: ${unclosed}`)
  await sleep(1200)
}

// --- plant the exchange, dated before the command ------------------------------
{
  const raw = JSON.parse(fs.readFileSync(path.join(liveUserData, 'session.json'), 'utf8'))
  const snap = raw.version === 2 ? raw.windows[0].snapshot : raw
  const paneId = snap.panes.find((entry) => entry.kind === 'terminal')?.id
  const app = await launch()
  const page = await app.firstWindow()
  await watchRunning(app)
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(3000)
  await page.evaluate(
    ({ paneId }) =>
      window.ember.saveBlock(paneId, {
        kind: 'conversation',
        id: 'planted-conversation',
        prompt: 'find all log files',
        answer: 'Every log file sits under logs/.',
        error: null,
        proposal: {
          command: 'Get-ChildItem -Recurse *.log',
          note: '',
          destructive: false,
          // A verdict recorded rather than open, so the restore has something
          // to get wrong: open would come back holding a Run button.
          state: 'dismissed'
        },
        attached: [],
        startedAt: Date.now() - 60_000,
        collapsed: false
      }),
    { paneId }
  )
  await sleep(1000)
  const unclosed = await closeApp(app)
  if (unclosed) failures.push(`the launch that planted the exchange: ${unclosed}`)
  await sleep(1200)
}

// --- and the exchange comes back where it happened ---------------------------
{
  const app = await launch()
  const page = await app.firstWindow()
  await watchRunning(app)
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4000)

  const back = await timeline(page)
  check('both came back', back.length === 2, JSON.stringify(back))
  check(
    'the question is still a question',
    back[0]?.kind === 'agent' && back[0]?.text.includes('find all log files'),
    JSON.stringify(back[0])
  )
  // The regression this ordering exists for: by the order the rows were written,
  // the command comes first. By the order the two things happened, it does not.
  check(
    'and it is still before the command that followed it',
    back[1]?.kind === 'command' && back[1]?.text.includes('after-the-question'),
    JSON.stringify(back)
  )

  const agent = page.locator('.block--agent').first()
  check(
    'the answer came back with it',
    ((await agent.locator('.block__answer').textContent()) ?? '').includes('log file'),
    await agent.locator('.block__answer').textContent()
  )
  check(
    'as did the command it offered',
    ((await agent.locator('.proposal__body').textContent()) ?? '').includes('Get-ChildItem'),
    await agent.locator('.proposal__body').textContent()
  )
  /*
   * The safety half. A proposal is the one restored thing that carries an action,
   * so it has to come back holding the answer it was given — a dismissed command
   * that reopens with a Run button is a restore that asks to do something the user
   * already said no to.
   */
  check(
    'a dismissed proposal comes back dismissed',
    ((await agent.locator('.proposal__state').textContent()) ?? '').trim() === 'Dismissed',
    await agent.locator('.proposal__state').textContent().catch(() => null)
  )
  check(
    'with nothing left to press',
    (await agent.locator('.proposal__primary').count()) === 0
  )
  await page.screenshot({ path: path.join(SHOT_DIR, '71-blocks-conversation.png') })

  const unclosed = await closeApp(app)
  if (unclosed) failures.push(`the last launch: ${unclosed}`)
  await sleep(600)
}

server.close()
auditProfileDir(userData)
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('blocks across restarts:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
