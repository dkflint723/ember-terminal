// Paths and URLs in finished output open things, and plain words never do.
//
// The output markup is untouched — hits are computed from the pointer and the
// affordance is a CSS highlight — so this drives it the way a hand would: point
// at things, watch what lights up, click, and see where the app goes.
//
// Run: node scripts/verify-links.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('links')
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

const run = async (cmd, settle = 2200) => {
  await page.click('.composer__input')
  await page.keyboard.type(cmd, { delay: 4 })
  await page.keyboard.press('Enter')
  await sleep(settle)
}

// The block's cwd is what a relative path resolves against, so the shell moves
// to the repo first. Plain echo, deliberately: the composer routes prose-shaped
// input to the agent, and these rows must come from the shell. The locators
// below scope to block BODIES, so the command echoed in the head cannot match.
await run(`cd "${APP_DIR}"`, 2600)
await run('echo scripts/verify-links.mjs:31:9')
await run("echo 'just plain prose with no destination'")
await run('echo https://example.com/docs')

/**
 * Hover a few characters INTO the row containing `text` — where the text
 * actually is. A row is a full-width line box, so its centre is usually empty
 * space past the last glyph, and pointing at nothing correctly hits nothing.
 */
const probe = async (text) => {
  const row = page.locator('.block__body .row', { hasText: text }).first()
  await row.hover({ position: { x: 28, y: 9 } })
  await sleep(250)
  return page.evaluate(() => ({
    highlight: CSS.highlights?.has('ember-link') ?? false,
    cursor: document.querySelectorAll('.block__body[data-link]').length
  }))
}

// --- prose stays prose --------------------------------------------------------
const prose = await probe('no destination')
check('plain words never light up', !prose.highlight && prose.cursor === 0, JSON.stringify(prose))

// --- a URL is an offer --------------------------------------------------------
const url = await probe('example.com')
check('a URL underlines under the pointer', url.highlight, JSON.stringify(url))
check('and the cursor says it will open', url.cursor === 1, JSON.stringify(url))

// --- a path with a position opens the editor there ----------------------------
const target = page.locator('.block__body .row', { hasText: 'verify-links.mjs:31' }).first()
await target.click({ position: { x: 28, y: 9 } })
await sleep(2600)

const landed = await page.evaluate(() => ({
  mode: document.querySelector('.workspace')?.getAttribute('data-mode') ?? null,
  crumbs: document.querySelector('.editor__crumbs')?.textContent ?? '',
  position: document.querySelector('[data-status="position"]')?.textContent ?? ''
}))
check('clicking a path brings the IDE', landed.mode === 'ide', landed.mode)
check('with the file open', landed.crumbs.includes('verify-links.mjs'), landed.crumbs)
check('at the line and column it named', landed.position.includes('Ln 31'), landed.position)

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('clickable output:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
