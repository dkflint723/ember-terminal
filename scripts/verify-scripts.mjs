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

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('scripts:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
