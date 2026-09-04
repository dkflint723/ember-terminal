// A session is a project.
//
// The workspace used to be one field on the window: one explorer, one search, one
// source control, one set of language servers, whatever you had open. So `ember A B`
// took A and ignored B, and switching sessions moved nothing — your shells, your
// open files and your scrollback stayed in one project while the sidebar described
// it whether or not that was where you were working.
//
// It now hangs off the session, which is what every other part of this app already
// believed: `newTab` takes a directory to start in, a folder opened from outside
// becomes a session rather than stealing the root, and pane lookup was scoped to the
// active session precisely because a build ran in another project's shell.
//
// Two throwaway projects, each with a script name and a needle the other does not
// have, so no check here can pass by reading the wrong project's answer.
//
// Run: node scripts/verify-workspaces.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('workspaces')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const project = (tag, script, needle) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ember-ws-${tag}-`))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: tag, scripts: { [script]: 'echo hi' } }, null, 2)
  )
  fs.writeFileSync(path.join(dir, `${tag}.txt`), `${needle}\n`)
  return dir
}

const alpha = project('alpha', 'alphabuild', 'NEEDLE-ALPHA')
const bravo = project('bravo', 'bravobuild', 'NEEDLE-BRAVO')
const nameOf = (dir) => dir.split(/[\\/]/).pop()

const launch = () =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, alpha, bravo],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

let app = await launch()
let page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane', { timeout: 40_000 })
await sleep(4000)

// --- both folders open, not just the first ------------------------------------
const cards = await page.locator('.sessions__card').count()
check('a folder each on the command line opens a session each', cards === 2, `${cards} sessions`)

/*
 * Which project a session is about, read from the view that answers it.
 *
 * The Scripts view lists the scripts of the workspace, so it cannot be satisfied by
 * anything except the root actually in force — and the two projects declare
 * differently named scripts so a stale answer is visible rather than plausible.
 */
const inMode = async (want) => {
  const now = await page.evaluate(
    () => document.querySelector('.workspace')?.getAttribute('data-mode') ?? ''
  )
  if (now !== want) {
    await page.keyboard.press('Control+Shift+I')
    await sleep(1200)
  }
}

/*
 * Sessions are listed in terminal mode and the sidebar takes that slot in IDE mode,
 * so choosing a session and reading what it is about happen on opposite faces of
 * the window. That is worth stating rather than working around silently: with the
 * sidebar up there is nothing on screen to switch sessions with.
 */
const selectSession = async (index) => {
  await inMode('terminal')
  await page.waitForSelector('.sessions__card', { timeout: 15_000 })
  // A session that is not there is reported rather than thrown: when the second
  // folder is being ignored, every check after this one has something to say about
  // what happened instead, and a crash here would hide all of it.
  if ((await page.locator('.sessions__card').count()) <= index) {
    check(`session ${index + 1} exists to switch to`, false, 'no such session')
    return
  }
  await page.locator('.sessions__card').nth(index).click()
  await sleep(1800)
}

const openScripts = async () => {
  await inMode('ide')
  if ((await page.locator('.scripts').count()) === 0) {
    await page.keyboard.press('Control+Shift+R')
    await sleep(1500)
  }
  await sleep(1200)
  return page.evaluate(() =>
    [...document.querySelectorAll('.scripts__name')].map((e) => e.textContent ?? '')
  )
}

await selectSession(0)
const first = await openScripts()
check(
  'the first session is about the first folder',
  first.includes('alphabuild') && !first.includes('bravobuild'),
  JSON.stringify(first)
)

await selectSession(1)
const second = await openScripts()
check(
  'and the second is about the second',
  second.includes('bravobuild') && !second.includes('alphabuild'),
  JSON.stringify(second)
)

/*
 * And the sidebar says which project it is describing.
 *
 * In IDE mode there is no session strip on screen, so without this the only symptom
 * of looking at the wrong project is that everything is mysteriously empty.
 */
const shown = await page.evaluate(
  () => document.querySelector('.sidebar__project')?.textContent?.trim() ?? ''
)
check('the sidebar names the project it is describing', shown === nameOf(bravo), JSON.stringify({ shown, want: nameOf(bravo) }))

/*
 * Search searches the session you are in. A needle that exists only in the other
 * project must find nothing here — the failure that matters is finding it, which
 * would mean search had stayed pointed at a project nobody was looking at.
 */
const searchFor = async (needle) => {
  await inMode('ide')
  /*
   * Only when it is not already showing. The chord that opens a view collapses the
   * sidebar when that view is the one already up — the activity bar is a toggle,
   * not just a selector — so pressing it twice searches nothing and shows nothing.
   */
  const onSearch = await page.evaluate(
    () => document.querySelector('.sidebar')?.getAttribute('data-view') === 'search'
  )
  if (!onSearch) {
    await page.keyboard.press('Control+Shift+F')
    await sleep(1200)
  }
  await page.waitForSelector('.find__box', { state: 'attached', timeout: 15_000 })
  // Focused rather than clicked: the box is in a panel that is still settling its
  // width, and what is under test is the search, not whether a pointer can reach it.
  await page.evaluate(() => document.querySelector('.find__box')?.focus())
  await page.keyboard.press('Control+A')
  await page.keyboard.type(needle, { delay: 20 })
  await sleep(3000)
  return page.evaluate(() => document.querySelectorAll('.find__hit').length)
}

const wrongProject = await searchFor('NEEDLE-ALPHA')
check(
  'search does not find the other project from here',
  wrongProject === 0,
  `${wrongProject} hits for the other project's needle`
)
const rightProject = await searchFor('NEEDLE-BRAVO')
check('and does find this one', rightProject > 0, `${rightProject} hits`)

/*
 * And the chord moves between sessions without leaving the IDE.
 *
 * Sessions are only listed in terminal mode — the sidebar takes that slot in IDE
 * mode — so with the sidebar up there is nothing on screen to switch with, and the
 * chord is the whole of the answer. It matters more now than it did: a session is a
 * project, so this is how you change projects without going back to the terminal.
 *
 * Tried with the caret in the editor as well, because Monaco claims Tab and would
 * be the thing that swallowed it.
 */
const projectShown = () =>
  page.evaluate(() => document.querySelector('.sidebar__project')?.textContent?.trim() ?? '')

await inMode('ide')
await page.keyboard.press('Control+Shift+R')
await sleep(1500)
const beforeChord = await projectShown()
await page.keyboard.press('Control+Tab')
await sleep(2000)
const afterChord = await projectShown()
check(
  'the next-session chord changes project without leaving the IDE',
  afterChord.length > 0 && afterChord !== beforeChord,
  JSON.stringify({ beforeChord, afterChord })
)

await page.keyboard.press('Control+Shift+Tab')
await sleep(2000)
check(
  'and the previous-session chord comes back',
  (await projectShown()) === beforeChord,
  JSON.stringify({ back: await projectShown(), want: beforeChord })
)

// With the caret in a file, which is where Monaco would swallow it.
await page.keyboard.press('Control+P')
await sleep(700)
await page.keyboard.type('package.json', { delay: 25 })
await page.waitForFunction(() => document.querySelectorAll('.qp__label').length > 0, {
  timeout: 20_000
})
await page.keyboard.press('Enter')
await sleep(2500)
await page.click('.monaco-editor .view-lines')
await sleep(500)
const fromEditor = await projectShown()
await page.keyboard.press('Control+Tab')
await sleep(2000)
check(
  'the chord still works with the caret in a file',
  (await projectShown()) !== fromEditor,
  JSON.stringify({ fromEditor, now: await projectShown() })
)

/*
 * And a session can be found by the project it is about.
 *
 * The one box built for finding things by name listed every session as "session"
 * and nothing else — and a shell with no integration reports the same title in
 * every project, so two sessions on two projects were an indistinguishable pair
 * exactly where you would go to tell them apart.
 */
// The title bar's search is the one box that holds sessions, files and commands
// together; Ctrl+Shift+P opens commands only, so it is not the box under test.
await page.locator('.titlebar__searchbox').click({ force: true })
await page.waitForSelector('.qp', { timeout: 15_000 })
await sleep(600)
await page.keyboard.type(nameOf(alpha), { delay: 20 })
await sleep(1200)
/*
 * Read from the detail line rather than the whole row.
 *
 * The row already contains the project, because a session's title is its shell's
 * directory — which is why the first version of this check could not fail. What is
 * under test is whether the session says which project it belongs to in its own
 * right, for the sessions whose title is not their project: one that has been given
 * a name, or one whose shell reports no directory at all.
 */
const details = await page.evaluate(() =>
  [...document.querySelectorAll('.qp__item')]
    .filter((e) => (e.querySelector('.qp__detail')?.textContent ?? '').startsWith('session'))
    .map((e) => e.querySelector('.qp__detail')?.textContent ?? '')
)
check(
  'a session says which project it is about',
  details.some((d) => d.includes(nameOf(alpha))),
  JSON.stringify(details.slice(0, 4))
)
await page.keyboard.press('Escape')
await sleep(500)

// --- and a session keeps its project across a restart -------------------------
await app.close()
await sleep(1200)

app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  // No folders this time: whatever comes back has to come back from the session file.
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
page = await app.firstWindow()
await placeTopRight(app)
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane', { timeout: 40_000 })
await sleep(5000)

await selectSession(0)
const afterRestart = await openScripts()
check(
  'a session comes back still about its own project',
  afterRestart.includes('alphabuild') && !afterRestart.includes('bravobuild'),
  JSON.stringify(afterRestart)
)

await app.close()
profile.cleanup()
fs.rmSync(alpha, { recursive: true, force: true })
fs.rmSync(bravo, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('workspaces:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
