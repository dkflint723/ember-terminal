// Probe: does an unsaved edit in a BACKGROUND editor tab survive two restarts?
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-probe-'))
const userData = path.join(work, 'userData')
const files = ['one.ts', 'two.ts'].map((name, i) => {
  const file = path.join(work, name)
  fs.writeFileSync(file, `export const n${i} = ${i}\n`, 'utf8')
  return file
})
const sessionFile = path.join(userData, 'session.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const launch = (args) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, `--user-data-dir=${userData}`, ...args],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const report = (label, obj) => console.log(`\n### ${label}\n${JSON.stringify(obj, null, 2)}`)

const sessionInfo = () => {
  if (!fs.existsSync(sessionFile)) return { exists: false }
  const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
  const ed = s.panes.find((p) => p.kind === 'editor')
  return {
    exists: true,
    docs: ed
      ? ed.documents.map((d) => ({
          title: d.title,
          hasUnsaved: d.unsaved !== undefined,
          unsavedHasEdit: d.unsaved !== undefined ? /EDIT_(ONE|TWO)/.test(d.unsaved) : null,
          unsavedTail: d.unsaved !== undefined ? d.unsaved.trim().split('\n').pop() : null
        }))
      : null,
    activeIndex: ed?.activeIndex
  }
}

// ---- run 1: make BOTH files dirty, leave two.ts in the background -----------
{
  const app = await launch(files)
  const page = await app.firstWindow()
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
  await sleep(2500)

  // two.ts is the active editor tab (opened last). Edit it.
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nconst EDIT_TWO = 2\n', { delay: 8 })
  await sleep(600)

  // Switch to one.ts and edit it. two.ts is now a dirty BACKGROUND tab.
  await page.locator('.etab', { hasText: 'one.ts' }).click()
  await sleep(600)
  await page.click('.pane.editor .view-lines')
  await page.keyboard.press('Control+End')
  await page.keyboard.type('\nconst EDIT_ONE = 1\n', { delay: 8 })
  await sleep(2500)

  report('run1 in-app', await page.evaluate(() => ({
    etabs: Array.from(document.querySelectorAll('.etab')).map((e) => ({
      label: e.querySelector('.etab__label')?.textContent,
      dirty: e.className.includes('etab--dirty'),
      active: e.className.includes('etab--active')
    }))
  })))
  await app.close()
  await sleep(1500)
}
report('session.json after run 1 (both edits should be present)', sessionInfo())

// ---- run 2: relaunch, DO NOT touch the background tab, quit ----------------
{
  const app = await launch([])
  const page = await app.firstWindow()
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(5000)

  report('run2 in-app', await page.evaluate(() => ({
    etabs: Array.from(document.querySelectorAll('.etab')).map((e) => ({
      label: e.querySelector('.etab__label')?.textContent,
      dirty: e.className.includes('etab--dirty'),
      active: e.className.includes('etab--active')
    })),
    shownText: Array.from(document.querySelectorAll('.pane.editor .view-line'))
      .map((l) => l.textContent ?? '')
      .join('\n')
  })))
  report('session.json 5s into run 2 (autosave already rewrote it)', sessionInfo())

  await app.close()
  await sleep(1500)
}
report('session.json after run 2', sessionInfo())

// ---- run 3: relaunch and look for the background tab's edit ----------------
{
  const app = await launch([])
  const page = await app.firstWindow()
  await page.waitForSelector('.pane', { timeout: 30_000 })
  await sleep(4000)
  await page.locator('.etab', { hasText: 'two.ts' }).click()
  await sleep(1200)

  report('run3 two.ts buffer', await page.evaluate(() => ({
    etabs: Array.from(document.querySelectorAll('.etab')).map((e) => ({
      label: e.querySelector('.etab__label')?.textContent,
      dirty: e.className.includes('etab--dirty')
    })),
    shownText: Array.from(document.querySelectorAll('.pane.editor .view-line'))
      .map((l) => l.textContent ?? '')
      .join('\n')
  })))
  await app.close()
  await sleep(1000)
}

console.log('\nDISK one.ts:', JSON.stringify(fs.readFileSync(files[0], 'utf8')))
console.log('DISK two.ts:', JSON.stringify(fs.readFileSync(files[1], 'utf8')))
console.log('\nworkdir:', work)
