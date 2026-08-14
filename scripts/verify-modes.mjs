// Terminal mode and IDE mode.
//
// The app is a terminal that becomes an IDE on a keystroke, and both modes are the
// same session seen differently. The thing most worth proving is that the switch
// costs nothing: terminals are bound to a DOM node, so a layout that moved them by
// rendering them elsewhere would unmount xterm and take the pty, the scrollback and
// the block history with it. The regions stay put and CSS grid moves them instead,
// and the check for that is a command run before the switch still being there after
// two of them.
//
// Run: node scripts/verify-modes.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('modes')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-modes-'))
fs.writeFileSync(
  path.join(work, 'geometry.ts'),
  'export interface Point {\n  x: number\n  y: number\n}\n\nexport const origin: Point = { x: 0, y: 0 }\n',
  'utf8'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

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
const BENIGN = [/foldingRange failed/]
page.on('pageerror', (e) => {
  if (BENIGN.some((re) => re.test(e.message))) return
  // Reported as it happens, not only in the summary: an error that tears the
  // renderer down makes every later check fail for reasons of its own, and the
  // summary then describes the wreckage rather than the cause.
  console.log('!! page error:', e.message.split('\n')[0])
  errors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 45_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const view = () =>
  page.evaluate(() => ({
    mode: document.querySelector('.workspace')?.getAttribute('data-mode'),
    shells: document.querySelectorAll('.region--shells .pane').length,
    editors: document.querySelectorAll('.region--editors .pane.editor').length,
    claude: document.querySelectorAll('.region--secondary .claude').length,
    panelBar: document.querySelectorAll('.panel__bar').length,
    blocks: document.querySelectorAll('.block').length
  }))

// --- it starts as a terminal -------------------------------------------------
await page.click('.composer__input')
await page.keyboard.type('echo mode-marker-one')
await page.keyboard.press('Enter')
await sleep(2500)

const start = await view()
check('it opens as a terminal', start.mode === 'terminal', JSON.stringify(start))
check('with no IDE furniture', start.panelBar === 0 && start.editors === 0, JSON.stringify(start))
check('and a shell that ran something', start.blocks >= 1, JSON.stringify(start))

// --- one key makes it an IDE -------------------------------------------------
await page.keyboard.press('Control+Shift+I')
await sleep(1500)
const ide = await view()
check('Ctrl+Shift+I turns it into an IDE', ide.mode === 'ide', JSON.stringify(ide))
check('the panel appears', ide.panelBar === 1, JSON.stringify(ide))
check('and the shell is in it', ide.shells >= 1, JSON.stringify(ide))
check('carrying its blocks across', ide.blocks === start.blocks, `${start.blocks} → ${ide.blocks}`)

// --- files open in the middle ------------------------------------------------
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('geometry')
await sleep(900)
await page.keyboard.press('Enter')
await sleep(3500)
const opened = await view()
check('a file opens in the editor area', opened.editors === 1, JSON.stringify(opened))
check('and the shell stays in the panel', opened.shells >= 1, JSON.stringify(opened))

// --- Claude on the right ------------------------------------------------------
await page.keyboard.press('Control+Shift+B')
await sleep(1200)
check('Ctrl+Shift+B opens Claude', (await view()).claude === 1)
await page.keyboard.press('Control+Shift+B')
await sleep(900)
check('and closes it again', (await view()).claude === 0)

// --- the panel toggles --------------------------------------------------------
await page.keyboard.press('Control+j')
await sleep(900)
check(
  'Ctrl+J hides the panel',
  (await page.locator('.region--shells[data-collapsed="true"]').count()) === 1
)
await page.keyboard.press('Control+j')
await sleep(900)
const reopened = await view()
console.log('after Ctrl+J twice →', JSON.stringify(reopened))
check(
  'and brings it back',
  (await page.locator('.region--shells[data-collapsed="false"]').count()) === 1,
  JSON.stringify(reopened)
)

// --- the panel's other views --------------------------------------------------
await page.locator('.panel__tab', { hasText: 'Problems' }).click()
await sleep(1000)
check('the panel can show problems', (await page.locator('.panel__overlay').count()) === 1)
await page.locator('.panel__tab', { hasText: 'Terminal' }).click()
await sleep(800)
check('and go back to the terminal', (await page.locator('.panel__overlay').count()) === 0)

/*
 * --- and back, with the shell intact -----------------------------------------
 *
 * The whole point. A terminal that had to be restarted to change layout would be
 * a terminal you could not keep a build running in.
 */
await page.keyboard.press('Control+Shift+I')
await sleep(1500)
const back = await view()
check('Ctrl+Shift+I goes back to the terminal', back.mode === 'terminal', JSON.stringify(back))
check('the blocks survived both switches', back.blocks === start.blocks, JSON.stringify(back))
const stillThere = await page.evaluate(() =>
  document.querySelector('.region--shells')?.textContent?.includes('mode-marker-one')
)
check('and so did the output of the command', stillThere === true)

// The shell must still take input, not merely look like it does.
await page.click('.composer__input')
await page.keyboard.type('echo mode-marker-two')
await page.keyboard.press('Enter')
await sleep(2500)
const after = await view()
check('the shell still runs commands', after.blocks === start.blocks + 1, JSON.stringify(after))

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('terminal and IDE modes:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
