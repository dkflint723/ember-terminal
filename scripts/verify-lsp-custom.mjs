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

await app.close()
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('taught language server:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
