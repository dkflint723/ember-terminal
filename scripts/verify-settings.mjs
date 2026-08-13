// Settings: reachable, and the fields actually apply.
//
// This exists because the dialog was complete but effectively hidden — reachable
// only from the new-tab menu or an undocumented Ctrl+, — which is a good way to
// ship settings nobody finds.
//
// Run: node scripts/verify-settings.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('settings')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
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
await sleep(1000)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- reachable without knowing a shortcut -----------------------------------
const gear = page.locator('.activity__item[data-view="settings"]')
check('the rail has a settings button', (await gear.count()) === 1)
await gear.click()
await page.waitForSelector('.modal', { timeout: 10_000 })
check('clicking it opens settings', true)

const fields = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.field > label:first-child')).map((l) => l.textContent)
)
for (const wanted of ['Theme', 'Default shell', 'Claude access', 'On launch', 'Notify after']) {
  check(`it offers ${wanted}`, fields.some((f) => f?.includes(wanted)), fields.join(' | '))
}
// The key moved behind a disclosure when signing in became the common case, so it
// is checked as a disclosure rather than as a labelled field.
check(
  'and an API key is still available under a disclosure',
  (await page.locator('details.field summary').count()) >= 1
)
await page.screenshot({ path: path.join(SHOT_DIR, '97-settings.png') })

// --- the API key field actually persists ------------------------------------
const KEY = 'sk-ant-verify-not-a-real-key'
await page.locator('details.field').first().locator('summary').click()
await sleep(400)
await page.locator('details.field').first().locator('input[type="password"]').fill(KEY)
await page.evaluate(() => {
  const save = [...document.querySelectorAll('.modal__actions .btn')].find((b) =>
    b.textContent?.includes('Save')
  )
  save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(1200)
check('saving closes the dialog', (await page.locator('.modal').count()) === 0)

const stored = await page.evaluate(() => window.ember.getSettings())
check('the key was stored', stored.anthropicApiKey === KEY, String(stored.anthropicApiKey))

// It must not be readable from the settings file in the clear.
const onDisk = path.join(profile.dir, 'settings.json')
if (fs.existsSync(onDisk)) {
  const raw = fs.readFileSync(onDisk, 'utf8')
  check('and is not on disk in the clear', !raw.includes(KEY), raw.slice(0, 120))
}

// --- the key reaches the AI path --------------------------------------------
// A bad key must come back as a rejection rather than a hang: the composer is
// disabled while a request is in flight, so a stall reads as the app locking up.
await page.click('.composer__input')
await page.keyboard.press('Control+k')
await sleep(400)
check('Ctrl+K switches to ask mode', (await page.locator('.composer__row--ai').count()) === 1)

await page.keyboard.type('list files by size', { delay: 6 })
await page.keyboard.press('Enter')

let settled = null
for (let i = 0; i < 60; i++) {
  await sleep(1000)
  settled = await page.evaluate(() => {
    const box = document.querySelector('.composer__input')
    return {
      disabled: box?.disabled ?? false,
      text: document.querySelector('.composer__proposal, .proposal')?.textContent ?? ''
    }
  })
  if (settled.text.length > 0) break
}
check('the request settles rather than hanging', (settled?.text.length ?? 0) > 0, JSON.stringify(settled))
check('and the composer is usable again', settled?.disabled === false, String(settled?.disabled))

// Escape must always get back out of ask mode.
await page.keyboard.press('Escape')
await sleep(300)
await page.keyboard.press('Escape')
await sleep(300)
await page.click('.composer__input')
await page.keyboard.type('echo alive', { delay: 6 })
await sleep(300)
const recovered = await page.evaluate(() => document.querySelector('.composer__input')?.value ?? '')
check('and typing works afterwards', recovered.includes('echo alive'), recovered)

/*
 * --- the dialog has to take the keyboard ------------------------------------
 *
 * Typed, not filled. Every other check here sets input values directly, which is
 * exactly what cannot notice a focus bug — and there was one: opening Settings left
 * focus in the terminal composer, so typing went to the shell behind the scrim and
 * Enter ran it as a command.
 */
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(900)

const focused = await page.evaluate(() => {
  const active = document.activeElement
  return { inDialog: !!active?.closest('.modal'), what: active?.tagName ?? 'none' }
})
check('the dialog takes focus when it opens', focused.inDialog, JSON.stringify(focused))

await page.keyboard.type('whoami')
await sleep(600)
const leaked = await page.evaluate(
  () => document.querySelector('.composer__input')?.value ?? ''
)
check('and typing cannot reach the shell behind it', !leaked.includes('whoami'), leaked)

// Tab must not walk out of the dialog into the app underneath.
await page.keyboard.press('Tab')
await page.keyboard.press('Tab')
await sleep(400)
const stillInside = await page.evaluate(() => !!document.activeElement?.closest('.modal'))
check('and Tab stays inside it', stillInside)

await page.keyboard.press('Escape')
await sleep(400)

await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('settings:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
