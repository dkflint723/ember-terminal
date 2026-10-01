// Git worktrees as sessions beside each other.
// Run: node scripts/verify-worktrees.mjs
//
// Parallel work on another branch meant a second clone, or stashing and switching
// one checkout back and forth (audit R33). Source Control now lists the repository's
// worktrees, makes one for a new branch beside the repository, opens each as a
// session of its own, and removes one only after asking — and not while it holds
// anything removing it would lose.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, seedDirs, workDir } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('worktrees')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const repo = workDir('ember-worktrees-')
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'suite@example.com')
git('config', 'user.name', 'Suite')
fs.writeFileSync(path.join(repo, 'readme.txt'), 'hello\n')
git('add', '.')
git('commit', '-qm', 'first')
const sibling = `${repo}-feat-x`
for (const d of seedDirs(profile.dir)) {
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ trustedFolders: [repo] }), 'utf8')
}

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, repo],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(800)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const waitFor = async (test, ms) => {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (await test()) return true
    await sleep(250)
  }
  return test()
}
const notice = () => page.evaluate(() => document.querySelector('.notice')?.textContent ?? '')
// What the panel says when git refuses: its own error line.
const panelSays = () => page.evaluate(() => document.querySelector('.scm__error')?.textContent ?? '')

await page.click('.activity__item[data-view="scm"]')
await page.waitForSelector('.worktree__new', { timeout: 15_000 })
await sleep(500)
const rows = () => page.evaluate(() => [...document.querySelectorAll('.worktree__row')].map((r) => r.textContent ?? ''))
check('Source Control lists the repository as its first worktree', (await rows()).length === 1 && /main/.test((await rows())[0] ?? ''), JSON.stringify(await rows()))

// --- a bad name is refused, saying so ---------------------------------------------------------
await page.locator('.worktree__new').fill('bad..name')
await page.locator('.worktree__form button[type="submit"]').click()
await waitFor(async () => /not a branch name/.test(await notice()), 8_000)
check('a name git would refuse is refused, by name', /not a branch name/.test(await notice()), await notice())

// --- made, and opened as a session of its own ----------------------------------------------------
await page.locator('.worktree__new').fill('feat-x')
await page.locator('.worktree__form button[type="submit"]').click()
await waitFor(() => fs.existsSync(sibling), 20_000)
check('a worktree is made beside the repository', fs.existsSync(path.join(sibling, 'readme.txt')), sibling)
check('on its new branch', git('worktree', 'list').includes('[feat-x]'), git('worktree', 'list'))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)
const before = await page.locator('.block--done', { hasText: 'WHERE[' }).count()
await page.locator('.composer__input').first().focus()
await page.keyboard.type('Write-Output "WHERE[$((Get-Location).Path)]"', { delay: 4 })
await page.keyboard.press('Enter')
await waitFor(async () => (await page.locator('.block--done', { hasText: 'WHERE[' }).count()) > before, 15_000)
const where = (await page.locator('.block--done', { hasText: 'WHERE[' }).last().locator('.block__body').textContent()) ?? ''
check('whose shell starts in the worktree', where.toLowerCase().includes(sibling.toLowerCase()), where)
const trusted = await page.evaluate(async () => (await window.ember.getSettings()).trustedFolders)
check('and which is trusted, as the repository it came from is', trusted.some((f) => f.toLowerCase() === sibling.toLowerCase()), JSON.stringify(trusted))

// --- removed only when nothing would be lost ---------------------------------------------------
// Opened again only if it is not showing: pressing its icon while it is shown closes it.
if (!(await page.locator('.worktree__new').isVisible().catch(() => false))) await page.click('.activity__item[data-view="scm"]')
await page.waitForSelector('[aria-label="Remove the worktree feat-x"]', { timeout: 15_000 })
fs.writeFileSync(path.join(sibling, 'unsaved-work.txt'), 'not committed\n')
// Every question is answered and kept; the first removal must not ask at all.
const asked = []
page.on('dialog', (d) => {
  asked.push(d.message())
  void d.accept()
})
await page.locator('[aria-label="Remove the worktree feat-x"]').click()
await waitFor(async () => /changes or untracked files/.test(await panelSays()), 10_000)
check('removing is refused while it holds untracked work, before anything is asked', fs.existsSync(path.join(sibling, 'unsaved-work.txt')) && /changes or untracked files/.test(await panelSays()) && asked.length === 0, `${await panelSays()} | asked: ${asked.join(' / ')}`)
fs.rmSync(path.join(sibling, 'unsaved-work.txt'))
// A file git ignores goes with the folder, so the question names it.
fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\n*.log\n')
fs.writeFileSync(path.join(sibling, 'build.log'), 'ignored\n')
// The folder both sit in, trusted too: removing the worktree must not take it away.
const parent = path.dirname(sibling)
await page.evaluate(async (p) => {
  const s = await window.ember.getSettings()
  await window.ember.setSettings({ trustedFolders: [...s.trustedFolders, p] })
}, parent)
await page.locator('[aria-label="Remove the worktree feat-x"]').click()
await waitFor(() => !fs.existsSync(sibling), 15_000)
const question = asked[0] ?? ''
check('it asks first, saying its session will be closed', /Remove the worktree/.test(question) && /session here will be closed/.test(question), question)
check('and naming the ignored files deleted with it', /git ignores/.test(question) && question.includes('build.log'), question)
check('with nothing to lose, it is removed — its session closed so the folder can go', !fs.existsSync(sibling), await panelSays())
check('and the branch stays', git('branch', '--list', 'feat-x').includes('feat-x'))
const left = await page.evaluate(async () => (await window.ember.getSettings()).trustedFolders)
const key = (f) => f.toLowerCase().replace(/[\\/]+$/, '')
check('its own trust is forgotten, the folder it sits in still trusted', !left.some((f) => key(f) === key(sibling)) && left.some((f) => key(f) === key(parent)), JSON.stringify(left))

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
try {
  git('worktree', 'prune')
} catch {
  // Already gone.
}
fs.rmSync(sibling, { recursive: true, force: true })
fs.rmSync(repo, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('worktrees:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
