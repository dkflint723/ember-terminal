// What git knows that is not the working tree.
//
// The panel could show what has changed and nothing whatever about the past: no
// blame, no log, no stash. Those are the three everyday git operations people
// reach for that Ember simply had no code for, and they are checked together
// because they share one thing — they all answer questions about commits rather
// than about files on disk.
//
// Everything here happens in a repository this script builds and throws away. The
// stash in particular must never be exercised against a real one: dropping a
// stash is the single git operation in this app that nothing undoes.
//
// Run: node scripts/verify-history.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('history')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- a repository with a past ------------------------------------------------
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-history-'))
const git = (...args) =>
  execFileSync('git', args, {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com'
    }
  })

git('init', '-q', '-b', 'main')
git('config', 'user.name', 'Ada Lovelace')
git('config', 'user.email', 'ada@example.com')

fs.writeFileSync(path.join(work, 'notes.ts'), ['export const first = 1', ''].join('\n'))
git('add', '.')
git('commit', '-q', '-m', 'The first commit, which the log must show')

fs.writeFileSync(
  path.join(work, 'notes.ts'),
  ['export const first = 1', 'export const second = 2', ''].join('\n')
)
git('add', '.')
git('commit', '-q', '-m', 'The second commit, which blame must attribute')

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2500)

/*
 * --- blame, on the line the caret is on --------------------------------------
 *
 * Line 2 belongs to the second commit and line 1 to the first, so this also
 * proves the annotation follows the caret rather than reporting the file's most
 * recent commit for every line — which is the failure that would look correct on
 * a one-commit file.
 */
await page.keyboard.press('Control+p')
await sleep(800)
await page.keyboard.type('notes.ts', { delay: 25 })
await sleep(1200)
await page.keyboard.press('Enter')
await page.waitForSelector('.monaco-editor', { timeout: 20_000 })
await sleep(3000)

const blameAt = async (line) => {
  await page.click('.monaco-editor .view-lines')
  await page.keyboard.press('Control+Home')
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown')
  await sleep(2200)
  /*
   * Monaco renders the spaces inside an `after` decoration as hard spaces
   * (U+00A0), so a plain substring test against ordinary spaces fails on text
   * that plainly contains the words. Normalised here rather than in the product,
   * where the hard spaces are correct: they are what stops the annotation
   * wrapping away from the line it belongs to.
   */
  return page.evaluate(() =>
    (document.querySelector('.editor__blame')?.textContent ?? '')
      .replace(/\u00a0/g, ' ')
      .trim()
  )
}

const line2 = await blameAt(2)
check('the caret line is blamed', line2.length > 0, JSON.stringify(line2))
check('with the author git recorded', line2.includes('Ada Lovelace'), JSON.stringify(line2))
check(
  'and the commit that actually touched that line',
  line2.includes('second commit'),
  JSON.stringify(line2)
)

const line1 = await blameAt(1)
check(
  'a different line reports its own commit',
  line1.includes('first commit'),
  JSON.stringify(line1)
)

// --- the log ------------------------------------------------------------------
await page.keyboard.press('Control+Shift+G')
await sleep(1500)
await page.locator('.scm__section-toggle', { hasText: 'History' }).click()
await sleep(2000)

const log = await page.evaluate(() =>
  [...document.querySelectorAll('.log__row')].map((r) => ({
    hash: r.querySelector('.log__hash')?.textContent ?? '',
    subject: r.querySelector('.log__subject')?.textContent ?? ''
  }))
)
check('the history lists both commits', log.length === 2, JSON.stringify(log))
check(
  'newest first, as git orders them',
  log[0]?.subject.includes('second commit'),
  JSON.stringify(log.map((l) => l.subject))
)
check('each with its short hash', /^[0-9a-f]{7,}$/.test(log[0]?.hash ?? ''), log[0]?.hash)

// --- the stash ----------------------------------------------------------------
// A change to put away, and an untracked file beside it: a stash that leaves new
// files behind is the one that loses work.
fs.writeFileSync(
  path.join(work, 'notes.ts'),
  ['export const first = 1', 'export const second = 2', 'export const third = 3', ''].join('\n')
)
fs.writeFileSync(path.join(work, 'untracked.txt'), 'new file\n')
await sleep(2500)

await page.locator('.scm__section-head', { hasText: 'Stashes' }).locator('.icon-btn').click()
await sleep(3000)

const stashed = await page.evaluate(() =>
  [...document.querySelectorAll('.stash__subject')].map((e) => e.textContent ?? '')
)
check('stashing puts an entry on the stash', stashed.length === 1, JSON.stringify(stashed))
check(
  'and the working tree goes back to the commit',
  fs.existsSync(path.join(work, 'notes.ts')) &&
    !fs.readFileSync(path.join(work, 'notes.ts'), 'utf8').includes('third'),
  'notes.ts still holds the stashed edit'
)
check(
  'taking the untracked file with it',
  !fs.existsSync(path.join(work, 'untracked.txt')),
  'untracked.txt was left behind'
)

// Pop it back.
await page.locator('.stash__row').first().locator('.icon-btn').first().click()
await sleep(3000)

check(
  'popping restores the edit',
  fs.readFileSync(path.join(work, 'notes.ts'), 'utf8').includes('third'),
  'the edit did not come back'
)
check(
  'and the untracked file with it',
  fs.existsSync(path.join(work, 'untracked.txt')),
  'untracked.txt did not come back'
)
const left = await page.evaluate(() => document.querySelectorAll('.stash__subject').length)
check('leaving the stash empty', left === 0, `${left} left`)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('git history:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
