// The look: a Windows 11 backdrop, the window's opacity, frosted overlays and accent
// touches — each on by default but opacity, each its own setting, each previewed
// live in Settings and put back by Cancel, and all of it off under reduced motion
// (the movement) and a Windows contrast theme (everything).
//
// What this can and cannot see. A Playwright screenshot is the page, not the
// window: whatever DWM draws behind the page — Mica, Acrylic — is not in it, and
// neither is the window's opacity. So the backdrop is checked as what main handed
// to Windows (main keeps it, since Electron has no getter for a material) and what
// the page did in answer, the opacity as BrowserWindow.getOpacity(), and the
// screenshots show the page's half of the look only. Where the page is glass, the
// screenshot shows it over the white Chromium puts behind a transparent page.
//
// Run: node scripts/verify-look.mjs
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, untilNothingRuns, watchPageErrors, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const failures = []
const errors = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
/** Wait for `probe` to return something `good` accepts, for at most `ms`; returns the last answer. */
const until = async (probe, good, ms = 8_000) => {
  const end = Date.now() + ms
  let last = await probe()
  while (!good(last) && Date.now() < end) {
    await sleep(150)
    last = await probe()
  }
  return last
}

const launch = async (profile, extraEnv = {}) => {
  const env = { ...process.env, ...extraEnv }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })
  watchPageErrors(app, errors)
  const page = await app.firstWindow()
  await watchRunning(app)
  await placeTopRight(app)
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  return { app, page }
}

/** What main applied to the window, read in main, and the window's opacity. */
const mainLook = (app) =>
  app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const lookOf = globalThis.emberLookOf
    return {
      look: typeof lookOf === 'function' ? lookOf(win) : null,
      opacity: win ? win.getOpacity() : null
    }
  })

/** The alpha of a computed colour, in either spelling Chromium uses for color-mix(). */
const alphaOf = (colour) => {
  if (!colour) return null
  const slashed = /\/\s*([0-9.]+)\s*\)/.exec(colour)
  if (slashed) return parseFloat(slashed[1])
  const fn = /rgba?\(([^)]+)\)/.exec(colour)
  if (fn) {
    const parts = fn[1].split(',').map((p) => parseFloat(p))
    return parts.length > 3 ? parts[3] : 1
  }
  return /^(color|rgb)\(/.test(colour) ? 1 : null
}

/** Everything the page says about its half of the look, as the engine resolved it. */
const pageLook = (page) =>
  page.evaluate(async () => {
    const root = document.documentElement
    const css = (el, prop) => (el ? getComputedStyle(el)[prop] : null)
    const settings = await window.ember.getSettings()
    const theme = await window.ember.getTheme(settings.themeId)
    /*
     * Which of the theme's two palettes is on the page, told by a text token the
     * glass derivation actually moved — a token both palettes share cannot say.
     */
    const lower = (s) => String(s ?? '').trim().toLowerCase()
    const differing = theme?.glass
      ? ['fg-faint', 'fg-dim', 'fg', 'accent', 'ok', 'fail', 'info', 'info-fg'].filter(
          (k) => lower(theme.glass.vars[k]) !== lower(theme.vars[k])
        )
      : []
    const key = differing[0]
    const onPage = key ? lower(getComputedStyle(root).getPropertyValue(`--${key}`)) : null
    const term = document.querySelector('.live .xterm')
    return {
      backdrop: root.dataset.backdrop ?? null,
      frosted: root.dataset.frosted ?? null,
      accents: root.dataset.accents ?? null,
      body: css(document.body, 'backgroundColor'),
      ground: css(document.querySelector('.workspace'), 'backgroundImage'),
      termAlpha: term?.getAttribute('data-term-alpha') ?? null,
      termBg: term?.getAttribute('data-term-bg') ?? null,
      bg: getComputedStyle(root).getPropertyValue('--bg').trim().toLowerCase(),
      palette: !key
        ? 'indistinguishable'
        : onPage === lower(theme.glass.vars[key])
          ? 'glass'
          : onPage === lower(theme.vars[key])
            ? 'plain'
            : `neither (--${key} is ${onPage})`,
      paletteDiffers: differing.length > 0
    }
  })

const run = async (page, command) => {
  const before = await page.locator('.block').count()
  await page.focus('.composer__input')
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  await until(
    () => page.evaluate(() => [document.querySelectorAll('.block').length, document.querySelectorAll('.block--running').length]),
    ([blocks, running]) => blocks > before && running === 0,
    20_000
  )
}

const openPalette = async (page) => {
  await page.focus('.composer__input')
  await page.keyboard.press('Control+Shift+P')
  await page.waitForSelector('.qp', { timeout: 10_000 })
}
const closeOverlay = async (page) => {
  await page.keyboard.press('Escape')
  await until(() => page.locator('.qp, .modal').count(), (n) => n === 0, 5_000)
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOT_DIR, name) })

const panelOf = (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const c = getComputedStyle(el)
    return { filter: c.backdropFilter, colour: c.backgroundColor, animation: c.animationName, shadow: c.boxShadow }
  }, selector)

const ringOf = (page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane--active')
    return pane ? getComputedStyle(pane).boxShadow : null
  })

// ================================================================== the defaults
const profile = newProfile('look')
let { app, page } = await launch(profile)

await run(page, 'echo look-one')
await run(page, 'Get-ChildItem -Path $env:SystemRoot | Select-Object -First 4 Name, Mode')
await run(page, 'Write-Output "a", "few", "lines"')

const start = await mainLook(app)
check('main reports what it applied to the window', start.look !== null, JSON.stringify(start))
const supported = start.look?.supported === true
console.log(
  `  (this system ${supported ? 'can' : 'cannot'} draw a backdrop material; main applied "${start.look?.applied}")`
)
check('the backdrop asked for by default is Mica', start.look?.requested === 'mica', JSON.stringify(start.look))
check(
  "and what was handed to Windows is Mica where it can draw one, and nothing where it cannot",
  start.look?.applied === (supported ? 'mica' : 'none'),
  JSON.stringify(start.look)
)
check('and nothing refused it', !start.look?.error, start.look?.error)
check('the window is fully opaque by default', start.opacity === 1, String(start.opacity))

const look0 = await pageLook(page)
check('the page follows what main applied', look0.backdrop === start.look?.applied, JSON.stringify(look0))
check('frosted panels are on by default', look0.frosted === 'on', JSON.stringify(look0))
check('accent touches are on by default', look0.accents === 'on', JSON.stringify(look0))
// Without a difference, "the page is on the glass palette" below could not fail.
check("the default theme's glass palette differs from its solid one", look0.paletteDiffers === true, JSON.stringify(look0))
if (start.look?.applied !== 'none') {
  check('on glass the body lets the backdrop through', alphaOf(look0.body) === 0, look0.body)
  check(
    'and the ground is tinted at 92%, not painted',
    /(\/\s*0\.92\b|,\s*0\.92\))/.test(look0.ground ?? ''),
    (look0.ground ?? '').slice(0, 160)
  )
  check('and the text is the glass palette', look0.palette === 'glass', JSON.stringify(look0))
  check('and the terminal draws no background of its own', look0.termAlpha === '0', JSON.stringify(look0))
  check("while still holding the theme's background colour", look0.termBg === look0.bg, JSON.stringify(look0))
} else {
  check('with no material the body is solid', alphaOf(look0.body) === 1, look0.body)
  check('and the text is the solid palette', look0.palette === 'plain', JSON.stringify(look0))
  check('and the terminal paints its background', look0.termAlpha === '1', JSON.stringify(look0))
}

// --- a running command glows, the pane the keyboard is in is ringed --------------
await page.focus('.composer__input')
check('the pane the keyboard is in carries a ring', (await ringOf(page))?.includes('inset'), await ringOf(page))
await page.keyboard.type('Start-Sleep -Seconds 6; echo slept', { delay: 4 })
await page.keyboard.press('Enter')
const running = await until(
  () => panelOf(page, '.block--running'),
  (p) => p !== null,
  10_000
)
check('a running command has a glow', running !== null && running.shadow !== 'none', JSON.stringify(running))
await sleep(400)
await shot(page, 'look-01-default-blocks.png')
await until(() => page.locator('.block--running').count(), (n) => n === 0, 20_000)

// --- frosted overlays, easing in --------------------------------------------------
await openPalette(page)
const palette = await panelOf(page, '.qp')
check('the command palette is frosted', palette?.filter?.includes('blur'), JSON.stringify(palette))
check('and lets a little of what it covers through', alphaOf(palette?.colour) === 0.9, JSON.stringify(palette))
check('and eases in', palette?.animation === 'look-rise', JSON.stringify(palette))
await sleep(400)
await shot(page, 'look-02-palette.png')
await closeOverlay(page)

// ================================================================== Settings, as a user
const openSettings = async () => {
  await page.locator('.activity__item[data-view="settings"]').click()
  await page.waitForSelector('.modal', { timeout: 10_000 })
  await sleep(300)
}
const cancelSettings = async () => {
  await page.locator('.modal__actions .btn', { hasText: 'Cancel' }).click()
  await until(() => page.locator('.modal').count(), (n) => n === 0, 5_000)
}
const stored = () => page.evaluate(() => window.ember.getSettings())

await openSettings()
const modal = await panelOf(page, '.modal')
check('Settings is frosted too', modal?.filter?.includes('blur'), JSON.stringify(modal))
const labelled = {
  backdrop: await page.getByLabel('Window backdrop', { exact: true }).count(),
  opacity: await page.getByLabel('Window opacity', { exact: true }).count(),
  frosted: await page.getByLabel('Frost dialogs, the palette, menus and notices').count(),
  accents: await page.getByLabel('Glows, light on headers, and dialogs that ease in').count()
}
check(
  'Appearance offers the four look settings, each found by its label',
  Object.values(labelled).every((n) => n === 1),
  JSON.stringify(labelled)
)
await page.getByLabel('Window backdrop', { exact: true }).scrollIntoViewIfNeeded()
await sleep(300)
await shot(page, 'look-03-settings.png')

// --- each previews as it changes ---------------------------------------------------
await page.getByLabel('Window backdrop', { exact: true }).selectOption('acrylic')
const acrylic = await until(() => mainLook(app), (m) => m.look?.requested === 'acrylic')
check('choosing Acrylic applies it to the window at once', acrylic.look?.requested === 'acrylic', JSON.stringify(acrylic))
check(
  'as Acrylic where it can be drawn',
  acrylic.look?.applied === (supported ? 'acrylic' : 'none'),
  JSON.stringify(acrylic)
)
check('before anything is saved', (await stored()).windowBackdrop === 'mica')

const slider = page.getByLabel('Window opacity', { exact: true })
await slider.focus()
await page.keyboard.press('Home')
for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight')
const faded = await until(() => mainLook(app), (m) => Math.abs((m.opacity ?? 1) - 0.8) < 0.01)
check('sliding the opacity to 80% applies it to the window at once', Math.abs((faded.opacity ?? 1) - 0.8) < 0.01, String(faded.opacity))
check('and says so beside the slider', (await page.locator('.settings__opacity + .field__unit-label').textContent())?.trim() === '80%')

await page.getByLabel('Frost dialogs, the palette, menus and notices').uncheck()
await page.getByLabel('Glows, light on headers, and dialogs that ease in').uncheck()
const offLook = await pageLook(page)
check('unticking frost takes it off at once', offLook.frosted === 'off', JSON.stringify(offLook))
check('and the open dialog stops blurring', (await panelOf(page, '.modal'))?.filter === 'none', JSON.stringify(await panelOf(page, '.modal')))
check('unticking the accents takes them off at once', offLook.accents === 'off', JSON.stringify(offLook))

// --- and Cancel puts every one of them back ----------------------------------------
await cancelSettings()
const back = await until(() => mainLook(app), (m) => m.look?.requested === 'mica' && m.opacity === 1)
check('Cancel puts the backdrop back', back.look?.requested === 'mica', JSON.stringify(back))
check('and the opacity', back.opacity === 1, String(back.opacity))
const backPage = await pageLook(page)
check('and the frost', backPage.frosted === 'on', JSON.stringify(backPage))
check('and the accents', backPage.accents === 'on', JSON.stringify(backPage))
check('and the page is glass again exactly where it was', backPage.backdrop === start.look?.applied, JSON.stringify(backPage))
const afterCancel = await stored()
check(
  'and nothing was saved',
  afterCancel.windowBackdrop === 'mica' &&
    afterCancel.windowOpacity === 1 &&
    afterCancel.frostedPanels === true &&
    afterCancel.accentEffects === true,
  JSON.stringify(afterCancel)
)

// --- each backdrop, saved (the dialog is not the point here) -----------------------
for (const material of ['mica', 'tabbed', 'acrylic', 'none']) {
  await page.evaluate((m) => window.ember.setSettings({ windowBackdrop: m }), material)
  const m = await until(() => mainLook(app), (x) => x.look?.requested === material)
  const expected = supported ? material : 'none'
  check(`a saved backdrop of ${material} is applied`, m.look?.applied === expected, JSON.stringify(m.look))
  const p = await until(() => pageLook(page), (x) => x.backdrop === expected)
  check(`and the page follows it to ${expected}`, p.backdrop === expected, JSON.stringify(p))
  check(
    `with the ${expected === 'none' ? 'solid' : 'glass'} palette`,
    p.palette === (expected === 'none' ? 'plain' : 'glass'),
    JSON.stringify(p)
  )
  await sleep(300)
  await shot(page, `look-04-backdrop-${material}.png`)
}
await page.evaluate(() => window.ember.setSettings({ windowBackdrop: 'mica' }))

await page.evaluate(() => window.ember.setSettings({ windowOpacity: 0.8 }))
const eighty = await until(() => mainLook(app), (m) => Math.abs((m.opacity ?? 1) - 0.8) < 0.01)
check('a saved opacity of 80% is applied', Math.abs((eighty.opacity ?? 1) - 0.8) < 0.01, String(eighty.opacity))
await sleep(300)
// The page only: the window's opacity is applied by Windows, outside anything a page screenshot captures.
await shot(page, 'look-05-opacity-80.png')
await page.evaluate(() => window.ember.setSettings({ windowOpacity: 0.3 }))
const floor = await until(() => mainLook(app), (m) => Math.abs((m.opacity ?? 1) - 0.6) < 0.01)
check('an opacity below 60% is held at 60%', Math.abs((floor.opacity ?? 1) - 0.6) < 0.01, String(floor.opacity))
await page.evaluate(() => window.ember.setSettings({ windowOpacity: 1 }))

// --- everything off, through the dialog, saved -------------------------------------
await openSettings()
await page.getByLabel('Window backdrop', { exact: true }).selectOption('none')
await page.getByLabel('Frost dialogs, the palette, menus and notices').uncheck()
await page.getByLabel('Glows, light on headers, and dialogs that ease in').uncheck()
await page.locator('.modal__actions .btn', { hasText: 'Save' }).click()
await until(() => page.locator('.modal').count(), (n) => n === 0, 5_000)
const saved = await stored()
check(
  'Save keeps all three',
  saved.windowBackdrop === 'none' && saved.frostedPanels === false && saved.accentEffects === false,
  JSON.stringify({ b: saved.windowBackdrop, f: saved.frostedPanels, a: saved.accentEffects })
)
const offMain = await mainLook(app)
check('and the window is solid', offMain.look?.applied === 'none', JSON.stringify(offMain))
const off = await pageLook(page)
check('and so is the page', alphaOf(off.body) === 1 && off.palette === 'plain', JSON.stringify(off))
await page.focus('.composer__input')
check('no ring without the accents', (await ringOf(page)) === 'none', await ringOf(page))
await openPalette(page)
const plainPalette = await panelOf(page, '.qp')
check('no frost without it', plainPalette?.filter === 'none' && alphaOf(plainPalette?.colour) === 1, JSON.stringify(plainPalette))
check('and nothing eases in', plainPalette?.animation === 'none', JSON.stringify(plainPalette))
await closeOverlay(page)
await sleep(300)
await shot(page, 'look-06-everything-off.png')

// ================================================================== what the system asks for
await page.evaluate(() =>
  window.ember.setSettings({ windowBackdrop: 'mica', windowOpacity: 1, frostedPanels: true, accentEffects: true })
)
await until(() => pageLook(page), (x) => x.frosted === 'on' && x.accents === 'on')

/*
 * Less motion: nothing moves. The ring stays — it is not movement — and the frost
 * stays, but no overlay animates in, rather than animating in a hundredth of a
 * millisecond under the older global rule.
 */
await page.emulateMedia({ reducedMotion: 'reduce' })
await openPalette(page)
const calm = await panelOf(page, '.qp')
const calmScrim = await panelOf(page, '.qp__scrim')
check('under reduced motion the palette does not animate', calm?.animation === 'none', JSON.stringify(calm))
check('nor its scrim', calmScrim?.animation === 'none', JSON.stringify(calmScrim))
check('but is still frosted', calm?.filter?.includes('blur'), JSON.stringify(calm))
await closeOverlay(page)
await page.focus('.composer__input')
check('and the focused pane is still ringed', (await ringOf(page))?.includes('inset'), await ringOf(page))

/*
 * A contrast theme: none of it. Chromium removes box-shadows by itself under forced
 * colours, so the ring going is not evidence and is not counted; the blur, the
 * translucent ground and the translucent panel are this app's to withdraw.
 */
await page.emulateMedia({ reducedMotion: null, forcedColors: 'active' })
await sleep(300)
const forcedLook = await pageLook(page)
check('forced colours can be emulated here', await page.evaluate(() => matchMedia('(forced-colors: active)').matches))
check('under a contrast theme the ground is solid, whatever the backdrop', alphaOf(forcedLook.body) === 1, JSON.stringify(forcedLook))
await openPalette(page)
const forcedPalette = await panelOf(page, '.qp')
check('and nothing is frosted', forcedPalette?.filter === 'none', JSON.stringify(forcedPalette))
check('or eased in', forcedPalette?.animation === 'none', JSON.stringify(forcedPalette))
await sleep(200)
await shot(page, 'look-07-forced-colours.png')
await closeOverlay(page)
await page.emulateMedia({ reducedMotion: null, forcedColors: null })

await untilNothingRuns(app)
let unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()

// ================================================================== a system without Mica
/*
 * The same defaults on a system that cannot draw a material: the window and the
 * page stay solid, with the ordinary palette, and nothing complains. Made on this
 * machine with EMBER_BACKDROP=unsupported, which main reads as "Windows 10".
 */
const solidProfile = newProfile('look-solid')
;({ app, page } = await launch(solidProfile, { EMBER_BACKDROP: 'unsupported' }))
const solid = await mainLook(app)
check('without Mica the setting still says Mica', solid.look?.requested === 'mica', JSON.stringify(solid))
check('but nothing is handed to Windows', solid.look?.applied === 'none' && solid.look?.supported === false, JSON.stringify(solid))
check('and nothing refused anything', !solid.look?.error, solid.look?.error)
const solidPage = await pageLook(page)
check('the page stays solid', solidPage.backdrop === 'none' && alphaOf(solidPage.body) === 1, JSON.stringify(solidPage))
check('with the solid palette', solidPage.palette === 'plain', JSON.stringify(solidPage))
check('and the terminal paints its own background', solidPage.termAlpha === '1', JSON.stringify(solidPage))
await page.locator('.activity__item[data-view="settings"]').click()
await page.waitForSelector('.modal', { timeout: 10_000 })
const note = await page.locator('#settings-backdrop ~ .field__note--lead').textContent()
check('and Settings says why', /cannot draw one/.test(note ?? ''), note)
await sleep(300)
await shot(page, 'look-08-unsupported.png')
await page.locator('.modal__actions .btn', { hasText: 'Cancel' }).click()

unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
solidProfile.cleanup()

for (const f of failures) console.log(`  - ${f}`)
console.log('look:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
