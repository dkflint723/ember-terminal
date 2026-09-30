// What one window may ask of main about another's shells, and where file requests go.
// Run: node scripts/verify-ipc-scope.mjs
//
// Main did whatever a window asked, of any pane (audit R25, SE-07): a second window —
// or a compromised one — could type into the first window's shell, kill it, read its
// nonce, adopt it, or spawn over it. And nothing was noted about file requests outside
// a window's folder, which is what a rule limiting them has to be built on.
//
// What it asks: from a second window, typing into, killing, adopting and spawning over
// the first window's shell all do nothing, and the first window's shell goes on; its
// nonce is not given out; ordinary work in the folder — opening a file, saving it —
// notes nothing; and a write and a read outside it are each noted in the log.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, userDataOf } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('ipcscope')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ipcscope-')))
fs.writeFileSync(path.join(dir, 'notes.txt'), 'first line\n', 'utf8')
// Outside the folder, in a place of its own: written to and read from on purpose.
const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ipcscope-outside-')))
const outsideFile = path.join(outside, 'planted.txt')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n', 'utf8')

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, dir],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const first = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
await first.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(800)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const waitFor = async (test, ms) => {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (await test()) return true
    await sleep(300)
  }
  return test()
}
const logText = async () => {
  const dataDir = await userDataOf(app)
  try {
    return fs.readFileSync(path.join(dataDir, 'ember.log'), 'utf8')
  } catch {
    return ''
  }
}
const outsideLines = async () => (await logText()).split(/\r?\n/).filter((l) => l.includes('ipc outside:'))

// --- ordinary work in the folder notes nothing ----------------------------------------
await first.keyboard.press('Control+p')
await first.waitForSelector('.qp__box', { timeout: 8_000 })
await first.locator('.qp__box').fill('notes.txt')
await sleep(500)
await first.locator('.qp__box').press('Enter')
await waitFor(
  () => first.evaluate(() => window.monaco?.editor.getEditors().some((e) => e.getModel()?.uri.path.endsWith('/notes.txt'))),
  15_000
)
await first.click('.pane.editor .view-lines')
await first.keyboard.press('Control+End')
await first.keyboard.type('second line')
await first.keyboard.press('Control+s')
await waitFor(() => fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8').includes('second line'), 10_000)
check('a file in the folder is opened and saved', fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8').includes('second line'))
await sleep(500)
const ordinary = (await outsideLines()).filter((l) => l.toLowerCase().includes(dir.toLowerCase()))
check('and nothing about it is noted as outside', ordinary.length === 0, JSON.stringify(ordinary.slice(0, 3)))

// --- a write and a read outside are noted -------------------------------------------------
await first.evaluate(async ({ file, secret }) => {
  await window.ember.writeFile(file, 'planted\n', { expect: null })
  await window.ember.readFile(secret)
}, { file: outsideFile, secret: path.join(outside, 'secret.txt') })
await sleep(500)
const noted = await outsideLines()
check('a write outside the folder is noted, with its channel', noted.some((l) => l.includes('file:write (write)') && l.includes('planted.txt')), JSON.stringify(noted.slice(-3)))
check('and so is a read', noted.some((l) => l.includes('file:read (read)') && l.includes('secret.txt')), JSON.stringify(noted.slice(-3)))

// --- a second window, and the first window's shell ------------------------------------------
const firstPane = await first.evaluate(() => document.querySelector('.pane[data-pane][data-integration]')?.getAttribute('data-pane'))
check('the first window has a shell', typeof firstPane === 'string' && firstPane.length > 0, String(firstPane))
await first.evaluate(() => window.ember.newWindow())
await sleep(4000)
const second = app.windows().find((w) => w !== first) ?? (await app.waitForEvent('window', { timeout: 30_000 }))
await second.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1000)

// Typed first, and given time to print: the spawn below would take the shell with it.
await second.evaluate((pane) => window.ember.write(pane, 'Write-Output ("TYPED-" + "FROM-THE-OTHER-WINDOW")\r'), firstPane)
await sleep(3000)
const typedIn = await first.evaluate(() => (document.body.textContent ?? '').includes('TYPED-FROM-THE-OTHER-WINDOW'))
check('what it typed never reached the shell', !typedIn)
const asked = await second.evaluate(async (pane) => {
  const nonce = await window.ember.paneNonce(pane)
  const adopted = await window.ember.adoptPanes([pane])
  const spawned = await window.ember.spawn({ paneId: pane, cols: 80, rows: 24 })
  window.ember.kill(pane)
  return { nonce, adopted, spawned }
}, firstPane)
await sleep(2500)
check('the other window is not given the shell’s nonce', !asked.nonce, JSON.stringify(asked.nonce))
check('nor can it adopt the shell', Array.isArray(asked.adopted) && asked.adopted.length === 0, JSON.stringify(asked.adopted))
check('nor spawn over it', asked.spawned?.ok === false, JSON.stringify(asked.spawned))

// The first window's shell is still there, and still its own.
await first.bringToFront()
await first.locator('.composer__input').first().focus()
await first.keyboard.type('Write-Output ("STILL-" + "HERE")', { delay: 4 })
await first.keyboard.press('Enter')
const alive = await waitFor(
  () => first.evaluate(() => [...document.querySelectorAll('.block__body')].some((b) => (b.textContent ?? '').includes('STILL-HERE'))),
  15_000
)
check('and the shell it tried to kill still answers', alive)
const refusals = (await logText()).split(/\r?\n/).filter((l) => l.includes('ipc refused:'))
check('the refusals are written down', refusals.some((l) => l.includes('pty:write')) && refusals.some((l) => l.includes('pty:kill')), JSON.stringify(refusals.slice(0, 5)))

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
fs.rmSync(outside, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('ipc scope:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
