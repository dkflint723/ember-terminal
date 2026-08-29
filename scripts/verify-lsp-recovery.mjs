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

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('lsp crash recovery:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
