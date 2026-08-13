// Throwaway UX probe #2. Delete when done.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('uxprobe2')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ux2-'))
fs.writeFileSync(path.join(work, 'alpha.ts'), 'export const alpha = 1\n', 'utf8')
fs.writeFileSync(path.join(work, 'beta.ts'), 'export const alpha = 2\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const out = { dialogs: [] }
page.on('dialog', async (d) => {
  out.dialogs.push(d.message())
  await d.dismiss()
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

// ---- A. Settings dialog: focus + Escape while another overlay is on top ------
await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(900)
out.settingsFocus = await page.evaluate(() => {
  const el = document.activeElement
  return {
    tag: el?.tagName ?? null,
    cls: el?.className ?? null,
    insideModal: !!el?.closest?.('.modal')
  }
})
// Tab from the dialog: does focus stay inside it?
await page.keyboard.press('Tab')
await sleep(300)
out.settingsAfterTab = await page.evaluate(() => {
  const el = document.activeElement
  return { cls: el?.className ?? null, insideModal: !!el?.closest?.('.modal') }
})
// Global shortcuts still fire behind the modal.
await page.keyboard.press('Control+Shift+G')
await sleep(800)
out.scmOpenedBehindModal = await page.evaluate(() => ({
  modal: !!document.querySelector('.modal'),
  scm: !!document.querySelector('.scm')
}))
// Quick open on top of the modal, then Escape.
await page.keyboard.press('Control+P')
await sleep(1200)
out.stacked = await page.evaluate(() => ({
  modal: !!document.querySelector('.modal'),
  qp: !!document.querySelector('.qp')
}))
await page.keyboard.press('Escape')
await sleep(800)
out.afterEscapeStacked = await page.evaluate(() => ({
  modal: !!document.querySelector('.modal'),
  qp: !!document.querySelector('.qp')
}))
await page.keyboard.press('Escape')
await sleep(600)
await page.evaluate(() => {
  const m = document.querySelector('.modal-scrim')
  if (m) m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
})
await sleep(600)
out.cleanedUp = await page.evaluate(() => ({
  modal: !!document.querySelector('.modal'),
  qp: !!document.querySelector('.qp')
}))

// ---- B. Replace All: destructive, unconfirmed? -------------------------------
await page.keyboard.press('Control+Shift+F')
await page.waitForSelector('.find__box', { timeout: 10_000 })
await sleep(600)
await page.locator('.find__box').first().fill('alpha')
await sleep(1800)
out.hits = await page.evaluate(
  () => document.querySelector('.find__summary')?.textContent ?? ''
)
await page.locator('input[placeholder="Replace"]').fill('OMEGA')
await sleep(400)
const dialogsBefore = out.dialogs.length
await page.locator('.find__replace', { hasText: 'Replace All' }).first().click()
await sleep(2500)
out.replaceDialogs = out.dialogs.length - dialogsBefore
out.replaceNote = await page.evaluate(
  () => document.querySelector('.find__note')?.textContent ?? ''
)
out.filesAfterReplace = {
  alpha: fs.readFileSync(path.join(work, 'alpha.ts'), 'utf8'),
  beta: fs.readFileSync(path.join(work, 'beta.ts'), 'utf8')
}
// Is there any undo affordance offered anywhere?
out.undoAffordance = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.find button')).map((b) => b.textContent?.trim())
)

// ---- C. Is Ctrl+O reachable by anything other than the key? ------------------
out.uiTextMentionsOpenFile = await page.evaluate(() => {
  const titles = Array.from(document.querySelectorAll('[title]')).map((e) => e.getAttribute('title'))
  return titles.filter((t) => /open file/i.test(t ?? ''))
})

console.log(JSON.stringify(out, null, 2))
await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
