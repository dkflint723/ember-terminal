// Source-control checks against a scratch repository.
//
// Everything is asserted through the UI and then confirmed against git itself,
// because the panel's whole contract is that it agrees with the command line: a
// staged file has to be staged for `git status` too, not merely drawn as staged.
//
// Run: node scripts/verify-git.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
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

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, path.join(repo, 'tracked.ts')],
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

const failures = []
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
}

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

await app.close()
fs.rmSync(repo, { recursive: true, force: true })

for (const f of failures) console.log(`  - ${f}`)
console.log('source control:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 5))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
