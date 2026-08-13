// Scratch probe: source-control panel against a repo with staged/modified/untracked/conflicted.
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import { placeTopRight } from './place-window.mjs'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('scmprobe')
const SHOT = path.join(APP_DIR, '.shots-probe')
fs.mkdirSync(SHOT, { recursive: true })

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-scm-'))
const git = (...a) =>
  execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const w = (p, s) => fs.writeFileSync(path.join(repo, p), s, 'utf8')

git('init', '-q', '-b', 'main')
git('config', 'user.email', 'p@p.invalid')
git('config', 'user.name', 'P')
w('base.txt', 'one\n')
w('conflict.txt', 'shared\n')
w('tostage.txt', 'stage me\n')
w('todiscard.txt', 'original\n')
git('add', '-A')
git('commit', '-qm', 'initial')

git('checkout', '-q', '-b', 'side')
w('conflict.txt', 'side version\n')
git('commit', '-qam', 'side')
git('checkout', '-q', 'main')
w('conflict.txt', 'main version\n')
git('commit', '-qam', 'main-side')
try {
  git('merge', 'side')
} catch {
  /* expected */
}

w('tostage.txt', 'staged content\n')
git('add', 'tostage.txt')
w('todiscard.txt', 'MODIFIED - would be lost\n')
w('brandnew.txt', 'untracked content\n')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, repo],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
let dialogAction = 'dismiss'
const dialogs = []
page.on('dialog', (d) => {
  dialogs.push({ type: d.type(), message: d.message() })
  if (dialogAction === 'accept') void d.accept()
  else void d.dismiss()
})
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await page.waitForSelector('.activity__item[data-view="scm"]', { timeout: 30_000 })
await page.click('.activity__item[data-view="scm"]')
await page.waitForSelector('.scm', { timeout: 15_000 })
await sleep(1500)

const openScm = async () => {
  const open = await page.evaluate(
    () => !!document.querySelector('.sidebar[data-view="scm"] .scm')
  )
  if (!open) {
    await page.click('.activity__item[data-view="scm"]')
    await page.waitForSelector('.scm', { timeout: 10_000 })
  }
  await sleep(500)
}

const snap = async (label) => {
  const data = await page.evaluate(() => {
    const sections = Array.from(document.querySelectorAll('.scm__section')).map((s) => ({
      head: s.querySelector('.scm__section-head')?.textContent?.trim(),
      rows: Array.from(s.querySelectorAll('.scm__row')).map((r) => ({
        name: r.querySelector('.scm__name')?.textContent,
        status: r.querySelector('.scm__status')?.textContent,
        actions: Array.from(r.querySelectorAll('.scm__actions button, .scm__actions span')).map(
          (b) => b.getAttribute('title') ?? b.textContent
        )
      }))
    }))
    const btn = document.querySelector('.scm__commit-btn')
    return {
      branch: document.querySelector('.scm__branch')?.textContent?.trim(),
      badge: document.querySelector('.activity__badge')?.textContent,
      sections,
      commitDisabled: btn?.hasAttribute('disabled'),
      commitTitle: btn?.getAttribute('title'),
      error: document.querySelector('.scm__error')?.textContent ?? null,
      note: document.querySelector('.scm__note')?.textContent ?? null,
      empty: document.querySelector('.scm--empty')?.textContent ?? null
    }
  })
  console.log(`\n=== ${label} ===`)
  console.log(JSON.stringify(data))
  return data
}

// ---------- 1. conflicted file diff ----------
const conflictRow = page.locator('.scm__row', { hasText: 'conflict.txt' }).first()
await conflictRow.locator('.scm__file').click()
await sleep(2500)
const diffTexts = await page.evaluate(() => {
  const pane = document.querySelector('.pane.diff')
  if (!pane) return { none: true }
  const eds = pane.querySelectorAll('.monaco-diff-editor .editor')
  return {
    path: pane.getAttribute('data-diff-path'),
    label: pane.querySelector('.editor__lang')?.textContent,
    sides: Array.from(eds).map((e) => (e.textContent || '').slice(0, 200)),
    inserts: pane.querySelectorAll('.line-insert').length,
    deletes: pane.querySelectorAll('.line-delete').length
  }
})
console.log('\n=== conflicted-file diff ===')
console.log(JSON.stringify(diffTexts, null, 1))
console.log('working-tree conflict.txt on disk:', JSON.stringify(fs.readFileSync(path.join(repo, 'conflict.txt'), 'utf8')))
await page.screenshot({ path: path.join(SHOT, 'b-conflict-diff.png') })

// ---------- 2. Ctrl+Enter with an empty message ----------
await openScm()
await page.fill('.scm__message', '')
await page.locator('.scm__message').press('Control+Enter')
await sleep(1500)
await snap('after Ctrl+Enter with EMPTY message')

// ---------- 3. message persistence across a view switch ----------
await page.fill('.scm__message', 'a carefully written commit message')
await sleep(300)
await page.click('.activity__item[data-view="explorer"]')
await sleep(800)
await openScm()
const kept = await page.inputValue('.scm__message')
console.log('\n=== message after switching views and back ===', JSON.stringify(kept))

// ---------- 4. Ctrl+Enter mid-conflict ----------
await page.fill('.scm__message', 'try to commit mid-conflict')
await page.locator('.scm__message').press('Control+Enter')
await sleep(2500)
await snap('after Ctrl+Enter mid-conflict')
let head = ''
try { head = git('log', '-1', '--pretty=%s') } catch (e) { head = 'ERR' }
console.log('HEAD subject:', head, '| MERGE_HEAD:', fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD')))

// ---------- 5. discard confirmation (DISMISS) ----------
await openScm()
dialogs.length = 0
dialogAction = 'dismiss'
const dRow = page.locator('.scm__row', { hasText: 'todiscard.txt' }).first()
await dRow.hover()
await dRow.locator('[title="Discard changes"]').click()
await sleep(1200)
console.log('\n=== discard dialog(s) ===', JSON.stringify(dialogs))
console.log('todiscard.txt after DISMISS:', JSON.stringify(fs.readFileSync(path.join(repo, 'todiscard.txt'), 'utf8')))

// ---------- 6. open its diff, then discard for real, check the diff pane ----------
await dRow.locator('.scm__file').click()
await sleep(2000)
dialogAction = 'accept'
dialogs.length = 0
await openScm()
const dRow2 = page.locator('.scm__row', { hasText: 'todiscard.txt' }).first()
await dRow2.hover()
await dRow2.locator('[title="Discard changes"]').click()
await sleep(2000)
console.log('todiscard.txt after ACCEPT:', JSON.stringify(fs.readFileSync(path.join(repo, 'todiscard.txt'), 'utf8')))
const staleDiff = await page.evaluate(() => {
  const pane = document.querySelector('.pane.diff')
  if (!pane) return { none: true }
  return {
    path: pane.getAttribute('data-diff-path'),
    label: pane.querySelector('.editor__lang')?.textContent,
    sides: Array.from(pane.querySelectorAll('.monaco-diff-editor .editor')).map((e) =>
      (e.textContent || '').slice(0, 120)
    )
  }
})
console.log('\n=== diff pane AFTER the discard (should no longer claim a change) ===')
console.log(JSON.stringify(staleDiff))

// ---------- 7. discard the untracked file ----------
await openScm()
const uRow = page.locator('.scm__row', { hasText: 'brandnew.txt' }).first()
dialogs.length = 0
dialogAction = 'accept'
await uRow.hover()
await uRow.locator('[title="Discard changes"]').click()
await sleep(1800)
console.log('\n=== untracked discard dialog ===', JSON.stringify(dialogs))
console.log('brandnew.txt still exists:', fs.existsSync(path.join(repo, 'brandnew.txt')))
await snap('after discarding the untracked file')

console.log('\npage errors:', errors.slice(0, 8))
await app.close()
profile.cleanup()
console.log('\nrepo kept at', repo)
