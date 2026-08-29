// Completion in the right accent for the shell that asked.
//
// The generic backend answered every non-PowerShell pane in Windows dialect:
// directories completed with a trailing backslash into bash command lines, a
// bash-shaped cwd (/d/…) was mangled through path.resolve, and no dialect got
// its builtins. It also looked profiles up in a snapshot, so a custom shell
// taught mid-session completed as a stranger. This drives the service straight
// through window.ember.complete — the filesystem is real, no guest shell needed.
//
// Run: node scripts/verify-completion.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('completion')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// A directory with one folder and one file, so "al" has exactly one dir answer.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-cmp-'))
fs.mkdirSync(path.join(dir, 'alpha'))
fs.writeFileSync(path.join(dir, 'beta.txt'), 'x', 'utf8')
/** The same directory in a bash accent: C:\Users\… → /c/Users/…. */
const bashDir = `/${dir[0].toLowerCase()}${dir.slice(2).replace(/\\/g, '/')}`

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// Teach a bash-dialect shell through settings alone — the service must find it
// live, not in whatever list existed at startup.
await page.evaluate(() =>
  window.ember.setSettings({
    customProfiles: [
      { id: 'custom-bashish', name: 'Bashish', path: 'bash.exe', args: [], integration: 'bash' }
    ]
  })
)
await sleep(400)

const ask = (profileId, cwd, input) =>
  page.evaluate(
    ({ profileId, cwd, input }) =>
      window.ember.complete({ profileId, cwd, input, cursor: input.length }),
    { profileId, cwd, input }
  )

// --- bash: paths in its own accent --------------------------------------------
const bashPath = await ask('custom-bashish', bashDir, 'cat al')
check(
  'a bash pane completes the directory with a forward slash',
  bashPath.items.some((i) => i.text === 'alpha/'),
  JSON.stringify(bashPath.items.slice(0, 5))
)
check(
  'and never hands it a backslash',
  !bashPath.items.some((i) => i.text.includes('\\')),
  JSON.stringify(bashPath.items.slice(0, 5))
)

// --- bash: its builtins exist -------------------------------------------------
const bashBuiltin = await ask('custom-bashish', bashDir, 'expor')
check(
  'bash builtins complete on the first token',
  bashBuiltin.items.some((i) => i.text === 'export'),
  JSON.stringify(bashBuiltin.items.slice(0, 5))
)

// --- bash: another filesystem stays quiet -------------------------------------
const wslish = await ask('custom-bashish', '/home/nobody', 'cat al')
check(
  'a Linux cwd yields no path answers read off the wrong disk',
  !wslish.items.some((i) => i.type.startsWith('Provider')),
  JSON.stringify(wslish.items.slice(0, 5))
)
const wslishCmd = await ask('custom-bashish', '/home/nobody', 'expor')
check(
  'while commands still answer there',
  wslishCmd.items.some((i) => i.text === 'export'),
  JSON.stringify(wslishCmd.items.slice(0, 5))
)

// --- cmd: its own verbs, its own separator ------------------------------------
const cmdVerb = await ask('cmd', dir, 'di')
check(
  'cmd completes dir among its verbs',
  cmdVerb.items.some((i) => i.text === 'dir'),
  JSON.stringify(cmdVerb.items.slice(0, 5))
)
const cmdPath = await ask('cmd', dir, 'type al')
check(
  'and its directories keep the backslash',
  cmdPath.items.some((i) => i.text === 'alpha\\'),
  JSON.stringify(cmdPath.items.slice(0, 5))
)

await app.close()
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('dialect completion:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
