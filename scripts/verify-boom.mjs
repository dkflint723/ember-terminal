// The last thing between a render error and a blank window, proven to stand —
// and the reload that has to put the workspace back.
//
// React unmounts the whole tree when a render throws uncaught, so before the
// boundary a single bad component left an empty black rectangle over live
// shells. This detonates a deliberate render failure through the Detonator seam
// and requires the boundary to say so, keep the message on screen, and offer a
// reload that rebuilds the window.
//
// The reload used to be the lie in that sentence. Main handed each window its
// saved snapshot once, at creation, and deleted it — so the reloaded renderer
// asked for its workspace, got nothing, opened a fresh tab, and the next autosave
// wrote that over the session file, unsaved buffers included. The shells it had
// kept running where nothing could reach them. Both were carried here as known
// bugs against RE-02 and PT-04; they are ordinary checks now.
//
// Run: node scripts/verify-boom.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, userDataOf } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
/*
 * One fault is expected here, because this suite causes it on purpose: the
 * renderer is force-crashed below to prove main notices and puts the workspace
 * back. Main writing that down is the evidence, not a failure — anything else in
 * ember.log still fails the run.
 */
const profile = newProfile('boom', { expectFaults: [/renderer gone: crashed/] })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// A folder with a file in it, so there is an unsaved edit to lose: the workspace
// the crash screen promises back is not only tabs and blocks.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-boom-'))
fs.writeFileSync(path.join(work, 'note.txt'), 'first line\n', 'utf8')

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const pageErrors = []
page.on('pageerror', (e) => {
  // The detonation itself is the one error this suite causes on purpose.
  if (!e.message.includes('ember:boom')) pageErrors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/*
 * The session file, waited for rather than slept on, and told apart rather than
 * counted.
 *
 * This was read once, nine seconds after the crash, and reported -1 for all three
 * of "not written yet", "half-written as I read it" and "not valid JSON". On a
 * hosted runner, where starting Electron is slow and the session is written about
 * a second after the workspace settles, nine seconds is a budget rather than an
 * assertion — and when it ran out the failure said `-1 tab(s)`, naming no cause
 * at all.
 */
/*
 * Asked of the app rather than assumed from the switch it was given.
 *
 * This read `<profile>/session.json`, and on a hosted runner found nothing there
 * for the whole wait. The app was saving the workspace correctly the entire time,
 * one directory down: a process already running elevated moves its user data into
 * an `admin-window` profile so an administrator's Ember and an ordinary one never
 * fight over one session file, and everything on a hosted Windows runner is
 * elevated. So the check reported lost work on a machine that had lost none.
 */
const userData = await userDataOf(app)
const sessionFile = path.join(userData, 'session.json')
const readSession = () => {
  if (!fs.existsSync(sessionFile)) return { tabs: -1, why: 'not written yet' }
  try {
    const file = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    return { tabs: file?.windows?.[0]?.snapshot?.tabs?.length ?? 0, why: 'read' }
  } catch (err) {
    // Most likely caught mid-write; worth retrying, and worth saying if it lasts.
    return { tabs: -1, why: `unreadable: ${String(err?.message ?? err).slice(0, 48)}` }
  }
}
/** Poll until the session on disk holds `want` tabs; report what it last said. */
const waitForSession = async (want, tries) => {
  let saved = readSession()
  for (let i = 0; i < tries && saved.tabs !== want; i++) {
    await sleep(500)
    saved = readSession()
  }
  return saved
}
/** What the profile actually holds, for a failure that says the file is not in it. */
const profileHolds = () => {
  const show = (d) => {
    try {
      return fs.readdirSync(d).join(', ') || '(empty)'
    } catch (err) {
      return `unreadable: ${String(err?.message ?? err).slice(0, 40)}`
    }
  }
  // Both, when they differ: which they do is the answer, and it was the listing
  // of the profile root that gave this away the first time.
  return userData === profile.dir
    ? show(profile.dir)
    : `${show(profile.dir)}; user data is ${path.basename(userData)}/ holding: ${show(userData)}`
}
const sessionDetail = (read) =>
  `${read.tabs} tab(s) in session.json — ${read.why}; profile holds: ${profileHolds()}`

/**
 * Put the session rail on screen, whatever mode the window is in.
 *
 * The rail belongs to terminal mode; an IDE window shows the file sidebar in that
 * slot instead, so `.sessions__card` is not merely unselected there, it is not
 * rendered. The chord that switches modes is a toggle, which is the trap: pressed
 * unconditionally it takes a window that was already a terminal and makes it an
 * IDE, and the count that follows reads zero sessions from a window that has two.
 * That is exactly how this suite reported `0 session(s)` beside two live shells.
 */
const showSessions = async () => {
  if ((await page.locator('.sessions__card').count()) > 0) return
  await page.locator('.pane').first().click()
  await page.keyboard.press('Control+Shift+KeyI')
  await page.waitForSelector('.sessions__card', { timeout: 10_000 }).catch(() => {})
  await sleep(400)
}

// --- a workspace worth getting back -------------------------------------------------
// A block in the first session, an unsaved edit in an editor, and a second session
// beside them: what a reload that really rebuilt the window would have to bring back.
await page.click('.composer__input')
await page.keyboard.type('echo boom-before-crash', { delay: 8 })
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => [...document.querySelectorAll('.block--done .block__body')].some((b) => b.textContent?.includes('boom-before-crash')),
  undefined,
  { timeout: 20_000 }
)

await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('note.txt')
await sleep(700)
await page.keyboard.press('Enter')
await page.waitForSelector('.pane.editor .monaco-editor', { timeout: 20_000 })
await sleep(1200)
await page.locator('.pane.editor .view-lines').click()
await page.keyboard.press('Control+End')
await page.keyboard.type('edited-before-crash', { delay: 6 })
await sleep(900)
check(
  'the edit is unsaved before the crash',
  (await page.locator('.pane.editor[data-dirty="true"]').count()) === 1,
  `${await page.locator('.pane.editor[data-dirty="true"]').count()} dirty`
)

// Out of the editor and back to a terminal window: focus is inside Monaco after
// the edit above, and a keystroke aimed at a code editor is not aimed at the
// window — which is how this step timed out the first time it ran.
await showSessions()
await page.keyboard.press('Control+Shift+KeyT')
const secondSession = await page
  .waitForFunction(() => document.querySelectorAll('.sessions__card').length === 2, undefined, {
    timeout: 10_000
  })
  .then(() => true)
  .catch(() => false)
check('a second session opens', secondSession, `${await page.locator('.sessions__card').count()} card(s)`)
/*
 * On disk before the crash, rather than assumed to be.
 *
 * This slept 2.6 seconds for the autosave's debounce and went on. The sleep was
 * almost certainly long enough; what was missing was the assertion. So when the
 * check after the crash reported no session file, there was no telling a
 * workspace main had failed to write back from one that had never been written at
 * all — and those are different faults with different fixes. Asked here, the
 * answer localises itself.
 */
const before = await waitForSession(2, 30)
check('the workspace is on disk before the crash', before.tabs === 2, sessionDetail(before))

// --- the crash ------------------------------------------------------------------
await page.evaluate(() => window.dispatchEvent(new CustomEvent('ember:boom')))
await sleep(800)

const boom = await page.evaluate(() => ({
  shown: !!document.querySelector('.boom'),
  alert: document.querySelector('.boom')?.getAttribute('role') ?? null,
  title: document.querySelector('.boom__title')?.textContent ?? '',
  error: document.querySelector('.boom__error')?.textContent ?? '',
  appGone: !document.querySelector('.pane')
}))
check('the boundary catches the render crash', boom.shown, JSON.stringify(boom))
check('and announces itself as an alert', boom.alert === 'alert', String(boom.alert))
check('saying what happened', boom.title.includes('stopped drawing'), boom.title)
check('with the actual error on screen', boom.error.includes('ember:boom'), boom.error)
check('while the broken tree is down', boom.appGone === true, String(boom.appGone))

// --- the way back ---------------------------------------------------------------
await page.locator('.boom .btn', { hasText: 'Reload the window' }).click()
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2500)
check('and the boundary stands down', (await page.locator('.boom').count()) === 0)

/*
 * What the reload brought back, which is what the boundary's own copy promises:
 * "the workspace is still saved — reloading rebuilds the window from it".
 */
// The rail on screen before anything is counted: a restored window comes back in
// whichever mode it was saved in, and only one of them shows the sessions.
await showSessions()
await sleep(600)

const sessionsBack = await page.locator('.sessions__card').count()
check('reload brings back both sessions', sessionsBack === 2, `${sessionsBack} session(s)`)

/*
 * The first session, chosen rather than assumed.
 *
 * Only the session in front has its panes mounted, and the one in front after a
 * restore is the one that was in front when the workspace was written down — the
 * second, which was created last. Asking without choosing would read a session
 * that legitimately holds neither the block nor the edit, and call that a failure
 * of the restore.
 */
if (sessionsBack > 1) {
  // Ctrl+Tab rather than a click on the card: the chord belongs to the window and
  // works whether or not the rail is showing, and from the second session — which
  // is the one a restore puts in front — one press lands on the first.
  await page.keyboard.press('Control+Tab')
  await sleep(2500)
}
const back = await page.evaluate(async () => {
  const stats = await window.ember.ptyFlowStats()
  return {
    marker: [...document.querySelectorAll('.block__body')].some((b) => b.textContent?.includes('boom-before-crash')),
    shells: Object.keys(stats).length
  }
})
check('and the first session’s blocks', back.marker, JSON.stringify(back))

/*
 * The editor is asked about in the other mode, because it only exists there.
 *
 * The editors region is rendered when the window is an IDE and not otherwise, and
 * the blocks above are only on screen when it is a terminal — so the two halves of
 * "the workspace came back" have to be asked in different modes. Counting dirty
 * editors from terminal mode reports zero for a window whose edit is perfectly
 * safe, which is exactly what this check did before it counted the panes as well.
 */
await page.keyboard.press('Control+Shift+KeyI')
await page.waitForSelector('.region--editors', { timeout: 10_000 }).catch(() => {})
await sleep(1200)
const editors = await page.evaluate(() => ({
  panes: document.querySelectorAll('.pane.editor').length,
  dirty: document.querySelectorAll('.pane.editor[data-dirty="true"]').length
}))
check('the editor comes back with the workspace', editors.panes >= 1, JSON.stringify(editors))
check('and the edit that was never saved is still unsaved', editors.dirty === 1, JSON.stringify(editors))
// Each session here has one terminal pane, so a window that adopted its shells owns
// exactly one per session; anything more is a shell still running behind the reload.
check(
  'and no shell is left running behind it',
  back.shells === sessionsBack,
  `${back.shells} shells for ${sessionsBack} session(s)`
)

// --- and a renderer that dies without asking ------------------------------------------
// The boundary only catches what React throws. A renderer killed outright leaves a
// frameless window with nothing in it and no caption buttons, which is the case the
// crash handler exists for: main puts the workspace back and reloads by itself.
/*
 * Asked of main and of the file on disk, not of the page — because the page is the
 * thing that died.
 *
 * A handle to a crashed renderer cannot be used again, and the reload gives the
 * window a new renderer that the old handle does not follow: every locator after
 * this point answers "target crashed". Reaching for the DOM here hid that behind a
 * caught exception and reported it as "0 of 2 sessions", which read like lost work
 * and was nothing of the kind.
 *
 * What matters is checkable without the renderer. The window is still there, and
 * the workspace it writes down a moment later is still the one it had — where the
 * bug this guards would have written a single empty tab over it.
 */
await app.evaluate(({ BrowserWindow }) => {
  BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
})
await sleep(9000)

const alive = await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed()).length
)
check('the window survives a killed renderer', alive >= 1, `${alive} window(s)`)

/*
 * The assertion is unchanged: the session main writes after putting the workspace
 * back still has to hold both of them. Only the clock has gone — and now that the
 * same thing is asked before the crash as well, a failure here means main did not
 * write the workspace back, rather than meaning any of the several things a bare
 * `-1 tab(s)` used to mean.
 */
const saved = await waitForSession(2, 90)
check(
  'and the workspace it saves afterwards is still both sessions',
  saved.tabs === 2,
  sessionDetail(saved)
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('crash boundary:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
