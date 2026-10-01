// A project's own environment, offered once and kept.
// Run: node scripts/verify-project-env.mjs
//
// A session in a Python project had to be pointed at its .venv by hand, every time,
// and a .env loaded by hand (audit R32). Now a session starting in a trusted project
// folder is offered what the folder has, once; the answer is kept.
//
// What it asks: in a trusted folder with a .venv and a .env, the offer appears;
// Activate gives the shell both; the line typed holds no value from the .env, and
// neither does history; a block that printed the .env shares its names, not its
// values; and the next session there is activated without being asked.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, seedDirs, workDir } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('projectenv')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const dir = workDir('ember-projectenv-')
fs.mkdirSync(path.join(dir, '.venv', 'Scripts'), { recursive: true })
fs.writeFileSync(path.join(dir, '.venv', 'Scripts', 'Activate.ps1'), "$env:EMBER_VENV_ON = 'yes'\n", 'utf8')
const SECRET = 'dot-secret-' + '41'
fs.writeFileSync(path.join(dir, '.env'), `# for the app\nEMBER_DOTENV_VAL="${SECRET}"\nexport EMBER_OTHER=two\n`, 'utf8')
// Trusted before the first session, as a folder opened on purpose is.
for (const d of seedDirs(profile.dir)) {
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ trustedFolders: [dir], restoreSession: true }), 'utf8')
}

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const waitFor = async (test, ms) => {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (await test()) return true
    await sleep(250)
  }
  return test()
}
const pageErrors = []
const launch = async () => {
  const app = watchPageErrors(
    await electron.launch({
      executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
      args: [APP_DIR, profile.arg, dir],
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
  return { app, page }
}
const ask = async (page, command, marker) => {
  const before = await page.locator('.block--done', { hasText: marker }).count()
  await page.locator('.composer__input').first().focus()
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  await waitFor(async () => (await page.locator('.block--done', { hasText: marker }).count()) > before, 15_000)
  return page.locator('.block--done', { hasText: marker }).last().locator('.block__body').textContent()
}
const probe = 'Write-Output "V[$env:EMBER_VENV_ON]D[$env:EMBER_DOTENV_VAL]O[$env:EMBER_OTHER]"'

// --- the first session: offered, and activated -------------------------------------------
let { app, page } = await launch()
const offered = await waitFor(async () => (await page.locator('.notice', { hasText: '.venv' }).count()) > 0, 20_000)
const offer = await page.evaluate(() => document.querySelector('.notice')?.textContent ?? '')
check('a session in the folder is offered its environment', offered && /\.venv/.test(offer) && /\.env/.test(offer), offer)
if (offered) await page.locator('.notice button', { hasText: 'Activate' }).click()
await sleep(2500)
const after = (await ask(page, probe, 'V[')) ?? ''
check('Activate gives the shell the .venv', after.includes('V[yes]'), after)
check('and the .env, quotes and export taken off', after.includes(`D[${SECRET}]`) && after.includes('O[two]'), after)
const typed = await page.evaluate(() => [...document.querySelectorAll('.block__cmd')].map((b) => b.textContent ?? '').join('\n'))
check('nothing typed holds a value from the .env', !typed.includes(SECRET), typed.slice(0, 300))
// The commands history keeps — the probe's own output prints the value on purpose.
const inHistory = await page.evaluate(async (s) => ((await window.ember.searchHistory({ text: s, limit: 20 })) ?? []).map((h) => h.command ?? ''), SECRET.slice(0, 10))
check('nor does any command history keeps', !inHistory.some((c) => c.includes(SECRET)), JSON.stringify(inHistory))

// --- a block that printed it shares names, not values ------------------------------------------
await ask(page, 'Get-Content .env', 'EMBER_DOTENV_VAL')
const shown = page.locator('.block--done', { hasText: 'EMBER_DOTENV_VAL' }).last()
await shown.locator('button[title^="Copy as Markdown"]').dispatchEvent('click')
await sleep(600)
const shared = await app.evaluate(({ clipboard }) => clipboard.readText())
check('a block that printed the .env shares its names', shared.includes('EMBER_DOTENV_VAL=<withheld>'), shared.slice(0, 200))
check('and none of its values', !shared.includes(SECRET) && !shared.includes('=two'), shared.slice(0, 200))

// --- the next session: activated without asking ------------------------------------------------
const unclosed = await closeApp(app)
if (unclosed) failures.push(`first run: ${unclosed}`)
;({ app, page } = await launch())
await sleep(4000)
const again = (await ask(page, probe, 'V[')) ?? ''
check('the next session in the folder is activated without asking', again.includes('V[yes]') && again.includes(`D[${SECRET}]`), again)
check('and is not asked again', (await page.locator('.notice', { hasText: '.venv' }).count()) === 0)

const unclosed2 = await closeApp(app)
if (unclosed2) failures.push(unclosed2)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('project environments:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
