// The project's own commands, one press from running.
//
// Every editor this competes with has this view and every terminal it competes
// with has the neighbouring idea — VS Code calls them tasks, Warp calls them
// workflows — and Ember had neither: the way to run a project's build was to
// remember its name and type it.
//
// Two things have to be true for the view to be worth having. It must read the
// scripts the project actually declares, and it must invoke them the way the
// project is actually set up — running `npm run build` inside a pnpm workspace is
// how you end up with a second, disagreeing node_modules. So the lockfile decides,
// and that is checked against a fixture rather than against this repo, which only
// ever exercises the npm branch.
//
// Run: node scripts/verify-scripts.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('scripts')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// A throwaway project that declares scripts and commits a pnpm lockfile.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-scripts-'))
fs.writeFileSync(
  path.join(work, 'package.json'),
  JSON.stringify({ name: 'fixture', scripts: { build: 'echo building', lint: 'echo linting' } }, null, 2)
)
fs.writeFileSync(path.join(work, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2000)

// The view lives in the side slot, which is the IDE's.
await page.keyboard.press('Control+Shift+I')
await sleep(1200)
await page.keyboard.press('Control+Shift+R')
await sleep(1800)

check(
  'the chord opens the scripts view',
  (await page.evaluate(() => document.querySelector('.sidebar')?.getAttribute('data-view'))) === 'run'
)
check(
  'and the activity bar offers it too',
  (await page.locator('.activity__item[data-view="run"]').count()) === 1
)

const items = await page.evaluate(() =>
  [...document.querySelectorAll('.scripts__item')].map((e) => ({
    name: e.querySelector('.scripts__name')?.textContent ?? '',
    cmd: e.querySelector('.scripts__cmd')?.textContent ?? '',
    title: e.getAttribute('title') ?? ''
  }))
)
check('it lists the scripts the project declares', items.length === 2, JSON.stringify(items))
check(
  'by name',
  items.map((i) => i.name).join(',') === 'build,lint',
  JSON.stringify(items.map((i) => i.name))
)
check(
  'and says what each one actually runs',
  items[0]?.cmd === 'echo building',
  JSON.stringify(items[0])
)

/*
 * The lockfile, not the habit. This fixture commits pnpm-lock.yaml and no
 * package-lock.json, so anything that reaches for npm here is guessing.
 */
check(
  'the lockfile decides how they are invoked',
  items[0]?.title === 'Run: pnpm run build',
  items[0]?.title
)

// --- and pressing one runs it where every other command runs ------------------
await page.locator('.scripts__item', { hasText: 'build' }).first().click()
await sleep(3500)

const ran = await page.evaluate(() => ({
  commands: [...document.querySelectorAll('.block__cmd')].map((e) => e.textContent),
  bodies: [...document.querySelectorAll('.block__body')].map((e) => e.textContent ?? '')
}))
check(
  'a press opens a block for it',
  ran.commands.some((c) => c === 'pnpm run build'),
  JSON.stringify(ran.commands.slice(-3))
)

/*
 * --- commands the person saved, as against the ones the project declares -------
 *
 * The neighbour of the list above: that is whatever package.json holds, and this
 * is whatever the user keeps. They share a view because they answer the same
 * question — what do I run here — and they are told apart by a heading rather
 * than by living somewhere else.
 */
await page.evaluate(() =>
  window.ember.setSettings({
    savedCommands: [
      { id: 's1', name: 'Say hello', command: 'echo hello-there' },
      { id: 's2', name: 'Greet', command: 'echo hello {{who}}' },
      { id: 's3', name: 'Twice', command: 'echo {{word}} and {{word}}' },
      { id: 's4', name: 'Pair', command: 'echo {{first}} then {{second}}' }
    ]
  })
)
await sleep(1200)

const heads = await page.evaluate(() =>
  [...document.querySelectorAll('.scripts__head')].map((e) => e.textContent)
)
check('the two kinds are told apart', heads.join('|') === 'Saved|This project', JSON.stringify(heads))

// One with nothing to fill in runs straight away.
await page.locator('.scripts__item', { hasText: 'Say hello' }).first().click()
await sleep(3000)
let saidSoFar = await page.evaluate(() =>
  [...document.querySelectorAll('.block__cmd')].map((e) => e.textContent)
)
check('a saved command with no holes just runs', saidSoFar.includes('echo hello-there'), JSON.stringify(saidSoFar.slice(-2)))

/*
 * One with a hole asks first, and nothing reaches the shell until it is answered.
 * Abandoning it half-way must run nothing at all: a command with `{{who}}` still
 * in it is not one anybody meant to send.
 */
await page.locator('.scripts__item', { hasText: 'Greet' }).first().click()
await page.waitForSelector('.qp', { timeout: 8_000 })
check(
  'a hole is asked about by name',
  (await page.evaluate(() => document.querySelector('.qp input')?.placeholder)) === 'who?',
  await page.evaluate(() => document.querySelector('.qp input')?.placeholder)
)

await page.keyboard.press('Escape')
await sleep(1500)
saidSoFar = await page.evaluate(() => [...document.querySelectorAll('.block__cmd')].map((e) => e.textContent))
check(
  'and abandoning the question runs nothing',
  !saidSoFar.some((c) => c.includes('{{') || c === 'echo hello'),
  JSON.stringify(saidSoFar.slice(-2))
)

await page.locator('.scripts__item', { hasText: 'Greet' }).first().click()
await page.waitForSelector('.qp', { timeout: 8_000 })
await page.keyboard.type('world', { delay: 40 })
await sleep(500)
await page.keyboard.press('Enter')
await sleep(3000)
saidSoFar = await page.evaluate(() => [...document.querySelectorAll('.block__cmd')].map((e) => e.textContent))
check('an answered hole is filled in', saidSoFar.includes('echo hello world'), JSON.stringify(saidSoFar.slice(-2)))

// A name used twice is asked once, and filled everywhere.
await page.locator('.scripts__item', { hasText: 'Twice' }).first().click()
await page.waitForSelector('.qp', { timeout: 8_000 })
await page.keyboard.type('echo-me', { delay: 40 })
await sleep(500)
await page.keyboard.press('Enter')
await sleep(3000)
saidSoFar = await page.evaluate(() => [...document.querySelectorAll('.block__cmd')].map((e) => e.textContent))
check(
  'a hole named twice is asked once and filled in both places',
  saidSoFar.includes('echo echo-me and echo-me'),
  JSON.stringify(saidSoFar.slice(-2))
)

/*
 * Two different holes, answered one after the other.
 *
 * The question is asked by the same box each time — one component, re-rendered
 * with the next hole's name rather than replaced — so what was typed for the
 * first hole was still sitting in it when the second was asked, offered as
 * "Use as second", and one press of Enter away from being the answer to a
 * question it was never typed for.
 */
await page.locator('.scripts__item', { hasText: 'Pair' }).first().click()
await page.waitForSelector('.qp', { timeout: 8_000 })
await page.keyboard.type('one', { delay: 40 })
await sleep(400)
await page.keyboard.press('Enter')
await sleep(700)

check(
  'the second hole is asked about by its own name',
  (await page.evaluate(() => document.querySelector('.qp input')?.placeholder)) === 'second?',
  await page.evaluate(() => document.querySelector('.qp input')?.placeholder)
)
check(
  'and asks it on an empty box, not the previous answer',
  (await page.evaluate(() => document.querySelector('.qp input')?.value)) === '',
  JSON.stringify(await page.evaluate(() => document.querySelector('.qp input')?.value))
)

await page.keyboard.type('two', { delay: 40 })
await sleep(400)
await page.keyboard.press('Enter')
await sleep(3000)
saidSoFar = await page.evaluate(() => [...document.querySelectorAll('.block__cmd')].map((e) => e.textContent))
check(
  'so each hole gets the answer meant for it',
  saidSoFar.includes('echo one then two'),
  JSON.stringify(saidSoFar.slice(-2))
)

/*
 * And it runs in the session you are looking at.
 *
 * `panes` is one record for the whole window, so the fallback for "the active
 * pane is not a terminal" searched all of them and found the oldest — normally
 * the first tab's. The Scripts view lives in the IDE sidebar, where the active
 * pane is an editor whenever a file is open, so that fallback was the ordinary
 * path: the build ran in another tab's shell, in another directory, in scrollback
 * nobody was watching.
 */
await page.keyboard.press('Control+Shift+T')
await sleep(3500)
await page.keyboard.press('Control+P')
await sleep(600)
await page.keyboard.type('package.json', { delay: 30 })
await page.waitForFunction(() => document.querySelectorAll('.qp__label').length > 0, { timeout: 20_000 })
await sleep(300)
await page.keyboard.press('Enter')
await sleep(2500)

// The chord toggles, and the view may already be up from an earlier case.
if ((await page.locator('.scripts').count()) === 0) {
  await page.keyboard.press('Control+Shift+R')
  await sleep(1500)
}
await page.waitForSelector('.scripts__item', { timeout: 15_000 })
await page.locator('.scripts__item', { hasText: 'lint' }).first().click()
await sleep(3500)

const hereNow = await page.evaluate(() =>
  [...document.querySelectorAll('.block__cmd')].map((e) => e.textContent ?? '')
)
check(
  'a script runs in the session that is on screen',
  hereNow.some((c) => c.includes('pnpm run lint')),
  JSON.stringify(hereNow.slice(-3))
)

await app.close()

/*
 * Two more projects, each in its own run, because the lockfile is read once when
 * the tree root is set.
 *
 * `bun.lockb` is a binary format. Existence used to be probed by reading the file
 * through the editor's loader, which refuses a binary one outright — so it never
 * matched, and every Bun project fell through to npm: the exact "second,
 * disagreeing node_modules" the list exists to prevent, arrived at silently.
 *
 * And yarn's row emitted the bare shorthand, which only reaches a script when its
 * name is not one of yarn's own commands. A project declaring a `version` script
 * got yarn's release command — a version bump, a commit and a tag.
 */
for (const fixture of [
  {
    lock: 'bun.lockb',
    bytes: Buffer.from([0x62, 0x75, 0x6e, 0x00, 0x00, 0x13, 0x00, 0x07]),
    script: 'build',
    expect: 'Run: bun run build'
  },
  { lock: 'yarn.lock', bytes: '# yarn lockfile v1\n', script: 'version', expect: 'Run: yarn run version' }
]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-lock-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { [fixture.script]: 'echo hi' } }, null, 2)
  )
  fs.writeFileSync(path.join(dir, fixture.lock), fixture.bytes)

  const own = newProfile(`lock-${fixture.lock}`)
  const second = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, own.arg, dir],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })
  const other = await second.firstWindow()
  await other.waitForSelector('.pane', { timeout: 40_000 })
  await sleep(2500)
  await other.keyboard.press('Control+Shift+R')
  await sleep(2500)
  const titles = await other.evaluate(() =>
    [...document.querySelectorAll('.scripts__item')].map((e) => e.getAttribute('title') ?? '')
  )
  check(
    `a ${fixture.lock} project is run the way that lockfile says`,
    titles.includes(fixture.expect),
    JSON.stringify({ titles, wanted: fixture.expect })
  )
  await second.close()
  own.cleanup()
  fs.rmSync(dir, { recursive: true, force: true })
}

profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('scripts:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
