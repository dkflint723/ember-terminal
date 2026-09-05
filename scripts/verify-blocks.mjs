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

// --- a session worth keeping -------------------------------------------------
{
  const app = await launch([work])
  const page = await app.firstWindow()
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
  await page.click('.composer__input')
  await page.keyboard.type('Start-Sleep -Seconds 8', { delay: 8 })
  await page.keyboard.press('Enter')
  // Waited for rather than slept through: a fixed pause here is a race with how
  // long the shell takes to start the command, and clearing before it has begun
  // tests nothing at all.
  await page.waitForSelector('.block--running', { timeout: 20_000 })
  await sleep(400)
  await page.keyboard.press('Control+Shift+K')
  await sleep(1200)
  check(
    'clearing the screen keeps the command still running in it',
    (await page.locator('.block--running').count()) === 1,
    `${await page.locator('.block--running').count()} running blocks`
  )
  check(
    'so the keyboard still belongs to the program',
    (await page.locator('.composer__badge--warn').count()) === 1,
    `${await page.locator('.composer__badge--warn').count()} running panels`
  )
  while ((await page.locator('.block--running').count()) > 0) await sleep(500)
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
  await app.close()
  await sleep(1200)
}

// --- plant the exchange, dated before the command ------------------------------
{
  const raw = JSON.parse(fs.readFileSync(path.join(userData, 'session.json'), 'utf8'))
  const snap = raw.version === 2 ? raw.windows[0].snapshot : raw
  const paneId = snap.panes.find((entry) => entry.kind === 'terminal')?.id
  const app = await launch()
  const page = await app.firstWindow()
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
  await app.close()
  await sleep(1200)
}

// --- and the exchange comes back where it happened ---------------------------
{
  const app = await launch()
  const page = await app.firstWindow()
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

  await app.close()
  await sleep(600)
}

server.close()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('blocks across restarts:', failures.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 ? 0 : 1)
