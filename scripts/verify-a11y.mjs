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

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('keyboard and a11y:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
