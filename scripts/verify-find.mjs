// Find in the terminal, including the part of it that is folded away.
//
// A collapsed block's body is not in the DOM, so a find that walks the DOM
// reported "no matches" while the match sat inside a folded build log. The bar
// now reads the block data, unfolds the blocks it needs, and folds back what it
// opened when it closes — which is exactly the sequence this drives.
//
// Run: node scripts/verify-find.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('find')
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

const run = async (cmd) => {
  await page.click('.composer__input')
  await page.keyboard.type(cmd, { delay: 5 })
  await page.keyboard.press('Enter')
  await sleep(2200)
}

// Two blocks: one to stay open, one to fold. The second command CONSTRUCTS its
// marker so the text appears only in the output — the head stays on screen when
// a block folds, and a marker echoed literally would match there and prove
// nothing about seeing into the folded body.
await run('echo neon-marker-alpha')
await run("('folded-marker-' + 'beta')")

const heads = page.locator('.block__head')
check('two blocks are on screen', (await heads.count()) === 2, `${await heads.count()}`)

// Fold the second block and make sure it is folded.
await heads.nth(1).click()
await sleep(400)
const folded = await heads.nth(1).getAttribute('aria-expanded')
check('the second block folds', folded === 'false', String(folded))

// --- a match inside the folded block is found, by unfolding it ---------------
await page.keyboard.press('Control+f')
await page.waitForSelector('.find__input', { timeout: 5_000 })
await page.locator('.find__input').fill('folded-marker-beta')
await sleep(700)

const count = (await page.locator('.find__count').textContent()) ?? ''
check('the folded match is counted', /\b1 of \d+/.test(count), count)
const reopened = await heads.nth(1).getAttribute('aria-expanded')
check('because the block was unfolded for it', reopened === 'true', String(reopened))

// --- closing the bar folds back what it opened -------------------------------
await page.keyboard.press('Escape')
await sleep(400)
check('Escape closes the bar', (await page.locator('.find__input').count()) === 0)
const refolded = await heads.nth(1).getAttribute('aria-expanded')
check('and the block folds back the way it was', refolded === 'false', String(refolded))

// --- an ordinary visible match still works -----------------------------------
await page.keyboard.press('Control+f')
await page.waitForSelector('.find__input', { timeout: 5_000 })
await page.locator('.find__input').fill('neon-marker-alpha')
await sleep(700)
const visible = (await page.locator('.find__count').textContent()) ?? ''
check('a visible match is still found', /of \d+/.test(visible), visible)
await page.keyboard.press('Escape')

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('find in output:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
