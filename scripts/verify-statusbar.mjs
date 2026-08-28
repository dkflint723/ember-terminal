// The status bar, in both of the things this window can be.
//
// The bar is where the ambient facts went when they were taken out of the composer,
// and it carries two different sets of them: with a terminal in front of you it says
// where you are, which shell that is and what the repository looks like; with a file
// open the right-hand group becomes the caret position, the indentation, the encoding
// and the language. Both readings come from the same strip, so the thing worth
// proving is that each one is actually being read from the session rather than drawn
// once and left — a position that says "Ln 1, Col 1" forever is worse than no
// position at all, because it looks like an answer.
//
// The clickable half is checked by its consequence and never by the click. Every item
// down there is a shortcut to somewhere — the branch to source control, the counts to
// Problems, the position to go-to-line — and a button whose handler is wired to
// nothing still accepts a click perfectly well. So each one is asserted by what came
// on screen afterwards.
//
// The bar is rendered below the workspace grid and spans the whole window, under the
// activity rail as well, which is what makes it present in terminal mode and IDE mode
// alike. That is checked here too: it costs one measurement, and it is exactly the
// sort of thing a change to the grid quietly breaks — the bar would keep working and
// simply stop being visible in one of the two modes.
//
// Run: node scripts/verify-statusbar.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const profile = newProfile('statusbar')

/*
 * A repository on a branch nothing else could have produced.
 *
 * "main" or "master" would be indistinguishable from a bar that prints a plausible
 * default when it has not read anything, so the branch is named something no
 * fallback would ever guess and the check compares against that.
 */
const BRANCH = 'status-line'
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-statusbar-'))
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()

// Line 3 is where the caret checks do their moving, so it needs columns to move
// through; nothing here is meant to be interesting TypeScript.
const SAMPLE = [
  '// A file with enough lines for the caret checks below.',
  'export interface Marker {',
  '  line: number',
  '  column: number',
  '}',
  '',
  'export function describe(at: Marker): string {',
  "  return 'Ln ' + at.line + ', Col ' + at.column",
  '}',
  ''
].join('\n')
const SAMPLE_NAME = 'caret-sample.ts'

git('init', '-q', '-b', BRANCH)
git('config', 'user.email', 'verify@example.invalid')
git('config', 'user.name', 'Verify')
fs.writeFileSync(path.join(repo, SAMPLE_NAME), SAMPLE, 'utf8')
git('add', '-A')
git('commit', '-qm', 'a file to put a caret in')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// The folder argument is what makes this a workspace: the shell starts in it, so the
// bar has a working directory and a repository to report without anything being typed.
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, repo],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)

const errors = []
// Folding ranges get asked for before the server has the document on a cold start;
// the editor checks already treat this as benign for the same reason.
const BENIGN = [/foldingRange failed/]
page.on('pageerror', (e) => {
  if (BENIGN.some((re) => re.test(e.message))) return
  // Said as it happens rather than only at the end: an error that takes the renderer
  // down makes every later check fail on its own account, and the summary then
  // describes the wreckage instead of the cause.
  console.log('!! page error:', e.message.split('\n')[0])
  errors.push(e.message)
})

await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 45_000 })
await sleep(1500)

/**
 * A wait that comes back either way.
 *
 * waitForFunction throws on a timeout, which in a harness means the run stops at the
 * first thing that did not happen and everything after it goes unasked. This returns
 * false instead, so a missing item is one line in the summary and the rest still runs.
 */
const settles = (fn, arg, timeout = 8000) =>
  page.waitForFunction(fn, arg, { timeout }).then(
    () => true,
    () => false
  )

/**
 * Click an item, or record that there was nothing to click.
 *
 * Same reasoning: Playwright's click throws when the selector matches nothing, and an
 * item missing from the bar is one of the things these checks exist to catch.
 */
const clickItem = async (selector, label) => {
  if ((await page.locator(selector).count()) === 0) {
    check(label, false, `${selector} is not in the bar`)
    return false
  }
  await page.locator(selector).first().click()
  return true
}

/** Everything the bar is currently saying, plus where it is sitting while it says it. */
const bar = () =>
  page.evaluate(() => {
    const el = document.querySelector('.statusbar')
    if (!el) return null
    const clean = (node) => (node ? (node.textContent ?? '').replace(/\s+/g, ' ').trim() : null)
    const item = (name) => clean(el.querySelector(`[data-status="${name}"]`))
    const workspace = document.querySelector('.workspace')
    return {
      role: el.getAttribute('role'),
      text: clean(el),
      branch: item('branch'),
      changes: item('changes'),
      problems: item('problems'),
      cwd: item('cwd'),
      cwdTitle: el.querySelector('[data-status="cwd"]')?.getAttribute('title') ?? null,
      shell: item('shell'),
      position: item('position'),
      language: item('language'),
      indent:
        el.querySelector('[data-status="position"]')?.getAttribute('data-indent') ?? null,
      // A button with no name is read out as "button" and nothing else, so the ones
      // without a label are collected rather than counted — the summary should say
      // which item is unreachable, not how many are.
      unlabelled: Array.from(el.querySelectorAll('button'))
        .filter((b) => !(b.getAttribute('aria-label') ?? '').trim())
        .map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() || '(no text)'),
      // Inside the grid's content column now: the chips line up with the cards
      // above them and the rail and side slot run past them to the bottom edge.
      insideGrid: workspace ? workspace.contains(el) : null,
      width: Math.round(el.getBoundingClientRect().width),
      // Where the content column starts — the bar's left edge should agree with
      // the shells region's rather than with the window's.
      left: Math.round(el.getBoundingClientRect().left),
      regionLeft: Math.round(
        document.querySelector('.region--shells')?.getBoundingClientRect().left ?? -1
      ),
      windowWidth: document.documentElement.clientWidth,
      mode: workspace?.getAttribute('data-mode') ?? null
    }
  })

/** Which view the sidebar is showing, and whether the Problems list is anywhere. */
const views = () =>
  page.evaluate(() => ({
    sidebar: document.querySelector('.sidebar')?.getAttribute('data-view') ?? null,
    title: document.querySelector('.sidebar__title')?.textContent?.trim() ?? null,
    scmBranch: document.querySelector('.scm__branch')?.textContent?.trim() ?? null,
    // The Problems list renders this and nothing else does, so it answers "is the
    // Problems view on screen" wherever the view happens to have been opened.
    problems: document.querySelectorAll('.probs').length,
    problemsInPanel: document.querySelectorAll('.panel__overlay .probs').length
  }))

// --- with a terminal in front of you -----------------------------------------

// The branch is read from git after the folder is opened, so it arrives a moment
// after the window does.
const branchArrived = await settles(
  (want) => document.querySelector('[data-status="branch"]')?.textContent?.trim() === want,
  BRANCH,
  20_000
)
const terminal = await bar()
check('there is a status bar', terminal !== null)
if (terminal) {
  check('it is a status region', terminal.role === 'status', terminal.role)
  check('the window is still a terminal', terminal.mode === 'terminal', terminal.mode)

  /*
   * The directory, checked by what it names rather than by being non-empty.
   *
   * It is drawn shortened — the head dropped and marked with an ellipsis — so the
   * assertion is on the tail, which is the part that identifies the folder, with the
   * full path confirmed from the title the item carries for a hover.
   */
  const here = path.basename(repo)
  check('it names the working directory', (terminal.cwd ?? '').endsWith(here), `${terminal.cwd}`)
  /*
   * Contains rather than ends with: the tooltip carries the full path and then says
   * what clicking does, since the click browses the directory now and copying it
   * moved to the right button. The path is what this checks; the hint is allowed to
   * change wording without failing a check about the path.
   */
  check(
    'and holds the whole path for a hover',
    (terminal.cwdTitle ?? '').toLowerCase().includes(here.toLowerCase()),
    terminal.cwdTitle
  )

  /*
   * The shell, compared against the shells this machine actually has.
   *
   * Which one a fresh tab opens on depends on what is installed — PowerShell 7 where
   * it is there, Windows PowerShell where it is not — so the expected name is asked
   * of the app rather than written down here, where it would pass on one machine and
   * fail on the next.
   */
  const profileNames = await page.evaluate(async () =>
    (await window.ember.listProfiles()).map((p) => p.name)
  )
  /*
   * The shell moved off the bar and into the folder chip's tooltip: it changes
   * about never, so it keeps a hover rather than a chip. The strict read is the
   * tooltip naming a real profile; the chip row itself should no longer say it.
   */
  const namesTheShell = profileNames.some((n) => (terminal.cwdTitle ?? '').includes(n))
  check(
    'and the shell that is running there, in the folder tooltip',
    namesTheShell,
    JSON.stringify({ title: terminal.cwdTitle, profiles: profileNames })
  )
  check(
    'without spending a chip on it',
    !profileNames.some((n) => (terminal.text ?? '').includes(n)),
    terminal.text
  )

  check('the branch is reported', branchArrived && terminal.branch === BRANCH, terminal.branch)
  // UTF-8 is gone from the bar on purpose: a value that never varies is not a
  // reading, and the chips only carry facts that can change.
  check('the encoding is not taking up a chip', !terminal.text.includes('UTF-8'), terminal.text)

  /*
   * The editor group is not there yet.
   *
   * The right-hand group *becomes* the file's context when one is open; a bar that
   * shows a caret position with no editor anywhere is reporting something it cannot
   * know, and would make the check further down pass for the wrong reason.
   */
  check('nothing claims a caret position yet', terminal.position === null, terminal.position)
  check('and nothing claims a language', terminal.language === null, terminal.language)

  check(
    'every button in it has a name a screen reader can use',
    terminal.unlabelled.length === 0,
    terminal.unlabelled.join(' | ')
  )
  check(
    'the bar sits in the content column, not across the window',
    terminal.insideGrid === true &&
      terminal.width < terminal.windowWidth - 40 &&
      Math.abs(terminal.left - terminal.regionLeft) <= 2,
    JSON.stringify({
      insideGrid: terminal.insideGrid,
      width: terminal.width,
      left: terminal.left,
      regionLeft: terminal.regionLeft,
      window: terminal.windowWidth
    })
  )
}
await page.screenshot({ path: path.join(SHOT_DIR, '82-status-terminal.png') })

// --- the branch is a way into source control ----------------------------------
const beforeBranchClick = await views()
check(
  'source control is not already showing',
  beforeBranchClick.sidebar !== 'scm',
  JSON.stringify(beforeBranchClick)
)
if (await clickItem('[data-status="branch"]', 'the branch can be pressed')) {
  const opened = await settles(
    () => document.querySelector('.sidebar')?.getAttribute('data-view') === 'scm',
    undefined,
    10_000
  )
  const scm = await views()
  check('pressing the branch opens source control', opened && scm.sidebar === 'scm', JSON.stringify(scm))
  // The view, not merely the frame: a sidebar that switched its data-view and
  // rendered nothing would satisfy the attribute on its own.
  check('with the repository in it', (scm.scmBranch ?? '').includes(BRANCH), scm.scmBranch)
}

/*
 * --- the problem counts appear only when there is a problem ---------------------
 *
 * The bar showed two zeros all day, which made the one moment they changed look
 * exactly like every other moment. The chip exists only once there is something to
 * count — so with a clean workspace, the strict check is its absence. The
 * click-through it offers when present is the same showSidebarView the branch chip
 * already proves.
 */
check(
  'the problem counts stay off the bar while there are none',
  (await page.locator('[data-status="problems"]').count()) === 0,
  `${await page.locator('[data-status="problems"]').count()} problem chips`
)

// --- a file, which changes what the right-hand group is about ------------------
await page.keyboard.press('Control+p')
const quickOpen = await settles(() => !!document.querySelector('.qp__box'), undefined, 10_000)
check('quick open is reachable', quickOpen)
if (quickOpen) {
  await page.locator('.qp__box').fill('caret-sample')
  await sleep(900)
  await page.keyboard.press('Enter')
}
const editorOpened = await settles(() => !!document.querySelector('.editor .monaco-editor'), undefined, 30_000)
check('the file opened', editorOpened)
await sleep(2500)

const openedPath = await page.evaluate(
  () => document.querySelector('.editor')?.getAttribute('data-editor-path') ?? null
)
check('and it is the one that was asked for', (openedPath ?? '').endsWith(SAMPLE_NAME), openedPath)

// The caret is reported once the editor has one, which is a frame or two after the
// pane exists.
const atTheTop = await settles(
  () =>
    (document.querySelector('[data-status="position"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim() === 'Ln 1, Col 1',
  undefined,
  15_000
)
const editing = await bar()
check('there is still a status bar', editing !== null)
if (editing) {
  check('the window is now an IDE', editing.mode === 'ide', editing.mode)
  check('a freshly opened file puts the caret at the top', atTheTop, editing.position)
  check('the language is named', /typescript/i.test(editing.language ?? ''), editing.language)
  // The pane is created with tabSize 2 and spaces, so both halves of this are facts
  // about the editor rather than a guess at what looks right. The fact rides the
  // caret chip now instead of holding a chip of its own, so it is read from there.
  check('the indentation is named', /^Spaces\b/.test(editing.indent ?? ''), editing.indent)
  check('and it gives the width', /\b2\b/.test(editing.indent ?? ''), editing.indent)
  check('the encoding stays out of the chips', !editing.text.includes('UTF-8'), editing.text)
  check(
    'the new items are named too',
    editing.unlabelled.length === 0,
    editing.unlabelled.join(' | ')
  )
  // The other half of the layout check, in the mode with a second region in the grid.
  check(
    'and the bar keeps to the column as an IDE',
    editing.insideGrid === true && editing.width < editing.windowWidth - 40,
    JSON.stringify({
      insideGrid: editing.insideGrid,
      width: editing.width,
      window: editing.windowWidth
    })
  )
  // Observed rather than asserted: the design replaces the directory and the shell
  // with the file's context, and this run says which of them the bar kept.
  console.log(
    'right-hand group with a file open →',
    JSON.stringify({ cwd: editing.cwd, shell: editing.shell, position: editing.position })
  )
}
await page.screenshot({ path: path.join(SHOT_DIR, '83-status-editor.png') })

// --- the position follows the caret -------------------------------------------
//
// The whole point of the item. It is asserted as a change from one exact reading to
// another exact reading: a position stuck at the top is non-empty, well formatted and
// wrong, and a check that only asked for text would pass on it every time.
await page.click('.view-lines')
await page.keyboard.press('Control+Home')
const backToTop = await settles(
  () =>
    (document.querySelector('[data-status="position"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim() === 'Ln 1, Col 1',
  undefined,
  8000
)
check('the caret can be put back at the top', backToTop, (await bar())?.position)

const wasAtTop = (await bar())?.position ?? ''
await page.keyboard.press('ArrowDown')
await page.keyboard.press('ArrowDown')
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
const moved = await settles(
  (was) =>
    (document.querySelector('[data-status="position"]')?.textContent ?? '')
      .replace(/\s+/g, ' ')
      .trim() !== was,
  wasAtTop,
  8000
)
const afterMove = await bar()
check('moving the caret changes the position', moved, `${wasAtTop} → ${afterMove?.position}`)
check(
  'and it changes to where the caret actually is',
  afterMove?.position === 'Ln 3, Col 4',
  `${wasAtTop} → ${afterMove?.position}`
)

/*
 * --- a selection ---------------------------------------------------------------
 *
 * Optional, deliberately. The store carries a count of selected characters, so a bar
 * that reports it should report the right number — but a bar that says nothing about
 * selections is showing a position, which is what was asked for. So this fails only
 * on a count that disagrees with the five characters that were actually selected.
 */
for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowRight')
await sleep(700)
const selected = (await bar())?.position ?? ''
const reported = /(\d+)\s*(?:chars?|characters?)?\s*selected/i.exec(selected)
if (reported) {
  check('a selection is counted correctly', reported[1] === '5', selected)
} else {
  console.log('selection is not reported by the position item →', JSON.stringify(selected))
}

// --- and the position is a way into go-to-line ---------------------------------
if (await clickItem('[data-status="position"]', 'the position can be pressed')) {
  const widgetShown = await settles(
    () => {
      const w = document.querySelector('.quick-input-widget')
      if (!w) return false
      const style = getComputedStyle(w)
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        w.getBoundingClientRect().height > 0
      )
    },
    undefined,
    8000
  )
  const widget = await page.evaluate(() => {
    const input = document.querySelector('.quick-input-widget input')
    return {
      placeholder: input?.getAttribute('placeholder') ?? null,
      label: input?.getAttribute('aria-label') ?? null
    }
  })
  check('pressing the position opens a picker', widgetShown, JSON.stringify(widget))
  // Monaco asks for "a line number, optionally followed by colon and column number",
  // which is how this is told apart from the app's own quick open — which is also a
  // box with an input in it, and would otherwise satisfy the check above.
  check(
    'and it is go-to-line rather than some other picker',
    /line number/i.test(`${widget.placeholder} ${widget.label}`),
    JSON.stringify(widget)
  )
  await page.keyboard.press('Escape')
  await sleep(500)
}

await app.close()
profile.cleanup()
fs.rmSync(repo, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('status bar:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
