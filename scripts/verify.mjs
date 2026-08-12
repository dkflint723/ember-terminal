// Launches the built app and drives it the way a user would, then reports what
// actually happened. Windows has a real display, so no xvfb wrapper is needed.
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ELECTRON_RUN_AS_NODE makes electron.exe behave as plain Node with no Electron
// APIs at all, so it has to be stripped from the inherited environment.
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})

const consoleErrors = []
const page = await app.firstWindow()

page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') {
    consoleErrors.push(`[${m.type()}] ${m.text()}`)
  }
})
page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))

log('window url:', page.url())
await page.waitForSelector('.app', { timeout: 20_000 })
log('app shell mounted')

// The pane mounts, spawns a pty, and the integration script is dot-sourced a
// beat later. Wait for the composer rather than sleeping blindly.
await page.waitForSelector('.composer__input', { timeout: 20_000 })
log('composer present')

// Shell integration reports in via OSC 633;Ready, which clears this badge.
let ready = false
for (let i = 0; i < 60; i++) {
  ready = await page.evaluate(() => {
    const badges = [...document.querySelectorAll('.composer__badge')]
    return !badges.some((b) => b.textContent?.includes('no blocks'))
  })
  if (ready) break
  await sleep(500)
}
log('shell integration ready:', ready)

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
    body: (el.querySelector('.block__body')?.textContent ?? '').slice(0, 160)
  }))
)
log('--- final blocks ---')
for (const b of final) log(JSON.stringify(b))

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

await page.keyboard.press('Control+Shift+KeyE')
await sleep(1500)
log(
  'after Ctrl+Shift+E →',
  JSON.stringify(
    await page.evaluate(() => ({
      panes: document.querySelectorAll('.pane').length,
      dividers: document.querySelectorAll('.divider').length
    }))
  )
)

// Screenshot the splits while their tab is still the active one.
await page.screenshot({ path: path.join(SHOT_DIR, '04-splits.png') })
log('shot: 04-splits.png')

await page.keyboard.press('Control+Shift+KeyT')
await sleep(1500)
log('tabs after Ctrl+Shift+T →', await page.evaluate(() => document.querySelectorAll('.tab').length))

// Switching back must restore the split layout, not a fresh pane.
await page.evaluate(() => document.querySelector('.tab')?.dispatchEvent(
  new MouseEvent('mousedown', { bubbles: true })
))
await sleep(1200)
log(
  'back on tab 1 →',
  JSON.stringify(
    await page.evaluate(() => ({
      panes: document.querySelectorAll('.pane').length,
      blocks: document.querySelectorAll('.block').length
    }))
  )
)

// Settings modal.
await page.keyboard.press('Control+Comma')
await sleep(800)
log('settings modal open:', await page.evaluate(() => !!document.querySelector('.modal')))
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
    log(`theme ${id}: NOT FOUND`)
    continue
  }
  await page.selectOption('.field select', id)
  await sleep(700)
  log(`theme ${id} →`, JSON.stringify(await readTokens()))
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

  // Leave the saved setting back on the default for the next run.
  await page.evaluate(() => window.ember.setSettings({ themeId: 'ember-dark' }))
  await page.keyboard.press('Control+Comma')
  await sleep(600)
}

// Cancel must restore the theme that was active on open.
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.modal__actions .btn')]
  btns.find((b) => b.textContent?.includes('Cancel'))?.dispatchEvent(
    new MouseEvent('click', { bubbles: true })
  )
})
await sleep(900)
log('after Cancel →', JSON.stringify(await readTokens()))

log('--- console errors/warnings ---')
log(consoleErrors.length === 0 ? '(none)' : consoleErrors.slice(0, 25).join('\n'))

await app.close()
log('closed cleanly')
