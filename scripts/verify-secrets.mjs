// Credentials do not reach the disk, and do not reach a model.
//
// The patterns that recognise a credential were narrow: a key typed as a bare
// argument — `./deploy.sh sk-ant-…`, which is how a deploy script takes one — had
// no flag in front of it, so nothing looked at it and the command line went into a
// database that outlives the session. The command column was stored exactly as
// typed either way, and the search index with it. On the way out it was worse: the
// buffer under the caret and every attached block went to a model verbatim, and so
// did the question, so an .env file open in the editor was sent to somebody else's
// server in full.
//
// Everything here is asked of what is actually on disk when the app has closed, and
// of what the model was actually handed — the fake backend echoes the last message
// and the head of the first attachment, so the check reads what would have gone out
// rather than trusting that it would not have.
//
// Run: node scripts/verify-secrets.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, seedDirs, userDataOf } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
import { DatabaseSync } from 'node:sqlite'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('secrets')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, EMBER_FAKE_AI: '1' }
delete env.ELECTRON_RUN_AS_NODE

/*
 * One marker per door, so a leak names the door it came through rather than
 * leaving a hunt. Each is a real key shape: `sk-ant-` and at least eight more.
 */
const TYPED = 'sk-ant-api03-TYPEDKEY0123456789'
const PRINTED = 'sk-ant-api03-PRINTEDKEY01234567'
const ASKED = 'sk-ant-api03-ASKEDKEY012345678'
const GHOSTED = 'sk-ant-api03-GHOSTKEY012345678'
const EDITED = 'sk-ant-api03-EDITKEY0123456789'
const FORGET_ME = 'forget-me-please-0451'

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-secrets-'))
// A command line with nothing in it, printing a key the way `aws configure list`
// or a curl that echoes its own headers does.
fs.writeFileSync(path.join(work, 'leak.js'), `console.log("x-api-key: ${PRINTED}")\n`)
const leakPath = path.join(work, 'leak.js')

/*
 * A history written by a build that did not know these shapes, seeded before the
 * app has ever run. The row is here to be found again afterwards — redacted and
 * still readable — rather than deleted: rewriting somebody's history is a thing to
 * do once, in the open, and losing the command lines with it was not asked for.
 */
const OLD = 'sk-ant-api03-OLDKEY0123456789'
// Into every directory the app might read from, since it cannot be asked yet.
for (const dir of seedDirs(profile.dir)) {
  const seeded = new DatabaseSync(path.join(dir, 'history.db'))
  seeded.exec(`
    CREATE TABLE IF NOT EXISTS commands (
      id          INTEGER PRIMARY KEY,
      command     TEXT    NOT NULL,
      cwd         TEXT    NOT NULL DEFAULT '',
      shell       TEXT    NOT NULL DEFAULT '',
      exit_code   INTEGER,
      duration_ms INTEGER,
      started_at  INTEGER NOT NULL,
      output      TEXT    NOT NULL DEFAULT ''
    );
  `)
  seeded
    .prepare(
      `INSERT INTO commands (command, cwd, shell, exit_code, duration_ms, started_at, output)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(`curl -H "x-api-key: ${OLD}" https://api.example.com`, 'C:\\', 'pwsh', 0, 12, Date.now(), 'ok')
  seeded.close()
}

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
page.on('dialog', (d) => void d.accept())
// Ready, not merely present: a command becomes a block — and so a history row —
// only once the shell's integration is reporting its prompts.
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 }).catch(() => {})
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
check(
  'the shell reports its prompts, so commands become blocks',
  (await page.locator('.pane[data-integration="ready"]').count()) > 0
)

const run = async (command, timeoutMs = 60_000) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    if ((await page.locator('.block--running').count()) === 0) break
  }
  await sleep(800)
}

/** What history says it holds, asked through the app's own search. */
const found = async (text) =>
  page.evaluate(async (t) => {
    const rows = await window.ember.searchHistory({ text: t, limit: 50 })
    return rows.map((r) => ({ id: r.id, command: r.command }))
  }, text)

// --- a key typed on the command line never reaches the database ------------------------
await run(`echo ${TYPED}`)
const typedRows = await found('TYPEDKEY')
check('a command carrying a key is not in history at all', typedRows.length === 0, JSON.stringify(typedRows))

// --- a key a command prints is redacted, and the command itself is kept -----------------
await run(`node '${leakPath}'`)
const leakRows = await found('leak.js')
check('an ordinary command is still recorded', leakRows.length >= 1, JSON.stringify(leakRows))

// --- what the model is handed ------------------------------------------------------------
// The panel is closed until it is asked for, which is what Ctrl+Shift+B does.
await page.keyboard.press('Control+Shift+B')
const asking = await page
  .waitForSelector('.agent__input', { timeout: 15_000 })
  .then(() => true)
  .catch(() => false)
check('the Claude panel opens to be asked something', asking)
let answered = ''
if (asking) {
  await page.locator('.agent__input').click()
  await page.keyboard.type(`why is ${ASKED} rejected?`, { delay: 3 })
  await page.keyboard.press('Enter')
  /*
   * Waited out rather than sampled. The answer streams, and read while the cursor
   * is still blinking it is a prefix that has not reached the echoed question yet —
   * which would let the check below pass on a build that leaks, because the key had
   * simply not arrived on screen. That is how it passed the first time this ran.
   */
  await page
    .waitForFunction(
      () =>
        document.querySelectorAll('.agent__cursor').length === 0 &&
        ([...document.querySelectorAll('.agent__turn--assistant .agent__text')].at(-1)
          ?.textContent ?? '').includes('fake-reply'),
      undefined,
      { timeout: 30_000 }
    )
    .catch(() => {})
  answered = await page.evaluate(
    () =>
      [...document.querySelectorAll('.agent__turn--assistant .agent__text')].at(-1)?.textContent ??
      ''
  )
}
// The fake backend echoes the last message it was given, so this is literally what
// the model received rather than what the panel chose to display. The echo has to
// be there for its silence about the key to mean anything.
check('the whole question came back echoed', answered.includes('rejected?'), answered.slice(0, 200))
check('with the key taken out of it', !answered.includes('ASKEDKEY'), answered.slice(0, 200))
check('and something in its place', answered.includes('[redacted]'), answered.slice(0, 200))

// --- one Enter is one command, the first one after the panel included --------------------------
/*
 * The panel takes width from the terminal, and on the elevated runner the first
 * command after it doubled: two blocks, two history rows. The terminal was three
 * columns narrower running than idle, so it shrank under the prompt as the command
 * began — onto the prompt's exact width — and PSReadLine threw drawing it, printed
 * its bug report, and put up a fresh prompt before running the line. The block
 * opened on Enter was closed by that prompt, and the line then ran under a second.
 *
 * Both causes are fixed, and this one no longer happens here: the width now holds
 * steady across a command, so nothing narrows under the prompt. What this still
 * asks is the outcome someone would see. The sequence itself — a prompt coming
 * back before its line starts — is made on purpose in verify-shell, which does not
 * depend on any machine's path being the right length.
 */
const ONCE = 'echo once-after-the-panel-2718'
await run(ONCE)
const onceRows = (await found('once-after-the-panel-2718')).filter((r) => r.command === ONCE)
check('one Enter after the panel answers is one history row', onceRows.length === 1, JSON.stringify(onceRows))
const onceBlocks = await page.locator(`.block[aria-label^="${ONCE} "]`).count()
check('and one block', onceBlocks === 1, `${onceBlocks} blocks`)
const onceBody = await page
  .locator(`.block[aria-label^="${ONCE} "] .block__body`)
  .last()
  .textContent()
  .catch(() => '')
check('holding what the command printed', (onceBody ?? '').includes('once-after-the-panel-2718'), (onceBody ?? '').slice(0, 120))

// --- the two round trips withhold rather than redact ---------------------------------------
await page.evaluate(() =>
  window.ember.setSettings({
    ghostEnabled: true,
    ghostProvider: 'local',
    // Nothing listens here. A request that is not withheld fails against this with
    // a connection error, which is a different sentence from the one below.
    ghostBaseUrl: 'http://127.0.0.1:9/v1'
  })
)
await sleep(600)
const ghosted = await page
  .evaluate(
    (key) =>
      window.ember.ghostComplete(4101, {
        prefix: `const key = "${key}"\nconst next = `,
        suffix: '\n',
        language: 'javascript'
      }),
    GHOSTED
  )
  .catch((e) => ({ ok: false, error: `threw: ${String(e).slice(0, 80)}` }))
check(
  'a suggestion is not asked for around a credential',
  ghosted && ghosted.ok === false && /credential/i.test(String(ghosted.error)),
  JSON.stringify(ghosted)
)
const ghostedClean = await page
  .evaluate(() =>
    window.ember.ghostComplete(4102, {
      prefix: 'export function add(a, b) {\n  return ',
      suffix: '\n}\n',
      language: 'javascript'
    })
  )
  .catch((e) => ({ ok: false, error: `threw: ${String(e).slice(0, 80)}` }))
check(
  'while ordinary text is still asked about',
  ghostedClean && !/credential/i.test(String(ghostedClean.error ?? '')),
  JSON.stringify(ghostedClean)
)

const rewritten = await page
  .evaluate(
    (key) => window.ember.rewriteSelection(`const k = "${key}"`, 'rename k to token', 'javascript'),
    EDITED
  )
  .catch((e) => ({ ok: false, error: `threw: ${String(e).slice(0, 80)}` }))
check(
  'a selection carrying a credential is not sent to be rewritten',
  rewritten && rewritten.ok === false && /credential/i.test(String(rewritten.error)),
  JSON.stringify(rewritten)
)
const rewrittenClean = await page
  .evaluate(() => window.ember.rewriteSelection('const k = 1', 'rename k to n', 'javascript'))
  .catch((e) => ({ ok: false, error: `threw: ${String(e).slice(0, 80)}` }))
check(
  'while an ordinary selection is',
  rewrittenClean && rewrittenClean.ok === true,
  JSON.stringify(rewrittenClean)
)

// --- and one command can be forgotten on purpose --------------------------------------------
/*
 * Run twice, so there are twins to forget. Main forgets by what was typed, every
 * row of it, and the list used to drop only the row that was clicked — which went
 * unseen here until the elevated runner happened to record this line twice on its
 * own, and the list kept the twin the file no longer held. Two runs make the case
 * on every machine rather than on the one that stumbles into it.
 */
await run(`echo ${FORGET_ME}`)
await run(`echo ${FORGET_ME}`)
const beforeForget = await found(FORGET_ME)
check('the command to forget was recorded, twice', beforeForget.length >= 2, JSON.stringify(beforeForget))

await page.keyboard.press('Control+r')
await page.waitForSelector('.hist__input', { timeout: 10_000 }).catch(() => {})
if ((await page.locator('.hist__input').count()) > 0) {
  await page.locator('.hist__input').fill(FORGET_ME)
  await sleep(1000)
  const rows = await page.locator('.hist__forget').count()
  check('the row offers to be forgotten', rows >= 1, `${rows} forget controls`)
  check('and its twin is listed beside it', rows >= 2, `${rows} rows listed`)
  if (rows >= 1) {
    await page.locator('.hist__forget').first().click()
    await sleep(1200)
    const left = await page.locator('.hist__cmd').count()
    check('and goes from the list when it is, twin and all', left === 0, `${left} rows left`)
  }
  await page.keyboard.press('Escape')
  await sleep(400)
}
const afterForget = await found(FORGET_ME)
check('and from the database', afterForget.length === 0, JSON.stringify(afterForget))

// --- and the history that was already on disk ------------------------------------------------
// Polled rather than slept through: the pass starts a couple of seconds after the
// database is first opened and works in batches, so how long it takes depends on
// how much was in there to begin with.
let oldRow = null
for (let i = 0; i < 25; i++) {
  // Listed rather than searched. The search index is rebuilt at the end of the
  // pass, so asking through it here would confuse "the row was scrubbed" with
  // "the index has caught up with it" — which are two separate promises, and are
  // checked separately below.
  const rows = await found('')
  oldRow = rows.find((r) => r.command.includes('api.example.com')) ?? null
  if (oldRow && !oldRow.command.includes('OLDKEY')) break
  await sleep(1000)
}
check('a row written before this change is still there', oldRow !== null, JSON.stringify(oldRow))
check(
  'with the key taken out of it',
  oldRow !== null && !oldRow.command.includes('OLDKEY'),
  JSON.stringify(oldRow)
)
check(
  'and the rest of the command still readable',
  oldRow !== null && oldRow.command.includes('api.example.com'),
  JSON.stringify(oldRow)
)
// The other half of the promise: the index mirrors a table that has just been
// rewritten underneath it, so it is rebuilt at the end of the pass. Without that,
// the row survives but cannot be found by anything the search box asks.
const indexed = await found('api.example.com')
check(
  'and the search index was rebuilt over it',
  indexed.some((r) => r.command.includes('api.example.com')),
  JSON.stringify(indexed.slice(0, 2))
)

// --- what is actually on disk, with the app shut --------------------------------------------
// Asked while the app is still up, because the files are read after it closes.
const userData = await userDataOf(app)
await app.close()
await sleep(1200)

const onDisk = []
for (const name of ['history.db', 'history.db-wal', 'history.db-shm', 'session.json']) {
  const file = path.join(userData, name)
  if (!fs.existsSync(file)) continue
  onDisk.push({ name, bytes: fs.readFileSync(file) })
}
check('the profile holds a history database to look at', onDisk.some((f) => f.name.startsWith('history.db')), JSON.stringify(onDisk.map((f) => f.name)))
for (const { name, bytes } of onDisk) {
  for (const [what, marker] of [
    ['a key typed on a command line', 'TYPEDKEY'],
    ['a key a command printed', 'PRINTEDKEY'],
    ['a key typed into a question', 'ASKEDKEY'],
    ['a command that was forgotten', FORGET_ME],
    ['a key written before this change', 'OLDKEY']
  ]) {
    check(`${name} does not hold ${what}`, !bytes.includes(marker), `${name} holds ${marker}`)
  }
}

profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('secrets off the disk and away from models:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
