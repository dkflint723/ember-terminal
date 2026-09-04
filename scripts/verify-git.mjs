// Source-control checks against a scratch repository.
//
// Everything is asserted through the UI and then confirmed against git itself,
// because the panel's whole contract is that it agrees with the command line: a
// staged file has to be staged for `git status` too, not merely drawn as staged.
//
// Run: node scripts/verify-git.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('git')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-git-'))
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()

// A repository with one commit, then one modification and one new file: the
// smallest tree that exercises tracked and untracked paths at the same time.
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'verify@example.invalid')
git('config', 'user.name', 'Verify')
fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 1\n', 'utf8')
git('add', '-A')
git('commit', '-qm', 'initial')
fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 2\n', 'utf8')
fs.writeFileSync(path.join(repo, 'fresh.ts'), 'export const added = true\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/*
 * --- the shell's own repository, with no folder open -------------------------
 *
 * The branch and change-count chips used to come from the workspace status alone,
 * so they appeared only for someone who had opened a folder and whose shell
 * happened to sit inside it. A terminal is the case that matters: launched bare,
 * cd'd into a project, wanting to know what it is about to commit to. This runs on
 * its own profile so the session it writes cannot disturb the checks below.
 */
{
  const bare = newProfile('git-cwd')
  const app = await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, bare.arg],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
  await sleep(1500)

  // Read from the status bar: the branch and the change count moved out of the
  // composer, since they are facts about the session rather than about the thing
  // being typed.
  const chips = () =>
    page.evaluate(() => ({
      branch: document.querySelector('[data-status="branch"]')?.textContent?.trim() ?? null,
      changes: document.querySelector('[data-status="changes"]')?.textContent?.trim() ?? null,
      workspace: !!document.querySelector('.sidebar')
    }))

  const before = await chips()
  check('a terminal outside a repository shows no branch', before.branch === null, before.branch)

  await page.click('.composer__input')
  await page.keyboard.type(`cd "${repo}"`, { delay: 10 })
  await page.keyboard.press('Enter')
  await sleep(4000)

  const after = await chips()
  check('cd into a repository shows its branch', after.branch === 'main', after.branch)
  /*
   * The chip carries three facts now: how many paths changed, and how many lines
   * went in and out — read from `git diff --shortstat`, both sides of the index.
   * This fixture has two changed paths and a one-line edit, so all three numbers
   * are known exactly and each is asserted rather than pattern-matched.
   */
  const changes = (after.changes ?? '').replace(/\s/g, '')
  check('and how many paths changed', changes.startsWith('2●'), after.changes)
  check('with the lines added and removed', changes.includes('+1') && changes.includes('−1'), after.changes)
  check('with no folder opened to make it happen', after.workspace === false)
  await page.screenshot({ path: path.join(SHOT_DIR, '71-git-cwd-chips.png') })

await app.close()
  await sleep(800)
  bare.cleanup()
}

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, path.join(repo, 'tracked.ts')],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})

const errors = []
// Folding ranges can be requested before the language server has the document; it
// is already treated as benign by the editor checks for the same reason.
const BENIGN = [/textDocument\/foldingRange failed/]
const page = await app.firstWindow()
await placeTopRight(app)
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})
page.on('console', (m) => {
  if (m.type() === 'error' && !BENIGN.some((re) => re.test(m.text()))) {
    errors.push(`[console] ${m.text()}`)
  }
})

await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
// Discarding prompts for confirmation; the harness always agrees.
page.on('dialog', (d) => void d.accept())

// --- the activity bar is present with the sidebar closed -------------------
// Asserted as "has a source control entry" rather than a count: this check exists
// to prove the rail is there and reaches this view, and counting made adding a
// third view look like a regression in source control.
const railCount = await page.locator('.activity__item').count()
check('the rail is present', railCount >= 2, `saw ${railCount}`)
check(
  'and offers source control',
  (await page.locator('.activity__item[data-view="scm"]').count()) === 1
)

// The badge counts changed paths, and must appear without the sidebar ever
// being opened — it reads the same status the explorer colours itself from.
await page.waitForFunction(() => document.querySelector('.activity__badge')?.textContent === '2', {
  timeout: 15_000
})
check('badge counts both changes', true)

// --- source control view ---------------------------------------------------
await page.click('.activity__item[data-view="scm"]')
await page.waitForSelector('.scm', { timeout: 10_000 })
await sleep(600)

const branch = (await page.locator('.scm__branch').textContent())?.trim()
check('branch is shown', branch?.includes('main'), branch)

const listed = await page.locator('.scm__row').count()
check('both changes listed', listed === 2, `saw ${listed}`)

const statuses = await page.locator('.scm__status').allTextContents()
check('modified and untracked distinguished', statuses.sort().join('') === 'MU', statuses.join(''))

await page.screenshot({ path: path.join(SHOT_DIR, '20-source-control.png') })

// --- diff opens in a pane --------------------------------------------------
await page.locator('.scm__file', { hasText: 'tracked.ts' }).first().click()
await page.waitForSelector('.pane.diff', { timeout: 15_000 })
await sleep(1200)

const diff = await page.evaluate(() => {
  const pane = document.querySelector('.pane.diff')
  return {
    path: pane?.getAttribute('data-diff-path') ?? null,
    // Monaco marks inserted lines in the modified editor of a diff view.
    insertions: document.querySelectorAll('.line-insert, .char-insert').length,
    label: pane?.querySelector('.editor__lang')?.textContent ?? ''
  }
})
check('diff pane names the file', diff.path === 'tracked.ts', diff.path)
check('diff renders a change', diff.insertions > 0, `${diff.insertions} marked regions`)
check('diff labels its sides', diff.label.includes('Working tree'), diff.label)
await page.screenshot({ path: path.join(SHOT_DIR, '21-diff.png') })

// --- staging, confirmed against git ---------------------------------------
await page.locator('.scm__row', { hasText: 'tracked.ts' }).first().hover()
await page.locator('.scm__row', { hasText: 'tracked.ts' }).first().locator('[title="Stage"]').click()
await sleep(1200)

const stagedByGit = git('diff', '--cached', '--name-only')
check('staging reached the index', stagedByGit === 'tracked.ts', JSON.stringify(stagedByGit))

const sections = await page.locator('.scm__section-head').allTextContents()
check('staged section appears', sections.some((s) => s.includes('Staged')), sections.join(' | '))

// --- commit, confirmed against git ----------------------------------------
await page.fill('.scm__message', 'verify: stage and commit from the panel')
await page.click('.scm__commit-btn')
await sleep(2000)

const subject = git('log', '-1', '--pretty=%s')
check('commit landed', subject === 'verify: stage and commit from the panel', subject)
const stillStaged = git('diff', '--cached', '--name-only')
check('index is clear after commit', stillStaged === '', JSON.stringify(stillStaged))

// The untracked file is still there, so the panel must still show exactly one row.
await sleep(1200)
const remaining = await page.locator('.scm__row').count()
check('untracked file survives the commit', remaining === 1, `saw ${remaining}`)

// --- explorer decorations --------------------------------------------------
await page.click('.activity__item[data-view="explorer"]')
await page.waitForSelector('.tree', { timeout: 10_000 })
await sleep(1500)

const decorated = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.tree__row[data-git]:not([data-git=""])')).map((r) => ({
    name: r.querySelector('.tree__label')?.textContent,
    status: r.getAttribute('data-git')
  }))
)
check(
  'explorer marks the untracked file',
  decorated.some((d) => d.name === 'fresh.ts' && d.status === 'U'),
  JSON.stringify(decorated)
)
await page.screenshot({ path: path.join(SHOT_DIR, '22-explorer-git.png') })

/*
 * --- a merge that has to be finishable ---------------------------------------
 *
 * A merge with a conflict is the case the panel handled worst: the conflicted file
 * showed an empty left-hand side labelled "Index", presenting the whole thing as an
 * addition; there was no way to mark it resolved; and once it was resolved the
 * change lists went empty, so the panel said "No changes" and disabled Commit —
 * the one action that would have finished the merge.
 */
// The explorer checks above left the sidebar on the file tree.
await page.keyboard.press('Control+Shift+G')
await page.waitForSelector('.scm', { timeout: 10_000 })
await sleep(800)

git('checkout', '-q', '-b', 'other', 'HEAD')
fs.writeFileSync(path.join(repo, 'conflict.txt'), 'theirs\n', 'utf8')
git('add', '-A')
git('commit', '-qm', 'theirs')
git('checkout', '-q', 'main')
fs.writeFileSync(path.join(repo, 'conflict.txt'), 'ours\n', 'utf8')
git('add', '-A')
git('commit', '-qm', 'ours')
try {
  git('merge', 'other')
} catch {
  // Expected: this is the conflict the checks below are about.
}

await page.locator('.icon-btn[title="Refresh"]').click()
await sleep(2500)

const merging = await page.evaluate(() => ({
  operation: document.querySelector('.scm__operation')?.textContent ?? null,
  conflictRows: Array.from(document.querySelectorAll('.scm__section')).some((s) =>
    (s.querySelector('.scm__section-head')?.textContent ?? '').includes('Merge conflicts')
  ),
  resolveButton: !!document.querySelector('[title="Mark resolved and stage"]')
}))
check('a merge in progress is reported', merging.operation?.includes('Merge') === true, JSON.stringify(merging))
check('the conflict is listed', merging.conflictRows, JSON.stringify(merging))
check('and can be marked resolved from the panel', merging.resolveButton, JSON.stringify(merging))

// The conflict's diff must show the two sides being merged, not an empty original.
await page
  .locator('.scm__row', { hasText: 'conflict.txt' })
  .first()
  .locator('.scm__file')
  .click()
await sleep(2500)
// Across every diff pane: the earlier checks left one open on another file.
const conflictDiff = await page.evaluate(() => ({
  panes: Array.from(document.querySelectorAll('.pane.diff')).map((p) => p.textContent ?? '')
}))
check(
  'a conflict diff shows both sides rather than an empty original',
  conflictDiff.panes.some((t) => t.includes('ours') && t.includes('theirs')),
  JSON.stringify(conflictDiff).slice(0, 260)
)

// Resolve it, stage it, and the merge must become committable.
fs.writeFileSync(path.join(repo, 'conflict.txt'), 'resolved\n', 'utf8')
await page.locator('.icon-btn[title="Refresh"]').click()
await sleep(2000)
// Row actions appear on hover, so the row is pointed at first — Playwright checks
// visibility before it moves the mouse, so a direct click never becomes actionable.
const conflictRow = page.locator('.scm__row', { hasText: 'conflict.txt' }).first()
await conflictRow.hover()
await sleep(400)
await conflictRow.locator('[title="Mark resolved and stage"]').click()
await sleep(2500)

await page.locator('.scm__message').fill('finish the merge')
await sleep(600)
const canFinish = await page.evaluate(() => {
  const btn = document.querySelector('.scm__commit-btn')
  return { disabled: btn?.disabled ?? null, title: btn?.getAttribute('title') ?? null }
})
check('a resolved merge can be committed', canFinish.disabled === false, JSON.stringify(canFinish))
await page.click('.scm__commit-btn')
await sleep(2500)

/*
 * --- the remote, reachable from the panel ------------------------------------
 *
 * The head has always shown ahead/behind and an upstream tooltip; now the
 * arrows beside them act. A bare repository stands in for origin: the first
 * push has no upstream and must publish the branch, the pull must bring back a
 * commit made elsewhere, and every claim is checked against git itself.
 */
const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-git-remote-'))
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-git-elsewhere-'))
const gitAt = (dir, ...args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true }).trim()
gitAt(remoteDir, 'init', '-q', '--bare')
git('remote', 'add', 'origin', remoteDir)

await page.locator('.scm [aria-label="Push"]').click()
await sleep(3000)
const scmSays = await page.evaluate(() => ({
  error: document.querySelector('.scm__error')?.textContent ?? null,
  note: document.querySelector('.scm__note')?.textContent ?? null
}))
// By ref, not by HEAD: a fresh bare's HEAD names an unborn default branch,
// and `git log` with no ref dies on it even after a successful push of main.
let pushedLog = ''
try {
  pushedLog = gitAt(remoteDir, 'log', '--oneline', '-1', 'main')
} catch {
  pushedLog = '(remote has no main)'
}
check(
  'push publishes the branch to origin',
  pushedLog.includes('finish the merge'),
  `${pushedLog} | panel: ${JSON.stringify(scmSays)}`
)
const upstreamNow = await page.evaluate(
  () => document.querySelector('button.scm__branch')?.getAttribute('title') ?? ''
)
check('and the branch now has an upstream', upstreamNow.includes('origin/'), upstreamNow)

// Someone else moves the remote on; the panel pulls it back.
gitAt(elsewhere, 'clone', '-q', '-b', 'main', remoteDir, 'work')
const there = path.join(elsewhere, 'work')
gitAt(there, 'config', 'user.email', 'verify@example.invalid')
gitAt(there, 'config', 'user.name', 'Verify Elsewhere')
fs.writeFileSync(path.join(there, 'from-elsewhere.txt'), 'hello from the other clone' + String.fromCharCode(10), 'utf8')
gitAt(there, 'add', '-A')
gitAt(there, 'commit', '-qm', 'a commit made elsewhere')
gitAt(there, 'push', '-q')

await page.locator('.scm [title="Refresh"]').click()
await sleep(2000)
await page.locator('.scm [aria-label="Pull"]').click()
await sleep(3000)
check(
  'pull brings the elsewhere commit home',
  fs.existsSync(path.join(repo, 'from-elsewhere.txt'))
)

// --- branches, switched and created from the head ------------------------------
await page.locator('button.scm__branch').click()
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('feature-verify')
await sleep(500)
await page.keyboard.press('Enter')
await sleep(2000)
check(
  'typing a new name creates and switches',
  git('branch', '--show-current') === 'feature-verify',
  git('branch', '--show-current')
)

await page.locator('button.scm__branch').click()
await page.waitForSelector('.qp__box', { timeout: 8_000 })
await page.locator('.qp__box').fill('main')
await sleep(500)
await page.keyboard.press('Enter')
await sleep(2000)
check('picking an existing branch switches back', git('branch', '--show-current') === 'main', git('branch', '--show-current'))

fs.rmSync(remoteDir, { recursive: true, force: true })
fs.rmSync(elsewhere, { recursive: true, force: true })

/*
 * A stash is acted on by identity, not by position.
 *
 * `stash@{n}` is positional and every push shifts it — including one made in the
 * terminal in the next pane, which this app treats as the ordinary case. The
 * panel loads its list once, so its rows can describe one stash while their
 * references point at another, and the confirm-twice gesture then confirms a
 * label while destroying something else.
 */
fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 10\n', 'utf8')
const pushed = await page.evaluate((r) => window.ember.gitStashPush(r, 'first stash'), repo)
fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 11\n', 'utf8')
await page.evaluate((r) => window.ember.gitStashPush(r, 'second stash'), repo)
const stashesBefore = await page.evaluate((r) => window.ember.gitStashList(r), repo)

// The row the panel is showing for the older stash, read before anything moves.
const older = stashesBefore.find((e) => e.subject.includes('first stash'))

// Something else gets stashed — from the terminal, from another window, from
// anywhere. Every reference below it now names a different stash.
fs.writeFileSync(path.join(repo, 'tracked.ts'), 'export const value = 12\n', 'utf8')
await page.evaluate((r) => window.ember.gitStashPush(r, 'third stash'), repo)

const dropped = await page.evaluate(
  ([r, ref, hash]) => window.ember.gitStashDrop(r, ref, hash),
  [repo, older?.ref, older?.hash]
)
const stashesAfter = await page.evaluate((r) => window.ember.gitStashList(r), repo)
check(
  'a stash reference that no longer names the same stash is refused',
  dropped?.ok === false,
  JSON.stringify({ pushed: pushed?.ok, older, dropped })
)
check(
  'and nothing is destroyed',
  stashesAfter.length === 3,
  JSON.stringify(stashesAfter.map((e) => e.subject))
)


await app.close()
fs.rmSync(repo, { recursive: true, force: true })

profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('source control:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 5))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
