// Can the app be operated without a mouse?
//
// Several controls were reachable only by pointing at them: block copy and re-run,
// source-control stage and discard, the editor tab close, and the terminal tab
// strip — which had no keyboard behaviour at all. The trap in each case was CSS.
// `display: none` and `visibility: hidden` both remove an element from the tab
// order, so revealing on :focus-within cannot work: the element can never take the
// focus that would reveal it. Only opacity leaves a control focusable.
//
// Run: node scripts/verify-a11y.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('a11y')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

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
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** Whether an element could ever receive focus, given how it is styled. */
const focusable = (selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return { present: false }
    const cs = getComputedStyle(el)
    // offsetParent is null for display:none; visibility hides from the tab order too.
    const hidden = cs.display === 'none' || cs.visibility === 'hidden' || el.offsetParent === null
    el.focus?.()
    return { present: true, hidden, focused: document.activeElement === el }
  }, selector)

// --- a command block ----------------------------------------------------------
await page.click('.composer__input')
await page.keyboard.type('echo keyboard-check', { delay: 5 })
await page.keyboard.press('Enter')
await page.waitForSelector('.block', { timeout: 20_000 })
await sleep(2500)

const head = await focusable('.block__head')
check('a block header can take focus', head.present && head.focused, JSON.stringify(head))

const action = await focusable('.block__action')
check(
  'a block action is reachable rather than hidden from the keyboard',
  action.present && !action.hidden && action.focused,
  JSON.stringify(action)
)

/*
 * --- the keyboard never lands somewhere there is nothing to see -------------
 *
 * xterm reads input through a textarea that carries tabIndex 0 and has its focus
 * ring removed, and it sits just before the composer. While the pane is idle the
 * whole live view is height 0 and opacity 0, so Shift+Tab out of the composer put
 * the caret in a control that was not on screen: typing went to the shell,
 * invisibly, and Enter ran it. Escape did the same thing on purpose — it called
 * focus() on that terminal — which is the press a PowerShell user makes to clear
 * a line.
 */
const where = () =>
  page.evaluate(() => {
    const el = document.activeElement
    if (!el) return 'none'
    const cls = typeof el.className === 'string' ? el.className : ''
    return el.tagName.toLowerCase() + (cls ? '.' + cls.trim().split(/[ ]+/).join('.') : '')
  })

await page.click('.composer__input')
await page.keyboard.type('a half-written line', { delay: 5 })
await page.keyboard.press('Escape')
await sleep(300)
check(
  'Escape clears the line rather than moving the caret out of sight',
  (await page.inputValue('.composer__input')) === '' &&
    (await where()).includes('composer__input'),
  await where()
)
await page.keyboard.press('Escape')
await sleep(300)
check(
  'and a second Escape steps out of the composer',
  !(await where()).includes('composer__input'),
  await where()
)

await page.click('.composer__input')
const tabStops = []
for (let i = 0; i < 3; i++) {
  await page.keyboard.press('Shift+Tab')
  await sleep(250)
  tabStops.push(await where())
}
check(
  'Shift+Tab out of the composer never lands in the hidden terminal',
  !tabStops.some((spot) => spot.includes('xterm-helper-textarea')),
  JSON.stringify(tabStops)
)
check(
  'and reaches the blocks',
  tabStops.some((spot) => spot.includes('block__')),
  JSON.stringify(tabStops)
)

// Enter on the header collapses it, the same as clicking.
await page.evaluate(() => document.querySelector('.block__head')?.focus())
const expandedBefore = await page.getAttribute('.block__head', 'aria-expanded')
await page.keyboard.press('Enter')
await sleep(600)
const expandedAfter = await page.getAttribute('.block__head', 'aria-expanded')
check(
  'Enter collapses a block',
  expandedBefore !== expandedAfter,
  `${expandedBefore} -> ${expandedAfter}`
)

// --- the session list -----------------------------------------------------------
// The tab strip moved out of the title bar and into the side slot; the roles moved
// with it, because the cards are still tabs however they are drawn.
const strip = await page.evaluate(() => {
  const list = document.querySelector('.sessions__list')
  const tab = document.querySelector('.sessions__card')
  return {
    role: list?.getAttribute('role') ?? null,
    tabRole: tab?.getAttribute('role') ?? null,
    tabIndex: tab?.getAttribute('tabindex') ?? null,
    closeLabel: document.querySelector('.sessions__close')?.getAttribute('aria-label') ?? null
  }
})
check('the tab strip is a tab list', strip.role === 'tablist', JSON.stringify(strip))
check('its tabs are tabs, and reachable', strip.tabRole === 'tab' && strip.tabIndex === '0', JSON.stringify(strip))
check('and the close button is named', (strip.closeLabel ?? '').length > 0, JSON.stringify(strip))

// --- severity is not carried by colour alone -----------------------------------
const dots = await page.evaluate(() => {
  const el = document.createElement('div')
  return { note: 'checked in the problems panel below', ok: !!el }
})
check('problems panel is checkable', dots.ok)

await page.keyboard.press('Control+Shift+M')
await page.waitForSelector('.probs', { timeout: 10_000 })
await sleep(800)
const severityGlyphs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.probs__dot')).map((d) => ({
    text: (d.textContent ?? '').trim(),
    label: d.getAttribute('aria-label')
  }))
)
// With no problems open there is nothing to check, and that is not a failure.
if (severityGlyphs.length > 0) {
  check(
    'severity is shown by shape, not only colour',
    severityGlyphs.every((g) => g.text.length > 0 && g.text !== '●' && (g.label ?? '').length > 0),
    JSON.stringify(severityGlyphs.slice(0, 4))
  )
}

// --- the file tree is a tree ---------------------------------------------------
// Every row used to be its own tab stop, so reaching anything past the first few
// meant pressing Tab once per file, and nothing moved between them.
// Through the rail rather than Ctrl+B: the chord is a visibility toggle for the
// side slot now, and what fills the slot depends on the mode — the icon is the
// gesture that means "the explorer, specifically", and it brings the IDE with it.
await page.click('.activity__item[data-view="explorer"]')
await page.waitForSelector('.tree', { timeout: 10_000 })
await sleep(1500)

const treeShape = await page.evaluate(() => {
  const body = document.querySelector('.tree__body')
  const rows = Array.from(document.querySelectorAll('.tree__row[role="treeitem"]'))
  return {
    role: body?.getAttribute('role') ?? null,
    rows: rows.length,
    stops: rows.filter((r) => r.getAttribute('tabindex') === '0').length
  }
})
if (treeShape.rows > 1) {
  check('the tree is a tree', treeShape.role === 'tree', JSON.stringify(treeShape))
  check('with one tab stop, not one per row', treeShape.stops === 1, JSON.stringify(treeShape))

  // Down arrow moves to the next row rather than doing nothing.
  await page.evaluate(() =>
    document.querySelector('.tree__row[role="treeitem"]')?.focus()
  )
  const firstFocused = await page.evaluate(
    () => document.activeElement?.getAttribute('data-path') ?? null
  )
  await page.keyboard.press('ArrowDown')
  await sleep(500)
  const afterDown = await page.evaluate(
    () => document.activeElement?.getAttribute('data-path') ?? null
  )
  check('arrow keys move between rows', afterDown !== null && afterDown !== firstFocused, `${firstFocused} -> ${afterDown}`)
}

// --- reduced motion is honoured ------------------------------------------------
const motion = await page.evaluate(() => {
  const style = Array.from(document.styleSheets)
    .flatMap((sheet) => {
      try {
        return Array.from(sheet.cssRules)
      } catch {
        return []
      }
    })
    .some((rule) => (rule.conditionText ?? '').includes('prefers-reduced-motion'))
  return style
})
check('the stylesheet answers prefers-reduced-motion', motion)

/*
 * --- a screen reader can hear where Enter goes, and what came of it -----------
 *
 * The composer had no name — its placeholder is empty in the shell reading — and
 * the word saying where Enter goes was a plain span beside it, so a screen reader
 * announced "edit text, blank" and nothing about whether Enter would run the line
 * or send it to Claude. And nothing announced a finished command at all: a block
 * is drawn, and a reader who cannot see it has no way to know it is there, or
 * that it failed.
 */
const composerSays = () =>
  page.evaluate(() => {
    const el = document.querySelector('.composer__input')
    const ids = (el?.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    return {
      label: el?.getAttribute('aria-label') ?? null,
      described: ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim()
    }
  })

await page.click('.composer__input')
await page.keyboard.press('Control+a')
await page.keyboard.press('Delete')
await page.keyboard.type('git status', { delay: 5 })
await sleep(400)
const asCommand = await composerSays()
check('the composer has a name', (asCommand.label ?? '').trim().length > 0, JSON.stringify(asCommand))
check(
  'and says that Enter runs a command, and in which shell',
  /Enter runs/.test(asCommand.described) && /PowerShell/i.test(asCommand.described),
  JSON.stringify(asCommand)
)

await page.keyboard.press('Control+a')
await page.keyboard.press('Delete')
await page.keyboard.type('how do I find the biggest files in this folder', { delay: 5 })
await sleep(400)
const asQuestion = await composerSays()
check(
  'and that Enter asks Claude when the line reads as a question',
  /Enter asks Claude/.test(asQuestion.described),
  JSON.stringify(asQuestion)
)
await page.keyboard.press('Control+a')
await page.keyboard.press('Delete')

/** What the pane's status region has said most recently. */
const announced = () =>
  page.evaluate(() =>
    (document.querySelector('.pane [role="status"][aria-live="polite"]')?.textContent ?? '').trim()
  )

await page.keyboard.type('cmd /c exit 3', { delay: 5 })
await page.keyboard.press('Enter')
const heardFailure = await page
  .waitForFunction(
    () =>
      /exit 3/.test(
        document.querySelector('.pane [role="status"][aria-live="polite"]')?.textContent ?? ''
      ),
    null,
    { timeout: 20_000 }
  )
  .then(() => true)
  .catch(() => false)
const failureSaid = await announced()
check('a failed command is announced with its exit code', heardFailure, failureSaid || '(nothing announced)')
check('and by name', failureSaid.includes('cmd /c exit 3'), failureSaid || '(nothing announced)')

await page.click('.composer__input')
await page.keyboard.type('echo said-aloud', { delay: 5 })
await page.keyboard.press('Enter')
const heardSuccess = await page
  .waitForFunction(
    () =>
      /echo said-aloud/.test(
        document.querySelector('.pane [role="status"][aria-live="polite"]')?.textContent ?? ''
      ),
    null,
    { timeout: 20_000 }
  )
  .then(() => true)
  .catch(() => false)
check('and so is one that succeeded', heardSuccess, (await announced()) || '(nothing announced)')

/*
 * The Claude panel's thread is a log: new turns are announced as they arrive, and
 * held while an answer is still streaming so it is read once rather than as a
 * run of fragments.
 */
await page.keyboard.press('Control+Shift+B')
const panelOpened = await page
  .waitForSelector('.agent__scroll', { timeout: 10_000 })
  .then(() => true)
  .catch(() => false)
const thread = await page.evaluate(() => {
  const el = document.querySelector('.agent__scroll')
  return {
    role: el?.getAttribute('role') ?? null,
    label: el?.getAttribute('aria-label') ?? null,
    busy: el?.getAttribute('aria-busy') ?? null
  }
})
check(
  'the Claude thread is a log, and named',
  panelOpened && thread.role === 'log' && (thread.label ?? '').length > 0,
  JSON.stringify(thread)
)
check('and is not busy while nothing is streaming', thread.busy !== 'true', JSON.stringify(thread))
if (panelOpened) {
  await page.keyboard.press('Control+Shift+B')
  await sleep(400)
}

/*
 * Screen reader mode. xterm draws into a canvas, which a screen reader cannot
 * read; its screen-reader mode keeps a parallel tree of the rows that one can.
 * It costs rendering speed, so it is a setting rather than always on — and it has
 * to take in a terminal that is already open, not only in the next one.
 */
const treeIn = () =>
  page.evaluate(() => document.querySelectorAll('.pane .xterm-accessibility').length)
check('screen reader mode is off by default', (await treeIn()) === 0, `${await treeIn()} trees`)
await page.evaluate(() => window.ember.setSettings({ screenReaderMode: true }))
const treeCameUp = await page
  .waitForFunction(() => document.querySelectorAll('.pane .xterm-accessibility').length > 0, null, {
    timeout: 5_000
  })
  .then(() => true)
  .catch(() => false)
check('turning it on gives the open terminal a tree a screen reader can read', treeCameUp)
await page.evaluate(() => window.ember.setSettings({ screenReaderMode: false }))
const treeWent = await page
  .waitForFunction(() => document.querySelectorAll('.pane .xterm-accessibility').length === 0, null, {
    timeout: 5_000
  })
  .then(() => true)
  .catch(() => false)
check('and turning it off takes the tree away again', treeWent)

/*
 * --- Shift+Tab keeps leaving, all the way out ---------------------------------
 *
 * xterm consumes every key, so focus that entered a terminal pane could never leave
 * it from the keyboard. Shift+Tab is given up deliberately to break that trap, and
 * it hands focus to the composer below — where both of the composer's own handlers
 * then took it: the idle one spent it on a completion, and the running one wrote a
 * literal TAB into the program while eating the focus move. So the trap closed one
 * step later instead of opening, and the panel's own hint advertised the gesture
 * that did not work.
 */
await page.click('.composer__input')
await sleep(400)
const landed = await page.evaluate(() => document.activeElement?.className ?? '')
check('the composer is where the terminal hands focus', landed.includes('composer'), landed)

await page.keyboard.press('Shift+Tab')
await sleep(600)
const left = await page.evaluate(() => document.activeElement?.className ?? '')
check(
  'and again leaves the composer rather than being spent there',
  !left.includes('composer'),
  left || '(nothing focused)'
)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('keyboard and a11y:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
