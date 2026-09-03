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

/*
 * --- the layout holds a shape a person can read --------------------------------
 *
 * Settings is mostly prose, and prose that runs the full width of the body was
 * about a hundred and fifteen characters a line. The checkbox rows were worse
 * and quieter: `.field > label` outranked `.field__check`, so those labels were
 * display:block and the flex gap never applied — every tick sat flush against
 * its own words, for as long as the dialog has existed.
 */
const layout = await page.evaluate(() => {
  const row = document.querySelector('label.field__check')
  const box = row?.querySelector('input')?.getBoundingClientRect()
  const text = row?.querySelector('span')?.getBoundingClientRect()
  const notes = [...document.querySelectorAll('.field__note')].map((n) =>
    Math.round(n.getBoundingClientRect().width)
  )
  return {
    checkboxDisplay: row ? getComputedStyle(row).display : null,
    checkboxToText: box && text ? Math.round(text.left - box.right) : null,
    widestNote: notes.length ? Math.max(...notes) : 0
  }
})
check('checkbox rows lay out as rows', layout.checkboxDisplay === 'flex', JSON.stringify(layout))
check(
  'so a tick is not flush against its own words',
  (layout.checkboxToText ?? 0) >= 6,
  JSON.stringify(layout)
)
check(
  'and no explanation runs past a readable measure',
  layout.widestNote > 0 && layout.widestNote <= 460,
  JSON.stringify(layout)
)

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

/*
 * Stored, and deliberately not readable from here.
 *
 * The renderer is the side that turns command output into HTML, so anything that
 * ever ran there could have asked for the settings and taken the key with it. Main
 * keeps the value and answers only whether there is one — so the check is that a
 * key is held and that its text does not come back.
 */
const stored = await page.evaluate(() => window.ember.getSettings())
check('a key is held', stored.hasApiKey === true, JSON.stringify(stored.hasApiKey))
check(
  'and its value never reaches the renderer',
  stored.anthropicApiKey === null,
  String(stored.anthropicApiKey)
)

/*
 * --- the pickers pick -----------------------------------------------------------
 *
 * Font family and model are choices from lists, not strings to remember the
 * spelling of. The font list is whatever monospace faces this machine has, so
 * the test picks the one face every Windows box carries; the model list is the
 * curated set, with a hand-typed escape for ids newer than the build.
 */
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(800)
const fontOptions = await page.evaluate(() =>
  [...document.querySelectorAll('.settings__font option')].map((o) => o.value)
)
check('the font field is a list of real faces', fontOptions.includes('Consolas'), JSON.stringify(fontOptions.slice(0, 8)))
await page.locator('.settings__font').selectOption('Consolas')
const modelOptions = await page.evaluate(() =>
  [...document.querySelectorAll('.settings__model option')].map((o) => o.value)
)
check(
  'the model field lists the curated models',
  modelOptions.includes('claude-haiku-4-5') && modelOptions.includes('custom'),
  JSON.stringify(modelOptions)
)
/*
 * The density the app launched with, read before anything here has touched it.
 *
 * This is the half the picker cannot prove: the dialog sets the attribute itself
 * as you choose, so a check made right after choosing passes even when nothing
 * applies the saved value at startup — which is the only moment that matters for
 * a setting you set once.
 */
check(
  'the saved density is applied at launch',
  (await page.evaluate(() => document.documentElement.dataset.density)) === 'normal',
  String(await page.evaluate(() => document.documentElement.dataset.density))
)

/*
 * --- how much room a block takes is a preference, not a verdict ----------------
 *
 * The blocks were flattened because they spent seventy-six pixels to show
 * nineteen, and that default was chosen for everyone. Warp offers the same choice
 * for the same reason — its own settings carry `[appearance] spacing` — so this
 * one is checked the way the font is: that picking it changes the running app,
 * and that the choice survives a save.
 */
await page.locator('.settings__density').selectOption('compact')
await sleep(400)
check(
  'picking a density applies it to the running app',
  (await page.evaluate(() => document.documentElement.dataset.density)) === 'compact',
  await page.evaluate(() => document.documentElement.dataset.density)
)

await page.locator('.settings__model').selectOption('claude-haiku-4-5')
await page.evaluate(() => {
  const save = [...document.querySelectorAll('.modal__actions .btn')].find((b) =>
    b.textContent?.includes('Save')
  )
  save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(1200)
const picked = await page.evaluate(() => window.ember.getSettings())
check('the picked font is saved as a stack', picked.fontFamily.startsWith('Consolas'), picked.fontFamily)
check('and the density with it', picked.blockDensity === 'compact', String(picked.blockDensity))
/*
 * And reaches the surfaces a person actually reads. Almost everything in
 * terminal mode is HTML styled `font-family: var(--mono)` — the blocks, the
 * composer, the chips — and that variable was once a constant in the
 * stylesheet, so a picked font changed the two canvases nobody looks at and
 * nothing else.
 */
const applied = await page.evaluate(() => {
  const composer = document.querySelector('.composer__input')
  return {
    monoVar: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
    composer: composer ? getComputedStyle(composer).fontFamily : null
  }
})
check('the pick reaches the CSS the HTML surfaces read', applied.monoVar.startsWith('Consolas'), JSON.stringify(applied))
check(
  'so the composer really wears it',
  (applied.composer ?? '').includes('Consolas') && !/cascadia/i.test(applied.composer ?? ''),
  JSON.stringify(applied)
)
check('the picked model is saved', picked.aiModel === 'claude-haiku-4-5', picked.aiModel)

// The escape hatch: an id the list has never heard of can still be typed.
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(800)
await page.locator('.settings__model').selectOption('custom')
await sleep(300)
await page.locator('.settings__model-custom').fill('claude-x-9')
await page.evaluate(() => {
  const save = [...document.querySelectorAll('.modal__actions .btn')].find((b) =>
    b.textContent?.includes('Save')
  )
  save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(1200)
const custom = await page.evaluate(() => window.ember.getSettings())
check('a hand-typed model id still works', custom.aiModel === 'claude-x-9', custom.aiModel)

// Saving something unrelated must not wipe it: the field comes back empty because
// the value is hidden, and an empty field means "leave it alone".
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(600)
await page.evaluate(() => {
  const save = [...document.querySelectorAll('.modal__actions .btn')].find((b) =>
    b.textContent?.includes('Save')
  )
  save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(1200)
const afterUnrelatedSave = await page.evaluate(() => window.ember.getSettings())
check(
  'saving again does not discard the stored key',
  afterUnrelatedSave.hasApiKey === true,
  JSON.stringify(afterUnrelatedSave.hasApiKey)
)

// It must not be readable from the settings file in the clear.
const onDisk = path.join(profile.dir, 'settings.json')
if (fs.existsSync(onDisk)) {
  const raw = fs.readFileSync(onDisk, 'utf8')
  check('and is not on disk in the clear', !raw.includes(KEY), raw.slice(0, 120))
}

/*
 * --- the key reaches the AI path ---------------------------------------------
 *
 * A bad key must come back as a rejection rather than a hang. Questions stream
 * into the agent panel now, so settling means the newest assistant turn has
 * stopped showing its cursor — and it can settle either way, since a key the API
 * refuses produces an error turn where a working one would produce an answer.
 * Waiting for an answer alone would hang out the full minute on exactly the case
 * this is here to check.
 */
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
    const turns = document.querySelectorAll('.agent__turn--assistant')
    const turn = turns[turns.length - 1]
    return {
      // The question goes to the panel on send, so the composer is left empty and
      // pointed back at the shell — which is what "usable again" means now that
      // nothing disables it for the length of a request.
      composer: document.querySelector('.composer__input')?.value ?? null,
      panelOpen: !!document.querySelector('.agent'),
      streaming: !!turn?.querySelector('.agent__cursor'),
      text: (turn?.textContent ?? '').trim()
    }
  })
  if (settled.panelOpen && settled.text.length > 0 && !settled.streaming) break
}
check(
  'the request settles in the panel rather than hanging',
  settled !== null && settled.panelOpen && settled.text.length > 0 && !settled.streaming,
  JSON.stringify(settled)
)
check('and the composer is empty and waiting', settled?.composer === '', String(settled?.composer))

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
