// Probe: external change to an open file — detection, clobber-on-save, and whether
// any route back to disk content exists (close+reopen, revert).
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('extchange')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ext-'))
const alpha = path.join(work, 'alpha.ts')
const beta = path.join(work, 'beta.ts')
fs.writeFileSync(alpha, 'export const alpha = 1\n', 'utf8')
fs.writeFileSync(beta, 'export const beta = 2\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work, alpha, beta],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
const prompts = []
page.on('dialog', (d) => {
  prompts.push(d.message())
  void d.accept()
})
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(3000)

const state = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane.editor')
    const btn = (word) =>
      Array.from(document.querySelectorAll('.editor__bar .block__action')).find((x) =>
        x.textContent?.trim().includes(word)
      )
    const revert = btn('revert')
    return {
      shownPath: pane?.getAttribute('data-editor-path') ?? null,
      dirtyAttr: pane?.getAttribute('data-dirty') ?? null,
      tabs: Array.from(document.querySelectorAll('.etab')).map(
        (t) =>
          `${t.querySelector('.etab__label')?.textContent}${
            t.classList.contains('etab--dirty') ? '*' : ''
          }`
      ),
      lines: Array.from(document.querySelectorAll('.pane.editor .view-line')).map((l) =>
        (l.textContent ?? '').replace(/ /g, ' ')
      ),
      revertDisabled: revert ? revert.disabled : 'no-revert-button'
    }
  })

const click = (word) =>
  page.evaluate((w) => {
    const b = Array.from(document.querySelectorAll('.editor__bar .block__action')).find((x) =>
      x.textContent?.trim().includes(w)
    )
    if (!b || b.disabled) return `blocked:${!b ? 'missing' : 'disabled'}`
    b.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'clicked'
  }, word)

console.log('=== PHASE 0: beta.ts open and clean ===')
console.log(JSON.stringify(await state(), null, 1))

console.log('\n=== PHASE 1: external writer appends a line ===')
const EXTERNAL = 'export const beta = 2\nexport const EXTERNAL = true\n'
fs.writeFileSync(beta, EXTERNAL, 'utf8')
await sleep(4000)
const afterExternal = await state()
console.log(JSON.stringify(afterExternal, null, 1))
console.log('  detected?', afterExternal.lines.some((l) => l.includes('EXTERNAL')))
console.log('  revert usable while clean?', afterExternal.revertDisabled === false)

console.log('\n=== PHASE 2: close the beta.ts tab, then reopen it from the tree ===')
await page.locator('.etab', { hasText: 'beta.ts' }).locator('.etab__close').click()
await sleep(1200)
console.log('after close:', JSON.stringify((await state()).tabs))
await page.locator('.tree__row', { hasText: 'beta.ts' }).first().click()
await sleep(2500)
const reopened = await state()
console.log(JSON.stringify(reopened, null, 1))
console.log('  reopened content is stale?', !reopened.lines.some((l) => l.includes('EXTERNAL')))
console.log('  marked dirty on reopen?', reopened.dirtyAttr === 'true')
console.log('  revert now enabled?', reopened.revertDisabled === false)

console.log('\n=== PHASE 3: click revert ===')
console.log('  revert click →', await click('revert'))
await sleep(2000)
const reverted = await state()
console.log(JSON.stringify(reverted, null, 1))
console.log('  disk content now shown?', reverted.lines.some((l) => l.includes('EXTERNAL')))
console.log('  prompts so far:', JSON.stringify(prompts))

console.log('\n=== PHASE 4: fresh external change, then type + save (clobber test) ===')
const EXTERNAL2 = 'export const beta = 2\nexport const EXTERNAL = true\nexport const SECOND = 9\n'
fs.writeFileSync(beta, EXTERNAL2, 'utf8')
await sleep(3000)
console.log('  UI saw the second change?', (await state()).lines.some((l) => l.includes('SECOND')))
await page.click('.pane.editor .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst mine = 1\n', { delay: 10 })
await sleep(900)
console.log('  save click →', await click('save'))
await sleep(2500)
const disk = fs.readFileSync(beta, 'utf8')
console.log('  DISK AFTER SAVE:', JSON.stringify(disk))
console.log('  SECOND survived?', disk.includes('SECOND'))
console.log('  EXTERNAL survived?', disk.includes('EXTERNAL'))
console.log('  my edit written?', disk.includes('const mine = 1'))

await app.close()
fs.rmSync(work, { recursive: true, force: true })
profile.cleanup()
