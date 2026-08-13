// Probe: does closing a pane / tab / window actually destroy unsaved editor work?
// Run: node scripts/tmp-refute-close.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-refute-'))
const userData = path.join(work, 'userData')
const file = path.join(work, 'probe.ts')
fs.writeFileSync(file, 'export const original = 1\n', 'utf8')

const launch = (args) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, `--user-data-dir=${userData}`, ...args],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const shape = (page) =>
  page.evaluate(() => ({
    editorPanes: document.querySelectorAll('.pane.editor').length,
    tabs: document.querySelectorAll('.tab').length,
    dirty: document.querySelector('.pane.editor')?.getAttribute('data-dirty') ?? null,
    shownPath: document.querySelector('.pane.editor')?.getAttribute('data-editor-path') ?? null,
    text: Array.from(document.querySelectorAll('.pane.editor .view-line'))
      .map((l) => l.textContent ?? '')
      .join('\n')
  }))

const log = (...a) => console.log(...a)

// ---------------------------------------------------------------- launch one
{
  const app = await launch([file])
  const page = await app.firstWindow()
  await placeTopRight(app)
  const prompts = []
  page.on('dialog', (d) => {
    prompts.push(d.message())
    void d.accept()
  })
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
  await sleep(2500)

  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n// DIRTY-ONE\n', { delay: 10 })
  await sleep(900)

  log('A. before close:', JSON.stringify(await shape(page)))

  // Ctrl+Shift+W == closePane on the active pane. Editor must be the active pane.
  await page.keyboard.press('Control+Shift+W')
  await sleep(1200)
  log('A. after Ctrl+Shift+W:', JSON.stringify(await shape(page)))
  log('A. prompts:', JSON.stringify(prompts))
  log('A. disk:', JSON.stringify(fs.readFileSync(file, 'utf8')))

  // Reopen the same file from the explorer and see what comes back.
  await page.click('.activity__item[data-view="explorer"]')
  await sleep(1200)
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tree__label')).map((l) => l.textContent)
  )
  log('A. tree labels:', JSON.stringify(labels))
  await page.locator('.tree__label', { hasText: 'probe.ts' }).first().click()
  await sleep(2500)
  const back = await shape(page)
  log('A. after reopen:', JSON.stringify(back))
  log('A. text has DIRTY-ONE:', back.text.includes('DIRTY-ONE'))

  // Now close the pane again and quit, to see whether the session keeps it.
  await page.click('.pane.editor .view-lines')
  await sleep(300)
  await page.keyboard.press('Control+Shift+W')
  await sleep(1500)
  log('A. after second close:', JSON.stringify(await shape(page)))
  await sleep(2600) // let the session debounce fire
  await app.close()
  await sleep(1200)
}

const sessionFile = path.join(userData, 'session.json')
const sessionA = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '(none)'
log('A. session mentions DIRTY-ONE after pane close + quit:', sessionA.includes('DIRTY-ONE'))

// -------------------------------------------------------------- launch two
// Reopen the file, dirty it, and close the WINDOW via the titlebar × button.
{
  const app = await launch([file])
  const page = await app.firstWindow()
  await placeTopRight(app)
  const prompts = []
  page.on('dialog', (d) => {
    prompts.push(d.message())
    void d.accept()
  })
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
  await sleep(2500)
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\n// DIRTY-WINDOW\n', { delay: 10 })
  await sleep(600)
  log('B. before window close:', JSON.stringify(await shape(page)))

  // The titlebar close button -> window:action 'close' -> mainWindow.close()
  await page.click('.caption-btn--close')
  await sleep(3000)
  log('B. prompts on window close:', JSON.stringify(prompts))
  try {
    await app.close()
  } catch {
    /* already gone */
  }
  await sleep(1000)
}

const sessionB = fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '(none)'
log('B. session mentions DIRTY-WINDOW:', sessionB.includes('DIRTY-WINDOW'))
log('B. disk still clean:', !fs.readFileSync(file, 'utf8').includes('DIRTY-WINDOW'))

// ------------------------------------------------------------- launch three
{
  const app = await launch([])
  const page = await app.firstWindow()
  await placeTopRight(app)
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4500)
  const after = await shape(page)
  log('C. after restart:', JSON.stringify(after))
  log('C. buffer has DIRTY-WINDOW:', after.text.includes('DIRTY-WINDOW'))
  await app.close()
  await sleep(800)
}

fs.rmSync(work, { recursive: true, force: true })
