// An install moved to the new default model, once. Run: node scripts/verify-migrate.mjs
//
// Opus 5.5 replaced Opus 5 as the default. A default reaches only new installs, so
// existing ones on Opus 5 are moved — and told — on their first launch after the
// change, and never again: somebody who picks Opus 5 back keeps it.
//
// Two launches on one profile: the first finds Opus 5 saved and must move it and
// say so; the second finds Opus 5 chosen afterwards and must leave it alone.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('migrate')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const settingsFile = path.join(profile.dir, 'settings.json')

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const errors = []

const launch = async () => {
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })
  const page = await app.firstWindow()
  await watchRunning(app)
  await placeTopRight(app)
  page.on('pageerror', (e) => errors.push(e.message))
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  await sleep(1500)
  return { app, page }
}
const noticeOf = (page) => page.locator('.notice__text').textContent({ timeout: 2000 }).catch(() => '')

// An install that saved its settings while Opus 5 was the default.
fs.writeFileSync(settingsFile, JSON.stringify({ aiModel: 'claude-opus-5', firstRunDone: true }, null, 2))

// --- first launch: moved, and told --------------------------------------------
{
  const { app, page } = await launch()
  const model = await page.evaluate(() => window.ember.getSettings().then((s) => s.aiModel))
  check('an install on Opus 5 starts on Opus 5.5', model === 'claude-opus-5-5', model)
  const notice = (await noticeOf(page)) ?? ''
  check('and is told, with the way back', /Opus 5\.5/.test(notice) && /go back to Opus 5/.test(notice), notice)
  const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  check(
    'the move is written down at once, and marked done',
    onDisk.aiModel === 'claude-opus-5-5' && (onDisk.migrations ?? []).includes('default-model-opus-5-5'),
    JSON.stringify({ aiModel: onDisk.aiModel, migrations: onDisk.migrations })
  )
  // And then Opus 5 is chosen back, on purpose.
  await page.evaluate(() => window.ember.setSettings({ aiModel: 'claude-opus-5' }))
  const unclosed = await closeApp(app)
  if (unclosed) failures.push(unclosed)
}

// --- second launch: the choice stands ------------------------------------------
{
  const { app, page } = await launch()
  const model = await page.evaluate(() => window.ember.getSettings().then((s) => s.aiModel))
  check('Opus 5 chosen after the move is kept', model === 'claude-opus-5', model)
  const notice = (await noticeOf(page)) ?? ''
  check('and nothing is said about it again', !/Opus 5\.5/.test(notice), notice)
  const unclosed = await closeApp(app)
  if (unclosed) failures.push(unclosed)
}

profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('model migration:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
