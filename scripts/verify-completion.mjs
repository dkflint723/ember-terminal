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
// Two names sharing a prefix, so Tab has something unambiguous to insert and
// something still to choose between afterwards.
fs.writeFileSync(path.join(dir, 'report-a.txt'), 'x', 'utf8')
fs.writeFileSync(path.join(dir, 'report-b.txt'), 'x', 'utf8')
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

/*
 * --- a quoted argument is replaced, and nothing beside it -----------------------
 *
 * The pattern that finds the token captures the opening quote inside it, so the
 * span already covers the quote. Adjusting for it a second time reached one
 * character further left — which is the space between the command and its
 * argument — and completing `cat "al` produced `catalpha`, welding the two
 * together into something that cannot run. At column zero it reached index -1 and
 * the clamp swallowed the quote instead.
 */
const quoted = await ask('custom-bashish', bashDir, 'cat "al')
check(
  'a quoted token is replaced from the quote, not from the space before it',
  quoted.replaceIndex === 'cat "al'.indexOf('"'),
  JSON.stringify({ replaceIndex: quoted.replaceIndex, want: 'cat "al'.indexOf('"') })
)
check(
  'and for exactly its own length',
  quoted.replaceIndex + quoted.replaceLength === 'cat "al'.length,
  JSON.stringify({ index: quoted.replaceIndex, length: quoted.replaceLength })
)

/*
 * And what the renderer does with that span: `before + text + after` must put the
 * command back exactly as it was.
 */
const rebuilt =
  'cat "al'.slice(0, quoted.replaceIndex) +
  (quoted.items[0]?.text ?? '') +
  'cat "al'.slice(quoted.replaceIndex + quoted.replaceLength)
check(
  'so applying it leaves the command name intact',
  rebuilt.startsWith('cat '),
  JSON.stringify({ rebuilt, from: 'cat "al' })
)

/*
 * --- accepting from a list that is still open over a rewritten line -------------
 *
 * Tab with more than one match inserts the part they agree on and leaves the list
 * up. The span the list carries describes the token as it was when the request was
 * sent, and inserting the prefix rewrote exactly that span — so accepting an item
 * afterwards spliced the tail of the prefix back in behind it. Driven through the
 * composer, because the corruption happens in the renderer's own apply and the
 * checks above call main directly.
 */
await page.click('.composer__input')
await page.keyboard.type(`cd "${dir.replace(/\\/g, '/')}"`, { delay: 4 })
await page.keyboard.press('Enter')
await sleep(2500)

await page.click('.composer__input')
await page.keyboard.type('type r', { delay: 30 })
await page.keyboard.press('Tab')
await sleep(1500)
const afterTab = await page.evaluate(
  () => document.querySelector('.composer__input')?.value ?? ''
)
// The shell's own accent decides the leading `.\` or `./`; what matters is that
// the line ends at the part the matches agree on and goes no further.
check(
  'Tab inserts the part the matches agree on',
  afterTab.startsWith('type ') && afterTab.endsWith('report-'),
  JSON.stringify(afterTab)
)

await page.keyboard.press('Enter')
await sleep(900)
const accepted = await page.evaluate(
  () => document.querySelector('.composer__input')?.value ?? ''
)
check(
  'and accepting one of them replaces that, rather than appending to it',
  /^type .*report-[ab]\.txt$/.test(accepted),
  JSON.stringify(accepted)
)

await app.close()
profile.cleanup()
fs.rmSync(dir, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('dialect completion:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
