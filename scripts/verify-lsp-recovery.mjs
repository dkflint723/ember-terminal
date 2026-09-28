// A language server that crashes comes back, documents and all.
//
// The renderer's client cannot be rebuilt — its providers register with Monaco
// once — so main hides the crash: respawn, replay the handshake it kept, then
// have the renderer re-open its documents. This kills the real server process
// out from under a real session and requires the squiggles to return: not
// merely a new process, but a new process that knows the file again.
//
// Run: node scripts/verify-lsp-recovery.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('lsp-recovery')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// One file with one deliberate type error, so "the server is alive and knows
// the document" is observable as exactly one squiggle.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-lsp-recovery-'))
fs.writeFileSync(
  path.join(work, 'broken.ts'),
  'const wrong: number = "not a number"\nexport default wrong\n',
  'utf8'
)
fs.writeFileSync(path.join(work, 'tsconfig.json'), '{ "compilerOptions": { "strict": true } }', 'utf8')

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, path.join(work, 'broken.ts')],
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

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const squiggles = () => page.evaluate(() => document.querySelectorAll('.squiggly-error').length)
const waitForSquiggles = async (atLeast, ms) => {
  const start = Date.now()
  for (;;) {
    const n = await squiggles()
    if (n >= atLeast) return n
    if (Date.now() - start > ms) return n
    await sleep(500)
  }
}

// The editor opens as an IDE holding broken.ts; the server proves itself by
// underlining the deliberate mistake.
const before = await waitForSquiggles(1, 45_000)
check('the server marks the deliberate error', before >= 1, `${before} squiggles`)

/** Every typescript-language-server process, found by its own command line. */
const serverPids = () => {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name like '%node%' or Name like '%electron%'\" | Where-Object { $_.CommandLine -like '*typescript-language-server*' } | Select-Object -ExpandProperty ProcessId"
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  return out ? out.split(/\s+/).map(Number) : []
}

const original = serverPids()
check('the server process is findable', original.length >= 1, JSON.stringify(original))

// The crash, delivered from outside — exactly what a real tsserver OOM does.
for (const pid of original) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
  } catch {
    // Already gone is fine.
  }
}

// Recovery: a NEW process appears (backoff starts at one second)...
let revived = []
{
  const start = Date.now()
  for (;;) {
    revived = serverPids().filter((pid) => !original.includes(pid))
    if (revived.length >= 1 || Date.now() - start > 30_000) break
    await sleep(500)
  }
}
check('a fresh server process appears on its own', revived.length >= 1, JSON.stringify(revived))

// ...and it knows the document again: a SECOND error typed after the crash
// must gain a second squiggle, which needs the replayed didOpen to have
// carried the file and the diagnostics pipeline to be live end to end.
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst alsoWrong: string = 42\n', { delay: 10 })
const after = await waitForSquiggles(2, 45_000)
check('and it underlines new mistakes in the same buffer', after >= 2, `${after} squiggles`)

/*
 * --- restarted by hand, from the palette ---------------------------------------
 *
 * A server that has gone wrong without dying could only be put right by
 * restarting Ember. "Restart language server" does it for the language of the file
 * in front of you, through the same path as a crash: a new process that knows the
 * document.
 */
const runCommand = async (label) => {
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+Shift+P')
  await page.waitForSelector('.qp__box', { timeout: 10_000 })
  await page.locator('.qp__box').fill(label)
  await sleep(400)
  const offered = await page.evaluate(() => document.querySelector('.qp__item--on')?.textContent ?? '')
  await page.keyboard.press('Enter')
  // Offered nothing, the palette stays up over the editor; closed, so the checks
  // after this say what went wrong rather than a click timing out.
  await sleep(300)
  if (await page.locator('.qp').count()) await page.keyboard.press('Escape')
  return offered
}
const newServer = async (known, ms = 30_000) => {
  const start = Date.now()
  for (;;) {
    const fresh = serverPids().filter((pid) => !known.includes(pid))
    if (fresh.length >= 1 || Date.now() - start > ms) return fresh
    await sleep(300)
  }
}
const seen = [...original, ...revived]
const offered = await runCommand('Restart language server')
check('the palette offers "Restart language server"', /Restart language server/.test(offered), offered || '(nothing offered)')
const byHand = await newServer(seen)
check('asked for by hand, a new server process starts', byHand.length >= 1, JSON.stringify(byHand))
seen.push(...byHand)
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst thirdWrong: boolean = "no"\n', { delay: 10 })
const afterHand = await waitForSquiggles(3, 45_000)
check('and it knows the document: a third mistake is underlined', afterHand >= 3, `${afterHand} squiggles`)

/*
 * --- given up on, and asked back -----------------------------------------------
 *
 * Three deaths in two minutes and Ember gives up on a server for the rest of the
 * session, saying it could not be revived. Asking for a restart gives it another
 * chance.
 */
const notice = () => page.evaluate(() => document.body.textContent ?? '')
for (let round = 0; round < 6 && !/could not be revived/.test(await notice()); round += 1) {
  for (const pid of serverPids()) {
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true })
    } catch {
      // Already gone.
    }
  }
  const next = await newServer(seen, 8_000)
  seen.push(...next)
}
check('killed often enough, the server is given up on', /could not be revived/.test(await notice()))
/*
 * And what it said about the file is taken down with it. Its squiggles stayed with
 * nothing behind them, and the bundled TypeScript worker, standing back up, drew
 * its own beside them: every mistake underlined twice.
 */
const staleLsp = await page.evaluate(() => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('broken.ts'))
  return model ? window.monaco.editor.getModelMarkers({ owner: 'lsp', resource: model.uri }).length : -1
})
check('given up on, its squiggles are taken down', staleLsp === 0, `${staleLsp} left`)
await runCommand('Restart language server')
const asked = await newServer(seen)
check('asked back by hand, a server given up on starts again', asked.length >= 1, JSON.stringify(asked))
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst fourthWrong: number = []\n', { delay: 10 })
/*
 * Counted as the server's own, on the line just typed. Squiggles on screen prove
 * nothing here: once Ember gives up, the bundled TypeScript worker stands back up
 * and underlines the same mistakes itself.
 */
const lspMarkerOn = (text) =>
  page.evaluate((needle) => {
    const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('broken.ts'))
    if (!model) return false
    const line = model.getLinesContent().findIndex((l) => l.includes(needle)) + 1
    return window.monaco.editor.getModelMarkers({ owner: 'lsp', resource: model.uri }).some((m) => m.startLineNumber === line)
  }, text)
let serverMarked = false
for (let until = Date.now() + 45_000; !serverMarked && Date.now() < until; ) {
  serverMarked = await lspMarkerOn('fourthWrong')
  if (!serverMarked) await sleep(500)
}
check('and the server itself underlines the next mistake', serverMarked)
/*
 * And answers a hover, which diagnostics alone cannot: the editor's client asks for
 * hovers only once its handshake with the server has been answered.
 */
const hovered = await page.evaluate(async () => {
  const model = window.monaco.editor.getModels().find((m) => m.uri.path.endsWith('broken.ts'))
  if (!model) return null
  const line = model.getLinesContent().findIndex((l) => l.includes('fourthWrong')) + 1
  const reply = await window.ember.lspRequest('typescript', 'textDocument/hover', {
    textDocument: { uri: model.uri.toString(true) },
    position: { line: line - 1, character: 8 }
  })
  return JSON.stringify(reply ?? null)
})
check('and answers a hover about it', /fourthWrong/.test(hovered ?? ''), (hovered ?? '').slice(0, 120))

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('lsp crash recovery:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
