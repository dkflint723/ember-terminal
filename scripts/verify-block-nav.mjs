// Moving between command blocks from the keyboard, and hearing one.
// Run: node scripts/verify-block-nav.mjs
//
// Blocks turn terminal output into separate things a screen reader could move
// between, and nothing let it: a block was a group with no landmark, and the only
// way to one was Tab through every control of every block before it (audit R30).
//
// What it asks: each block is a region named for its command and how it ended;
// Alt+Up and Alt+Down move between them from the composer and from each other;
// Alt+Shift+Up lands on the last failure; Alt+Shift+R reads the output of the one in
// focus aloud; running out says so; and in the code editor Alt+Up still moves a line.
// (An NVDA walkthrough of the same, by hand, is in the CHANGELOG entry.)
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('blocknav')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-blocknav-')))
fs.writeFileSync(path.join(dir, 'lines.txt'), 'first line\nsecond line\n', 'utf8')

const pageErrors = []
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
await sleep(800)

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
const run = async (command) => {
  const before = await page.locator('.block--done, .block--failed').count()
  await page.locator('.composer__input').first().focus()
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  await waitFor(async () => (await page.locator('.block--done, .block--failed').count()) > before, 15_000)
}
/** The block the focus is in, by its command. */
const focused = () =>
  page.evaluate(() => document.activeElement?.closest('.block')?.querySelector('.block__cmd')?.textContent?.trim() ?? `(${document.activeElement?.className ?? 'nothing'})`)
const heard = () => page.evaluate(() => document.querySelector('[data-block-nav="announcer"]')?.textContent?.trim() ?? '')

await run('Write-Output "block-one"')
await run('cmd /c "echo block-two-failed & exit 3"')
await run('Write-Output "block-three"')

// --- landmarks ------------------------------------------------------------------------
const regions = await page.evaluate(() =>
  [...document.querySelectorAll('.pane [role="region"]')].map((r) => r.getAttribute('aria-label') ?? '')
)
check('each command block is a region', regions.length >= 3, JSON.stringify(regions))
check('named for its command and how it ended', regions.some((r) => r.includes('block-one') && r.includes('succeeded')) && regions.some((r) => r.includes('exit 3') && r.includes('failed')), JSON.stringify(regions))

// --- moving between them --------------------------------------------------------------------
await page.locator('.composer__input').first().focus()
await page.keyboard.press('Alt+ArrowUp')
await sleep(300)
check('Alt+Up from the composer goes to the last command', (await focused()).includes('block-three'), await focused())
await page.keyboard.press('Alt+ArrowUp')
await sleep(300)
check('and again, to the one before', (await focused()).includes('exit 3'), await focused())
await page.keyboard.press('Alt+ArrowDown')
await sleep(300)
check('Alt+Down goes back down', (await focused()).includes('block-three'), await focused())
await page.keyboard.press('Alt+Shift+ArrowUp')
await sleep(300)
check('Alt+Shift+Up goes to the last failure', (await focused()).includes('exit 3'), await focused())
await page.keyboard.press('Alt+Shift+R')
await sleep(400)
check('Alt+Shift+R reads its output aloud', (await heard()).includes('block-two-failed'), await heard())
await page.keyboard.press('Alt+Shift+ArrowUp')
await sleep(300)
check('with no earlier failure, it says so', /No earlier command failed/.test(await heard()), await heard())
for (let i = 0; i < 4; i += 1) await page.keyboard.press('Alt+ArrowUp')
await sleep(300)
check('and at the first command, it says that', /first command/.test(await heard()), await heard())

// --- not in the code editor, where Alt+Up moves a line ----------------------------------------
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('lines.txt')
await sleep(500)
await page.locator('.qp__box').press('Enter')
await waitFor(() => page.evaluate(() => window.monaco?.editor.getEditors().some((e) => e.getModel()?.uri.path.endsWith('/lines.txt'))), 15_000)
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.press('ArrowUp')
await page.keyboard.press('Alt+ArrowUp')
await sleep(400)
const first = await page.evaluate(() => window.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.endsWith('/lines.txt'))?.getModel()?.getLineContent(1))
check('in the code editor Alt+Up still moves the line', first === 'second line', String(first))

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('block navigation:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
