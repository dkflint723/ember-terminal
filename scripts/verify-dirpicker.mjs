// The directory browser on the status bar, through a name with a space in it.
//
// Clicking the path chip opens a walkable picker; Enter walks into a
// directory, Escape closes and takes the shell where the walking ended — as a
// real `cd` in the block list. The name that breaks naive plumbing is one with
// a space: the command must arrive quoted, run clean, and actually move the
// pane.
//
// Run: node scripts/verify-dirpicker.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('dirpicker')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-walk-'))
const spaced = path.join(base, 'has space here')
fs.mkdirSync(spaced)
fs.writeFileSync(path.join(base, 'plain.txt'), 'x', 'utf8')

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

// Stand the shell in the playground first, the ordinary way.
await page.click('.composer__input')
await page.keyboard.type(`cd "${base}"`, { delay: 6 })
await page.keyboard.press('Enter')
await sleep(2600)

// --- the chip opens the walk ----------------------------------------------------
await page.click('.statusbar__path')
await page.waitForSelector('.qp__box', { timeout: 8_000 })
const offered = await page.evaluate(() =>
  [...document.querySelectorAll('.qp__item, .qp__row')].map((r) => r.textContent ?? '')
)
check(
  'the picker lists what is here',
  offered.some((t) => t.includes('has space here')) && offered.some((t) => t.includes('plain.txt')),
  JSON.stringify(offered.slice(0, 6))
)

// --- walk into the spaced directory, then leave through the door ----------------
await page.locator('.qp__box').fill('has space')
await sleep(500)
await page.keyboard.press('Enter')
await sleep(700)
await page.keyboard.press('Escape')
await sleep(2800)

const after = await page.evaluate(() => {
  const blocks = [...document.querySelectorAll('.block .block__cmd')].map(
    (b) => b.textContent ?? ''
  )
  return {
    cd: blocks.find((b) => b.includes('has space here')) ?? '',
    status: [...document.querySelectorAll('.block')].at(-1)?.className ?? '',
    statusbar: document.querySelector('.statusbar__path')?.textContent ?? ''
  }
})
check('closing sends a real cd for the walked-to directory', after.cd.length > 0, JSON.stringify(after))
check('and the path travels quoted, spaces intact', after.cd.includes('"'), after.cd)
check('the command runs clean', after.status.includes('block--done'), after.status)
check(
  'and the shell is actually standing there',
  after.statusbar.toLowerCase().includes('has space here'),
  after.statusbar
)

await app.close()
profile.cleanup()
fs.rmSync(base, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('directory picker:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
