// Throwaway UX probe. Delete when done.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('uxprobe')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ux-'))
fs.writeFileSync(path.join(work, 'alpha.ts'), 'export const alpha = 1\n', 'utf8')
fs.writeFileSync(path.join(work, 'beta.ts'), 'export const beta = 2\n', 'utf8')

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
const out = {}
page.on('dialog', async (d) => {
  out.dialogSeen = (out.dialogSeen ?? []).concat(d.message())
  await d.dismiss()
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const rows = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('.qp__item')).map((i) => ({
      label: i.querySelector('.qp__label')?.textContent ?? '',
      hint: i.querySelector('.qp__hint')?.textContent ?? '',
      on: i.classList.contains('qp__item--on')
    }))
  )
const boxState = () =>
  page.evaluate(() => {
    const b = document.querySelector('.qp__box')
    return b ? { placeholder: b.placeholder, value: b.value } : null
  })

// ---- 1. full command list ---------------------------------------------------
await page.keyboard.press('Control+Shift+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(600)
out.commands = (await rows()).map((r) => `${r.label} [${r.hint}]`)

// ---- 2. Ctrl+P inside the command palette -----------------------------------
await page.locator('.qp__box').fill('term')
await sleep(400)
out.beforeCtrlP = await boxState()
out.beforeRows = (await rows()).map((r) => r.label)
await page.keyboard.press('Control+P')
await sleep(600)
out.afterCtrlP = await boxState()
out.afterRows = (await rows()).map((r) => r.label)
await page.keyboard.press('Escape')
await sleep(400)

// ---- 3. ">" in quick open ---------------------------------------------------
await page.keyboard.press('Control+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(900)
await page.locator('.qp__box').fill('>')
await sleep(600)
out.angleRows = (await rows()).map((r) => r.label)
out.angleEmpty = await page.evaluate(
  () => document.querySelector('.qp__none')?.textContent ?? null
)
await page.keyboard.press('Escape')
await sleep(400)

// ---- 4. open a file, dirty it, close the tab --------------------------------
await page.keyboard.press('Control+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(1200)
await page.locator('.qp__box').fill('alpha')
await sleep(500)
await page.keyboard.press('Enter')
await page.waitForSelector('.pane.editor', { timeout: 20_000 })
await sleep(2000)

await page.locator('.pane.editor .view-lines').first().click()
await sleep(400)
await page.keyboard.press('End')
await page.keyboard.type('// UNSAVED-EDIT')
await sleep(800)
out.dirtyAfterTyping = await page.evaluate(
  () => document.querySelector('.pane.editor')?.getAttribute('data-dirty') ?? null
)

// Splitting from an editor pane: the palette offers it, does it do anything?
const panesBefore = await page.evaluate(() => document.querySelectorAll('.pane').length)
await page.keyboard.press('Control+Shift+D')
await sleep(800)
out.splitFromEditor = {
  before: panesBefore,
  after: await page.evaluate(() => document.querySelectorAll('.pane').length)
}

// Close the dirty tab. No confirm expected.
out.dialogSeen = out.dialogSeen ?? []
await page.locator('.etab__close').first().click()
await sleep(1200)
out.dialogsAfterClose = [...(out.dialogSeen ?? [])]
out.editorPanesAfterClose = await page.evaluate(
  () => document.querySelectorAll('.pane.editor').length
)

// Reopen the same file and see what the buffer holds vs what dirty says.
await page.keyboard.press('Control+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await sleep(1200)
await page.locator('.qp__box').fill('alpha')
await sleep(500)
await page.keyboard.press('Enter')
await page.waitForSelector('.pane.editor', { timeout: 20_000 })
await sleep(2000)
out.reopened = await page.evaluate(() => {
  const pane = document.querySelector('.pane.editor')
  return {
    dirty: pane?.getAttribute('data-dirty') ?? null,
    text: pane?.querySelector('.view-lines')?.textContent ?? '',
    dot: pane?.querySelector('.editor__dot') ? 'shown' : 'absent'
  }
})
out.diskAfterClose = fs.readFileSync(path.join(work, 'alpha.ts'), 'utf8')

// ---- 5. revert throws away the undo history ---------------------------------
await page.locator('.pane.editor .view-lines').first().click()
await sleep(300)
await page.keyboard.press('End')
await page.keyboard.type('MORE')
await sleep(700)
out.beforeRevert = await page.evaluate(
  () => document.querySelector('.pane.editor .view-lines')?.textContent ?? ''
)
const revertBtn = page.locator('.pane.editor .editor__bar button', { hasText: 'revert' }).first()
await revertBtn.click()
await sleep(1200)
out.revertDialogs = [...(out.dialogSeen ?? [])]
out.afterRevert = await page.evaluate(
  () => document.querySelector('.pane.editor .view-lines')?.textContent ?? ''
)
await page.locator('.pane.editor .view-lines').first().click()
await sleep(300)
await page.keyboard.press('Control+Z')
await sleep(300)
await page.keyboard.press('Control+Z')
await sleep(700)
out.afterUndo = await page.evaluate(
  () => document.querySelector('.pane.editor .view-lines')?.textContent ?? ''
)

// ---- 6. Ctrl+K while a command is running -----------------------------------
await page.locator('.pane:not(.editor) .composer__input').first().click()
await sleep(400)
await page.keyboard.type('Start-Sleep -Seconds 5')
await page.keyboard.press('Enter')
await sleep(1500)
out.running = await page.evaluate(() => ({
  runningBadge: !!document.querySelector('.composer__badge--warn'),
  aiRow: !!document.querySelector('.composer__row--ai')
}))
await page.keyboard.press('Control+K')
await sleep(1200)
out.afterCtrlKWhileRunning = await page.evaluate(() => ({
  aiRow: !!document.querySelector('.composer__row--ai'),
  sigil: document.querySelector('.composer__sigil')?.textContent ?? '',
  hint: document.querySelector('.composer__hint')?.textContent ?? ''
}))
await sleep(7000)
out.afterCommandFinished = await page.evaluate(() => ({
  aiRow: !!document.querySelector('.composer__row--ai'),
  sigil: document.querySelector('.composer__sigil')?.textContent ?? '',
  placeholder: document.querySelector('.composer__input')?.placeholder ?? ''
}))
await page.screenshot({ path: path.join(work, 'ai-mode.png') })

// ---- 7. Escape in the search box --------------------------------------------
await page.keyboard.press('Control+Shift+F')
await page.waitForSelector('.find__box', { timeout: 10_000 })
await sleep(600)
await page.locator('.find__box').first().fill('alpha')
await sleep(900)
await page.locator('.find__box').first().press('Escape')
await sleep(600)
out.searchAfterEscape = await page.evaluate(() => {
  const box = document.querySelector('.find__box')
  return { value: box?.value ?? null, panelStillOpen: !!document.querySelector('.find') }
})

// ---- 8. new-tab menu dismissal ----------------------------------------------
out.profiles = await page.evaluate(() => document.querySelectorAll('.titlebar__new').length)
await page.locator('.titlebar__new').click()
await sleep(600)
out.menuAfterClick = await page.evaluate(
  () => document.querySelectorAll('.titlebar__tabs button').length
)
await page.keyboard.press('Escape')
await sleep(600)
out.menuAfterEscape = await page.evaluate(
  () => document.querySelectorAll('.titlebar__tabs button').length
)
await page.screenshot({ path: path.join(work, 'menu.png') })

// ---- 9. accessible names ----------------------------------------------------
out.namelessButtons = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button'))
    .map((b) => ({
      cls: b.className,
      name: (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()
    }))
    .filter((b) => !/[a-z0-9]/i.test(b.name))
    .map((b) => `${b.cls} => ${JSON.stringify(b.name)}`)
    .filter((v, i, a) => a.indexOf(v) === i)
)

// ---- 10. focus ring on a keyboard-focused tree row ---------------------------
await page.keyboard.press('Control+B')
await sleep(900)
out.treeFocus = await page.evaluate(() => {
  const row = document.querySelector('.tree__row')
  if (!row) return null
  row.focus()
  const cs = getComputedStyle(row)
  return { outline: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor }
})

console.log(JSON.stringify(out, null, 2))
console.log('shots in', work)
await app.close()
profile.cleanup()
