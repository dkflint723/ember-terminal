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
      { id: 's3', name: 'Twice', command: 'echo {{word}} and {{word}}' }
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

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('scripts:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
