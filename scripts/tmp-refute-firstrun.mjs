// Scratch probe: does launching with no folder argument adopt homeDir as treeRoot?
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const profile = newProfile('refute-firstrun')
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await page.waitForSelector('.app', { timeout: 40_000 })

for (const t of [1500, 3000, 6000]) {
  await sleep(t === 1500 ? 1500 : 2000)
  const snap = await page.evaluate(async () => {
    const settings = await window.ember.getSettings()
    return {
      recentFolders: settings.recentFolders,
      restoreSession: settings.restoreSession
    }
  })
  console.log(`@${t}ms`, JSON.stringify(snap))
}

// Explorer
await page.keyboard.press('Control+B')
await sleep(1200)
const tree = await page.evaluate(() => ({
  rootTitle: document.querySelector('.tree__root')?.getAttribute('title') ?? null,
  rootText: document.querySelector('.tree__root')?.textContent ?? null,
  rows: Array.from(document.querySelectorAll('.tree__label')).map((l) => l.textContent).slice(0, 40),
  count: document.querySelectorAll('.tree__label').length
}))
console.log('TREE', JSON.stringify(tree))

// Search panel empty state?
await page.keyboard.press('Control+Shift+F')
await sleep(1000)
console.log(
  'SEARCH PANEL:',
  await page.evaluate(() => document.querySelector('.find')?.className ?? '(none)'),
  JSON.stringify(await page.evaluate(() => document.querySelector('.find--empty')?.textContent ?? null))
)

// Source control + github empty states
await page.keyboard.press('Control+Shift+G')
await sleep(800)
console.log('SCM:', JSON.stringify(await page.evaluate(() => document.querySelector('.scm')?.textContent?.slice(0, 120) ?? null)))
await page.keyboard.press('Control+Shift+H')
await sleep(800)
console.log('GH:', JSON.stringify(await page.evaluate(() => document.querySelector('.gh')?.textContent?.slice(0, 120) ?? null)))

// Quick open: count entries only, do not print names beyond a few
await page.keyboard.press('Escape')
await page.keyboard.press('Control+P')
await sleep(6000)
const qp = await page.evaluate(() => ({
  count: document.querySelectorAll('.qp__item').length,
  none: document.querySelector('.qp__none')?.textContent ?? null,
  first: Array.from(document.querySelectorAll('.qp__item')).slice(0, 5).map((r) => (r.textContent ?? '').slice(0, 70))
}))
console.log('QUICKOPEN', JSON.stringify(qp))

await app.close()
profile.cleanup()
