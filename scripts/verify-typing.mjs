// A command typed on the person's behalf reaches a shell only at its prompt.
//
// Five buttons type commands into a terminal: Claude's Run, a block's Run again, a
// script, a history row's `git show`, and the directory picker. Each used to send
// its text to the pty whatever held it — so with `ssh prod` open, Run on Claude's
// `rm -rf node_modules && npm ci` ran it on the server, with python open it went
// into the REPL, and at a password prompt it was sent as the password.
//
// Here a program that writes down everything it is sent holds the terminal, and
// each button is pressed in turn. The program must receive nothing; the person
// must be told why, and offered another terminal, which then really runs it. With
// the program gone, the same buttons run at the prompt as before — so the rule
// refuses what it should and only that.
//
// Run: node scripts/verify-typing.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const profile = newProfile('typing')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, EMBER_FAKE_AI: '1' }
delete env.ELECTRON_RUN_AS_NODE

// A project: a script to press, a commit for the history, and the recorder.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-typing-'))
const heard = path.join(work, 'heard.log')
fs.writeFileSync(
  path.join(work, 'package.json'),
  JSON.stringify(
    {
      name: 'typing-fixture',
      private: true,
      // Printed in two halves: npm echoes a script's source before running it, and
      // only a run that really happened puts the halves together.
      scripts: {
        hello: 'node -e "console.log(\'script-\' + \'ran-here\')"',
        'say hi': 'node -e "console.log(\'spaced-\' + \'script-ran\')"'
      }
    },
    null,
    2
  ),
  'utf8'
)
fs.writeFileSync(
  path.join(work, 'recorder.js'),
  // Everything the terminal sends it, written down as it arrives; it never exits.
  `const fs = require('fs');\nprocess.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(heard)}, d));\nsetInterval(() => {}, 1 << 30);\n`,
  'utf8'
)
const git = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', windowsHide: true }).trim()
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'verify@example.invalid')
git('config', 'user.name', 'Verify')
git('add', '-A')
git('commit', '-qm', 'the only commit')
const heardSoFar = () => (fs.existsSync(heard) ? fs.readFileSync(heard, 'utf8') : '')

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, work],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

/*
 * Trusted, the way somebody trusts a project they opened on purpose.
 *
 * This suite is about which terminal a command reaches and when: it needs the
 * fixture's scripts to really run, and the refusals it checks for are the typing
 * rule's — "not sent, because a program holds that terminal". Workspace trust
 * refuses earlier and for a different reason, so an untrusted fixture here would
 * shadow the very rule this exists to prove and quietly pass for the wrong one.
 */
await page.evaluate((dir) => window.ember.setSettings({ trustedFolders: [dir] }), work)
await sleep(400)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const typeCommand = async (text) => {
  await page.click('.composer__input')
  await page.keyboard.type(text, { delay: 4 })
  await page.keyboard.press('Enter')
}
const notice = () => page.evaluate(() => document.querySelector('.notice')?.textContent?.replace(/\s+/g, ' ').trim() ?? null)
const dismiss = async () => {
  if (await page.locator('.notice__close').count()) await page.locator('.notice__close').click()
  await sleep(300)
}
const blockCommands = () =>
  page.evaluate(() => [...document.querySelectorAll('.block .block__cmd')].map((b) => b.textContent?.trim() ?? ''))
const panes = () => page.locator('.pane[data-integration]').count()
/*
 * Run again on the first block, reached the way a reader reaches it.
 *
 * On the runner this pane is short enough to scroll, and the first block has gone
 * up out of view by the time it is pressed. Playwright brings a button into view
 * by setting the scroll position, which since d83ec58 the pane rightly does not
 * take as the reader leaving the end: measured there, the press went down on Run
 * again at scrollTop 11, focus moving to the button put the pane back on the end
 * at 61, and the release landed on the time beside it — so the click went to the
 * scroller and nothing was pressed at all. A person scrolls up with the wheel,
 * which is a gesture the pane honours; so does this.
 */
const runAgain = async () => {
  const block = page.locator('.block', { hasText: 'echo first-block' }).first()
  const scroller = block.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " pane__scroll ")][1]')
  await scroller.hover()
  await page.mouse.wheel(0, -5000)
  await sleep(300)
  await block.hover()
  await block.locator('button[title="Run again"]').click()
}

// --- something to run again, and something Claude proposed ------------------------
await typeCommand('echo first-block')
await sleep(2000)
await page.keyboard.press('Control+Shift+B')
await sleep(500)
await page.locator('.agent__input').click()
await page.keyboard.type('run-echo please', { delay: 3 })
await page.keyboard.press('Enter')
await page.waitForSelector('.agent__card .agent__code', { timeout: 20_000 })
await sleep(800)

// --- a program takes the terminal ---------------------------------------------------
await typeCommand('node recorder.js')
await sleep(2500)
check('the recorder is running, and has heard nothing yet', heardSoFar() === '', JSON.stringify(heardSoFar()))

// Run again, on the block from before.
await runAgain()
await sleep(1200)
check('Run again sends nothing into the program', heardSoFar() === '', JSON.stringify(heardSoFar()))
const rerunSaid = await notice()
check('and says why', /not sent/i.test(rerunSaid ?? '') && /running/i.test(rerunSaid ?? ''), String(rerunSaid))
check('and offers another terminal', /new terminal/i.test(rerunSaid ?? ''), String(rerunSaid))
// The refusal and the busy card, together on one screen.
await page.screenshot({ path: path.join(SHOT_DIR, '85-typing-refused.png') })
await dismiss()

// Claude's Run.
const card = page.locator('.agent__card', { hasText: 'panel-ran-this' }).last()
const cardSays = await card.textContent()
check('Claude’s card says where it would run, and why it will not now', /running/i.test(cardSays ?? ''), cardSays)
const runButton = card.locator('.btn', { hasText: /^Run$/ })
if ((await runButton.count()) > 0 && (await runButton.isEnabled())) await runButton.click()
await sleep(1200)
check('Claude’s Run sends nothing into the program', heardSoFar() === '', JSON.stringify(heardSoFar()))

// A script, from the Run view.
await page.click('.activity__item[data-view="run"]')
await page.waitForSelector('.scripts__item', { timeout: 10_000 })
await page.locator('.scripts__item', { hasText: 'hello' }).first().click()
await sleep(1200)
check('a script sends nothing into the program', heardSoFar() === '', JSON.stringify(heardSoFar()))
const scriptSaid = await notice()
check('and says why', /not sent/i.test(scriptSaid ?? ''), String(scriptSaid))

// And from that notice, another terminal — where it really runs.
const before = await panes()
const elsewhere = page.locator('.notice button', { hasText: /new terminal/i })
check('the notice offers another terminal', (await elsewhere.count()) === 1)
if ((await elsewhere.count()) === 1) {
  await elsewhere.click()
  check(
    'another terminal opens beside it',
    await (async () => {
      for (let i = 0; i < 60; i++) {
        if ((await panes()) > before) return true
        await sleep(250)
      }
      return false
    })(),
    `${before} → ${await panes()}`
  )
  const ranThere = await (async () => {
    for (let i = 0; i < 80; i++) {
      const text = await page.evaluate(() => document.body.innerText)
      if (text.includes('script-ran-here')) return true
      await sleep(250)
    }
    return false
  })()
  check('and the script runs there, at its prompt', ranThere)
  check('while the program still has heard nothing', heardSoFar() === '', JSON.stringify(heardSoFar()))
}
await dismiss()

// A history row's git show.
await page.click('.activity__item[data-view="scm"]')
await page.waitForSelector('.scm', { timeout: 10_000 })
await page.locator('.scm__section-toggle', { hasText: 'History' }).click()
await sleep(1500)
// The terminal the row types into is the tab's own first one, where the program is.
const firstPane = page.locator('.pane[data-integration]').first()
await firstPane.click({ position: { x: 20, y: 20 } }).catch(() => {})
await sleep(300)
const row = page.locator('.log__row', { hasText: 'the only commit' }).first()
check('the history lists the commit', (await row.count()) === 1)
if ((await row.count()) === 1) {
  await row.click()
  await sleep(1200)
  check('a history row sends nothing into the program', heardSoFar() === '', JSON.stringify(heardSoFar()))
  check('and says why', /not sent/i.test((await notice()) ?? ''), String(await notice()))
}
await dismiss()

// --- sending into the program on purpose ------------------------------------------------
// The second click a refusal offers, for a program that reads lines. What it sends is
// that program's input: it reaches the program, and it is not a command of the
// shell's, so it opens no block of its own — one that no prompt would ever close.
await page.keyboard.press('Control+Shift+I')
await sleep(800)
const blocksBefore = (await blockCommands()).length
await runAgain()
await sleep(800)
const anyway = page.locator('.notice button', { hasText: /anyway/i })
check('a refusal offers sending it to the program anyway', (await anyway.count()) === 1)
if ((await anyway.count()) === 1) await anyway.click()
await sleep(1500)
check('which the program then hears', heardSoFar().includes('echo first-block'), JSON.stringify(heardSoFar()))
check('as its input, with no block of its own', (await blockCommands()).length === blocksBefore, JSON.stringify(await blockCommands()))
const deliberate = heardSoFar()

// --- the program gone, the same buttons run at the prompt ------------------------------
await page.locator('.pane[data-integration]').first().locator('.composer__input').click()
await page.keyboard.press('Control+C')
await sleep(2000)
const runsBefore = (await blockCommands()).filter((c) => c === 'echo first-block').length
await runAgain()
await sleep(2200)
check(
  'at the prompt, Run again runs',
  (await blockCommands()).filter((c) => c === 'echo first-block').length > runsBefore,
  JSON.stringify(await blockCommands())
)

// And a script whose name needs quoting arrives as one name.
await page.click('.activity__item[data-view="run"]')
await page.waitForSelector('.scripts__item', { timeout: 10_000 })
await page.locator('.scripts__item', { hasText: 'say hi' }).first().click()
const spaced = await (async () => {
  for (let i = 0; i < 80; i++) {
    const text = await page.evaluate(() => document.body.innerText)
    if (text.includes('spaced-script-ran')) return true
    await sleep(250)
  }
  return false
})()
check('a script called “say hi” runs as that one script', spaced, JSON.stringify(await blockCommands()))
check(
  'and the recorder heard nothing but the line sent to it on purpose',
  heardSoFar() === deliberate,
  JSON.stringify(heardSoFar())
)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('typing into terminals:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
