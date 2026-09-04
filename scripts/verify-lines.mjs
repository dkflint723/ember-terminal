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

/*
 * --- what leaves the app when a block is shared --------------------------------
 *
 * Warp shares a block with a hosted permalink. Ember has no server, so what leaves
 * is Markdown on the clipboard — which means the clipboard is the only place these
 * can be observed, and the only place the truncation bug below was visible.
 */

const shareOf = async (index) => {
  const block = index === undefined ? page.locator('.block').last() : page.locator('.block').nth(index)
  await block.hover()
  await block.locator('.block__action[title^="Copy as Markdown"]').click({ force: true })
  await sleep(400)
  // Windows hands back CRLF from the clipboard whatever went in, and the shape
  // under test is the Markdown, not the platform's line endings.
  const text = await page.evaluate(() => window.ember.clipboardRead())
  return text.replace(/\r\n/g, '\n')
}

await run(`Write-Host "SHARED-ONE"; Write-Host "SHARED-TWO"`)
const shared = await shareOf()

/*
 * A fenced `console` block with the command on a prompt line. That is the form
 * every issue tracker and chat window already renders, so a reader knows what they
 * are looking at without being told.
 */
check(
  'a shared block is a fenced console block',
  /```console\n\$ Write-Host "SHARED-ONE"/.test(shared),
  JSON.stringify(shared.slice(0, 160))
)
check(
  'carrying the output, with its lines intact',
  shared.includes('SHARED-ONE\nSHARED-TWO'),
  JSON.stringify(shared.slice(0, 240))
)
check(
  'and how it went, which is usually why it is being shared',
  /_exited 0( in .+)?_/.test(shared),
  JSON.stringify(shared.slice(-120))
)

/*
 * Output is arbitrary bytes from arbitrary programs, and plenty of them print
 * three backticks — anything rendering Markdown, a linter quoting a sample, this
 * app's own README. A three-tick fence around that closes early and the rest of
 * the output escapes into the message as prose.
 */
await run('Write-Host "``````fenced``````"')
const fenced = await shareOf()
check(
  'output containing a fence gets a longer one around it',
  /````+console/.test(fenced),
  JSON.stringify(fenced.slice(0, 120))
)

/*
 * A credential on the command line is not handed to somebody else.
 *
 * The history database redacts what it stores for the same reason, but a row in a
 * local SQLite file is read by the person who typed the command and this is on its
 * way to another screen — so where redaction leaves a command still looking like it
 * carries a credential, the command is withheld rather than shared.
 */
await run('Write-Host "done"; # curl --token abcdef123456789 https://example.invalid')
const credential = await shareOf()
check(
  'a credential on the command line is not shared in the clear',
  !credential.includes('abcdef123456789'),
  JSON.stringify(credential.slice(0, 200))
)

/*
 * --- a block that lost output says so, in the text as well as on screen ---------
 *
 * The live capture marks what it had to drop with a line reading "earlier output
 * not kept". It was written as a bare span beside the rows rather than in one, and
 * text is taken from a block by joining its `.row` children — so the one line
 * saying output was lost was the one line dropped from every copy, from the
 * history database, and from what gets handed to Claude. The block read as whole.
 * The same marker written by the history layer has always been wrapped; only the
 * live one was not, so only live blocks lied.
 *
 * Three megabytes on one line, which is past the capture cap and cannot be
 * mistaken for anything else.
 */
await run('Write-Output ("x" * 3000000)', 180_000)
const truncated = await shareOf()
check(
  'a block that lost output says so in what is copied out of it',
  truncated.includes('earlier output not kept'),
  JSON.stringify(truncated.slice(0, 200))
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
