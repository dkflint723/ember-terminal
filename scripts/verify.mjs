// Launches the built app and drives it the way a user would, then reports what
// actually happened. Windows has a real display, so no xvfb wrapper is needed.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('main')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * This suite used to log and never decide.
 *
 * It printed "tab completion: FAIL" and four siblings, logged block and split counts
 * for a human to read, and then exited 0 whatever it had seen — and it is the first
 * stage of the gate, so everything it covers (blocks, exit codes, splits, sessions,
 * themes, completion, secret masking, history, the cmd.exe fallback) could break
 * without the gate noticing. Each observation is now a check against what a working
 * build shows, and the run exits nonzero when any of them fails.
 */
const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// ELECTRON_RUN_AS_NODE makes electron.exe behave as plain Node with no Electron
// APIs at all, so it has to be stripped from the inherited environment.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})

const consoleErrors = []
const page = await app.firstWindow()
await placeTopRight(app)

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    consoleErrors.push(`[${m.type()}] ${m.text()}`)
  }
})
// Console warnings are noise worth reading; an uncaught page error is a failure.
const pageErrors = []
page.on('pageerror', (e) => {
  pageErrors.push(e.message)
  consoleErrors.push(`[pageerror] ${e.message}`)
})

log('window url:', page.url())
await page.waitForSelector('.app', { timeout: 20_000 })
log('app shell mounted')

// The pane mounts, spawns a pty, and the integration script is dot-sourced a
// beat later. Wait for the composer rather than sleeping blindly.
await page.waitForSelector('.composer__input', { timeout: 20_000 })
log('composer present')

// Wait for the pane to actually report integration, not for a UI label — an
// earlier version of this check inferred readiness from badge text and silently
// passed the instant that text was renamed, letting commands be typed into a
// shell that had not finished starting.
let ready = false
try {
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 30_000 })
  ready = true
} catch {
  ready = false
}
log('shell integration ready:', ready)
check('the shell reports integration', ready)

await page.screenshot({ path: path.join(SHOT_DIR, '01-launch.png') })
log('shot: 01-launch.png')

// Drive a real command through the input editor.
await page.click('.composer__input')
await page.keyboard.type('echo ember-block-test', { delay: 20 })
await page.keyboard.press('Enter')
log('typed command + Enter')

// Wait for a finished block carrying our marker.
let blocks = []
for (let i = 0; i < 60; i++) {
  blocks = await page.evaluate(() =>
    [...document.querySelectorAll('.block')].map((el) => ({
      cls: el.className,
      cmd: el.querySelector('.block__cmd')?.textContent ?? '',
      body: (el.querySelector('.block__body')?.textContent ?? '').slice(0, 200)
    }))
  )
  if (blocks.some((b) => b.cmd.includes('ember-block-test') && !b.cls.includes('running'))) break
  await sleep(500)
}

log('--- blocks ---')
for (const b of blocks) log(JSON.stringify(b))
check(
  'a command becomes a finished block holding its own output',
  blocks.some(
    (b) =>
      b.cmd === 'echo ember-block-test' &&
      b.cls.includes('block--done') &&
      b.body.trim() === 'ember-block-test'
  ),
  JSON.stringify(blocks)
)

await page.screenshot({ path: path.join(SHOT_DIR, '02-after-command.png') })
log('shot: 02-after-command.png')

// A failing command should mark the block red and carry a non-zero exit code.
await page.click('.composer__input')
await page.keyboard.type('cmd-that-does-not-exist-xyz', { delay: 20 })
await page.keyboard.press('Enter')
for (let i = 0; i < 40; i++) {
  const failed = await page.evaluate(
    () => document.querySelectorAll('.block--failed').length > 0
  )
  if (failed) break
  await sleep(500)
}

const final = await page.evaluate(() =>
  [...document.querySelectorAll('.block')].map((el) => ({
    cls: el.className.replace('block ', ''),
    cmd: el.querySelector('.block__cmd')?.textContent ?? '',
    meta: el.querySelector('.block__meta')?.textContent ?? '',
    // The badge on its own: the meta line runs it into the clock and the duration
    // ("exit 113:23:16131ms"), so a pattern over the line matches digits it never meant.
    exit: el.querySelector('.block__exit')?.textContent ?? null,
    body: (el.querySelector('.block__body')?.textContent ?? '').slice(0, 160)
  }))
)
log('--- final blocks ---')
for (const b of final) log(JSON.stringify(b))
const failedBlock = final.find((b) => b.cmd === 'cmd-that-does-not-exist-xyz')
check(
  'a failing command marks its block failed',
  !!failedBlock && failedBlock.cls.includes('block--failed'),
  JSON.stringify(failedBlock)
)
// A command PowerShell cannot find is a cmdlet-style failure, which the integration
// reports as 1 (integration.ps1, Prompt) — not whatever native code ran last.
check('and gives it exit code 1', failedBlock?.exit === 'exit 1', String(failedBlock?.exit))

const rawHtml = await page.evaluate(
  () => document.querySelector('.block__body > div')?.innerHTML?.slice(0, 700) ?? '(none)'
)
log('--- first block body HTML ---')
log(rawHtml)

await page.screenshot({ path: path.join(SHOT_DIR, '03-failed-command.png') })
log('shot: 03-failed-command.png')

// Splits and tabs.
await page.keyboard.press('Control+Shift+KeyD')
await sleep(1500)
const afterSplit = await page.evaluate(() => ({
  panes: document.querySelectorAll('.pane').length,
  dividers: document.querySelectorAll('.divider').length
}))
log('after Ctrl+Shift+D →', JSON.stringify(afterSplit))
check(
  'Ctrl+Shift+D splits the pane',
  afterSplit.panes === 2 && afterSplit.dividers === 1,
  JSON.stringify(afterSplit)
)

await page.keyboard.press('Control+Shift+KeyE')
await sleep(1500)
const afterSecond = await page.evaluate(() => ({
  panes: document.querySelectorAll('.pane').length,
  dividers: document.querySelectorAll('.divider').length
}))
log('after Ctrl+Shift+E →', JSON.stringify(afterSecond))
check(
  'Ctrl+Shift+E splits again',
  afterSecond.panes === 3 && afterSecond.dividers === 2,
  JSON.stringify(afterSecond)
)

// Screenshot the splits while their tab is still the active one.
await page.screenshot({ path: path.join(SHOT_DIR, '04-splits.png') })
log('shot: 04-splits.png')

await page.keyboard.press('Control+Shift+KeyT')
await sleep(1500)
const cards = await page.evaluate(() => document.querySelectorAll('.sessions__card').length)
log('tabs after Ctrl+Shift+T →', cards)
check('Ctrl+Shift+T opens a second session', cards === 2, String(cards))

// Switching back must restore the split layout, not a fresh pane.
await page.evaluate(() => document.querySelector('.sessions__card')?.dispatchEvent(
  new MouseEvent('mousedown', { bubbles: true })
))
await sleep(1200)
const backOnOne = await page.evaluate(() => ({
  panes: document.querySelectorAll('.pane').length,
  blocks: document.querySelectorAll('.block').length
}))
log('back on tab 1 →', JSON.stringify(backOnOne))
check(
  'switching back restores the split layout and its blocks',
  backOnOne.panes === 3 && backOnOne.blocks === 2,
  JSON.stringify(backOnOne)
)

// Settings modal. The theme as it stood on open is what Cancel must come back to.
let tokensOnOpen = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement)
  return { bg: cs.getPropertyValue('--bg').trim(), accent: cs.getPropertyValue('--accent').trim() }
})
await page.keyboard.press('Control+Comma')
await sleep(800)
const modalOpen = await page.evaluate(() => !!document.querySelector('.modal'))
log('settings modal open:', modalOpen)
check('Ctrl+, opens Settings', modalOpen)
await page.screenshot({ path: path.join(SHOT_DIR, '05-settings.png') })
log('shot: 05-settings.png')

// Themes: the discovered list, then switching to each and reading back the
// tokens that were actually applied to the document.
const themeIds = await page.evaluate(() =>
  [...document.querySelectorAll('.field select')][0]
    ? [...document.querySelectorAll('option')]
        .map((o) => o.value)
        .filter((v) => v && !v.startsWith('pwsh') && !v.startsWith('windows') && !v.includes('.exe'))
    : []
)
log('theme options:', JSON.stringify(themeIds.slice(0, 12)))

const readTokens = () =>
  page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement)
    return {
      type: document.documentElement.dataset.themeType,
      bg: cs.getPropertyValue('--bg').trim(),
      fg: cs.getPropertyValue('--fg').trim(),
      accent: cs.getPropertyValue('--accent').trim(),
      // Proves the palette reached xterm, not just the CSS.
      xtermBg: getComputedStyle(document.querySelector('.xterm-screen') ?? document.body)
        .backgroundColor
    }
  })

for (const id of [
  'redgreen-safe-dark',
  'redgreen-safe-light',
  'blueyellow-safe-dark',
  'midnight',
  'paper'
]) {
  if (!themeIds.includes(id)) {
    check(`theme ${id} is offered`, false, 'not in the picker')
    continue
  }
  await page.selectOption('.field select', id)
  await sleep(700)
  const tokens = await readTokens()
  log(`theme ${id} →`, JSON.stringify(tokens))
  // Both halves: the document took the theme, and so did the terminal.
  const hex = tokens.bg.replace('#', '')
  const rgb =
    hex.length === 6
      ? `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`
      : null
  check(
    `theme ${id} reaches the page and the terminal`,
    tokens.type === (id.endsWith('light') || id === 'paper' ? 'light' : 'dark') && rgb === tokens.xtermBg,
    JSON.stringify(tokens)
  )
  await page.screenshot({ path: path.join(SHOT_DIR, `06-theme-${id}.png`) })
}

// Apply a light theme for real and look at it with no modal in the way — the
// scrim otherwise hides how the panes themselves render.
if (themeIds.includes('redgreen-safe-light')) {
  await page.selectOption('.field select', 'redgreen-safe-light')
  await sleep(500)
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.modal__actions .btn')]
    btns
      .find((b) => b.textContent?.includes('Save'))
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(1200)
  await page.screenshot({ path: path.join(SHOT_DIR, '07-light-applied.png') })
  log('shot: 07-light-applied.png (modal closed)')
  log('light theme live →', JSON.stringify(await readTokens()))

  // A fixed theme to reopen on. (This used to say it was putting back the default;
  // the default has been tidewater for a while, and a throwaway profile needs no
  // tidying anyway.) What matters is which theme the dialog opens with.
  await page.evaluate(() => window.ember.setSettings({ themeId: 'ember-dark' }))
  await sleep(500)
  tokensOnOpen = await readTokens()
  await page.keyboard.press('Control+Comma')
  await sleep(600)
  // Preview something else, so Cancel has something to put back.
  await page.selectOption('.field select', 'midnight')
  await sleep(600)
}

/*
 * The preview has to have changed something first. Without this, "Cancel puts the
 * theme back" is just as true of a Cancel that did nothing after a preview that did
 * nothing — which is what the reopened dialog amounted to before, with no theme
 * picked between opening and cancelling.
 */
const previewed = await readTokens()
check(
  'previewing a theme in Settings applies it before saving',
  previewed.bg !== tokensOnOpen.bg,
  `${JSON.stringify(tokensOnOpen)} → ${JSON.stringify(previewed)}`
)

// Cancel must restore the theme that was active on open.
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.modal__actions .btn')]
  btns.find((b) => b.textContent?.includes('Cancel'))?.dispatchEvent(
    new MouseEvent('click', { bubbles: true })
  )
})
await sleep(900)
const afterCancel = await readTokens()
log('after Cancel →', JSON.stringify(afterCancel))
check(
  'Cancel puts back the theme that was active on open',
  afterCancel.bg === tokensOnOpen.bg && afterCancel.accent === tokensOnOpen.accent,
  `${JSON.stringify(tokensOnOpen)} → ${JSON.stringify(afterCancel)}`
)

// Tab completion. Tab used to fall through to the browser and move focus out of
// the input, so the focus assertion matters as much as the candidates.
const completionCases = []

async function tabCase(label, text) {
  await page.click('.composer__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  await page.keyboard.type(text, { delay: 8 })
  await page.keyboard.press('Tab')
  await sleep(2200)
  const snap = await page.evaluate(() => ({
    value: document.querySelector('.composer__input')?.value ?? '',
    focusedTag: document.activeElement?.tagName ?? null,
    listCount: document.querySelectorAll('.complete__item').length,
    source: document.querySelector('.complete__foot')?.textContent?.includes('PowerShell')
      ? 'powershell'
      : document.querySelector('.complete__foot')
        ? 'paths'
        : null
  }))
  completionCases.push({ label, ...snap })
  return snap
}

// A unique cmdlet prefix completes outright.
const unique = await tabCase('unique cmdlet', 'Get-ChildIt')
// Parameter names are only reachable through the shell's own engine.
const param = await tabCase('parameter', 'Get-ChildItem -Rec')
// An ambiguous prefix opens the list.
const ambiguous = await tabCase('ambiguous', 'Get-A')
await page.screenshot({ path: path.join(SHOT_DIR, '10-completion.png') })
log('shot: 10-completion.png')
await page.keyboard.press('Escape')

for (const c of completionCases) log('completion', JSON.stringify(c))

const completionOk =
  unique.value === 'Get-ChildItem' &&
  param.value === 'Get-ChildItem -Recurse' &&
  ambiguous.listCount > 1 &&
  completionCases.every((c) => c.focusedTag === 'TEXTAREA')
log(completionOk ? 'tab completion: PASS' : 'tab completion: FAIL')
check('tab completion', completionOk, JSON.stringify(completionCases))

await page.click('.composer__input')
await page.keyboard.press('Control+A')
await page.keyboard.press('Delete')

// A no-echo prompt must mask input, and the value must never reach the
// serialized DOM. Pattern coverage is tested separately and far more thoroughly
// by scripts/test-secret-prompt.mjs.
await page.click('.composer__input')
await page.keyboard.type('$s = Read-Host -AsSecureString "Password"', { delay: 10 })
await page.keyboard.press('Enter')
await sleep(3000)

const SECRET_PROBE = 'verify-secret-must-not-leak'
await page.keyboard.type(SECRET_PROBE, { delay: 10 })
const secretState = await page.evaluate((s) => ({
  masked: !!document.querySelector('.composer__row--secret'),
  passwordInput: !!document.querySelector('input[type="password"]'),
  leakedToDom: document.documentElement.outerHTML.includes(s),
  visible: document.body.innerText.includes(s)
}), SECRET_PROBE)
await page.keyboard.press('Enter')
await sleep(3000)

log('secret prompt →', JSON.stringify(secretState))
const secretOk =
  secretState.masked && secretState.passwordInput && !secretState.leakedToDom && !secretState.visible
log(secretOk ? 'secret masking: PASS' : 'secret masking: FAIL')
check('secret masking', secretOk, JSON.stringify(secretState))

// Inline history suggestion. The ghost overlay sits next to the textarea, and
// inserting it conditionally once remounted the textarea and dropped focus — so
// focus is asserted here too, not just the suggested text.
await page.click('.composer__input')
await page.keyboard.press('Control+A')
await page.keyboard.press('Delete')
await page.keyboard.type('echo ember-bl', { delay: 12 })
await sleep(1100)
const ghostState = await page.evaluate(() => ({
  ghost: document.querySelector('.composer__ghost-rest')?.textContent ?? null,
  focusedTag: document.activeElement?.tagName ?? null
}))
await page.keyboard.press('ArrowRight')
await sleep(400)
const ghostAccepted = await page.evaluate(() => ({
  value: document.querySelector('.composer__input')?.value ?? '',
  focusedTag: document.activeElement?.tagName ?? null
}))
log('ghost suggestion →', JSON.stringify(ghostState), '→', JSON.stringify(ghostAccepted))
const ghostOk =
  !!ghostState.ghost &&
  ghostState.focusedTag === 'TEXTAREA' &&
  ghostAccepted.value === 'echo ember-block-test' &&
  ghostAccepted.focusedTag === 'TEXTAREA'
log(ghostOk ? 'history suggestion: PASS' : 'history suggestion: FAIL')
check('history suggestion', ghostOk, `${JSON.stringify(ghostState)} → ${JSON.stringify(ghostAccepted)}`)

await page.click('.composer__input')
await page.keyboard.press('Control+A')
await page.keyboard.press('Delete')

// Persistent history: the two blocks run above must be searchable, including by
// what they printed, and Enter must insert rather than run.
await page.keyboard.press('Control+r')
await sleep(1300)
const histOpen = await page.evaluate(() => !!document.querySelector('.hist'))

const histSearch = async (q) => {
  await page.click('.hist__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Delete')
  if (q) await page.keyboard.type(q, { delay: 8 })
  await sleep(1300)
  return page.evaluate(() => ({
    n: document.querySelectorAll('.hist__item').length,
    top: Array.from(document.querySelectorAll('.hist__item'))
      .slice(0, 2)
      .map((e) => e.querySelector('.hist__cmd')?.textContent)
  }))
}

const byCommand = await histSearch('ember-block-test')
const byOutput = await histSearch('not recognized')
log('history by command →', JSON.stringify(byCommand))
log('history by output  →', JSON.stringify(byOutput))

const blocksBefore = await page.evaluate(() => document.querySelectorAll('.block').length)
await histSearch('ember-block-test')
await page.keyboard.press('Enter')
await sleep(1200)
const inserted = await page.evaluate(
  (n) => ({
    closed: !document.querySelector('.hist'),
    value: document.querySelector('.composer__input')?.value ?? '',
    didNotRun: document.querySelectorAll('.block').length === n
  }),
  blocksBefore
)
log('history insert →', JSON.stringify(inserted))
const historyOk =
  histOpen &&
  byCommand.n > 0 &&
  byOutput.n > 0 &&
  inserted.closed &&
  inserted.value.includes('ember-block-test') &&
  inserted.didNotRun
log(historyOk ? 'history search: PASS' : 'history search: FAIL')
check('history search', historyOk, JSON.stringify({ histOpen, byCommand, byOutput, inserted }))

await page.click('.composer__input')
await page.keyboard.press('Control+A')
await page.keyboard.press('Delete')

// A shell with no integration hook (cmd.exe) must degrade to a plain terminal
// rather than stranding an unresolvable block. This regressed once; keep it here.
const hasCmd = await page.evaluate(async () =>
  (await window.ember.listProfiles()).some((p) => p.id === 'cmd')
)
// cmd.exe ships with every Windows; its absence is a detection bug, not a reason to skip.
check('Command Prompt is offered as a profile', hasCmd)
if (hasCmd) {
  // A reload is a boot, and boot restores the last session — which would put the
  // PowerShell panes back and never open the cmd one this check is about. Clearing
  // the session is not enough, because the window saves itself again on the way
  // out; restore is turned off so the reload is the cold start it pretends to be.
  await page.evaluate(() =>
    window.ember.setSettings({ defaultProfileId: 'cmd', restoreSession: false })
  )
  await page.reload()
  await page.waitForSelector('.app', { timeout: 20_000 })
  await sleep(4500)

  const plain = await page.evaluate(() => ({
    integration: document.querySelector('.pane')?.dataset.integration,
    composerHidden: !document.querySelector('.composer__input'),
    fullPaneTerminal: !!document.querySelector('.live--raw'),
    strandedBlocks: document.querySelectorAll('.block--running').length,
    notice: (document.querySelector('.pane__notice')?.textContent ?? '').slice(0, 60)
  }))
  log('cmd.exe fallback →', JSON.stringify(plain))

  const ok =
    plain.integration === 'absent' &&
    plain.composerHidden &&
    plain.fullPaneTerminal &&
    plain.strandedBlocks === 0
  log(ok ? 'cmd.exe fallback: PASS' : 'cmd.exe fallback: FAIL')
  check('cmd.exe fallback', ok, JSON.stringify(plain))

  await page.evaluate(() =>
    window.ember.setSettings({ defaultProfileId: null, restoreSession: true })
  )
}

log('--- console errors/warnings ---')
log(consoleErrors.length === 0 ? '(none)' : consoleErrors.slice(0, 25).join('\n'))

await app.close()
profile.cleanup()
log('closed cleanly')

for (const f of failures) log(`  - ${f}`)
if (pageErrors.length > 0) log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
log('core flow:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
