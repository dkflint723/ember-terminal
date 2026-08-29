// A shell that dies, and text moving in and out of one.
//
// A pane whose shell exited used to be a dead end: it kept its blocks, said
// `exited 1`, and the only thing left to do with it was close it — which threw the
// blocks away too, and they are the reason to still be looking at it. It restarts
// in place now, in the directory it was standing in, with its history intact.
//
// The clipboard half is about the live terminal rather than the blocks. Output in a
// block is ordinary selectable HTML and always has been; what had no copy or paste
// at all was the terminal itself, which is what a full-screen program is drawing on.
//
// Run: node scripts/verify-shell.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('shell')
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

const run = async (command, settle = 2600) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 6 })
  await page.keyboard.press('Enter')
  await sleep(settle)
}

// --- the one-time welcome ------------------------------------------------------
// A fresh profile is a first run, so the card must be standing before anything
// has been typed — and running the suite's first command below must put it away
// for good, which the settings flag records.
check('a first run opens with the welcome card', (await page.locator('.pane__hello').count()) === 1)

const state = () =>
  page.evaluate(() => ({
    integration: document.querySelector('.pane')?.getAttribute('data-integration') ?? null,
    exited: !!document.querySelector('.composer__badge--warn'),
    restart: document.querySelectorAll('[data-restart="shell"]').length,
    blocks: document.querySelectorAll('.pane__scroll .block').length,
    text: (document.querySelector('.pane__scroll')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    // The newest block's OUTPUT, not the pane's text: submitting a command adds a
    // block carrying the command line whether or not a shell ever ran it, so the
    // pane's text says nothing about whether anything is alive down there.
    lastBody: (() => {
      const all = document.querySelectorAll('.pane__scroll .block')
      return (all[all.length - 1]?.querySelector('.block__body')?.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
    })()
  }))

// --- something worth not losing ----------------------------------------------
await run('echo before-the-shell-died')
const alive = await state()
check('the shell is up', alive.integration === 'ready', alive.integration)
check('with a block in it', alive.blocks >= 1, `${alive.blocks}`)
check('and nothing offering to restart it', alive.restart === 0, `${alive.restart}`)

// Running something says "I know this is a terminal": the card must be gone,
// and gone permanently — the flag is what stops it returning next launch.
check('the first command puts the welcome away', (await page.locator('.pane__hello').count()) === 0)
const firstRun = await page.evaluate(() => window.ember.getSettings().then((s) => s.firstRunDone))
check('and records that for future launches', firstRun === true, String(firstRun))

// --- and the shell goes -------------------------------------------------------
await run('exit', 4000)
const dead = await state()
check('the pane notices the shell exited', dead.exited === true, JSON.stringify(dead))
check('and offers to start another', dead.restart === 1, `${dead.restart}`)
check('while keeping what was run in it', dead.text.includes('before-the-shell-died'), dead.text.slice(0, 80))

// --- restarting is not a new pane ---------------------------------------------
await page.locator('[data-restart="shell"]').click()
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)
const back = await state()
// The badge rather than the integration attribute: that attribute is still `ready`
// from the shell that died, so it says nothing about the one that replaced it.
check('restarting clears the exited state', back.exited === false, JSON.stringify(back))
check('and so is the restart button', back.restart === 0, `${back.restart}`)
check(
  'the blocks from before are still there',
  back.text.includes('before-the-shell-died'),
  back.text.slice(0, 80)
)

// The point of restarting rather than reopening: it has to actually take input.
await run('echo after-the-restart')
const working = await state()
check(
  'and the new shell runs commands',
  working.lastBody.includes('after-the-restart'),
  JSON.stringify(working.lastBody)
)

/*
 * --- the clipboard is reachable from the renderer -------------------------------
 *
 * Pasting needs to READ the clipboard, which a sandboxed renderer may not do — the
 * permission is not granted and a paste that depends on a prompt is not a paste. It
 * goes through main instead, and this is the check that the path exists and answers,
 * which is the part that silently would not.
 */
const roundTrip = await page.evaluate(async () => {
  const sample = `clip-${Date.now()}`
  await navigator.clipboard.writeText(sample)
  const read = await window.ember.clipboardRead()
  return { sample, read, same: read === sample }
})
check('the clipboard can be read back through main', roundTrip.same, JSON.stringify(roundTrip))

/*
 * --- finding something in the output --------------------------------------------
 *
 * The blocks are the whole history of a shell, and Ctrl+F — which is what everyone
 * presses — did nothing at all, so the only way through them was to scroll. The
 * matches are painted with a CSS highlight rather than by wrapping the text, so
 * this checks the count the bar reports rather than looking for marks in the DOM:
 * there are none to look for, which is the point.
 */
await run('1..40 | ForEach-Object { "needle-$_ in the haystack" }', 3200)
await page.click('.composer__input')
await page.keyboard.press('Control+f')
await sleep(700)
check('Ctrl+F opens a find bar', (await page.locator('.find__input').count()) === 1)

await page.locator('.find__input').fill('needle-4')
await sleep(700)
const one = await page.locator('.find__count').textContent()
// needle-4 and needle-40: two matches, and the count says which one is in front.
check('it counts what it found', /of 2$/.test((one ?? '').trim()), String(one))
check('starting at the first', /^1 of/.test((one ?? '').trim()), String(one))

await page.locator('.find__input').press('Enter')
await sleep(500)
const two = await page.locator('.find__count').textContent()
check('Enter steps to the next match', /^2 of/.test((two ?? '').trim()), String(two))

await page.locator('.find__input').fill('definitely-not-in-this-pane')
await sleep(700)
const none = await page.locator('.find__count').textContent()
check('and says so when there is nothing', (none ?? '').includes('no matches'), String(none))

await page.locator('.find__input').press('Escape')
await sleep(500)
check('Escape closes it', (await page.locator('.find__input').count()) === 0)

/*
 * --- walking the directory from the path -----------------------------------------
 *
 * The bar said where the shell was standing and offered nothing to do about it, so
 * getting four levels down meant typing the path or leaning on Tab. Clicking the
 * path opens the directory it names; picking a folder walks into it and closing on
 * one takes the shell there — as a real `cd`, because the shell owns the directory
 * and a label that disagreed with it would be worse than no label.
 */
// Somewhere known, so the entries below are this repository's rather than whatever
// the home directory happens to hold.
await run(`cd "${APP_DIR}"`, 3000)
await page.click('[data-status="cwd"]')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
check('the path opens a directory browser', (await page.locator('.qp__box').count()) === 1)

const listed = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.qp__item')).map((i) => (i.textContent ?? '').trim())
)
check('listing what is in the directory', listed.length > 1, JSON.stringify(listed.slice(0, 6)))
check('with a way back up', listed.some((l) => l.startsWith('..')), JSON.stringify(listed.slice(0, 3)))

// `src` exists in this repo, which is the directory the app was launched in.
await page.locator('.qp__box').fill('scripts')
await sleep(600)
await page.keyboard.press('Enter')
await sleep(800)
const walked = await page.evaluate(
  () => document.querySelector('.qp__box')?.getAttribute('placeholder') ?? ''
)
check('picking a folder walks into it', /scripts/.test(walked), walked)

await page.keyboard.press('Escape')
await sleep(2600)
const moved = await page.evaluate(
  () => document.querySelector('[data-status="cwd"]')?.getAttribute('title') ?? ''
)
check('and closing there moves the shell', /scripts/.test(moved), moved.slice(0, 60))

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('shell lifecycle:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
