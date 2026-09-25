// Session restore, checked the only way that means anything: build a workspace,
// close the app, launch it again, and look at what came back.
//
// The app's own userData directory holds the session file, so this runs against a
// throwaway one — a verification run must not overwrite the workspace someone had
// open.
//
// Run: node scripts/verify-session.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { watchPageErrors } from './harness.mjs'
import { auditProfileDir, userDataOf, workDir } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const work = workDir('ember-session-')
const userData = path.join(work, 'userData')
const files = ['one.ts', 'two.ts', 'crlf.ts'].map((name, i) => {
  const file = path.join(work, name)
  fs.writeFileSync(file, `export const n${i} = ${i}\n`, 'utf8')
  return file
})
// Written with LF for the first session; converted to CRLF while the app is closed,
// which is what a branch switch or a colleague's editor does.
const crlf = files[2]
const CRLF_TEXT = 'export const n2 = 2\r\nexport const also = 3\r\n'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** A separate userData keeps this off the real session file. */
// Every window of every launch below reports its uncaught page errors here.
const pageErrors = []
const launch = (args) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, `--user-data-dir=${userData}`, ...args],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }).then((app) => watchPageErrors(app, pageErrors))

const shape = (page) =>
  page.evaluate(() => ({
    tabs: document.querySelectorAll('.sessions__card').length,
    panes: document.querySelectorAll('.pane').length,
    terminals: document.querySelectorAll('.pane:not(.editor)').length,
    editorTabs: Array.from(document.querySelectorAll('.etab__label')).map((l) => l.textContent),
    shownPath: document.querySelector('.pane.editor')?.getAttribute('data-editor-path') ?? null,
    dirty: document.querySelector('.pane.editor')?.getAttribute('data-dirty') ?? null,
    sidebarOpen: !!document.querySelector('.sidebar'),
    sidebarView: document.querySelector('.sidebar')?.getAttribute('data-view') ?? null,
    mode: document.querySelector('.workspace')?.getAttribute('data-mode') ?? null,
    modeButton: document.querySelector('.titlebar__mode')?.textContent?.trim() ?? null
  }))

/**
 * Bring the editors on screen before touching one.
 *
 * Every launch opens as a terminal now, whatever was restored, so the editor region
 * is in the DOM but hidden — its tabs read fine and cannot be clicked. This is the
 * one keystroke a person would use, rather than reaching past the mode into state.
 */
const showEditors = async (page) => {
  const mode = await page.evaluate(
    () => document.querySelector('.workspace')?.getAttribute('data-mode') ?? null
  )
  if (mode !== 'ide') {
    await page.keyboard.press('Control+Shift+I')
    await sleep(1200)
  }
}

// Filled in from the first launch: see the note at the session file below.
let liveUserData = userData

// --- build a workspace worth restoring --------------------------------------
{
  const app = await launch(files)
  const page = await app.firstWindow()
  liveUserData = await userDataOf(app)
  await placeTopRight(app)
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
  await sleep(2000)

  // Splitting acts on the active pane and only splits terminals, so the terminal
  // has to be focused first — opening files left the editor active.
  await page.click('.pane:not(.editor) .composer__input')
  await sleep(400)
  await page.keyboard.press('Control+Shift+D')
  await sleep(1500)
  await page.keyboard.press('Control+Shift+G')
  await sleep(800)

  await showEditors(page)

  await page.locator('.etab', { hasText: 'one.ts' }).click()
  await sleep(600)
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nconst unsavedEdit = 42\n', { delay: 8 })
  await sleep(900)

  // Enough output that the restored view has somewhere to be other than the
  // end — without overflow, "weighted to the bottom" is true of any scroll
  // position and the launch check below could never fail.
  await page.locator('.composer__input').first().click()
  await page.keyboard.type('1..160 | ForEach-Object { "restore filler line $_" }', { delay: 3 })
  await page.keyboard.press('Enter')
  await sleep(2500)

  const before = await shape(page)
  check('built three editor tabs', before.editorTabs.length === 3, JSON.stringify(before.editorTabs))
  check('with an unsaved edit', before.dirty === 'true', before.dirty)
  check('and a split', before.terminals >= 2, `${before.terminals} terminals`)
  await page.screenshot({ path: path.join(SHOT_DIR, '90-session-before.png') })

  // The debounce has to be allowed to fire before the window goes.
  await sleep(2500)
  await app.close()
  await sleep(1200)
}

/*
 * The directory the app chose, not the one it was handed. A process already
 * running elevated moves its user data into an `admin-window` profile inside it,
 * so that an administrator's Ember and an ordinary one never fight over one
 * session file — and a hosted Windows runner is elevated throughout, which is why
 * this suite reported no session file on one while the app was writing a perfectly
 * good one a directory down.
 */
const sessionFile = path.join(liveUserData, 'session.json')
check('a session file was written', fs.existsSync(sessionFile))
if (fs.existsSync(sessionFile)) {
  const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  // Version 2: a list of windows, each carrying its own version-1 snapshot.
  check('it is versioned', saved.version === 2, String(saved.version))
  check(
    'and holds one window',
    Array.isArray(saved.windows) && saved.windows.length === 1,
    String(saved.windows?.length)
  )
  check('and holds the unsaved text', JSON.stringify(saved).includes('unsavedEdit'))
  // Command output is deliberately not kept; a stale block would look live.
  check('but not terminal scrollback', !JSON.stringify(saved).includes('"blocks"'))
}

// The file moves on while nothing is watching it.
fs.writeFileSync(crlf, CRLF_TEXT, 'utf8')

// --- launch again with no arguments and see what comes back -----------------
{
  const app = await launch([])
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4000)

  /*
   * What a restored session opens as, before anything is touched.
   *
   * It used to come back as an IDE whenever the session had a file in it, so a file
   * opened once and forgotten made every launch after it an IDE, and the only way
   * back to a terminal was to close every editor. Ember opens as a terminal and
   * becomes an IDE on a keystroke; restoring is not a reason to take that choice
   * away. The files are still restored, which is what the rest of this section then
   * goes on to prove — it just has to ask for them first.
   */
  const arrived = await shape(page)
  check('a restored session opens as a terminal', arrived.mode === 'terminal', JSON.stringify(arrived.mode))
  check('with the way to its files offered', arrived.modeButton === 'IDE', arrived.modeButton)
  check('and nothing of the editor on screen', arrived.editorTabs.length === 0, JSON.stringify(arrived.editorTabs))

  /*
   * The view arrives at the end of the restored blocks and stays there while the
   * layout keeps settling. The resize below is that settling, made deterministic:
   * shrinking the window grows the distance to the end, and a pane that is
   * following must close it again on its own. Without the follow logic this is
   * exactly the launch complaint — a view parked above the end until dragged.
   */
  await sleep(1200)

  /*
   * Waited for, not slept after — and asked on both sides of the resize.
   *
   * This shrank the window by 140px and read the scroll position 800ms later. On a
   * hosted runner it reported 114px above the end, and 114 being most of 140 that
   * looked like a pane caught partway through reacting. It is not: given fifteen
   * seconds instead of 800ms it reports 114px still, the same number rather than a
   * number on its way anywhere.
   *
   * Two guesses have been spent on that number. A slower machine was the first,
   * and the wait disproved it. The GPU-less renderer a hosted runner falls back to
   * was the second, and running this here under --disable-gpu disproved that too —
   * it passes.
   *
   * So rather than guess a third time: "the restored view is at the end" is two
   * claims, and they fail for different reasons in different places. A restore
   * that never pinned the view is one bug; a resize that unpins it is another.
   * Asked separately, the answer says which.
   */
  const distanceFromEnd = () =>
    page.evaluate(() => {
      const el = document.querySelector('.pane__scroll')
      return el ? el.scrollHeight - el.scrollTop - el.clientHeight : -1
    })
  const atBottom = (d) => d >= 0 && d < 24
  const settle = async () => {
    let d = await distanceFromEnd()
    for (let waited = 0; waited < 15_000 && !atBottom(d); waited += 250) {
      await sleep(250)
      d = await distanceFromEnd()
    }
    return d
  }

  /*
   * Every pane's geometry, for a number that has now survived three explanations.
   *
   * 114px has been blamed on a slow machine, on the GPU-less renderer a hosted
   * runner falls back to, and on the follow latch clearing itself. The first two
   * were disproved by measurement and the third changed nothing. What has never
   * been looked at is the state itself — and `distanceFromEnd` reads the *first*
   * `.pane__scroll` on the page, while this window deliberately holds a split. If
   * the pane being measured is not the pane holding the output, every explanation
   * so far has been of the wrong element.
   */
  const geometry = async () =>
    JSON.stringify({
      panes: await page.evaluate(() =>
        Array.from(document.querySelectorAll('.pane__scroll')).map((el, i) => ({
          i,
          top: Math.round(el.scrollTop),
          scrollH: Math.round(el.scrollHeight),
          clientH: Math.round(el.clientHeight),
          end: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight)
        }))
      ),
      content: await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getContentSize()
      )
    })

  const restored = await settle()
  check(
    'the restored view starts at the end',
    atBottom(restored),
    `${restored}px above the end — ${await geometry()}`
  )

  const size = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0]
    const [width, height] = w.getContentSize()
    w.setContentSize(width, height - 140)
    return { width, height }
  })
  const parked = await settle()
  /*
   * Which of the two it is, asked rather than reasoned about.
   *
   * scrollTop does not move at all after the resize — it sits on the maximum it
   * had at the old height — so nothing re-pins the pane. There are exactly two
   * reasons for that: the pane no longer believes it is following, or it believes
   * it is and nothing tells it the geometry moved.
   *
   * New output separates them. It arrives through React state, so it reaches the
   * pane whether or not any observer is working, and it pins only if the pane
   * still believes it is following. If the view jumps to the end here, following
   * is intact and the resize notification is what is missing. If it stays put,
   * the belief is what was lost, and it was lost before or during the resize.
   */
  const followsNewOutput = await (async () => {
    const before = await distanceFromEnd()
    await page.locator('.composer__input').first().click()
    await page.keyboard.type('Write-Output "after-the-resize"', { delay: 4 })
    await page.keyboard.press('Enter')
    await sleep(4000)
    return { before, after: await distanceFromEnd() }
  })()
  check(
    'the restored view is weighted to the bottom',
    atBottom(parked),
    `${parked}px above the end — ${await geometry()} — new output: ${JSON.stringify(
      followsNewOutput
    )}`
  )
  await app.evaluate(({ BrowserWindow }, s) => {
    BrowserWindow.getAllWindows()[0].setContentSize(s.width, s.height)
  }, size)
  await sleep(500)

  await showEditors(page)
  const after = await shape(page)
  check('the editor tabs came back', after.editorTabs.length === 3, JSON.stringify(after.editorTabs))
  check(
    'in the same order',
    after.editorTabs.join(',') === 'one.ts,two.ts,crlf.ts',
    after.editorTabs.join(',')
  )
  check('showing the same file', after.shownPath === files[0], after.shownPath)
  check('the split came back', after.terminals >= 2, `${after.terminals} terminals`)
  check('the sidebar reopened', after.sidebarOpen === true)
  check('on the same view', after.sidebarView === 'scm', after.sidebarView)


  // The point of keeping unsaved text: it has to be in the buffer, not just the file.
  const text = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pane.editor .view-line'))
      .map((l) => l.textContent ?? '')
      .join('\n')
  )
  check('the unsaved edit survived', text.includes('unsavedEdit'), text.slice(0, 90))
  check('and is still marked unsaved', after.dirty === 'true', after.dirty)
  // Restoring the edit must not have written it to disk behind the user's back.
  check('without touching the file', !fs.readFileSync(files[0], 'utf8').includes('unsavedEdit'))

  /*
   * A file whose line endings changed while the app was closed.
   *
   * Documents are re-read from disk on restore, but the line endings used to come
   * from the snapshot — so a file converted to CRLF in between was loaded as its new
   * self and then normalised back to what it had been. That marked an untouched file
   * unsaved, and the buffer's endings are what a save writes, so the next Ctrl+S
   * rewrote every line of it. Both halves are checked, the second against the bytes.
   */
  await showEditors(page)
  await page.locator('.etab', { hasText: 'crlf.ts' }).click()
  await sleep(900)
  const converted = await shape(page)
  check('a file converted to CRLF between sessions is not marked unsaved', converted.dirty === 'false', converted.dirty)
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+s')
  await sleep(1200)
  check(
    'and saving it does not rewrite every line ending',
    fs.readFileSync(crlf, 'utf8') === CRLF_TEXT,
    JSON.stringify(fs.readFileSync(crlf, 'utf8'))
  )

  await page.screenshot({ path: path.join(SHOT_DIR, '91-session-after.png') })
  await app.close()
  await sleep(800)
}

// --- launching on a folder does not destroy the session ----------------------
/*
 * Explorer's "Open in Ember" verb on a folder, with a previous workspace saved.
 *
 * A folder argument used to skip the restore — and the session autosave is armed
 * before boot decides anything, so the one-tab workspace it started instead was
 * written over session.json about a second later. Every tab from the last session
 * and every unsaved buffer stored with it were gone, on an ordinary launch, with
 * restore switched on the whole time. The folder is now opened alongside what came
 * back rather than instead of it.
 */
{
  const app = await launch([work])
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4500)

  const landed = await shape(page)
  check('the folder gets a tab of its own', landed.tabs >= 2, `${landed.tabs} tabs`)

  // Only the active tab renders its panes, and the folder's tab is the one in front.
  await page.locator('.sessions__card').first().click()
  await sleep(1500)
  await showEditors(page)
  const opened = await shape(page)
  check(
    'launching on a folder still restores the last session',
    opened.editorTabs.length === 3,
    JSON.stringify(opened.editorTabs)
  )
  // one.ts is the tab holding the unsaved edit; crlf.ts was left in front last time.
  await showEditors(page)
  await page.locator('.etab', { hasText: 'one.ts' }).click()
  await sleep(1200)
  const text = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.pane.editor .view-line'))
      .map((l) => l.textContent ?? '')
      .join('\n')
  )
  check('with the unsaved text intact', text.includes('unsavedEdit'), text.slice(0, 90))

  // The debounce has to fire before the window goes, so the next block reads a
  // session file this launch actually wrote.
  await sleep(2500)
  await app.close()
  await sleep(1000)
}

const afterFolder = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
check(
  'and the session it wrote still holds the unsaved work',
  JSON.stringify(afterFolder).includes('unsavedEdit'),
  JSON.stringify(afterFolder).slice(0, 120)
)

// --- a session pointing at directories that have since gone ------------------
// The exact shape that broke a real launch: a workspace rooted in a temp folder
// that was later cleaned up, with shells whose directories went with it. Restoring
// it verbatim leaves the sidebar rooted at nothing and the shells unable to start.
{
  const vanished = path.join(os.tmpdir(), 'ember-session-gone-forever')
  // The file holds a list of windows now; the scenario poisons the first one's
  // snapshot, which is the shape a single-window session comes back in.
  const onDisk = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  const stale = onDisk.version === 2 ? onDisk.windows[0].snapshot : onDisk
  stale.treeRoot = vanished
  for (const pane of stale.panes) if (pane.kind === 'terminal') pane.cwd = vanished
  // Editor documents for missing files are already dropped; keep only the shells.
  stale.panes = stale.panes.filter((p) => p.kind === 'terminal')
  const keep = new Set(stale.panes.map((p) => p.id))
  const prune = (node) => {
    if (node.type === 'leaf') return keep.has(node.paneId) ? node : null
    const children = node.children.map(prune).filter(Boolean)
    if (children.length === 0) return null
    if (children.length === 1) return children[0]
    return { ...node, children, sizes: children.map(() => 1 / children.length) }
  }
  stale.tabs = stale.tabs
    .map((t) => ({ ...t, root: prune(t.root) }))
    .filter((t) => t.root)
    .map((t) => ({ ...t, activePaneId: [...keep][0] }))
  fs.writeFileSync(sessionFile, JSON.stringify(onDisk), 'utf8')

  const app = await launch([])
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  await sleep(2500)

  const recovered = await page.evaluate(() => ({
    panes: document.querySelectorAll('.pane').length,
    integration: document.querySelector('.pane')?.getAttribute('data-integration') ?? null,
    composer: !!document.querySelector('.composer__input')
  }))
  check('shells still start when their directory is gone', recovered.integration === 'ready', recovered.integration)
  check('and the pane is usable', recovered.composer === true)
  check('panes were restored, not dropped', recovered.panes >= 1, `${recovered.panes}`)

  await page.click('.activity__item[data-view="explorer"]')
  await sleep(900)
  const rootLabel = await page.evaluate(
    () => document.querySelector('.tree__root')?.textContent ?? null
  )
  // Read at all first: a label of null means the explorer never drew, and "not the
  // vanished folder" was true of that too.
  check('the explorer shows a root label', rootLabel !== null, String(rootLabel))
  check(
    'the missing workspace root is not restored',
    rootLabel !== null && rootLabel !== path.basename(vanished),
    rootLabel
  )
  await app.close()
  await sleep(600)
}

auditProfileDir(userData)
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('session restore:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
