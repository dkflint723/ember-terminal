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
import * as http from 'node:http'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('settings')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

/*
 * A server that says what it holds, which is how the model field stops being a
 * name somebody has to remember exactly. Ollama answers `/api/tags`; anything
 * OpenAI-shaped answers `/v1/models`. This one answers the first, so the check
 * also proves Ember asks both and is not simply lucky.
 */
const serverHolding = async (names) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ models: names.map((name) => ({ name })) }))
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{}')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

/*
 * Two of them, holding different models, because the question that matters is not
 * "does discovery work" but "which server did it ask". The dialog edits a draft and
 * saves nothing until Save, so a first version of this asked main — which reads the
 * stored address — and cheerfully described the server the user was leaving.
 */
const models = (await serverHolding(['stub-coder:7b', 'stub-coder:1.5b'])).server
const modelsPort = models.address().port
const elsewhere = await serverHolding(['other-machine:3b'])

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

// A field's heading is a <label> when it names one control, and a labelled span
// when it names a group of them — a checkbox row, or a list of rows.
const fields = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.field > :is(label, .field__label):first-child')).map(
    (l) => l.textContent
  )
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
  modelOptions.includes('claude-haiku-4-5-20251001') && modelOptions.includes('custom'),
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

await page.locator('.settings__model').selectOption('claude-haiku-4-5-20251001')
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
check('the picked model is saved', picked.aiModel === 'claude-haiku-4-5-20251001', picked.aiModel)

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

/*
 * The same for the suggestion provider's key.
 *
 * It is a second secret, added later than the first, and every piece of code that
 * handles secrets was only ever taught about the first one. The read path redacts
 * it, so the dialog's copy is null whether or not one is stored — and a save that
 * does not strip that null writes it over the key that was there.
 */
await page.evaluate(() => window.ember.setSettings({ ghostApiKey: 'ghost-secret-value' }))
await sleep(600)
const ghostHeld = await page.evaluate(() => window.ember.getSettings())
check('a suggestion key is held too', ghostHeld.hasGhostKey === true, JSON.stringify(ghostHeld.hasGhostKey))

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
const afterGhostSave = await page.evaluate(() => window.ember.getSettings())
check(
  'and an unrelated save does not discard that one either',
  afterGhostSave.hasGhostKey === true,
  JSON.stringify(afterGhostSave.hasGhostKey)
)

/*
 * And no other door hands a key out. Noting a recent folder answers with the
 * settings as well — the store pipes that straight into applySettings when a tree
 * root is opened — so it is a read path like any other and has to redact like one.
 * Two doors were built with the redaction written out at each of them, and the
 * third was added without it.
 */
const viaFolder = await page.evaluate(() => window.ember.noteRecentFolder('D:/'))
check(
  'and noting a folder does not hand the keys back',
  viaFolder.anthropicApiKey == null && viaFolder.ghostApiKey == null,
  JSON.stringify({ anthropic: viaFolder.anthropicApiKey, ghost: viaFolder.ghostApiKey })
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

/*
 * --- the model field offers what the server has ---------------------------------
 *
 * A model name is exact and unforgiving, and the failure when it is subtly wrong is
 * an endpoint reporting "model not found" for something plainly installed. Where
 * the server will say what it holds, the name is chosen rather than remembered.
 */
await page.evaluate(
  (port) =>
    window.ember.setSettings({
      // The fields only exist when the feature does.
      ghostEnabled: true,
      ghostProvider: 'local',
      ghostBaseUrl: `http://127.0.0.1:${port}/v1`
    }),
  modelsPort
)
await sleep(600)
const offered = await page.evaluate(() => window.ember.ghostModels())
const offeredNames = offered.map((m) => m.name)
check(
  'the models a server holds are discovered',
  offeredNames.includes('stub-coder:7b') && offeredNames.includes('stub-coder:1.5b'),
  JSON.stringify(offered)
)
/*
 * And each one carries whether it can fill in the middle, which is the whole of
 * what a suggestion is. Null here, deliberately: this stub is OpenAI-shaped and
 * lists names only, and "the server did not say" must not be recorded as "no" —
 * a server that works fine and does not advertise would otherwise be refused.
 */
check(
  'and each says whether it can fill in the middle, or that it did not say',
  offered.every((m) => m.fim === null),
  JSON.stringify(offered)
)

await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(800)
// The dialog is sectioned, and only the section on screen is rendered.
await page.locator('.settings__nav-item', { hasText: 'Suggestions' }).click()
await sleep(1500)
const choices = await page.evaluate(() =>
  [...document.querySelectorAll('.settings__ghost-model option')].map((o) => o.value)
)
check(
  'and offered as a list rather than a field to type into',
  choices.includes('stub-coder:7b'),
  JSON.stringify(choices)
)
/*
 * The field has to remain reachable: a server that lists nothing may answer
 * perfectly well, and a name can be newer than the list.
 */
check(
  'with a way back to typing one in',
  choices.some((v) => v.includes('type')),
  JSON.stringify(choices)
)
/*
 * And it follows the address on screen, not the one on disk.
 *
 * Retyping the address and being shown the old server's models is worse than being
 * shown none: they are offered as installed, because whether a name is installed is
 * judged against that same wrong list. Picking one produces "model not found" for a
 * name Ember has just said is present — the exact failure the picker exists to
 * prevent.
 */
await page.locator('.settings__ghost-url').fill(`http://127.0.0.1:${elsewhere.port}/v1`)
// Past the debounce, which exists so that typing a URL is not one request per key.
await sleep(2500)
const afterRetype = await page.evaluate(() =>
  [...document.querySelectorAll('.settings__ghost-model option')].map((o) => o.value)
)
check(
  'the list follows the address being typed, not the one saved',
  afterRetype.includes('other-machine:3b') && !afterRetype.includes('stub-coder:7b'),
  JSON.stringify(afterRetype)
)

/*
 * --- a changed draft is not thrown away by accident ---------------------------
 *
 * The address above is an unsaved edit. Escape — and a click a few pixels outside
 * the dialog — used to discard it at once. Now they ask, Escape again answers
 * "keep editing", and only Discard (or Cancel, which is a decision) closes.
 */
await page.keyboard.press('Escape')
await sleep(400)
check(
  'Escape on a changed draft asks before discarding',
  (await page.locator('.modal').count()) === 1 && (await page.locator('.settings__discard').count()) === 1,
  `modals ${await page.locator('.modal').count()}, questions ${await page.locator('.settings__discard').count()}`
)
// On a version that closed straight away, reopen with a change so the rest can run.
if ((await page.locator('.modal').count()) === 0) {
  await page.keyboard.press('Control+Comma')
  await page.waitForSelector('.modal', { timeout: 10_000 })
  await page.locator('.field__unit input').first().fill('15')
  await page.keyboard.press('Escape')
  await sleep(300)
}
await page.keyboard.press('Escape')
await sleep(300)
check(
  'and Escape again means keep editing',
  (await page.locator('.modal').count()) === 1 && (await page.locator('.settings__discard').count()) === 0
)
// On the scrim itself, below the dialog: the window's top edge is the title bar,
// which is a drag region and takes no clicks at all.
const scrim = (await page.locator('.modal-scrim').count()) ? await page.locator('.modal-scrim').boundingBox() : null
if (scrim) await page.mouse.click(scrim.x + 12, scrim.y + scrim.height - 12)
await sleep(400)
check(
  'a click outside asks as well',
  (await page.locator('.modal').count()) === 1 && (await page.locator('.settings__discard').count()) === 1,
  `modals ${await page.locator('.modal').count()}, questions ${await page.locator('.settings__discard').count()}`
)
if (await page.locator('[data-confirm="discard"]').count()) {
  await page.locator('[data-confirm="discard"]').click()
  await sleep(400)
}
check('and Discard closes', (await page.locator('.modal').count()) === 0)
// Whatever happened above, the checks below start from a closed dialog.
if (await page.locator('.modal').count()) {
  await page.locator('.modal__actions .btn', { hasText: 'Cancel' }).click()
  await sleep(400)
}

/*
 * --- Cancel undoes every preview, not only the theme ---------------------------
 *
 * Zoom and density apply as they change so they can be judged by looking, and
 * Cancel put back the theme alone — a window zoomed to 150% and "cancelled" stayed
 * at 150%.
 */
const ratio = () => page.evaluate(() => window.devicePixelRatio)
const density = () => page.evaluate(() => document.documentElement.dataset.density ?? 'normal')
const ratioBefore = await ratio()
const densityBefore = await density()
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(600)
// By the dialog's own labels, so a version whose controls have no ids is reported
// as that rather than timing out here.
const zoomField = page.getByLabel('Interface size', { exact: true })
const densityField = page.getByLabel('Block density', { exact: true })
const labelled = (await zoomField.count()) === 1 && (await densityField.count()) === 1
check('zoom and density are found by their labels', labelled)
if (labelled) {
  await zoomField.fill('150')
  await densityField.selectOption(densityBefore === 'compact' ? 'comfortable' : 'compact')
}
await sleep(600)
const ratioPreviewed = await ratio()
check('zoom previews as it changes', ratioPreviewed > ratioBefore * 1.3, `${ratioBefore} -> ${ratioPreviewed}`)
await page.locator('.modal__actions .btn', { hasText: 'Cancel' }).click()
await sleep(700)
check(
  'and Cancel puts the zoom back',
  Math.abs((await ratio()) - ratioBefore) < 0.01,
  `${ratioBefore} -> ${ratioPreviewed} -> ${await ratio()}`
)
check('and the density', (await density()) === densityBefore, `${densityBefore} -> ${await density()}`)

/*
 * --- main reads what it is sent for what it should be --------------------------
 *
 * The dialog clamps what it can, but anything can call setSettings — and main used
 * to take a font size of 400, or a list of shells that was a string, as it stood.
 */
const clamped = await page.evaluate(() => window.ember.setSettings({ fontSize: 400 }))
check(
  'a font size of 400 is brought into range',
  clamped.settings.fontSize === 32,
  String(clamped.settings.fontSize)
)
check(
  'and main says it did',
  (clamped.notes ?? []).some((n) => n.includes('fontSize')),
  JSON.stringify(clamped.notes)
)
const refused = await page.evaluate(() => window.ember.setSettings({ customProfiles: 'wsl.exe' }))
check(
  'shells sent as a string are not taken',
  Array.isArray(refused.settings.customProfiles),
  JSON.stringify(refused.settings.customProfiles)
)
check('and main says why', (refused.notes ?? []).some((n) => n.includes('customProfiles')), JSON.stringify(refused.notes))
await page.evaluate(() => window.ember.setSettings({ fontSize: 13 }))

/*
 * --- search finds any setting, not only a shortcut ----------------------------
 */
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(600)
const search = page.locator('.settings__search')
const canSearch = (await search.count()) > 0
check('there is a search over every setting', canSearch)
if (canSearch) await search.fill('notify')
await sleep(300)
const visible = (sel) => page.evaluate((s) => {
  const el = document.querySelector(s)
  return !!el && el.getClientRects().length > 0
}, sel)
check('searching finds the setting it names', canSearch && (await visible('#settings-notify')))
check('and puts away the ones it does not', canSearch && !(await visible('#settings-theme')))
if (canSearch) await search.fill('no setting is called this')
await sleep(300)
check('and says when nothing matches', canSearch && (await visible('.settings__nomatch')))
if (canSearch) await search.fill('')

/*
 * --- import and export --------------------------------------------------------
 *
 * The native file dialogs are answered from main, where they live: each is stubbed
 * to hand back a path in the profile's scratch folder, and everything after that —
 * the reading, the checking, the draft — is the app's own.
 */
const scratch = fs.mkdtempSync(path.join(profile.dir ?? APP_DIR, 'port-'))
const answerDialogs = (file) =>
  app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: f })
  }, file)

await page.evaluate(() => window.ember.setSettings({ anthropicApiKey: 'sk-ant-verify-export-leak' }))
const exported = path.join(scratch, 'out.json')
await answerDialogs(exported)
const porting = (await page.locator('.btn', { hasText: 'Export…' }).count()) > 0
check('there are import and export buttons', porting)
if (porting) await page.locator('.btn', { hasText: 'Export…' }).click()
await sleep(800)
const written = fs.existsSync(exported) ? fs.readFileSync(exported, 'utf8') : ''
check('export writes a file', written.length > 0)
check('with the preferences in it', /"fontSize"/.test(written), written.slice(0, 120))
check('and never the key', !written.includes('sk-ant-verify-export-leak') && !/anthropicApiKey/.test(written))
await page.evaluate(() => window.ember.setSettings({ anthropicApiKey: null }))

const broken = path.join(scratch, 'broken.json')
fs.writeFileSync(broken, JSON.stringify({ settings: { fontSize: 15, customProfiles: 'wsl.exe' } }))
await answerDialogs(broken)
if (porting) await page.locator('.btn', { hasText: 'Import…' }).click()
await sleep(800)
const brokenNote = porting
  ? ((await page.locator('.field__note--bad').last().textContent({ timeout: 2000 }).catch(() => '')) ?? '')
  : ''
check(
  'an import with a string where a list belongs is refused, and says why',
  /Nothing was imported/.test(brokenNote) && /customProfiles/.test(brokenNote),
  brokenNote
)
const fontSizeNow = async () =>
  (await page.locator('#settings-font-size').count())
    ? await page.locator('#settings-font-size').inputValue()
    : '(no labelled font size)'
check('and changes nothing', (await fontSizeNow()) !== '15', await fontSizeNow())

const good = path.join(scratch, 'good.json')
fs.writeFileSync(good, JSON.stringify({ schemaVersion: 1, settings: { fontSize: 15 } }))
await answerDialogs(good)
if (porting) await page.locator('.btn', { hasText: 'Import…' }).click()
await sleep(800)
check('a good import lands in the dialog', (await fontSizeNow()) === '15', await fontSizeNow())
const storedSize = await page.evaluate(() => window.ember.getSettings().then((s) => s.fontSize))
check("and is not saved until Save", storedSize !== 15, String(storedSize))
await page.locator('.modal__actions .btn', { hasText: 'Cancel' }).click()
await sleep(400)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
models.close()
elsewhere.server.close()
for (const f of failures) console.log(`  - ${f}`)
console.log('settings:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
