// The directory browser on the status bar, through names that break naive plumbing.
//
// Clicking the path chip opens a walkable picker; Enter walks into a directory, and
// "Move the shell here" takes the shell there — as a real command in the block list.
// Escape leaves the shell where it was: it used to be the move, so the gesture every
// picker means as "never mind" was the one that acted.
//
// The move is typed into a shell, so the path has to arrive as data. It was typed as
// `cd "…"`, and inside double quotes PowerShell expands `$(…)` — so a folder named
// `a$(New-Item marker)b` ran New-Item the moment someone walked into it. And
// PowerShell closes a single-quoted string on ’ too, so `Bob’s Projects` broke the
// one quoter that used single quotes. Both are walked into here, and no marker may
// appear. Last, with a program holding the terminal, the move is not typed into it.
//
// Run: node scripts/verify-dirpicker.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, untilNothingRuns, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('dirpicker')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-walk-'))
const SPACED = 'has space here'
const HOSTILE = 'a$(New-Item marker)b'
const APOSTROPHE = 'Bob’s Projects'
for (const name of [SPACED, HOSTILE, APOSTROPHE]) fs.mkdirSync(path.join(base, name))
fs.writeFileSync(path.join(base, 'plain.txt'), 'x', 'utf8')
fs.writeFileSync(
  path.join(base, 'hold.js'),
  // A program that holds the terminal and writes down anything typed into it.
  `const fs = require('fs');\nprocess.stdin.on('data', (d) => fs.appendFileSync(${JSON.stringify(path.join(base, 'heard.log'))}, d));\nsetInterval(() => {}, 1 << 30);\n`,
  'utf8'
)
// Where an injected New-Item would put its file: wherever the shell was standing.
const marker = () =>
  fs.readdirSync(base, { recursive: true }).some((f) => path.basename(String(f)).toLowerCase() === 'marker')

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg],
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

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const statusPath = () => page.evaluate(() => document.querySelector('.statusbar__path')?.textContent ?? '')
const lastCommand = () =>
  page.evaluate(() => [...document.querySelectorAll('.block .block__cmd')].at(-1)?.textContent?.trim() ?? '')
const within = async (ms, test) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await test()) return true
    await sleep(200)
  }
  return test()
}

// Stand the shell in the playground first, the ordinary way.
await page.click('.composer__input')
await page.keyboard.type(`Set-Location -LiteralPath '${base}'`, { delay: 4 })
await page.keyboard.press('Enter')
await sleep(2600)

const openPicker = async () => {
  await page.click('.statusbar__path')
  await page.waitForSelector('.qp__box', { timeout: 8_000 })
  await sleep(500)
}
/** Walk into a folder of this name; false, and the picker closed, when it is not listed. */
const walkInto = async (name) => {
  await page.locator('.qp__box').fill(name.slice(0, 6))
  await sleep(500)
  const item = page.locator('.qp__item', { hasText: name }).first()
  if ((await item.count()) === 0) {
    check(`the picker lists ${JSON.stringify(name)} to walk into`, false, await statusPath())
    await page.keyboard.press('Escape')
    await sleep(500)
    return false
  }
  await item.click()
  await sleep(700)
  return true
}

// --- the chip opens the walk ----------------------------------------------------
await openPicker()
const offered = await page.evaluate(() =>
  [...document.querySelectorAll('.qp__item, .qp__row')].map((r) => r.textContent ?? '')
)
check(
  'the picker lists what is here',
  offered.some((t) => t.includes(SPACED)) && offered.some((t) => t.includes('plain.txt')),
  JSON.stringify(offered.slice(0, 6))
)
check('and offers no move before anything has been walked', !offered.some((t) => /Move the shell here/.test(t)))

// --- walking, then Escape, moves nothing ------------------------------------------
await walkInto(SPACED)
const commandsBefore = await lastCommand()
await page.keyboard.press('Escape')
await sleep(1800)
check('Escape closes the picker', (await page.locator('.qp__box').count()) === 0)
check('and leaves the shell where it was', !(await statusPath()).includes(SPACED), await statusPath())
check('with nothing typed', (await lastCommand()) === commandsBefore, await lastCommand())

// --- the move, into each name -------------------------------------------------------
for (const name of [SPACED, HOSTILE, APOSTROPHE]) {
  // From the playground each time, wherever the step before left the shell.
  await page.click('.composer__input')
  await page.keyboard.type(`Set-Location -LiteralPath '${base}'`, { delay: 4 })
  await page.keyboard.press('Enter')
  await sleep(2000)
  await openPicker()
  if (!(await walkInto(name))) continue
  const first = await page.evaluate(() => document.querySelector('.qp__item')?.textContent ?? '')
  check(`walking into ${JSON.stringify(name)} offers the move first`, /Move the shell here/.test(first), first)
  await page.keyboard.press('Enter')
  const moved = await within(6000, async () => (await statusPath()).includes(name))
  // A picker still open means Enter did not move anything; it is in the way now.
  if ((await page.locator('.qp__box').count()) > 0) {
    check(`Enter on the move closes the picker`, false)
    await page.keyboard.press('Escape')
    await sleep(800)
  }
  check(`and the shell stands in ${JSON.stringify(name)}`, moved, await statusPath())
  check(`sent as data, not as a command line`, /-LiteralPath '/.test(await lastCommand()), await lastCommand())
  check(`and nothing in ${JSON.stringify(name)} ran`, !marker())
}

// --- and never into a program ----------------------------------------------------------
await page.click('.composer__input')
await page.keyboard.type(`Set-Location -LiteralPath '${base}'`, { delay: 4 })
await page.keyboard.press('Enter')
await sleep(2000)
await page.click('.composer__input')
await page.keyboard.type('node hold.js', { delay: 4 })
await page.keyboard.press('Enter')
await sleep(2500)
await openPicker()
if (await walkInto(SPACED)) {
  await page.keyboard.press('Enter')
  await sleep(1500)
  if ((await page.locator('.qp__box').count()) > 0) {
    await page.keyboard.press('Escape')
    await sleep(800)
  }
}
const heard = fs.existsSync(path.join(base, 'heard.log')) ? fs.readFileSync(path.join(base, 'heard.log'), 'utf8') : ''
check('with a program holding the terminal, the move is not typed into it', heard === '', JSON.stringify(heard))
const said = await page.evaluate(() => document.querySelector('.notice')?.textContent ?? '')
check('and the person is told why', /not sent/i.test(said) && /running/i.test(said), said)

/*
 * The program is ended before the window is closed. It was left holding the
 * terminal, so the close asked whether to end it — and nobody here answers that:
 * every run on the runner sat at the question until the gate killed it at twenty
 * minutes, printing none of the checks above. hold.js leaves Ctrl+C alone, so it
 * goes like any ordinary program; if it does not, the close below says so by name.
 */
await page.locator('.composer__input').first().focus()
await page.keyboard.press('Control+C')
await untilNothingRuns(app, 15_000)
const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(base, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('directory picker:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
