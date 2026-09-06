// The Direction D chrome: the title bar, and the session list that took the tabs.
//
// The tab strip left the title bar for the side slot, where each session has room
// to say where it stands and on which branch — and the strip's clipped dropdown
// became an ordinary menu under the list's + button. The title bar kept the parts
// that are about the window rather than about any one session: the side-slot
// toggle, the search, the mode switch, the panel toggle, the caption buttons.
//
// Run: node scripts/verify-titlebar.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('titlebar')
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
const cards = () => page.locator('.sessions__card').count()

const profiles = await page.evaluate(() => window.ember.listProfiles())

// --- the title bar carries the window's own controls --------------------------
const bar = await page.evaluate(() => ({
  toggle: document.querySelectorAll('.titlebar__icon').length,
  togglePressed: document.querySelector('.titlebar__icon')?.getAttribute('aria-pressed') ?? null,
  search: document.querySelectorAll('.titlebar__searchbox').length,
  searchLabel: document.querySelector('.titlebar__searchbox')?.getAttribute('aria-label') ?? '',
  splits: document.querySelectorAll('.titlebar__split').length,
  mode: document.querySelector('.titlebar__mode')?.textContent?.trim() ?? null,
  tabsInBar: document.querySelectorAll('.titlebar .sessions__card, .titlebar [role="tab"]').length
}))
check('the side-slot toggle is there and reports open', bar.toggle === 1 && bar.togglePressed === 'true', JSON.stringify(bar))
check('the search is there and named', bar.search === 1 && bar.searchLabel.length > 0, JSON.stringify(bar))
// One region toggle now: the panel. The side slot has its own button at the left
// edge, and a third icon quietly reappearing would leave this loop checking less.
check('exactly the one region toggle remains', bar.splits === 1, `${bar.splits} toggles`)
check('the mode switch offers the IDE', bar.mode === 'IDE', bar.mode)
check('and no tabs live in the title bar any more', bar.tabsInBar === 0, `${bar.tabsInBar}`)

// --- the search opens the global palette --------------------------------------
await page.click('.titlebar__searchbox')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
const globalPick = await page.evaluate(() => ({
  placeholder: document.querySelector('.qp__box')?.getAttribute('placeholder') ?? '',
  sessionEntries: Array.from(document.querySelectorAll('.qp__detail')).filter(
    (d) => d.textContent === 'session'
  ).length
}))
check(
  'clicking it opens the everything search',
  /sessions/i.test(globalPick.placeholder),
  globalPick.placeholder
)
check('with the open sessions listed', globalPick.sessionEntries >= 1, `${globalPick.sessionEntries}`)
await page.keyboard.press('Escape')
await sleep(400)
check('and Escape puts it away', (await page.locator('.qp__box').count()) === 0)

// --- the session list stands in the side slot ---------------------------------
check('one session, one card', (await cards()) === 1, `${await cards()} cards`)

if (profiles.length > 1) {
  // With several shells the + offers a menu. It hangs inside the sidebar now, so
  // there is no scrolling strip left to clip it out of existence.
  await page.click('.sessions__new')
  await sleep(500)
  const entry = page.locator('.sessions__menu .titlebar__menu-item').first()
  check('the profile menu is visible', (await entry.count()) > 0 && (await entry.isVisible()))
  if (await entry.count()) {
    await entry.click()
    await sleep(1500)
  }
} else {
  await page.click('.sessions__new')
  await sleep(1200)
}
check('choosing a shell opens a card', (await cards()) === 2, `${await cards()} cards`)

if (profiles.length > 1) {
  await page.click('.sessions__new')
  await sleep(400)
  check('the menu reopens', (await page.locator('.sessions__menu .titlebar__menu-item').count()) > 0)
  await page.keyboard.press('Escape')
  await sleep(400)
  check('Escape closes it', (await page.locator('.sessions__menu').count()) === 0)
  await page.click('.sessions__new')
  await sleep(400)
  await page.locator('.pane').first().click({ position: { x: 60, y: 60 } })
  await sleep(400)
  check('and so does clicking away from it', (await page.locator('.sessions__menu').count()) === 0)
}

// --- the cards switch, filter, and close --------------------------------------
await page.locator('.sessions__card').first().click()
await sleep(600)
const onFirst = await page.evaluate(
  () => document.querySelector('.sessions__card')?.getAttribute('aria-selected') ?? null
)
check('clicking a card makes it the session', onFirst === 'true', String(onFirst))

// --- a card can be named by hand ---------------------------------------------
await page.locator('.sessions__card').first().locator('.sessions__name').dblclick()
await sleep(300)
check('double-click opens the rename box', (await page.locator('.sessions__rename').count()) === 1)
await page.locator('.sessions__rename').fill('build watch')
await page.keyboard.press('Enter')
await sleep(400)
const cardName = await page
  .locator('.sessions__card')
  .first()
  .locator('.sessions__name')
  .textContent()
check('and the name sticks to the card', cardName === 'build watch', String(cardName))
// The snapshot writer debounces; the name must be in the file it writes, or a
// restart would quietly hand the card back to the shell.
await sleep(2600)
const snapshot = fs.readFileSync(path.join(profile.dir, 'session.json'), 'utf8')
check('the name reaches the session file', snapshot.includes('"build watch"'))
await page.locator('.sessions__card').first().locator('.sessions__name').dblclick()
await sleep(300)
await page.locator('.sessions__rename').fill('')
await page.keyboard.press('Enter')
await sleep(400)
const derived = await page
  .locator('.sessions__card')
  .first()
  .locator('.sessions__name')
  .textContent()
check('an empty rename hands naming back', (derived ?? '').length > 0 && derived !== 'build watch', String(derived))

// --- the cards reorder by drag -------------------------------------------------
// Synthetic drag events rather than mouse choreography: the handlers are what is
// under test, and a DataTransfer-carrying sequence is exactly what a real drag
// delivers to them without the flake of pixel paths.
const orderBefore = await page.evaluate(() =>
  [...document.querySelectorAll('.sessions__name')].map((n) => n.textContent)
)
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.sessions__card')]
  const dt = new DataTransfer()
  cards[1].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }))
  cards[0].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }))
  cards[0].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }))
  cards[1].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }))
})
await sleep(500)
const orderAfter = await page.evaluate(() =>
  [...document.querySelectorAll('.sessions__name')].map((n) => n.textContent)
)
check(
  'dragging the second card onto the first swaps them',
  orderAfter.length === 2 &&
    orderAfter[0] === orderBefore[1] &&
    orderAfter[1] === orderBefore[0],
  JSON.stringify({ before: orderBefore, after: orderAfter })
)

await page.locator('.sessions__search').fill('definitely-nothing-is-called-this')
await sleep(400)
check('a filter that matches nothing empties the list', (await cards()) === 0, `${await cards()}`)
check(
  'and says so',
  (await page.locator('.sessions__none').count()) === 1
)
await page.locator('.sessions__search').fill('')
await sleep(400)
check('clearing it brings the cards back', (await cards()) === 2, `${await cards()}`)

// Closing goes through the ✕, which only shows itself on the pointed-at card.
await page.locator('.sessions__card').nth(1).hover()
await sleep(300)
await page.locator('.sessions__card').nth(1).locator('.sessions__close').click()
await sleep(900)
check('the ✕ closes a session', (await cards()) === 1, `${await cards()} cards`)

// --- the slot toggles, and the button tells the truth about it -----------------
await page.keyboard.press('Control+b')
await sleep(500)
const hidden = await page.evaluate(() => ({
  sessions: document.querySelectorAll('.sessions').length,
  pressed: document.querySelector('.titlebar__icon')?.getAttribute('aria-pressed') ?? null
}))
check('Ctrl+B puts the list away', hidden.sessions === 0, JSON.stringify(hidden))
check('and the toggle reports closed', hidden.pressed === 'false', JSON.stringify(hidden))
await page.keyboard.press('Control+b')
await sleep(500)
check('and brings it back', (await page.locator('.sessions').count()) === 1)

// --- the window controls can be named ----------------------------------------
const named = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.caption-btn')).map((b) => b.getAttribute('aria-label'))
)
check(
  'the window buttons have accessible names',
  named.length >= 3 && named.every((n) => (n ?? '').length > 0),
  JSON.stringify(named)
)

/*
 * --- every rule has an element, every exemption has a control -------------------
 *
 * Read from the source rather than from the window, because what is being looked
 * for is a rule that draws nothing — and a rule that draws nothing is, by
 * definition, invisible to anything that inspects the page.
 */
const cssRaw = fs.readFileSync(path.join(APP_DIR, 'src/renderer/src/styles/global.css'), 'utf8')
// Comments stripped first: this file explains its own deletions by name, and a
// class named in prose is not a rule that draws anything.
const css = cssRaw.replace(/\/\*[\s\S]*?\*\//g, '')
const tsx = []
;(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walk(full)
    else if (e.name.endsWith('.tsx')) tsx.push(fs.readFileSync(full, 'utf8'))
  }
})(path.join(APP_DIR, 'src/renderer/src'))
const markup = tsx.join('\n')
const titlebarClasses = [...new Set([...css.matchAll(/\.(titlebar__[a-z-]+)/g)].map((m) => m[1]))]
const orphans = titlebarClasses.filter((c) => !markup.includes(c))
check('every title-bar rule has an element to be about', orphans.length === 0, orphans.join(', '))

/*
 * And the bar is a named region. It is the first eight tab stops of the window and
 * was the only strip of chrome here without a name — the rail is a toolbar, the
 * session list a tablist.
 */
const landmark = await page.evaluate(() => {
  const bar = document.querySelector('.titlebar')
  return bar ? bar.tagName.toLowerCase() : null
})
check('and the bar is a landmark rather than an anonymous div', landmark === 'header', String(landmark))

/*
 * --- the bar stops saying what the palette is about to say ----------------------
 *
 * The label was, word for word, the placeholder of the input it opens — a sentence
 * whose only reader is somebody who has not pressed it yet, replaced on screen by
 * itself the instant they do. In an app whose whole hint system is built on
 * retiring legends, that one was news for zero seconds.
 *
 * And the thing it could say that IS news, it could not: the everything-search had
 * no chord at all. It was reachable from one mouse target in an app otherwise
 * driven from the keyboard, while files and commands both had one.
 */
const searchLabel = await page.evaluate(() => {
  const box = document.querySelector('.titlebar__searchbox')
  return {
    text: box?.textContent?.trim() ?? '',
    shortcut: box?.getAttribute('aria-keyshortcuts') ?? null,
    cap: box?.querySelector('kbd')?.textContent?.trim() ?? null
  }
})
check(
  'the bar does not repeat the palette placeholder',
  !searchLabel.text.includes('Search sessions, files, commands'),
  JSON.stringify(searchLabel)
)
check('and names the chord instead', searchLabel.cap === 'Ctrl+Shift+A', JSON.stringify(searchLabel))
check(
  'and says so to a screen reader as well',
  searchLabel.shortcut === 'Control+Shift+A',
  JSON.stringify(searchLabel)
)

/*
 * And the chord opens it. A label naming a key that does nothing is worse than the
 * placeholder it replaced.
 */
await page.keyboard.press('Control+Shift+A')
await sleep(900)
check(
  'the chord opens the everything-search',
  (await page.locator('.qp').count()) > 0,
  `${await page.locator('.qp').count()} palettes open`
)
await page.keyboard.press('Escape')
await sleep(500)
/*
 * And the cap retires, because it is a legend like every other in this app: the
 * chord that has just been pressed no longer needs advertising.
 */
const capAfter = await page.evaluate(
  () => document.querySelector('.titlebar__searchbox kbd')?.textContent ?? null
)
check('and the cap goes once the chord has been used', capAfter === null, String(capAfter))

/*
 * --- a toggle says whether it is on, and keeps saying it under the pointer ------
 *
 * The panel toggle's whole pressed indicator was `color: var(--fg)` — the one
 * property its own hover already sets, and hover outranks a bare modifier on
 * specificity besides — so open-and-hovered and closed-and-hovered computed
 * identically in colour, background and border. It said nothing at the exact
 * moment somebody was deciding whether to press it. The slot toggle had no pressed
 * rule at all: its entire state was a rect at 25% opacity inside the glyph.
 *
 * Hovering is half the check. Comparing the two resting states alone would pass
 * for a build whose pressed state is still erased the moment it is pointed at,
 * which is what shipped.
 */
const toggleState = async (selector) => {
  const read = () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel)
      if (!el) return null
      const c = getComputedStyle(el)
      return {
        pressed: el.getAttribute('aria-pressed'),
        /*
         * Kept apart from the attribute on purpose. The first version compared
         * whole objects that included `pressed`, so the two states differed on the
         * attribute rather than on anything drawn — and the check passed for a
         * build with no pressed styling at all, which is exactly what shipped.
         */
        paint: [c.color, c.backgroundColor, c.borderTopColor].join(' | ')
      }
    }, selector)
  /*
   * The pointer goes away first. Clicking a toggle leaves the mouse on it, so a
   * "resting" reading taken straight afterwards is a hovered one — which made the
   * resting state report the hover fill and the check argue with itself.
   */
  await page.mouse.move(4, 400)
  await sleep(250)
  const rest = await read()
  await page.locator(selector).hover()
  await sleep(350)
  const hovered = await read()
  await page.mouse.move(4, 400)
  await sleep(250)
  return { rest, hovered }
}

const slotFirst = await toggleState('.titlebar__icon')
await page.locator('.titlebar__icon').click()
await sleep(700)
const slotThen = await toggleState('.titlebar__icon')
check(
  'the slot toggle reports two different states',
  slotFirst.rest?.pressed !== slotThen.rest?.pressed,
  JSON.stringify({ a: slotFirst.rest?.pressed, b: slotThen.rest?.pressed })
)
/*
 * The pressed one carries a fill. Comparing the two resting paints alone passed on
 * a build with no pressed styling at all — something else about the two states
 * differs by a hair — so this asks for the thing the fill actually is: a tint,
 * where the unpressed state has none.
 */
const pressedPaint = slotFirst.rest?.pressed === 'true' ? slotFirst.rest : slotThen.rest
const restingPaint = slotFirst.rest?.pressed === 'true' ? slotThen.rest : slotFirst.rest
check(
  'the pressed one is tinted and the other is not',
  !/rgba\(0, 0, 0, 0\)/.test(pressedPaint?.paint.split(' | ')[1] ?? '') &&
    /rgba\(0, 0, 0, 0\)/.test(restingPaint?.paint.split(' | ')[1] ?? ''),
  JSON.stringify({ pressed: pressedPaint?.paint, resting: restingPaint?.paint })
)
check(
  'and still looks different while the pointer is on it',
  slotFirst.hovered?.paint !== slotThen.hovered?.paint,
  JSON.stringify({ a: slotFirst.hovered?.paint, b: slotThen.hovered?.paint })
)
// Put the slot back the way it was found.
await page.locator('.titlebar__icon').click()
await sleep(600)

/*
 * --- the window buttons are buttons ---------------------------------------------
 *
 * `.caption-btn` set a width and no height, and the row it sits in inherited the
 * bar's `align-items: center` — so each button was the line box of an 11px glyph,
 * about fifteen pixels tall inside a forty-pixel bar. They were the only controls
 * in this window under the twenty-four pixels the guidelines ask for, and their
 * height changed as the maximize glyph changed shape.
 *
 * And the bar carried ten pixels of padding on its right, so the very corner of a
 * maximized window belonged to `.titlebar`, which is a drag region — the fling into
 * the corner that closes every other Windows program started moving this one
 * instead. The corner is the cheapest target on the screen and it was spent on drag.
 */
const caption = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.caption-btn')]
  if (btns.length === 0) return null
  const last = btns[btns.length - 1].getBoundingClientRect()
  return {
    boxes: btns.map((b) => {
      const r = b.getBoundingClientRect()
      return { w: Math.round(r.width), h: Math.round(r.height) }
    }),
    rightGap: Math.round(window.innerWidth - last.right)
  }
})
check('there are window buttons to measure', caption !== null, String(caption))
if (caption) {
  check(
    'a window button is a target you can hit',
    caption.boxes.every((b) => b.h >= 24 && b.w >= 24),
    JSON.stringify(caption.boxes)
  )
  check(
    'and the last one reaches the window edge',
    caption.rightGap === 0,
    JSON.stringify(caption.rightGap)
  )
}

/*
 * Read from the DOM rather than from a real pointer, which is necessary and not
 * sufficient: a frameless maximized window on Windows can extend its client area
 * past the monitor edge by the width of the resize border, so this proves the
 * markup reaches the corner and not that the pixel is reachable by a mouse.
 */
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
await sleep(900)
const corner = await page.evaluate(() => {
  const el = document.elementFromPoint(window.innerWidth - 1, 0)
  if (!el) return 'nothing'
  return el.closest('.caption-btn--close') ? 'close' : el.className || el.tagName
})
check('the top-right corner of a maximized window closes it', corner === 'close', String(corner))
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
await sleep(600)

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('title bar:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
