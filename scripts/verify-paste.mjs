// Pasting into a terminal, which is the one ordinary gesture that runs code
// nobody has read.
//
// The clipboard went straight to the pty: no bracketed paste, so a shell willing
// to hold pasted text until Enter never got the chance — three lines on the
// clipboard were three commands the moment they landed, and the line that ran
// need not be the line that was visible. Nothing was stripped either, so an escape
// character in the clipboard arrived as an instruction rather than as text,
// including the marker that ends a bracketed paste. And plain Ctrl+V never came
// through the app's paste path at all; xterm answered it on its own.
//
// What the program on the other end actually received is the thing to check, so a
// small Node program holds the terminal, sets bracketed paste itself — PSReadLine
// would otherwise decide it — reports what arrived, and exits. Two consequences
// are used as signals: a program that has received nothing is still running, and
// one that has received something has finished, which is visible in the DOM
// whereas a running program's output is not.
//
// Run: node scripts/verify-paste.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('paste')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const ESC = String.fromCharCode(27)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-paste-'))
/*
 * Holds the terminal, sets the bracketed-paste mode for itself, and reports what
 * it was given as JSON before exiting — so an escape character that survived, or
 * a marker that was never applied, is there to be read rather than inferred. The
 * short wait gathers a paste that arrives in more than one chunk, which a
 * bracketed one does.
 */
const holder = (mode) =>
  [
    `process.stdout.write(${JSON.stringify(`${ESC}[?2004${mode}`)})`,
    /*
     * Raw, or the Windows console line-edits whatever arrives before the program
     * sees it: it eats the very markers this is here to look for and turns each
     * carriage return into a pair. Raw mode hands the program exactly what the
     * terminal sent, which is the only thing worth asserting about.
     */
    'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
    "process.stdin.setEncoding('utf8')",
    "let seen = ''",
    'let timer = null',
    "process.stdin.on('data', (d) => {",
    '  seen += d',
    '  if (timer) clearTimeout(timer)',
    '  timer = setTimeout(() => {',
    "    process.stdout.write('GOT:' + JSON.stringify(seen))",
    '    process.exit(0)',
    '  }, 600)',
    '})'
  ].join('\n')
fs.writeFileSync(path.join(work, 'held-off.js'), holder('l'))
fs.writeFileSync(path.join(work, 'held-on.js'), holder('h'))

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, work],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 }).catch(() => {})
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/*
 * One dialog handler, told what to do next by `answer`. Playwright dismisses an
 * unhandled dialog on its own, which would make "nothing was asked" and "it was
 * asked and declined" look identical — so every dialog is recorded as it passes.
 */
const asked = []
let answer = 'dismiss'
page.on('dialog', (d) => {
  asked.push(d.message())
  void (answer === 'accept' ? d.accept() : d.dismiss())
})

const copy = (text) => page.evaluate((t) => navigator.clipboard.writeText(t), text)
const running = () => page.locator('.block--running').count()
const typeCommand = async (command) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
}
/** The finished block's own output, which is where a program's report lands. */
const lastBody = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('.pane__scroll .block')]
        .at(-1)
        ?.querySelector('.block__body')?.textContent ?? ''
  )
const waitForFinish = async (ms = 8000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if ((await running()) === 0) return true
    await sleep(250)
  }
  return false
}
const received = (body) => {
  const m = /GOT:("(?:[^"\\]|\\.)*")/.exec(body)
  if (!m) return null
  try {
    return JSON.parse(m[1])
  } catch {
    return null
  }
}
/** Right-click on the terminal with nothing selected, which is a paste. */
const rightClickPaste = async () => {
  await page.click('.xterm', { button: 'right' })
  await sleep(1200)
}
/**
 * A real paste event on xterm's own textarea.
 *
 * Pressing Ctrl+V cannot be used here: Chromium does not run the clipboard
 * machinery for a synthetic key event, so no paste event is produced and nothing
 * would be under test. This is the event the browser would deliver, aimed where it
 * would arrive.
 */
const ctrlV = async (text) => {
  await page.evaluate((t) => {
    const target =
      document.querySelector('.xterm-helper-textarea') ?? document.querySelector('.xterm')
    if (!target) return
    const data = new DataTransfer()
    data.setData('text/plain', t)
    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  }, text)
  await sleep(1200)
}

// --- a shell that will not hold it: the paste is asked about ---------------------------------
await typeCommand('node held-off.js')
await sleep(2500)
check('the program that holds the terminal is running', (await running()) === 1, `${await running()} running`)

answer = 'dismiss'
asked.length = 0
await copy('echo one\necho two\necho three\n')
await rightClickPaste()
check('three lines to a shell that will not hold them is asked about', asked.length === 1, JSON.stringify(asked))
check(
  'and the question says how many lines and what it starts with',
  /3 lines/.test(asked[0] ?? '') && /echo one/.test(asked[0] ?? ''),
  JSON.stringify(asked[0] ?? null)
)
// Nothing arrived, so the program is still waiting: anything at all would have
// made it report and exit.
check('and nothing was sent when the answer was no', (await running()) === 1, `${await running()} running`)

// --- said yes, and what arrives is text ---------------------------------------------------------
answer = 'accept'
asked.length = 0
await copy(`echo one${ESC}[31m\necho two\n`)
await rightClickPaste()
check('saying yes sends it', await waitForFinish(), 'the program never finished')
const got = received(await lastBody())
check('and the program reported what it got', got !== null, (await lastBody()).slice(0, 200))
if (got !== null) {
  check('with the escape character gone from it', !got.includes(ESC), JSON.stringify(got))
  check('and the text itself intact', got.includes('echo one') && got.includes('echo two'), JSON.stringify(got))
}

// --- a shell that will hold it is not asked at all -----------------------------------------------
await typeCommand('node held-on.js')
await sleep(2500)
answer = 'dismiss'
asked.length = 0
await copy('echo four\necho five\n')
await rightClickPaste()
check('a shell holding pasted text is not asked about', asked.length === 0, JSON.stringify(asked))
check('and the paste still arrived', await waitForFinish(), 'the program never finished')
const held = received(await lastBody())
check('and the program reported it', held !== null, (await lastBody()).slice(0, 200))
if (held !== null) {
  check(
    'wrapped in the markers that tell the shell it is text',
    held.includes('[200~') && held.includes('[201~'),
    JSON.stringify(held)
  )
}

// --- the chord everyone actually presses ----------------------------------------------------------
await typeCommand('node held-off.js')
await sleep(2500)
answer = 'dismiss'
asked.length = 0
await ctrlV('echo six\necho seven\n')
check('an ordinary paste event is asked about too', asked.length === 1, JSON.stringify(asked))
check('and nothing was sent when that answer was no', (await running()) === 1, `${await running()} running`)

// Stop it, so the composer's Enter below reaches the shell rather than this.
await page.click('.xterm')
await page.keyboard.press('Control+c')
await sleep(1500)
check('the held program stops on Ctrl+C', await waitForFinish(4000), 'still running')

// --- and the composer, where Enter runs the lot ------------------------------------------------
answer = 'dismiss'
asked.length = 0
await page.click('.composer__input')
await page.keyboard.type('echo eight', { delay: 4 })
await page.keyboard.down('Shift')
await page.keyboard.press('Enter')
await page.keyboard.up('Shift')
await page.keyboard.type('echo nine', { delay: 4 })
await page.keyboard.press('Enter')
await sleep(1800)
check('two lines in the composer are asked about before they run', asked.length === 1, JSON.stringify(asked))
check(
  'and the question is about running them, not about pasting',
  /Run them\?/.test(asked[0] ?? ''),
  JSON.stringify(asked[0] ?? null)
)
const after = await page.evaluate(() =>
  [...document.querySelectorAll('.pane__scroll .block')].map((b) => b.textContent ?? '').join('\n')
)
check('and saying no runs neither of them', !after.includes('echo eight'), after.slice(-200))

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('paste into a terminal:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
