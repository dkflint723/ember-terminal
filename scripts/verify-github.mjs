// GitHub panel checks.
//
// Driven against a real repository, because the whole panel is a view of what `gh`
// says and a fixture would only prove the fixture. A scratch repo with a remote
// pointing at a large public project gives real pull requests and issues without
// needing write access to anything.
//
// Skips rather than fails when gh is missing, signed out, or the network is not
// there — none of those are defects in this code, and a check that goes red for
// them stops meaning anything.
//
// Run: node scripts/verify-github.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const UPSTREAM = 'https://github.com/cli/cli.git'

const skip = (why) => {
  console.log(`github panel: SKIP — ${why}`)
  process.exit(0)
}

try {
  execFileSync('gh', ['auth', 'status'], { stdio: 'ignore', windowsHide: true })
} catch {
  skip('gh is not installed or not signed in')
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-gh-'))
const git = (...args) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
git('init', '-q', '-b', 'main')
git('remote', 'add', 'origin', UPSTREAM)
fs.writeFileSync(path.join(repo, 'note.md'), '# scratch\n', 'utf8')

// Fail fast and skip if the repository is not reachable, rather than launching the
// app and blaming the panel for a network problem.
try {
  execFileSync('gh', ['repo', 'view', '--json', 'name'], {
    cwd: repo,
    stdio: 'ignore',
    timeout: 25_000,
    windowsHide: true
  })
} catch {
  fs.rmSync(repo, { recursive: true, force: true })
  skip('cannot reach github.com')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, path.join(repo, 'note.md')],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)

const errors = []
const BENIGN = [/textDocument\/foldingRange failed/]
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- the view is reachable from the rail ------------------------------------
check('the rail has three views', (await page.locator('.activity__item').count()) === 3)
await page.click('.activity__item[data-view="github"]')
await page.waitForSelector('.gh', { timeout: 10_000 })

// The first load is a network round trip, so it is waited for rather than slept on.
await page.waitForSelector('.gh__repo', { timeout: 40_000 })
const repoLabel = (await page.locator('.gh__repo').textContent())?.trim()
check('names the repository from the remote', repoLabel === 'cli/cli', repoLabel)

// --- pull requests ----------------------------------------------------------
await page.waitForSelector('.gh__row', { timeout: 30_000 })
const prs = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.gh__row')).map((r) => ({
    num: r.querySelector('.gh__num')?.textContent ?? '',
    title: r.querySelector('.gh__title')?.textContent ?? '',
    meta: r.querySelector('.gh__meta')?.textContent ?? ''
  }))
)
check('lists pull requests', prs.length > 0, `${prs.length} rows`)
check('each has a number', prs.every((p) => /^#\d+$/.test(p.num)), JSON.stringify(prs[0]))
check('each has a title', prs.every((p) => p.title.length > 0))
check('each names an author', prs.every((p) => p.meta.length > 0), JSON.stringify(prs[0]?.meta))
await page.screenshot({ path: path.join(SHOT_DIR, '60-github-prs.png') })

// --- issues -----------------------------------------------------------------
await page.locator('.gh__switch-btn', { hasText: 'Issues' }).click()
await sleep(700)
const issues = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.gh__row')).map(
    (r) => r.querySelector('.gh__num')?.textContent ?? ''
  )
)
check('switches to issues', issues.length > 0, `${issues.length} rows`)
check('which are also numbered', issues.every((n) => /^#\d+$/.test(n)), issues[0])
await page.screenshot({ path: path.join(SHOT_DIR, '61-github-issues.png') })

// A pull request and an issue are numbered from the same sequence, so identical
// lists would mean the switch did nothing.
const prNumbers = prs.map((p) => p.num).join(',')
check('issues are not the pull request list again', issues.join(',') !== prNumbers)

await app.close()
fs.rmSync(repo, { recursive: true, force: true })

for (const f of failures) console.log(`  - ${f}`)
console.log('github panel:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
