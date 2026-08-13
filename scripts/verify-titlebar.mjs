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

const beforeSplit = (await paneBoxes()).length
await page.locator('.titlebar__split[aria-label="Split right"]').click()
await sleep(1500)
const afterRight = await paneBoxes()
check('split right adds a pane', afterRight.length === beforeSplit + 1, `${beforeSplit} -> ${afterRight.length}`)
check(
  'and puts it beside, not below',
  new Set(afterRight.map((b) => b.left)).size > 1,
  JSON.stringify(afterRight)
)

// The newly split pane is active, so splitting left of it lands to its left.
const leftmostBefore = Math.min(...afterRight.map((b) => b.left))
await page.locator('.titlebar__split[aria-label="Split left"]').click()
await sleep(1500)
const afterLeft = await paneBoxes()
check('split left adds a pane', afterLeft.length === afterRight.length + 1, `${afterRight.length} -> ${afterLeft.length}`)
check(
  'and the new pane is left of where the old one started',
  Math.min(...afterLeft.map((b) => b.left)) <= leftmostBefore,
  `${leftmostBefore} -> ${Math.min(...afterLeft.map((b) => b.left))}`
)

await page.locator('.titlebar__split[aria-label="Split down"]').click()
await sleep(1500)
const afterDown = await paneBoxes()
check('split down adds a pane', afterDown.length === afterLeft.length + 1, `${afterLeft.length} -> ${afterDown.length}`)
check(
  'and it sits below something',
  new Set(afterDown.map((b) => b.top)).size > 1,
  JSON.stringify(afterDown)
)

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
