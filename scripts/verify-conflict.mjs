// A save never overwrites a file that changed on disk since the buffer last matched it.
//
// Nothing watched the files an editor had open, and every save wrote without
// looking: Claude Code in the next pane, `git checkout` below, Ember's own Pull
// button or a second window could change a file, and the next Ctrl+S — or an
// auto-save a second later — put the old version back with the user's one new
// keystroke on top. No prompt, and the tab reported itself cleanly saved. That is
// the workflow this app is built around, so it is the one place silent data loss
// hurts most.
//
// Each case here changes the file behind the editor's back and then saves, by every
// route that saves: Ctrl+S, auto-save and Save All. The file on disk must keep the
// change it was given; the editor must say so and offer both ways out.
//
// Run: node scripts/verify-conflict.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, workDir } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const profile = newProfile('conflict')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const dir = workDir('ember-conflict-')
const FILE = path.join(dir, 'notes.ts')
const ORIGINAL = 'export const first = 1\n'
fs.writeFileSync(FILE, ORIGINAL, 'utf8')
const read = () => fs.readFileSync(FILE, 'utf8')
/** A change made by somebody else — another program, another window, git. */
const changeOnDisk = (text) => {
  fs.writeFileSync(FILE, text, 'utf8')
  // A distinct modification time, whatever the filesystem's resolution.
  const t = new Date(Date.now() + 2000)
  fs.utimesSync(FILE, t, t)
}

// Claude Code finds the editor through a lockfile; ones already there are other
// editors', and are neither used nor touched.
const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide')
const locksBefore = new Set(fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, FILE],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
await page.waitForSelector('.monaco-editor', { timeout: 40_000 })
await sleep(2500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const typeAtEnd = async (text) => {
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text, { delay: 6 })
  await sleep(500)
}
const bar = () =>
  page.evaluate(() => {
    const el = document.querySelector('.editor__conflict')
    return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  })
const pressBar = async (label) => {
  await page.locator('.editor__conflict button', { hasText: label }).click()
  await sleep(1200)
}
const dirty = () => page.locator('.pane.editor[data-dirty="true"]').count()
// Monaco renders spaces as non-breaking ones; put them back before matching words.
const onScreen = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane.editor .view-line')]
      .map((l) => (l.textContent ?? '').replaceAll(String.fromCharCode(160), ' '))
      .join(' ')
  )

// --- Ctrl+S over a change somebody else made ------------------------------------
await typeAtEnd('// mine\n')
check('the edit reached the editor', (await dirty()) === 1)
changeOnDisk('export const first = 1\nexport const theirs = 2\n')
await page.keyboard.press('Control+S')
await sleep(1500)
check(
  'Ctrl+S leaves the other change on disk',
  read().includes('theirs') && !read().includes('// mine'),
  JSON.stringify(read())
)
const said = await bar()
check('and the editor says the file changed on disk', said !== null && /changed on disk/i.test(said), String(said))
await page.screenshot({ path: path.join(SHOT_DIR, '84-conflict-bar.png') })
check('and the edit is still unsaved, not lost', (await dirty()) === 1)

// --- Compare: seeing what each choice costs -----------------------------------------
if (said !== null) {
  await pressBar('Compare')
  const diff = await page.evaluate(() => {
    const pane = document.querySelector('.pane.diff')
    if (!pane) return null
    const labels = pane.querySelector('.editor__lang')?.textContent ?? ''
    const lines = [...pane.querySelectorAll('.view-line')].map((l) => l.textContent).join(' ')
    return `${labels} | ${lines}`
  })
  check(
    'Compare puts the version on disk beside the unsaved one',
    diff !== null && /On disk/.test(diff) && /theirs/.test(diff) && /mine/.test(diff),
    String(diff)
  )
  // Closed before going on: it is a .pane.editor too, and would be what gets typed at.
  if (diff !== null) {
    await page.locator('.pane.diff button', { hasText: 'close' }).click()
    await sleep(800)
  }
  check('and comparing changes nothing on disk', read().includes('theirs') && !read().includes('// mine'))
}

// --- Overwrite: the user's choice, made knowingly --------------------------------
if (said !== null) {
  await pressBar('Overwrite')
  check('Overwrite writes the editor’s text', read().includes('// mine'), JSON.stringify(read()))
  check('and the bar goes', (await bar()) === null)
  check('and the tab is saved', (await dirty()) === 0)
}

// --- Load from disk: the other choice ---------------------------------------------
await typeAtEnd('// second thought\n')
changeOnDisk('export const replaced = 3\n')
await page.keyboard.press('Control+S')
await sleep(1500)
check('a second conflict is caught the same way', (await bar()) !== null && read() === 'export const replaced = 3\n', JSON.stringify(read()))
if ((await bar()) !== null) {
  await pressBar('Load from disk')
  const shown = await onScreen()
  check('Load from disk shows what is on disk', /replaced/.test(shown) && !/second thought/.test(shown), shown)
  check('and the tab is clean', (await dirty()) === 0)
  check('and nothing was written', read() === 'export const replaced = 3\n', JSON.stringify(read()))
}

// --- auto-save a second later -------------------------------------------------------
// Straight through the settings IPC: the dialog's own path is verify-save's job, and
// main broadcasts the change to the window the same way either way.
await page.evaluate(() => window.ember.setSettings({ autoSaveAfterSeconds: 1 }))
await sleep(600)
await typeAtEnd('// typed before auto-save\n')
changeOnDisk('export const fromGit = 4\n')
await typeAtEnd('// and one more\n')
await sleep(3500)
check(
  'auto-save does not overwrite it either',
  read() === 'export const fromGit = 4\n',
  JSON.stringify(read())
)
check('and says so', (await bar()) !== null, String(await bar()))
await page.evaluate(() => window.ember.setSettings({ autoSaveAfterSeconds: 0 }))
if ((await bar()) !== null) await pressBar('Load from disk')

// --- Save All ---------------------------------------------------------------------
await typeAtEnd('// before save all\n')
changeOnDisk('export const again = 5\n')
await page.keyboard.press('Control+Alt+S')
await sleep(1500)
check('Save All does not overwrite it', read() === 'export const again = 5\n', JSON.stringify(read()))
check('and the editor says why', (await bar()) !== null, String(await bar()))
check('and the edit is still unsaved', (await dirty()) === 1)

// --- and a save with nothing in the way still saves ------------------------------------
if ((await bar()) !== null) await pressBar('Load from disk')
await typeAtEnd('// plain save\n')
await page.keyboard.press('Control+S')
await sleep(1200)
check('an ordinary save still writes', read().includes('// plain save'), JSON.stringify(read()))
check('and leaves no bar behind', (await bar()) === null, String(await bar()))

// --- a file deleted behind the editor is not quietly brought back -----------------
// A branch switch or a refactor in the next pane can remove a file outright. Saving
// would put it back, which is recoverable but not what anybody asked for — and an
// auto-save would do it with nobody watching. So it asks, the same way.
await typeAtEnd('// about to vanish\n')
fs.rmSync(FILE)
await page.keyboard.press('Control+S')
await sleep(1500)
check('a save does not recreate a file deleted on disk', !fs.existsSync(FILE))
const gone = await bar()
check('and the editor says it was deleted', gone !== null && /deleted/i.test(gone), String(gone))
if (gone !== null) {
  await pressBar('Save anyway')
  check('Save anyway puts it back', fs.existsSync(FILE) && read().includes('// about to vanish'))
  check('and the tab is saved', (await dirty()) === 0)
}

/*
 * --- a Claude Code session asking the editor to save ----------------------------
 *
 * The session is often the thing that changed the file: it edits on disk, then
 * asks Ember to save its open copy — and saving that copy would revert the edit
 * the session just made. Driven the way the CLI drives it, over the lockfile's
 * websocket, since the whole point is what that program is told.
 */
const lock = (fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])
  .filter((f) => f.endsWith('.lock') && !locksBefore.has(f))
  .map((f) => ({ port: Number(f.replace('.lock', '')), info: JSON.parse(fs.readFileSync(path.join(LOCK_DIR, f), 'utf8')) }))
  .find((l) => l.info.ideName === 'Ember')
check('Ember published a lockfile to be driven through', lock !== undefined)
if (lock) {
  const ws = new WebSocket(`ws://127.0.0.1:${lock.port}`, {
    headers: { 'x-claude-code-ide-authorization': lock.info.authToken }
  })
  const waiting = new Map()
  let id = 0
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m)
      waiting.delete(m.id)
    }
  })
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const mine = ++id
      waiting.set(mine, resolve)
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }))
      setTimeout(() => reject(new Error(`${method} timed out`)), 30_000)
    })
  await new Promise((resolve, reject) => (ws.on('open', resolve), ws.on('error', reject)))
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-conflict', version: '0' }
  })

  await typeAtEnd('// the editor’s copy\n')
  changeOnDisk('export const byTheSession = 6\n')
  const reply = await rpc('tools/call', { name: 'saveDocument', arguments: { filePath: FILE } })
  // Answered as a JSON document inside a text block, the way the CLI reads it.
  const text = reply.result?.content?.[0]?.text ?? JSON.stringify(reply)
  let answer = null
  try {
    answer = JSON.parse(text)
  } catch {
    // Left null: not an answer the CLI could read either.
  }
  await sleep(800)
  check(
    'a session asking the editor to save does not have its own edit reverted',
    read() === 'export const byTheSession = 6\n',
    JSON.stringify(read())
  )
  check(
    'and is told why, in words it can act on',
    answer?.success === false && /changed on disk/i.test(answer?.message ?? ''),
    text.slice(0, 200)
  )
  check('and the person is shown the question too', /changed on disk/i.test(String(await bar())), String(await bar()))
  ws.close()
}

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('save conflicts:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
