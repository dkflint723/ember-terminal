// Open editors follow the files they show.
//
// A save no longer writes over a file that changed since the buffer was based on
// it — verify-conflict holds that line. That makes the loss impossible, but on its
// own it leaves the editor showing stale text until somebody tries to save. Here the
// file changes while the editor is open, the way it does when Claude Code works in
// the next pane or a branch is switched: a buffer with nothing of the user's in it
// follows the file, one with edits is told at once, a deleted file leaves its text
// marked as the only copy, and each of those undoes itself when the file comes back
// as it was.
//
// Run: node scripts/verify-follow.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('follow')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// A repository, so the last part can switch branches the way a person would.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-follow-'))
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
const FILE = path.join(repo, 'notes.ts')
const MAIN = 'export const branch = "main"\n'
const OTHER = 'export const branch = "other"\nexport const onlyOnOther = true\n'
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'verify@example.invalid')
git('config', 'user.name', 'Verify')
fs.writeFileSync(FILE, MAIN, 'utf8')
git('add', '-A')
git('commit', '-qm', 'main')
git('checkout', '-q', '-b', 'other')
fs.writeFileSync(FILE, OTHER, 'utf8')
git('commit', '-qam', 'other')
git('checkout', '-q', 'main')

const read = () => fs.readFileSync(FILE, 'utf8')
/** A change made by somebody else, with a modification time of its own. */
const changeOnDisk = (text) => {
  fs.writeFileSync(FILE, text, 'utf8')
  const t = new Date(Date.now() + 2000)
  fs.utimesSync(FILE, t, t)
}

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, FILE],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await placeTopRight(app)
await page.waitForSelector('.monaco-editor', { timeout: 40_000 })
await sleep(2500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// Monaco renders spaces as non-breaking ones; put them back before matching words.
const onScreen = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane.editor:not(.diff) .view-line')]
      .map((l) => (l.textContent ?? '').replaceAll(String.fromCharCode(160), ' '))
      .join('\n')
  )
const bar = () =>
  page.evaluate(() => {
    const el = document.querySelector('.editor__conflict')
    return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null
  })
const dirty = () => page.locator('.pane.editor[data-dirty="true"]').count()
/** Poll for a condition, for up to `ms`; the answer is whether it came true. */
const within = async (ms, test) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (await test()) return true
    await sleep(150)
  }
  return test()
}
const typeAtEnd = async (text) => {
  await page.click('.pane.editor:not(.diff) .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type(text, { delay: 6 })
  await sleep(400)
}
// The look at the disk runs every two seconds; five is two looks and a margin.
const LOOK = 5000

// --- a clean buffer follows the file ---------------------------------------------
check('the file opened as it is on disk', (await onScreen()).includes('"main"'), await onScreen())
changeOnDisk('export const branch = "main"\nexport const fromClaude = 2\n')
check(
  'a buffer with nothing of the user’s follows a change made elsewhere',
  await within(LOOK, async () => (await onScreen()).includes('fromClaude')),
  await onScreen()
)
check('and stays clean', (await dirty()) === 0)
check('with nothing to decide', (await bar()) === null, String(await bar()))

// As one edit, so what the buffer held is a Ctrl+Z away.
await page.click('.pane.editor:not(.diff) .view-lines')
await page.keyboard.press('Control+Z')
await sleep(500)
check(
  'and Ctrl+Z brings back what it showed before',
  !(await onScreen()).includes('fromClaude'),
  await onScreen()
)
await page.keyboard.press('Control+Y')
await sleep(500)
check('and Ctrl+Y the change again', (await onScreen()).includes('fromClaude'), await onScreen())
check('which is clean again', (await dirty()) === 0)

// --- an edited buffer is told, and not touched ---------------------------------------
await typeAtEnd('// mine\n')
const based = read()
changeOnDisk('export const replaced = 3\n')
const told = await within(LOOK, async () => (await bar()) !== null)
check('an edited buffer is told the file changed, before anything is saved', told)
check('in words', /changed on disk/i.test(String(await bar())), String(await bar()))
const kept = await onScreen()
check('and keeps every character of its own', kept.includes('// mine') && !kept.includes('replaced'), kept)
check('and nothing is written', read() === 'export const replaced = 3\n', JSON.stringify(read()))

// --- and when the file comes back as it was, so does everything else ---------------------
fs.writeFileSync(FILE, based, 'utf8')
check(
  'the bar goes when the file returns to the version the edits were made on',
  await within(LOOK, async () => (await bar()) === null),
  String(await bar())
)
check('with the edit still there, unsaved', (await dirty()) === 1 && (await onScreen()).includes('// mine'))
await page.keyboard.press('Control+S')
await sleep(1200)
check('and saving it asks nothing', read().includes('// mine') && (await bar()) === null, JSON.stringify(read()))

// --- a deleted file ------------------------------------------------------------------------
const last = read()
fs.rmSync(FILE)
check(
  'a file deleted underneath the editor is said to be deleted',
  await within(LOOK, async () => /deleted/i.test(String(await bar()))),
  String(await bar())
)
check('and its text is marked as the only copy left', (await dirty()) === 1)
fs.writeFileSync(FILE, last, 'utf8')
check(
  'and when it comes back as it was, the tab is as it was',
  await within(LOOK, async () => (await bar()) === null && (await dirty()) === 0),
  `${await bar()} dirty=${await dirty()}`
)

// --- switching branch in Ember --------------------------------------------------------------
// The working tree has to be clean for git to switch, and the editor follows that
// too — which is the first part of this, again, from the other direction. Put back
// by git rather than by writing the text: with core.autocrlf on, as it is on many
// Windows machines, the same text with other line endings is a modification git
// refuses to switch branches over.
git('checkout', '--', 'notes.ts')
check(
  'the file back at the committed version is followed',
  await within(LOOK, async () => !(await onScreen()).includes('// mine')),
  await onScreen()
)
await page.click('.activity__item[data-view="scm"]')
await page.waitForSelector('.scm', { timeout: 10_000 })
await sleep(800)
const switchTo = async (name) => {
  await page.locator('button.scm__branch').click()
  await page.waitForSelector('.qp__box', { timeout: 8_000 })
  await page.locator('.qp__box').fill(name)
  await sleep(500)
  await page.keyboard.press('Enter')
}
await switchTo('other')
check(
  'a branch switched in Ember brings the editor that branch’s version',
  await within(LOOK, async () => (await onScreen()).includes('onlyOnOther')),
  await onScreen()
)
check('on the branch git says', git('branch', '--show-current') === 'other', git('branch', '--show-current'))
check('clean, and with nothing to decide', (await dirty()) === 0 && (await bar()) === null)
await switchTo('main')
check(
  'and switching back brings back main’s',
  await within(LOOK, async () => !(await onScreen()).includes('onlyOnOther')),
  await onScreen()
)

await app.close()
profile.cleanup()
fs.rmSync(repo, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('editors follow the disk:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
