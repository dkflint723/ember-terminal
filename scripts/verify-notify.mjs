// Long-command notifications.
//
// `Notification.prototype.show` is replaced in the main process, so the whole path
// is exercised — threshold in the renderer, focus suppression in main — while
// nothing is actually shown. A verification run should not leave real toasts in
// someone's Action Center.
//
// Run: node scripts/verify-notify.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('notify')
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

// Recorded rather than displayed. Everything up to the toast still runs.
await app.evaluate(({ Notification }) => {
  globalThis.__shown = []
  Notification.prototype.show = function () {
    globalThis.__shown.push({ title: this.title, body: this.body })
  }
})
const shown = () => app.evaluate(() => globalThis.__shown)

const supported = await page.evaluate(() => window.ember.notificationsSupported())
check('the platform supports notifications', supported === true, String(supported))

/*
 * Minimised, not merely blurred. `BrowserWindow.blur()` leaves `isFocused()` true,
 * so it would not exercise the suppression at all — which is how the first version
 * of this check passed while testing nothing.
 */
const foreground = () =>
  app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w?.restore()
    w?.focus()
  })
const background = () =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.minimize())

/**
 * Type and submit, then decide where the window is, because the decision is made
 * when the command finishes.
 *
 * Polled from here rather than with waitForFunction, which runs in the page and
 * can stall in a window that is deliberately in the background. `evaluate` does not.
 */
const run = async (command, { away }) => {
  await foreground()
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 5 })
  await page.keyboard.press('Enter')
  if (away) await background()

  for (let i = 0; i < 80; i++) {
    await sleep(500)
    const running = await page.evaluate(() => document.querySelectorAll('.block--running').length)
    if (running === 0) return
  }
  throw new Error(`command never finished: ${command}`)
}

/**
 * Set the threshold the way a person would.
 *
 * Not via `window.ember.setSettings`, which persists to disk but does not update
 * the renderer's copy — the controller reads the store, so a direct write leaves it
 * running on the old value and the check silently measures nothing.
 */
const setThreshold = async (seconds) => {
  await foreground()
  await page.keyboard.press('Control+Comma')
  await page.waitForSelector('.modal', { timeout: 10_000 })
  const input = page.locator('.field', { hasText: 'Notify after' }).locator('input')
  await input.fill(String(seconds))
  await page.evaluate(() => {
    const save = [...document.querySelectorAll('.modal__actions .btn')].find((b) =>
      b.textContent?.includes('Save')
    )
    save?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await sleep(900)
}

await setThreshold(2)

// --- too quick to be worth mentioning ---------------------------------------
await run('echo quick-one', { away: true })
await sleep(900)
check('a quick command says nothing', (await shown()).length === 0, JSON.stringify(await shown()))

// --- long, but the user is already looking at it ----------------------------
await run('Start-Sleep -Seconds 3', { away: false })
await sleep(900)
check('a long command says nothing while focused', (await shown()).length === 0, JSON.stringify(await shown()))

// --- long, and the user is elsewhere: the case this exists for --------------
await run('Start-Sleep -Seconds 3', { away: true })
await sleep(1200)
const raised = await shown()
check('a long command in the background notifies', raised.length === 1, JSON.stringify(raised))
if (raised.length === 1) {
  check('it says how long it took', /Finished in \d/.test(raised[0].title), raised[0].title)
  check('and which command it was', raised[0].body.includes('Start-Sleep'), raised[0].body)
}

// --- a failure reads differently --------------------------------------------
// Not `exit 1`, which in PowerShell exits the shell itself rather than the
// command — the pane would be dead for every check after this one.
await run('Start-Sleep -Seconds 3; cmd-that-does-not-exist-xyz', { away: true })
await sleep(1200)
const all = await shown()
check('a failing command notifies too', all.length === 2, `${all.length} shown`)
if (all.length === 2) check('and says it failed', /^Failed after/.test(all[1].title), all[1].title)

// --- zero turns it off -------------------------------------------------------
await setThreshold(0)
await run('Start-Sleep -Seconds 3', { away: true })
await sleep(1200)
check('zero disables it', (await shown()).length === 2, `${(await shown()).length} shown`)

await foreground()
await app.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('notifications:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
