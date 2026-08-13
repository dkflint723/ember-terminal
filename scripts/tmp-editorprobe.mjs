// Scratch probe: editor / IDE surfaces. Delete when done.
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('probe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-probe-'))
const F = (n) => path.join(work, n)

// Real source, copied so a failed run cannot touch the repo.
fs.copyFileSync(path.join(APP_DIR, 'src/renderer/src/state/store.ts'), F('store.ts'))
fs.copyFileSync(path.join(APP_DIR, 'src/main/files.ts'), F('files.ts'))

fs.writeFileSync(F('alpha.ts'), 'export const alpha = 1\n', 'utf8')
fs.writeFileSync(F('beta.ts'), 'export const beta = 2\n', 'utf8')
fs.writeFileSync(F('gamma.ts'), 'export const gamma = 3\n', 'utf8')
fs.writeFileSync(F('crlf.txt'), 'one\r\ntwo\r\nthree\r\n', 'utf8')
fs.writeFileSync(F('notrail.txt'), 'no newline at end', 'utf8')
fs.writeFileSync(F('bom.ts'), '﻿export const withBom = 1\n', 'utf8')
fs.writeFileSync(F('bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x41, 0x42]))
fs.writeFileSync(F('huge.txt'), 'x'.repeat(20 * 1024 * 1024), 'utf8')

const log = (...a) => console.log(...a)

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`)
})
await page.waitForSelector('.pane', { timeout: 30_000 })
await sleep(3000)

async function quickOpen(name) {
  await page.keyboard.press('Control+p')
  await sleep(600)
  await page.locator('.qp__box').fill(name)
  await sleep(900)
  const first = await page.locator('.qp__item').first().textContent().catch(() => null)
  await page.keyboard.press('Enter')
  await sleep(1400)
  return first
}

const editorState = () =>
  page.evaluate(() => {
    const eds = Array.from(document.querySelectorAll('.editor'))
    return eds.map((ed) => ({
      path: ed.getAttribute('data-editor-path'),
      dirty: ed.getAttribute('data-dirty'),
      tabs: ed.getAttribute('data-editor-tabs'),
      tabLabels: Array.from(ed.querySelectorAll('.etab__label')).map((s) => s.textContent),
      lang: ed.querySelector('.editor__lang')?.textContent ?? null,
      msg: ed.querySelector('.editor__msg')?.textContent ?? null,
      lines: Array.from(ed.querySelectorAll('.view-line')).map((l) => l.textContent)
    }))
  })

const clickSave = () =>
  page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.editor__bar .block__action')).find((x) =>
      x.textContent?.includes('save')
    )
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

const clickRevert = () =>
  page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.editor__bar .block__action')).find((x) =>
      x.textContent?.includes('revert')
    )
    b?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })

log('=== 1. open several files ===')
for (const n of ['alpha.ts', 'beta.ts', 'gamma.ts', 'store.ts']) {
  const picked = await quickOpen(n)
  log(`  quickOpen ${n} -> first item: ${picked}`)
}
log('  state:', JSON.stringify(await editorState()))

log('=== 2. binary + huge file open attempts ===')
const beforeBin = await editorState()
const binPicked = await quickOpen('bin.dat')
await sleep(800)
const afterBin = await editorState()
log(`  bin.dat first item: ${binPicked}`)
log(`  tabs before=${beforeBin[0]?.tabs} after=${afterBin[0]?.tabs} msg=${afterBin[0]?.msg}`)
log(`  any error surface on page:`,
  await page.evaluate(() => document.body.innerText.toLowerCase().includes('binary')))

const hugePicked = await quickOpen('huge.txt')
await sleep(1500)
const afterHuge = await editorState()
log(`  huge.txt first item: ${hugePicked}`)
log(`  tabs after huge=${afterHuge[0]?.tabs} msg=${afterHuge[0]?.msg}`)
log(`  'too large' anywhere on page:`,
  await page.evaluate(() => document.body.innerText.toLowerCase().includes('too large')))

log('=== 3. close a DIRTY tab, change file on disk, reopen ===')
await quickOpen('alpha.ts')
await sleep(500)
await page.click('.view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst MY_UNSAVED_WORK = true\n', { delay: 6 })
await sleep(900)
log('  after typing:', JSON.stringify((await editorState())[0]?.dirty))

// close alpha.ts tab via its × button
await page.evaluate(() => {
  const tab = Array.from(document.querySelectorAll('.etab')).find(
    (t) => t.querySelector('.etab__label')?.textContent === 'alpha.ts'
  )
  tab?.querySelector('.etab__close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(900)
log('  after closing dirty tab (no prompt?):',
  JSON.stringify({
    tabs: (await editorState())[0]?.tabs,
    labels: (await editorState())[0]?.tabLabels,
    dialogsOnScreen: await page.evaluate(() =>
      document.body.innerText.toLowerCase().includes('unsaved') ||
      document.body.innerText.toLowerCase().includes('discard'))
  }))

// somebody else (Claude Code, git, another editor) rewrites the file
fs.writeFileSync(F('alpha.ts'), 'export const alpha = 999 // WRITTEN BY SOMEONE ELSE\n', 'utf8')
log('  disk now:', JSON.stringify(fs.readFileSync(F('alpha.ts'), 'utf8')))

await quickOpen('alpha.ts')
await sleep(1200)
const reopened = await editorState()
log('  REOPENED editor shows:', JSON.stringify(reopened[0]?.lines))
log('  REOPENED dirty flag:', reopened[0]?.dirty)

// now the user types one character and saves
await page.click('.view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('//z', { delay: 8 })
await sleep(700)
await clickSave()
await sleep(1500)
log('  DISK AFTER SAVE:', JSON.stringify(fs.readFileSync(F('alpha.ts'), 'utf8')))

log('=== 4. file changed on disk while open (never closed) ===')
await quickOpen('beta.ts')
await sleep(700)
fs.writeFileSync(F('beta.ts'), 'export const beta = 2\nexport const EXTERNAL = true\n', 'utf8')
await sleep(2500)
const betaState = await editorState()
log('  editor still shows:', JSON.stringify(betaState[0]?.lines))
log('  dirty flag:', betaState[0]?.dirty)
await page.click('.view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst mine = 1\n', { delay: 8 })
await sleep(700)
await clickSave()
await sleep(1500)
log('  DISK AFTER SAVE:', JSON.stringify(fs.readFileSync(F('beta.ts'), 'utf8')))

log('=== 5. CRLF round trip ===')
await quickOpen('crlf.txt')
await sleep(900)
await page.click('.view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nfour', { delay: 10 })
await sleep(600)
await clickSave()
await sleep(1500)
const crlfBytes = fs.readFileSync(F('crlf.txt'))
log('  bytes:', JSON.stringify(crlfBytes.toString('utf8')))
log('  crlf count:', (crlfBytes.toString('utf8').match(/\r\n/g) || []).length,
  ' lone-lf count:', (crlfBytes.toString('utf8').match(/(?<!\r)\n/g) || []).length)

log('=== 6. no trailing newline ===')
await quickOpen('notrail.txt')
await sleep(900)
await page.click('.view-lines')
await page.keyboard.type('X', { delay: 10 })
await sleep(500)
await clickSave()
await sleep(1400)
log('  disk:', JSON.stringify(fs.readFileSync(F('notrail.txt'), 'utf8')))

log('=== 7. BOM file ===')
await quickOpen('bom.ts')
await sleep(1200)
const bomState = await editorState()
log('  lines:', JSON.stringify(bomState[0]?.lines))
log('  lang:', bomState[0]?.lang)
await clickSave()
await sleep(1400)
const bomBytes = fs.readFileSync(F('bom.ts'))
log('  first bytes on disk:', [...bomBytes.subarray(0, 6)])

log('=== 8. file deleted on disk while open ===')
await quickOpen('gamma.ts')
await sleep(900)
fs.rmSync(F('gamma.ts'))
await sleep(1200)
const delState = await editorState()
log('  editor after delete:', JSON.stringify({ path: delState[0]?.path, dirty: delState[0]?.dirty, tabs: delState[0]?.tabs }))
await clickRevert()
await sleep(1200)
log('  revert msg:', (await editorState())[0]?.msg)
await clickSave()
await sleep(1400)
log('  file recreated by save:', fs.existsSync(F('gamma.ts')))

log('=== 9. dirty doc, then close pane via Ctrl+Shift+W ===')
await quickOpen('store.ts')
await sleep(900)
await page.click('.view-lines')
await page.keyboard.type('// DIRTY', { delay: 8 })
await sleep(800)
log('  before close:', JSON.stringify({ dirty: (await editorState())[0]?.dirty, tabs: (await editorState())[0]?.tabs }))
await page.keyboard.press('Control+Shift+W')
await sleep(1200)
log('  editor panes left:', (await editorState()).length)
log('  prompt shown:', await page.evaluate(() =>
  document.body.innerText.toLowerCase().includes('unsaved') ||
  document.body.innerText.toLowerCase().includes('discard')))
log('  disk unchanged:', !fs.readFileSync(F('store.ts'), 'utf8').includes('// DIRTY'))

await page.screenshot({ path: path.join(APP_DIR, '.shots', 'probe-final.png') })
log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 8))

await app.close()
fs.rmSync(work, { recursive: true, force: true })
profile.cleanup()
