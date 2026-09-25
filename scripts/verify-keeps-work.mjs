// Four ways work was lost without anyone being asked, each done on purpose.
//
// Ctrl+S was registered for the whole window rather than for its editor, and the
// last editor created answered it: with two files side by side, saving the left one
// saved the right one — which had nothing to save — and left the edit where it
// was. Closing the right one left Ctrl+S calling an editor that no longer existed.
//
// Closing a window was waved through whenever session restore was on, on the
// grounds that the unsaved work would come back — but closing a window that is not
// the last deletes its session, and a buffer over 4 MB is never written into one.
// Both went without a word.
//
// Work that is still running was the loudest of them: closing a session, a pane or
// a window killed every shell under it silently, so a build, a dev server or an
// overnight test run ended on a keystroke meant for the window. Installing an
// update was worse — it latches a flag that tells every window's close handler not
// to prompt, so that door had no question behind it at all.
//
// And the lot where closed files' buffers wait to be reopened kept them by the
// exact spelling of the path, while disposing by the file. The same file arrives
// spelled differently from different places — the language server lowercases it,
// Explorer does not — so a stale entry could outlive the tab that was reopened and
// edited, and taking it out of the lot twenty files later disposed the live buffer,
// edit and all.
//
// The close prompts are the main process's own dialogs, which a test cannot click;
// the suite replaces them with one that writes down what it was asked and answers
// Cancel, so a prompt is something to count and a wrong one cannot close anything.
//
// Run: node scripts/verify-keeps-work.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('keeps-work')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-keeps-'))
const file = (name, text) => {
  const full = path.join(work, name)
  fs.writeFileSync(full, text, 'utf8')
  return full
}
const LEFT = file('left.ts', 'export const left = 1\n')
const RIGHT = file('right.ts', 'export const right = 2\n')
const SPELLED = file('spelled.ts', 'export const spelled = 3\n')
const BIG = file('big.log', 'small for now\n')
const FILLERS = Array.from({ length: 22 }, (_, i) => file(`filler-${String(i).padStart(2, '0')}.ts`, `export const f${i} = ${i}\n`))
const read = (p) => fs.readFileSync(p, 'utf8')

const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide')
const locksBefore = new Set(fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, LEFT],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await placeTopRight(app)
/*
 * The renderer's own questions, written down and answered by policy.
 *
 * Agreeing by default keeps a build that saved the wrong file from stalling the
 * run. But "nothing was asked" and "it was asked and declined" have to be told
 * apart, and the running-work question has to be declinable — cancelling is the
 * half of it that matters — so every confirm passes through here and `decline`
 * decides which ones are refused.
 */
const confirms = []
let decline = /(?!)/
page.on('dialog', (d) => {
  confirms.push(d.message())
  if (decline.test(d.message())) void d.dismiss()
  else void d.accept()
})
await page.waitForSelector('.monaco-editor', { timeout: 40_000 })
await sleep(2500)

// Every close prompt main raises is written down here and answered with Cancel.
await app.evaluate(({ dialog }) => {
  globalThis.__asked = []
  globalThis.__answer = 0
  dialog.showMessageBoxSync = (_win, options) => {
    globalThis.__asked.push(String(options?.message ?? ''))
    return globalThis.__answer
  }
  // The window's own close asks without blocking now; the install prompt still blocks.
  // Only the close question: the renderer's own confirm() arrives through this same
  // call, and answering it here took it away from the page's handler below.
  const real = dialog.showMessageBox.bind(dialog)
  dialog.showMessageBox = async (win, options) => {
    if (!String(options?.detail ?? '').startsWith('Closing now')) return real(win, options)
    globalThis.__asked.push(String(options?.message ?? ''))
    return { response: globalThis.__answer, checkboxChecked: false }
  }
})
const asked = () => app.evaluate(() => globalThis.__asked)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const quickOpen = async (name, where = page) => {
  await where.keyboard.press('Control+p')
  await where.waitForSelector('.qp__box', { timeout: 10_000 })
  await where.locator('.qp__box').fill(name)
  await sleep(700)
  await where.keyboard.press('Enter')
  await sleep(1500)
}
const typeIn = async (pane, text) => {
  await pane.locator('.view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text, { delay: 6 })
  await sleep(400)
}

// --- Ctrl+S saves the file it is pressed in -----------------------------------------
// right.ts in a split beside left.ts: the split shows left.ts again, and the right
// pane is then pointed at right.ts.
await page.locator('.pane.editor .etabs').first().click({ position: { x: 5, y: 5 } })
await page.keyboard.press('Control+Shift+D')
await sleep(1500)
check('the editor splits in two', (await page.locator('.pane.editor').count()) === 2)
await page.locator('.pane.editor').nth(1).locator('.view-lines').click()
await quickOpen('right.ts')
// By position: the split opened to the right, so it is second in the page.
const leftPane = page.locator('.pane.editor').nth(0)
const rightPane = page.locator('.pane.editor').nth(1)
check(
  'left.ts on one side and right.ts on the other',
  (await rightPane.locator('.etab--active', { hasText: 'right.ts' }).count()) === 1 &&
    (await leftPane.locator('.etab--active', { hasText: 'left.ts' }).count()) === 1
)

await typeIn(leftPane, '// saved from the left\n')
await page.keyboard.press('Control+S')
await sleep(1500)
check('Ctrl+S in the left editor saves the left file', read(LEFT).includes('saved from the left'), JSON.stringify(read(LEFT)))
check('and not the right one', read(RIGHT) === 'export const right = 2\n', JSON.stringify(read(RIGHT)))

// The right pane closed, the left one still saves: nothing is left calling an
// editor that has gone. It holds two tabs — the copy of left.ts the split made,
// and right.ts — and closes with its last one.
for (const name of ['right.ts', 'left.ts']) {
  const tab = rightPane.locator('.etab', { hasText: name }).first()
  if ((await tab.count()) === 0) continue
  await tab.hover()
  await tab.locator('.etab__close').click()
  await sleep(700)
}
check('the right pane closes', (await page.locator('.pane.editor').count()) === 1)
await typeIn(page.locator('.pane.editor').first(), '// and again after\n')
await page.keyboard.press('Control+S')
await sleep(1500)
check('Ctrl+S still saves the left file', read(LEFT).includes('and again after'), JSON.stringify(read(LEFT)))

// --- a file under two spellings survives the lot -------------------------------------
// Opened through Claude Code's bridge under a spelling nobody types — lowercase,
// forward slashes, the way a language server hands a path back — and closed.
const lock = (fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])
  .filter((f) => f.endsWith('.lock') && !locksBefore.has(f))
  .map((f) => ({ port: Number(f.replace('.lock', '')), info: JSON.parse(fs.readFileSync(path.join(LOCK_DIR, f), 'utf8')) }))
  .find((l) => l.info.ideName === 'Ember')
check('Ember published a lockfile to be driven through', lock !== undefined)
let rpc = null
if (lock) {
  const ws = new WebSocket(`ws://127.0.0.1:${lock.port}`, { headers: { 'x-claude-code-ide-authorization': lock.info.authToken } })
  const waiting = new Map()
  let id = 0
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m)
      waiting.delete(m.id)
    }
  })
  await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)))
  rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      waiting.set(mine, resolve)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }))
      setTimeout(() => reject(new Error(`${method} timed out`)), 30_000)
    })
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'verify-keeps-work', version: '0' } })
}
const closeTab = async (name) => {
  const tab = page.locator('.etab', { hasText: name }).first()
  if ((await tab.count()) === 0) return
  await tab.hover()
  await tab.locator('.etab__close').click()
  await sleep(250)
}
if (rpc) {
  const odd = SPELLED.replace(/\\/g, '/').toLowerCase()
  await rpc('tools/call', { name: 'openFile', arguments: { filePath: odd } })
  await sleep(1500)
  check('the oddly spelled path opens', (await page.locator('.etab', { hasText: 'spelled.ts' }).count()) === 1)
  await closeTab('spelled.ts')
  // Reopened the ordinary way, and edited.
  await quickOpen('spelled.ts')
  await typeIn(page.locator('.pane.editor').first(), '// the edit that must survive\n')
  check('the file is open again, with an unsaved edit', (await page.locator('.pane.editor[data-dirty="true"]').count()) === 1)
  // Twenty-two other files through the lot, more than its twenty spaces.
  for (const filler of FILLERS) {
    await rpc('tools/call', { name: 'openFile', arguments: { filePath: filler } })
    await sleep(350)
    await closeTab(path.basename(filler))
  }
  await sleep(800)
  await page.locator('.etab', { hasText: 'spelled.ts' }).first().click()
  await sleep(800)
  const kept = await page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.toLowerCase().endsWith('/spelled.ts'))
    return model && !model.isDisposed() ? model.getValue() : null
  })
  check('its buffer is still alive after the lot turned over', kept !== null, String(kept))
  check('and still holds the edit', (kept ?? '').includes('the edit that must survive'), JSON.stringify(kept))
  check('and the tab still says it is unsaved', (await page.locator('.pane.editor[data-dirty="true"]').count()) === 1)
}

// --- a second window's unsaved work ----------------------------------------------------
const second = await (async () => {
  const opened = app.waitForEvent('window', { timeout: 30_000 })
  await page.evaluate(() => window.ember.newWindow())
  return opened
})()
await second.waitForSelector('.pane[data-integration]', { timeout: 40_000 })
await sleep(2000)
// A new window has no folder to quick-open from, so the file goes in the way Claude
// Code would put it there: the bridge answers from the window in front.
const secondWindow = await app.browserWindow(second)
await secondWindow.evaluate((w) => w.focus())
await sleep(500)
if (rpc) await rpc('tools/call', { name: 'openFile', arguments: { filePath: RIGHT } })
const secondEditor = second.locator('.pane.editor .view-lines').first()
const opened = await secondEditor.waitFor({ timeout: 15_000 }).then(
  () => true,
  () => false
)
check('the second window opens a file of its own', opened)
if (opened) {
  await secondEditor.click()
  await second.keyboard.press('Control+End')
  await second.keyboard.type('// only in the second window\n', { delay: 6 })
  await sleep(1500)
}
// And something still running in it, so the one dialog has to carry both.
await second.locator('.composer__input').first().click()
await second.keyboard.type('ping -t 127.0.0.1', { delay: 5 })
await second.keyboard.press('Enter')
await second.waitForSelector('.block--running', { timeout: 20_000 })
await sleep(500)
const beforeSecond = (await asked()).length
await secondWindow.evaluate((w) => w.close())
await sleep(1500)
const afterSecond = await asked()
check('closing a window that is not the last asks about its unsaved work', afterSecond.length > beforeSecond, JSON.stringify(afterSecond))
const bothAsked = afterSecond[afterSecond.length - 1] ?? ''
check('and about what it had running, in the same breath', /unsaved changes/i.test(bothAsked) && /still running/i.test(bothAsked), JSON.stringify(bothAsked))
check('naming the command rather than counting it', /ping/i.test(bothAsked), JSON.stringify(bothAsked))

// --- work that is still running -------------------------------------------------------
// The audit's own test: run `ping -t`, close the session, and Cancel keeps the
// process alive. Cancel is the assertion — a question that does not actually stop
// the close is worse than no question, because it reads as permission asked.
//
// In a session of its own, holding nothing unsaved. Sharing one with the editors
// above would put the unsaved-work question in front of this one, and declining
// that returns before the running-work question is ever reached — so "it did not
// ask about running work" would be true for the wrong reason and the check would
// pass whatever the code did.
// The session cards are the terminal window's side slot, and this window opened
// on a file, so it is an IDE. The mode button turns it into the other thing and
// back; the editors and their unsaved edits are store state and survive the round
// trip, which is what the rest of this suite goes on to rely on.
const modeNow = () => page.evaluate(() => document.querySelector('.workspace')?.getAttribute('data-mode'))
const startedAs = await modeNow()
if (startedAs !== 'terminal') {
  await page.locator('.titlebar__mode').click()
  await page.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('data-mode') === 'terminal', { timeout: 15_000 })
  await sleep(1500)
}
check('the window is a terminal, so it has session cards', (await page.locator('.sessions__card').count()) > 0)

await page.locator('.sessions__new').click()
await sleep(500)
if ((await page.locator('.sessions__menu').count()) > 0) {
  await page.locator('.sessions__menu .titlebar__menu-item').first().click()
}
await page.waitForFunction(() => document.querySelectorAll('.sessions__card').length >= 2, { timeout: 20_000 })
await sleep(2500)
// Focused rather than clicked: a session that has run nothing draws its hint over
// the composer, and the click lands on that instead.
await page.locator('.composer__input').first().focus()
await page.keyboard.type('ping -t 127.0.0.1', { delay: 5 })
await page.keyboard.press('Enter')
await page.waitForSelector('.block--running', { timeout: 20_000 })
await sleep(500)
check('a command is running to be asked about', (await page.locator('.block--running').count()) === 1)

// Delete on the focused card, which is the path the finding names by hand — and
// the one that reached closeTab without going near the X button anybody would
// think to guard.
const tabsBefore = await page.locator('.sessions__card').count()
const closeCard = async () => {
  await page.locator('.sessions__card--on').first().focus()
  await page.keyboard.press('Delete')
  await sleep(1200)
}
decline = /still running/i
confirms.length = 0
await closeCard()
const tabQuestion = confirms.find((m) => /still running/i.test(m)) ?? ''
check('closing a session asks about the command still running in it', tabQuestion !== '', JSON.stringify(confirms))
check('and names it', /ping/i.test(tabQuestion), JSON.stringify(tabQuestion))
check('Cancel keeps the session', (await page.locator('.sessions__card').count()) === tabsBefore)
check('and Cancel keeps the process alive', (await page.locator('.block--running').count()) === 1)

// Installing an update is the door that latched the prompt off, so it has to ask
// on its own account. The stub answers Cancel, so nothing is installed here.
const beforeInstall = (await asked()).length
await page.evaluate(() => window.ember.installUpdateNow())
await sleep(2000)
const installAsked = await asked()
const installQuestion = installAsked[installAsked.length - 1] ?? ''
check('installing an update asks before ending it too', installAsked.length > beforeInstall, JSON.stringify(installAsked))
check('and names what it would end', /still running/i.test(installQuestion) && /ping/i.test(installQuestion), JSON.stringify(installQuestion))

// Stopped, and now the same close must not ask — a prompt on every close would be
// the cry-wolf version of this, and people stop reading those.
// Into the live terminal first: the keyboard is on a session card right now, and
// Ctrl+C there is a copy.
await page.locator('.xterm').first().click({ force: true })
await page.keyboard.press('Control+c')
for (let i = 0; i < 60 && (await page.locator('.block--running').count()) > 0; i++) await sleep(250)
check('the command stops', (await page.locator('.block--running').count()) === 0)
confirms.length = 0
await closeCard()
check('with nothing running, closing does not ask about running work', confirms.length === 0, JSON.stringify(confirms))
check('and the session closes', (await page.locator('.sessions__card').count()) === tabsBefore - 1)

// Back to what it was, for the editor checks below.
if (startedAs !== 'terminal') {
  await page.locator('.titlebar__mode').click()
  await page.waitForFunction(() => document.querySelector('.workspace')?.getAttribute('data-mode') === 'ide', { timeout: 15_000 })
  await sleep(1500)
}
check('the editors come back with it', (await page.locator('.pane.editor').count()) > 0)

// --- a buffer too big to keep ---------------------------------------------------------
await quickOpen('big.log')
// Asserted rather than assumed: a build where a close took the editors' session
// with it arrives here with nothing open, and a suite that throws on the way to
// its checks reports a stack trace instead of what went wrong.
const bigOpen = await page.evaluate(() =>
  window.monaco.editor.getModels().some((m) => m.uri.path.endsWith('/big.log'))
)
check('big.log opens', bigOpen)
// Five megabytes, the way a big paste arrives: one edit to the buffer.
if (bigOpen) {
  await page.evaluate(() => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('/big.log'))
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'x'.repeat(5 * 1024 * 1024) }], () => null)
  })
  await sleep(2500)
}
const bigNotice = await page.evaluate(() => document.querySelector('.notice')?.textContent ?? '')
check('a buffer too big to keep says so', /too large to keep/i.test(bigNotice), bigNotice)
const askedBefore = (await asked()).length
// Quitting: the last window's session is kept, but not this buffer.
// Last, because a build that does not ask simply quits, and the suite ends here.
let quit = false
await app.evaluate(({ app }) => app.quit()).catch(() => {
  quit = true
})
await sleep(1500)
quit = quit || page.isClosed()
const askedNow = quit ? [] : await asked().catch(() => [])
check('and quitting asks about it', !quit && askedNow.length > askedBefore, quit ? 'the app quit without asking' : JSON.stringify(askedNow))

// Cancelled, the quit leaves everything as it was. The shells, the history and
// Claude Code's bridge used to be torn down before the question was even asked, so
// Cancel kept a window whose terminals were dead.
if (!quit) {
await page.locator('.composer__input').first().click()
await page.keyboard.type('echo still-alive', { delay: 5 })
await page.keyboard.press('Enter')
const alive = await (async () => {
  for (let i = 0; i < 40; i++) {
    const ok = await page.evaluate(() =>
      [...document.querySelectorAll('.block')].some(
        (b) => b.textContent?.includes('still-alive') && b.className.includes('block--done')
      )
    )
    if (ok) return true
    await sleep(250)
  }
  return false
})()
check('after Cancel, the shell still runs commands', alive)
if (rpc) {
  const answered = await rpc('tools/call', { name: 'getOpenEditors', arguments: {} }).then(
    () => true,
    () => false
  )
  check('and Claude Code’s bridge still answers', answered)
}
}

// Let everything go now: every prompt from here answers "discard".
if (!quit) {
  await app.evaluate(() => {
    globalThis.__answer = 1
  })
  await app.close()
}
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('keeping work:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
