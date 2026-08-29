// Closed documents park their models; the lot holds twenty; eviction is real.
//
// Models outlive their tabs so a reopened file keeps its undo history — but
// that used to have no horizon, and every file ever opened held its buffer for
// the life of the window. This opens twenty-two files, closes twenty-one, and
// checks the exact contract: the last twenty closed are still warm, the first
// one closed is genuinely gone, and reopening it simply works cold.
//
// Run: node scripts/verify-models.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('models')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-models-'))
const names = []
for (let i = 0; i < 22; i++) {
  const name = `mod${String(i).padStart(2, '0')}.ts`
  names.push(name)
  fs.writeFileSync(path.join(work, name), `export const value${i} = ${i}\n`, 'utf8')
}

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, ...names.map((n) => path.join(work, n))],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const openTabs = () => page.locator('.etab').count()
const modelNames = () =>
  page.evaluate(() =>
    window.monaco.editor
      .getModels()
      .map((m) => m.uri.path.split('/').pop())
      .filter((n) => n?.startsWith('mod'))
      .sort()
  )

check('all twenty-two files opened', (await openTabs()) === 22, `${await openTabs()} tabs`)

// Close the first twenty-one, oldest first: mod00 is the first into the lot
// and therefore the one the twenty-first arrival must push out.
for (let i = 0; i < 21; i++) {
  // The ✕ only exists to the pointer while its tab is hovered — so hover it,
  // the way the hand this stands in for would have to.
  const first = page.locator('.etab').first()
  await first.hover()
  await sleep(80)
  await first.locator('.etab__close').click()
  await sleep(150)
}
await sleep(800)

check('one tab remains open', (await openTabs()) === 1, `${await openTabs()}`)
const kept = await modelNames()
check(
  'the last twenty closed are still warm, plus the open one',
  kept.length === 21,
  `${kept.length}: ${kept.join(',')}`
)
check('the first one closed was evicted', !kept.includes('mod00.ts'), kept.join(','))
check('the most recently closed is warm', kept.includes('mod20.ts'), kept.join(','))

// Reopening the evicted file is an ordinary cold open, not an error.
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('mod00')
await sleep(600)
await page.keyboard.press('Enter')
await sleep(1500)
const crumbs = await page.evaluate(
  () => document.querySelector('.editor__crumbs')?.textContent ?? ''
)
check('the evicted file reopens cold', crumbs.includes('mod00.ts'), crumbs)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('model parking:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
