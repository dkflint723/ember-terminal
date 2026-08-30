// Output that still has lines in it once it leaves a block.
//
// A block stores its output as markup — one `<div class="row">` per logical line —
// and four different places turned that back into plain text to hand somewhere
// else: the copy button, the cross-session history, the find bar's haystack, and
// the text given to the model when a block is attached to a prompt. All four did
// it the obvious way, with `innerText` on a detached div.
//
// `innerText` is only specified to insert a line break per block-level element for
// an element that is *being rendered*. A detached node is not, and the standard
// says to fall back to `textContent` — which concatenates. So every one of those
// four paths returned the right characters in the right order with every newline
// missing, and none of them had any way to notice: the string was there, it was
// merely one line long. A user reported it after pasting a WSL install log back
// and finding "Downloading: Arch LinuxInstalling: Arch Linux".
//
// This checks the two paths a person can observe directly — the clipboard and the
// history record — because those are the ones where a run-on line is provably
// wrong rather than a matter of taste.
//
// Run: node scripts/verify-lines.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('lines')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

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
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const run = async (command, timeoutMs = 60_000) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    if ((await page.locator('.block--running').count()) === 0) break
  }
  await sleep(900)
}

/*
 * Three lines whose concatenation is a different string from their join — so a
 * missing newline cannot hide behind a space that was there anyway.
 */
await run(`Write-Host "ALPHA"; Write-Host "BRAVO"; Write-Host "CHARLIE"`)

// --- the mechanism itself, in this build's DOM --------------------------------
//
// Stated as a check rather than assumed from the spec: if a future Chromium ever
// makes detached innerText line-aware, the helper this suite guards becomes
// unnecessary rather than wrong, and this is where that would show up.
const mechanism = await page.evaluate(() => {
  const html = '<div class="row">one</div><div class="row">two</div>'
  const el = document.createElement('div')
  el.innerHTML = html
  return { detached: el.innerText, textContent: el.textContent }
})
check(
  'detached innerText still drops line breaks (the reason the helper exists)',
  mechanism.detached === mechanism.textContent,
  JSON.stringify(mechanism)
)

// --- the clipboard ------------------------------------------------------------
await page.locator('.block').last().hover()
// The meta column overlaps the actions until the head is hovered; the press is
// what is under test, not whether the pointer can reach it.
await page
  .locator('.block')
  .last()
  .locator('.block__action[title="Copy output"]')
  .click({ force: true })
await sleep(400)
const copied = await page.evaluate(() => window.ember.clipboardRead())
check(
  'copied output has the lines the terminal drew',
  copied.includes('ALPHA\nBRAVO') || copied.includes('ALPHA\r\nBRAVO'),
  JSON.stringify(copied.slice(0, 160))
)
check(
  'and does not run them together',
  !copied.includes('ALPHABRAVO'),
  JSON.stringify(copied.slice(0, 160))
)

// --- the history record -------------------------------------------------------
//
// The one that had been quietly writing corrupted rows for as long as history has
// existed: a search across sessions was searching one long line per command.
// Read straight out of the database rather than through searchHistory, which
// returns a command's metadata and not the text stored against it. What is on
// disk is the thing that was wrong, so that is the thing to look at.
await app.close()

const db = new DatabaseSync(path.join(profile.dir, 'history.db'), { readOnly: true })
const rows = db.prepare("SELECT command, output FROM commands WHERE command LIKE '%ALPHA%'").all()
db.close()

const record = rows.find((r) => String(r.output).includes('ALPHA'))
check('the command reached history', record !== undefined, JSON.stringify(rows.slice(0, 3)))
if (record) {
  const out = String(record.output)
  check(
    'and its output kept its line breaks',
    out.includes('ALPHA\nBRAVO') || out.includes('ALPHA\r\nBRAVO'),
    JSON.stringify(out.slice(0, 160))
  )
  check(
    'rather than being stored as one run-on line',
    !out.includes('ALPHABRAVO'),
    JSON.stringify(out.slice(0, 160))
  )
}

profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.join(' | '))
console.log('lines:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
