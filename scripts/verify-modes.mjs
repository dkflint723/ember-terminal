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
// The two modes also render the same commands differently — a block apiece with the
// whole window, one continuous stream in the panel, because a hairline and a status
// glyph per command is height taken from the four lines someone is reading down
// there. That, and the button that switches between them, are checked here too: the
// switch used to live on a keystroke and a palette entry alone, so a window that had
// become an IDE stayed one and people restarted the app to get their terminal back.
//
// Run: node scripts/verify-modes.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
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
  page.evaluate(() => {
    const scroll = document.querySelector('.pane__scroll')
    const chevron = document.querySelector('.pane__scroll .block__chevron')
    return {
      mode: document.querySelector('.workspace')?.getAttribute('data-mode'),
      shells: document.querySelectorAll('.region--shells .pane').length,
      editors: document.querySelectorAll('.region--editors .pane.editor').length,
      // Reaching Claude is a composer state now, not a region: there is nothing on
      // the right to count any more.
      asking: document.querySelectorAll('.composer__row--ai').length,
      panelBar: document.querySelectorAll('.panel__bar').length,
      blocks: document.querySelectorAll('.block').length,
      // The button that says what the window is and turns it into the other thing.
      modeButton: document.querySelector('.titlebar__mode')?.textContent?.trim() ?? null,
      // How the commands are drawn: a separator and a chevron apiece, or neither.
      streamed: !!document.querySelector('.pane__scroll--stream'),
      rule: (() => {
        const b = document.querySelector('.pane__scroll .block')
        return b ? getComputedStyle(b).borderBottomWidth : null
      })(),
      chevron: chevron ? getComputedStyle(chevron).display : null,
      scrollback: scroll ? Math.max(0, Math.round(scroll.scrollHeight - scroll.clientHeight)) : null
    }
  })

const run = async (command, settle = 2500) => {
  await page.click('.composer__input')
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await sleep(settle)
}

// --- it starts as a terminal -------------------------------------------------
await run('echo mode-marker-one')

const start = await view()
check('it opens as a terminal', start.mode === 'terminal', JSON.stringify(start))
check('with no IDE furniture', start.panelBar === 0 && start.editors === 0, JSON.stringify(start))
check('and a shell that ran something', start.blocks >= 1, JSON.stringify(start))
// Compared as a number: the window scales CSS pixels, so a 1px rule computes to
// something like 0.83px and a string comparison would fail on the zoom level.
check('commands are separated from each other', parseFloat(start.rule ?? '0') > 0, start.rule)
check('and each one opens', start.chevron !== 'none', start.chevron)
check('the switch offers the other shape', start.modeButton === 'IDE', start.modeButton)
await page.screenshot({ path: path.join(SHOT_DIR, '72-mode-terminal.png') })

// --- one key makes it an IDE -------------------------------------------------
await page.keyboard.press('Control+Shift+I')
await sleep(1500)
const ide = await view()
check('Ctrl+Shift+I turns it into an IDE', ide.mode === 'ide', JSON.stringify(ide))
check('the panel appears', ide.panelBar === 1, JSON.stringify(ide))
check('and the shell is in it', ide.shells >= 1, JSON.stringify(ide))
check('carrying its blocks across', ide.blocks === start.blocks, `${start.blocks} → ${ide.blocks}`)
check('drawn as a stream instead', ide.streamed === true)
check('with the separators gone', parseFloat(ide.rule ?? '1') === 0, ide.rule)
check('and the chevrons with them', ide.chevron === 'none', ide.chevron)
check('the switch now offers the way back', ide.modeButton === 'Terminal', ide.modeButton)

/*
 * The stream has to be a stream: everything that has been run, scrollable.
 *
 * It is drawn from the captured blocks rather than by handing the panel to the live
 * terminal, and this is the check that says why — conpty repaints a small screen
 * instead of scrolling it, so a panel rendered that way holds one screenful and
 * scrolls back to nothing.
 */
await run('1..80 | ForEach-Object { "line $_ in the panel" }', 3600)
const streamed = await view()
check(
  'earlier output is still there to scroll back to',
  (streamed.scrollback ?? 0) > 200,
  `${streamed.scrollback}px of scrollback`
)
const streamText = await page.evaluate(
  () => document.querySelector('.pane__scroll')?.textContent?.replace(/\s+/g, ' ') ?? ''
)
check(
  'including the top of a long run',
  streamText.includes('line 1 in the panel') && streamText.includes('line 80 in the panel'),
  streamText.slice(0, 90)
)
await page.screenshot({ path: path.join(SHOT_DIR, '73-mode-ide-stream.png') })

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

/*
 * --- reaching Claude ----------------------------------------------------------
 *
 * The chord used to open a sidebar on the right; the sidebar is gone and the agent
 * is a block in the list, so it points the active shell's composer at Claude
 * instead. Pressed from here, with an editor focused, which is the case worth
 * proving: the chord has to find a shell to ask from, and this is the only test
 * where the focused pane is not one.
 *
 * It sets asking rather than toggling it, which is the half worth a check of its
 * own. The composer classifies what is typed now, so a chord meaning "ask Claude"
 * that flipped whatever was in effect would take you away from the agent exactly
 * when the buffer already read as a question — and pressing it twice, which is what
 * people do when the first press is not obviously visible, used to undo itself.
 * Ctrl+K is the one that flips a reading, so Ctrl+K is what comes back.
 */
check('nothing is asking to begin with', (await view()).asking === 0)
await page.keyboard.press('Control+Shift+B')
await sleep(1200)
const asked = await view()
check('Ctrl+Shift+B points the composer at Claude', asked.asking === 1, JSON.stringify(asked))
await page.keyboard.press('Control+Shift+B')
await sleep(900)
const again = await view()
check('and pressing it again leaves it pointed there', again.asking === 1, JSON.stringify(again))
await page.keyboard.press('Control+K')
await sleep(900)
const unasked = await view()
check('while Ctrl+K flips it back to the shell', unasked.asking === 0, JSON.stringify(unasked))

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
 * a terminal you could not keep a build running in. Pressed rather than typed this
 * time, since the button is the way most people will find.
 */
await page.click('.titlebar__mode')
await sleep(1500)
const back = await view()
check('the button goes back to the terminal', back.mode === 'terminal', JSON.stringify(back))
check('the blocks survived both switches', back.blocks === streamed.blocks, JSON.stringify(back))
check('with their separators back', parseFloat(back.rule ?? '0') > 0, back.rule)
const stillThere = await page.evaluate(() =>
  document.querySelector('.region--shells')?.textContent?.includes('mode-marker-one')
)
check('and so did the output of the command', stillThere === true)
const panelRun = await page.evaluate(() =>
  document.querySelector('.region--shells')?.textContent?.includes('line 80 in the panel')
)
check('as did everything run while it was a panel', panelRun === true)

// The shell must still take input, not merely look like it does.
await run('echo mode-marker-two')
const after = await view()
check('the shell still runs commands', after.blocks === back.blocks + 1, JSON.stringify(after))
await page.screenshot({ path: path.join(SHOT_DIR, '74-mode-back.png') })

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('terminal and IDE modes:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
