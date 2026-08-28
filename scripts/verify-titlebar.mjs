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

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('title bar:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
