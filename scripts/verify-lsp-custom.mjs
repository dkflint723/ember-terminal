// A language server taught in settings, answering like it was born here.
//
// The fake server speaks real LSP over stdio and is registered the way a user
// would register rust-analyzer: one settings row. Opening a .rs file must then
// start it — spawned by main, wired through the same transport the bundled
// servers use — and a hover in the editor must show the server's own words.
//
// Run: node scripts/verify-lsp-custom.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('lspcustom')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-taught-'))
fs.writeFileSync(path.join(dir, 'main.rs'), 'fn main() {\n    let answer = 42;\n}\n', 'utf8')

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, dir],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// Teach the server first, then open the file — the way a person would.
await page.evaluate(
  ({ node, script }) =>
    window.ember.setSettings({
      languageServers: [
        {
          id: 'taught-rust',
          languageId: 'rust',
          name: 'Fake rust-analyzer',
          command: node,
          args: [script],
          extensions: ['.rs']
        }
      ]
    }),
  { node: process.execPath, script: path.join(APP_DIR, 'scripts', 'lsp-fake-server.mjs') }
)
await sleep(600)

await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('main.rs')
await sleep(500)
await page.keyboard.press('Enter')
await page.waitForSelector('.pane.editor .view-lines', { timeout: 20_000 })
await sleep(2500)

// --- the taught server is up and the file speaks its language -------------------
const language = await page.evaluate(() => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.includes('main.rs'))
  return model?.getLanguageId() ?? null
})
check('the file is recognised as rust', language === 'rust', String(language))

// --- a hover shows the server's own words ---------------------------------------
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+Home')
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await page.keyboard.press('ArrowRight')
await sleep(300)
await page.evaluate(() => {
  const editor = window.monaco.editor.getEditors().find((e) => e.hasTextFocus())
  return editor?.getAction('editor.action.showHover')?.run()
})
let hover = ''
for (let i = 0; i < 20; i++) {
  await sleep(500)
  hover = await page.evaluate(
    () => document.querySelector('.monaco-hover')?.textContent ?? ''
  )
  if (hover.includes('taught-server-answer')) break
}
check('hover answers with the taught server’s words', hover.includes('taught-server-answer'), hover.slice(0, 120))

/*
 * --- a server that never speaks LSP gives up rather than parking forever --------
 *
 * A request waits for the handshake before it starts its own ten-second clock, so
 * the guard the comment promises protected nothing that happened during the wait.
 * The gate opens on an `initialize` reply or on the child exiting, and a process
 * that spawns, lives and says nothing reaches neither — so every request against it
 * parked a promise that could never settle, one every few seconds for as long as
 * the editor was open. A wrapper script that was meant to be a language server and
 * is actually a REPL is the ordinary way to get there.
 *
 * `node -e` with a stdin reader is exactly that: alive, silent, and never a server.
 */
await page.evaluate(
  ({ node }) =>
    window.ember.setSettings({
      languageServers: [
        {
          id: 'mute-server',
          languageId: 'mutelang',
          name: 'A server that never answers',
          command: node,
          args: ['-e', 'process.stdin.resume()'],
          extensions: ['.mute']
        }
      ]
    }),
  { node: process.execPath }
)
await sleep(1200)

// Started explicitly: a request against a language with no server returns at once
// on its own guard, which is not the wait under test.
await page.evaluate((root) => window.ember.lspStart('mutelang', root), dir)
await sleep(1500)

/*
 * Raced against a timer inside the page, so a request that never settles reports a
 * failure instead of wedging the suite. Without the fix it never settles at all,
 * and a check that hangs tells nobody anything.
 */
const started = Date.now()
const answer = await page.evaluate(
  () =>
    Promise.race([
      window.ember.lspRequest('mutelang', 'textDocument/hover', {
        textDocument: { uri: 'file:///nowhere.mute' },
        position: { line: 0, character: 0 }
      }),
      new Promise((resolve) => setTimeout(() => resolve('never-settled'), 25_000))
    ]),
  undefined
)
const waited = Date.now() - started
check(
  'a request to a silent server gives up rather than waiting forever',
  answer !== 'never-settled',
  `still waiting after ${waited} ms`
)
check('and answers with nothing rather than hanging its caller', answer === null, JSON.stringify(answer))

/*
 * --- a server that cannot start says why, in the Output panel -----------------
 *
 * A missing toolchain, a version refused, a wrapper script that fails: a server
 * that dies before its handshake explains itself on stderr and nowhere else, and
 * stderr was read only into a trace file an environment variable had to name. The
 * Output panel showed log messages, which such a server never sends, and only those
 * that arrived while it was open. This one says two things and exits — and the panel
 * is opened only afterwards, the way anyone would go looking.
 */
const KEY = 'sk-ant-api03-EmberLspNotARealKey0123456789abcdef'
await page.evaluate(
  ({ node, key }) =>
    window.ember.setSettings({
      languageServers: [
        {
          id: 'broken-server',
          languageId: 'brokenlang',
          name: 'A server whose toolchain is missing',
          command: node,
          args: [
            '-e',
            `console.error('ember:stderr the brokenlang toolchain is not installed');` +
              `console.error('ember:stderr tried with token ${key}');` +
              // A progress line redrawn with bare carriage returns, and one very long line.
              `process.stderr.write('ember:stderr progress 10%' + String.fromCharCode(13) + 'ember:stderr progress 20%' + String.fromCharCode(13));` +
              `process.stderr.write('ember:stderr long ' + 'x'.repeat(20000) + String.fromCharCode(10));` +
              `setTimeout(() => process.exit(3), 100)`
          ],
          extensions: ['.broken']
        }
      ]
    }),
  { node: process.execPath, key: KEY }
)
await sleep(1200)
await page.evaluate((root) => window.ember.lspStart('brokenlang', root), dir)
// Gone before anyone looks: the panel is opened only once the server has exited.
let backlog = []
for (let i = 0; i < 40 && backlog.length < 2; i += 1) {
  await sleep(250)
  backlog = await page.evaluate(() =>
    (window.ember.lspStderr?.() ?? Promise.resolve([])).then((lines) => lines.filter((l) => l.text.includes('ember:stderr')))
  )
}
check('main keeps what the server wrote to stderr', backlog.length >= 2, JSON.stringify(backlog))
const everything = await page.evaluate(() => (window.ember.lspStderr?.() ?? Promise.resolve([])))
check(
  'a carriage return ends a line, so a progress bar is lines rather than one line growing',
  everything.some((l) => l.text === 'ember:stderr progress 10%') && everything.some((l) => l.text === 'ember:stderr progress 20%'),
  JSON.stringify(everything.filter((l) => l.text.includes('progress')).map((l) => l.text.slice(0, 60)))
)
const longest = Math.max(0, ...everything.map((l) => l.text.length))
check('and one line is clipped rather than kept whole', longest > 0 && longest <= 4_010, `${longest} characters`)

if ((await page.locator('.panel__tab', { hasText: 'Output' }).count()) === 0) {
  await page.keyboard.press('Control+j')
  await page.waitForSelector('.panel__tab', { timeout: 5_000 }).catch(() => {})
}
await page.locator('.panel__tab', { hasText: 'Output' }).click()
let shown = []
for (let i = 0; i < 40; i += 1) {
  shown = await page.evaluate(() =>
    [...document.querySelectorAll('.output__line--stderr')].map((l) => l.textContent ?? '')
  )
  if (shown.some((t) => t.includes('toolchain is not installed'))) break
  await sleep(250)
}
check(
  'the Output panel, opened after the server died, shows why it died',
  shown.some((t) => t.includes('brokenlang') && t.includes('the brokenlang toolchain is not installed')),
  JSON.stringify(shown.slice(0, 4))
)
/*
 * A server that dies is started again, up to three times, and says the same thing
 * each time — so identical lines are expected. What must hold is that the backlog
 * fetched on opening and the lines streamed meanwhile are not both shown: the panel
 * holds exactly the lines main kept.
 */
await sleep(4000)
const kept = await page.evaluate(() =>
  (window.ember.lspStderr?.() ?? Promise.resolve([])).then((lines) => lines.filter((l) => l.text.includes('toolchain is not installed')).length)
)
const onScreen = await page.evaluate(
  () =>
    [...document.querySelectorAll('.output__line--stderr')].filter((l) =>
      (l.textContent ?? '').includes('toolchain is not installed')
    ).length
)
check('each line shown once: as many on screen as main kept', kept > 0 && onScreen === kept, `${onScreen} shown, ${kept} kept`)
check(
  'and without the key it quoted',
  shown.some((t) => t.includes('tried with token [redacted]')) && !shown.some((t) => t.includes(KEY)),
  JSON.stringify(shown.filter((t) => t.includes('tried with token')))
)

/*
 * --- a server that never answers cannot hold up Ctrl+S --------------------------
 *
 * Format on save asked the language server and waited for it, and a request on the
 * editor's channel had no deadline at all: a server that was busy, wedged or slow
 * held the save for as long as it stayed that way, with nothing on screen to say
 * why. This one offers formatting and never answers it, and notes what it is told.
 */
const noteFile = path.join(dir, 'mute-server-notes.txt')
fs.writeFileSync(path.join(dir, 'slow.rb'), 'puts "hello"\n', 'utf8')
await page.evaluate(
  ({ node, script, notes }) =>
    window.ember.setSettings({
      formatOnSave: true,
      languageServers: [
        {
          id: 'mute-formatter',
          languageId: 'ruby',
          name: 'A server that formats too late',
          command: node,
          args: [script, '--slow-formatting', '8000', '--note', notes],
          extensions: ['.rb']
        }
      ]
    }),
  { node: process.execPath, script: path.join(APP_DIR, 'scripts', 'lsp-fake-server.mjs'), notes: noteFile }
)
await sleep(800)
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('slow.rb')
await sleep(500)
await page.keyboard.press('Enter')
await page.waitForFunction(
  () => window.monaco.editor.getModels().some((m) => m.uri.path.endsWith('slow.rb') && m.getLanguageId() === 'ruby'),
  null,
  { timeout: 20_000 }
)
// The server up and holding the document before anything is asked of it.
await sleep(2500)
await page.evaluate(() => {
  const editor = window.monaco.editor.getEditors().find((e) => e.getModel()?.uri.path.endsWith('slow.rb'))
  editor?.focus()
})
await page.keyboard.press('Control+End')
await page.keyboard.type('# typed before saving\n', { delay: 5 })
const savedAt = Date.now()
await page.keyboard.press('Control+s')
const onDisk = () => fs.readFileSync(path.join(dir, 'slow.rb'), 'utf8')
let saveWaited = null
for (let until = Date.now() + 12_000; Date.now() < until; ) {
  if (onDisk().includes('# typed before saving')) {
    saveWaited = Date.now() - savedAt
    break
  }
  await sleep(100)
}
check('a save is not held by a server slow to format', saveWaited !== null && saveWaited < 4_000, saveWaited === null ? 'not saved after 12 s' : `${saveWaited} ms`)
const notes = () => (fs.existsSync(noteFile) ? fs.readFileSync(noteFile, 'utf8') : '')
check('the server was really asked to format — this is not a save that skipped it', /asked textDocument\/formatting/.test(notes()), notes() || '(nothing noted)')
const askedId = (/asked textDocument\/formatting (\S+)/.exec(notes()) ?? [])[1]
check(
  'and was told to stop that same request',
  askedId !== undefined && new RegExp(`^cancel ${askedId}$`, 'm').test(notes()),
  notes() || '(nothing noted)'
)
/*
 * The server answers anyway, eight seconds after it was asked, with an
 * edit. That answer is about a file already saved, and must change nothing.
 */
const savedText = onDisk()
for (let until = Date.now() + 14_000; !/^answered /m.test(notes()) && Date.now() < until; ) await sleep(200)
check('the server did answer, late — so what follows is tested, not assumed', /^answered /m.test(notes()), notes())
await sleep(1500)
const buffer = await page.evaluate(
  () => window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('slow.rb'))?.getValue() ?? ''
)
check('its late answer is not applied to the buffer', !buffer.includes('# formatted late'), JSON.stringify(buffer.slice(0, 80)))
check('what was saved stays as it was saved', onDisk() === savedText)
const dirty = await page.evaluate(
  () => [...document.querySelectorAll('[data-dirty]')].map((el) => el.getAttribute('data-dirty'))
)
check('and the file is not marked unsaved', dirty.length > 0 && dirty.every((d) => d === 'false'), JSON.stringify(dirty))

/*
 * --- an edit nobody asked for ----------------------------------------------------
 *
 * Ember now applies the edits a language server sends — which is how refactorings
 * reach the editor — but only while a command someone ran is asking for them. This
 * server, once a file opens, asks to change it unprompted. The file must stay as it
 * was, and the server must be told no.
 */
const pushNotes = path.join(dir, 'push-notes.txt')
fs.writeFileSync(path.join(dir, 'pushed.go'), 'package main\n', 'utf8')
await page.evaluate(
  ({ node, script, notes }) =>
    window.ember.setSettings({
      formatOnSave: false,
      languageServers: [
        {
          id: 'pushy',
          languageId: 'go',
          name: 'A server that edits unprompted',
          command: node,
          args: [script, '--push-edit', '--note', notes],
          extensions: ['.go']
        }
      ]
    }),
  { node: process.execPath, script: path.join(APP_DIR, 'scripts', 'lsp-fake-server.mjs'), notes: pushNotes }
)
await sleep(800)
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('pushed.go')
await sleep(500)
await page.keyboard.press('Enter')
const pushAnswer = () => (fs.existsSync(pushNotes) ? fs.readFileSync(pushNotes, 'utf8') : '')
for (let until = Date.now() + 20_000; !/^answered push-1 /m.test(pushAnswer()) && Date.now() < until; ) await sleep(300)
const pushedText = await page.evaluate(
  () => window.monaco.editor.getModels().find((m) => m.uri.path.toLowerCase().endsWith('/pushed.go'))?.getValue() ?? null
)
check('an edit the server sends unprompted is answered', /^answered push-1 /m.test(pushAnswer()), pushAnswer() || '(no answer noted)')
check('and refused', /answered push-1 \{"applied":false/.test(pushAnswer()), pushAnswer())
check('and the file is as it was', pushedText === 'package main\n', JSON.stringify(pushedText))

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('taught language server:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
