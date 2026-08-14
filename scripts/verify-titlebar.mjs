// The title bar: opening a tab, and the menu that does it.
//
// The new-tab button was dead for anyone with more than one shell installed. The
// menu rendered, then the tab strip clipped it out of existence — a strip that
// scrolls in one axis clips in both — so the button appeared to do nothing at all.
// Nothing here was tested, which is how it survived.
//
// Run: node scripts/verify-titlebar.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
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
const tabCount = () => page.locator('.tab').count()

const profiles = await page.evaluate(() => window.ember.listProfiles())
const before = await tabCount()

// --- the new-tab button sits with the tabs ------------------------------------
// The strip used to grow to fill the window, which left + stranded in the middle
// of the title bar with empty space on both sides of it.
const placement = await page.evaluate(() => {
  const tabs = Array.from(document.querySelectorAll('.tab'))
  const last = tabs[tabs.length - 1]?.getBoundingClientRect()
  const plus = document.querySelector('.titlebar__new')?.getBoundingClientRect()
  return last && plus ? { gap: Math.round(plus.left - last.right), width: window.innerWidth } : null
})
check(
  'the new-tab button sits beside the last tab',
  placement !== null && placement.gap >= 0 && placement.gap < 40,
  JSON.stringify(placement)
)

// --- the button opens a tab --------------------------------------------------
await page.locator('.titlebar__new').click()
await sleep(700)

if (profiles.length > 1) {
  // With several shells it offers a menu. Playwright will only click something
  // visible and hit-testable, so this failing is the clipped menu coming back.
  const entry = page.locator('.titlebar__newwrap .block__action').first()
  check('the profile menu is visible', (await entry.count()) > 0 && (await entry.isVisible()))
  if (await entry.count()) {
    await entry.click()
    await sleep(1500)
  }
} else {
  await sleep(1000)
}

check('choosing a shell opens a tab', (await tabCount()) === before + 1, `${before} -> ${await tabCount()}`)

// --- the menu can be dismissed ------------------------------------------------
if (profiles.length > 1) {
  await page.locator('.titlebar__new').click()
  await sleep(500)
  check('the menu reopens', (await page.locator('.titlebar__newwrap .block__action').count()) > 0)

  await page.keyboard.press('Escape')
  await sleep(500)
  check(
    'Escape closes it',
    (await page.locator('.titlebar__newwrap .block__action').count()) === 0
  )

  await page.locator('.titlebar__new').click()
  await sleep(500)
  await page.locator('.pane').first().click({ position: { x: 60, y: 60 } })
  await sleep(500)
  check(
    'and so does clicking away from it',
    (await page.locator('.titlebar__newwrap .block__action').count()) === 0
  )
}

// --- the split controls ------------------------------------------------------
// Left and right are only worth two buttons if they land on different sides, so
// the geometry is measured rather than the pane count trusted.
const paneBoxes = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.pane')).map((p) => {
      const r = p.getBoundingClientRect()
      return { left: Math.round(r.left), top: Math.round(r.top) }
    })
  )

/*
 * --- the three layout toggles -------------------------------------------------
 *
 * They used to split panes while wearing the icons of VS Code's sidebar, panel and
 * secondary-sidebar switches. They toggle those regions now, and each one reports
 * the state it is in, so this checks both halves: that pressing it changes the
 * layout, and that the button says so afterwards.
 */
const region = (label) => page.locator(`.titlebar__split[aria-label="${label}"]`)
const pressed = (label) =>
  page.evaluate(
    (l) => document.querySelector(`.titlebar__split[aria-label="${l}"]`)?.getAttribute('aria-pressed'),
    label
  )

/*
 * Visible, not merely present. The panel is hidden with display:none rather than
 * unmounted — a terminal that leaves the DOM leaves its pty with it — so counting
 * elements says it is still there when it is not on screen.
 */
const shown = async (sel) =>
  (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible())

const TOGGLES = [
  { label: 'Toggle the side bar', shows: '.sidebar' },
  { label: 'Toggle the panel', shows: '.panel__bar' },
  { label: 'Toggle Claude', shows: '.region--secondary' }
]

for (const t of TOGGLES) {
  const before = await shown(t.shows)
  await region(t.label).click()
  await sleep(1200)
  const after = await shown(t.shows)
  check(`${t.label} changes the layout`, after !== before, `${before} -> ${after}`)
  check(`${t.label} reports its state`, (await pressed(t.label)) === String(after), t.label)

  // And back, so each toggle is left as it was found and the next one starts clean.
  await region(t.label).click()
  await sleep(1200)
  check(`${t.label} toggles back`, (await shown(t.shows)) === before, `${after} -> back`)
}

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
