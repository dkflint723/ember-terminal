// Two windows, two language servers.
//
// A language server is one JSON-RPC connection with one id space, and every window
// builds its own client on it — each numbering its requests from 1, because the
// map that starts a client once is module state and module state is per window.
// Shared, the ids collide on the wire: tsserver answers one window's hover id 7 and
// the other's completion id 7, both replies go to both renderers, and each client
// resolves its own pending 7 with whichever lands first. The documents collide the
// same way, so one window's didClose closes a file the other still has open, and
// each window pushes its own workspace onto the one server.
//
// The id space cannot be shared, so the connection must not be either. What this
// checks is the thing that cannot be true without the fix: that a second window
// editing the same language has a server of its own.
//
// Counted from the operating system rather than from anything the app says, because
// what went wrong was two clients believing they had a server each.
//
// Run: node scripts/verify-lsp-windows.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('lsp-windows')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-lspwin-'))
fs.writeFileSync(
  path.join(work, 'tsconfig.json'),
  JSON.stringify({ compilerOptions: { strict: true } }, null, 2)
)
fs.writeFileSync(path.join(work, 'alpha.ts'), 'export const a: number = "not a number"\n')
fs.writeFileSync(path.join(work, 'bravo.ts'), 'export const b: number = "not a number"\n')

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/** Every typescript-language-server this machine is running, asked of Windows. */
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

// Anything already running belongs to another Ember and is not this suite's to count.
const strangers = new Set(serverPids())
const ours = () => serverPids().filter((pid) => !strangers.has(pid))

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const first = await app.firstWindow()
await placeTopRight(app)
const errors = []
first.on('pageerror', (e) => errors.push(e.message))
await first.waitForSelector('.pane', { timeout: 40_000 })
await sleep(3000)

/** Open a file by name through the palette, and wait for the editor to stand up. */
const openFile = async (page, name) => {
  await page.keyboard.press('Control+P')
  await sleep(700)
  await page.keyboard.type(name, { delay: 30 })
  await page.waitForFunction(() => document.querySelectorAll('.qp__label').length > 0, {
    timeout: 20_000
  })
  await sleep(400)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
  await sleep(2500)
}

await openFile(first, 'alpha.ts')
let started = 0
for (let i = 0; i < 40 && started === 0; i += 1) {
  await sleep(500)
  started = ours().length
}
check('the first window starts a server', started === 1, `${started} servers`)

// A second window, editing the same language.
await first.evaluate(() => window.ember.newWindow())
// Looked for rather than waited on: the window can be up before the wait starts.
await sleep(4000)
const second =
  app.windows().find((w) => w !== first) ??
  (await app.waitForEvent('window', { timeout: 30_000 }))
second.on('pageerror', (e) => errors.push(e.message))
await second.waitForSelector('.pane', { timeout: 40_000 })
await sleep(3000)

/*
 * A new window has no project — a session carries its own now — so its shell is
 * walked into the same one, which is how a person would give it one and is what
 * seeds the workspace that quick open lists from.
 */
await second.click('.composer__input')
await second.keyboard.type(`cd "${work.replace(/\\/g, '/')}"`, { delay: 4 })
await second.keyboard.press('Enter')
await sleep(4000)
await openFile(second, 'bravo.ts')

let both = 0
for (let i = 0; i < 40 && both < 2; i += 1) {
  await sleep(500)
  both = ours().length
}
check(
  'the second window has a server of its own rather than sharing one id space',
  both === 2,
  `${both} servers, expected 2`
)

/*
 * And both windows are actually being answered. A second server that starts and is
 * never spoken to would satisfy the count above while leaving the window as badly
 * off as sharing did.
 */
const marked = async (page) => {
  for (let i = 0; i < 40; i += 1) {
    const n = await page.evaluate(
      () => window.monaco?.editor?.getModelMarkers({}).filter((m) => m.severity === 8).length ?? 0
    )
    if (n > 0) return n
    await sleep(500)
  }
  return 0
}
check('the first window is answered', (await marked(first)) > 0, 'no errors marked in window one')
check('and so is the second', (await marked(second)) > 0, 'no errors marked in window two')

/*
 * And closing a window takes its server with it. Per-window services are only the
 * cheaper design if they are also given up — one tsserver left behind per closed
 * window is exactly the leak that would argue for going back to sharing.
 */
await second.evaluate(() => window.close())
let left = 2
for (let i = 0; i < 40 && left > 1; i += 1) {
  await sleep(500)
  left = ours().length
}
check('closing a window takes its server with it', left === 1, `${left} servers left`)

await app.close()
await sleep(1500)
let after = ours().length
for (let i = 0; i < 20 && after > 0; i += 1) {
  await sleep(500)
  after = ours().length
}
check('and quitting takes the rest', after === 0, `${after} servers still running`)

profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('lsp across windows:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
