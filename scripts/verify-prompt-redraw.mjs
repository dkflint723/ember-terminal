// A command typed the moment the last one ends reaches the shell whole.
//
// The nightly gate failed once on "bash: ype: command not found": `type -t …` typed
// straight after `false` reached Git Bash without its first letter. When a command
// ends, the pane fits the pty to the next command's strip (presize) — a resize that
// goes out while bash is still between its end marker and its next prompt. Bash's
// readline answers a resize by redrawing its prompt, and a line arriving inside that
// redraw loses characters. The guard for it waited for the redraw only when the
// resize was made with the prompt already seen — and in Git Bash the resize is
// routinely made before it (measured: every one of 45 sends), so it never waited.
//
// Real bash loses the race about one run in forty-eight. fake-redraw-shell.mjs loses
// it every time: it speaks Ember's markers, draws each prompt a moment after the end
// marker as bash does, and drops whatever arrives while it is redrawing for a resize.
// Each command is typed and sent the instant its predecessor's block ends, and each
// must come back as `ran:<the whole command>`.
//
// Run: node scripts/verify-prompt-redraw.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, seedDirs } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('prompt-redraw')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// The shell's own account of when it was resized, drew its prompt and got each line.
const shellLog = path.join(profile.dir, 'shell.log')
const shell = { id: 'slow-redraw', name: 'Slow redraw', path: process.execPath, args: [path.join(import.meta.dirname, 'fake-redraw-shell.mjs'), shellLog], integration: 'bash' }
for (const d of seedDirs(profile.dir)) {
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ customProfiles: [shell], defaultProfileId: shell.id }), 'utf8')
}

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({ executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'), args: [APP_DIR, profile.arg], cwd: APP_DIR, env, timeout: 60_000 }),
  pageErrors
)
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1000)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const lastBlock = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll('.pane__scroll .block')].at(-1)
    return b ? { body: (b.querySelector('.block__body')?.textContent ?? '').trim(), running: b.classList.contains('block--running') } : null
  })

/** Send a line, then wait — every frame, not every tenth of a second — for its block to end. */
const send = async (command) => {
  const before = await page.evaluate(() => document.querySelectorAll('.pane__scroll .block').length)
  const box = page.locator('.composer__input').first()
  await box.fill(command)
  await box.press('Enter')
  await page
    .waitForFunction(
      (n) => {
        const all = document.querySelectorAll('.pane__scroll .block')
        return all.length > n && !all[all.length - 1].classList.contains('block--running')
      },
      before,
      { polling: 'raf', timeout: 15_000 }
    )
    .catch(() => {})
}

// A fresh pane, so the strip is a different height for each of the first commands
// and every one of them ends in a resize. Each next line goes the moment the last
// block ends, as the nightly's `type` did after `false`.
const seen = []
for (let i = 1; i <= 6; i++) {
  await send(i % 2 ? 'false' : `echo r${i}`)
  const b = await lastBlock()
  seen.push(b?.body ?? '(no block)')
}
const wanted = [1, 2, 3, 4, 5, 6].map((i) => `ran:${i % 2 ? 'false' : `echo r${i}`}`)
const torn = seen.filter((body, i) => !body.startsWith(wanted[i]))
check('a command sent the moment the last one ends reaches the shell whole', torn.length === 0, JSON.stringify(seen))
check('every command answered', seen.every((b) => b.startsWith('ran:')), JSON.stringify(seen))

// The shell's side of it, read before the profile goes: when it was resized, and what reached it when.
const shellSide = fs.existsSync(shellLog) ? fs.readFileSync(shellLog, 'utf8').split(String.fromCharCode(10)).filter((l) => l && !/dropped|base64/.test(l)).join(String.fromCharCode(10)) : ''
const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (failures.length > 0) console.log(shellSide)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('prompt redraw:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
