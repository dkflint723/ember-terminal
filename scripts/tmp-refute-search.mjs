// Scratch probe: with treeRoot inherited from the terminal (= home dir), does
// full-text search actually grep the whole user profile? Counts only — no secret
// values are printed.
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const profile = newProfile('refute-search')
const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await page.waitForSelector('.app', { timeout: 40_000 })
await sleep(4000)

await page.keyboard.press('Control+Shift+F')
await sleep(1000)
await page.click('.find__box')
await page.keyboard.type('password', { delay: 15 })
await sleep(25_000)

const out = await page.evaluate(() => {
  const summary = document.querySelector('.find__summary')?.textContent ?? null
  const files = Array.from(document.querySelectorAll('.find__file')).map(
    (f) => f.getAttribute('title') ?? f.textContent ?? ''
  )
  return {
    summary,
    fileCount: files.length,
    // Only the top-level folder under the home directory, never the file name.
    topLevels: [...new Set(files.map((f) => (f.split(/[\\/]/)[3] ?? '(root)')))].slice(0, 20),
    classes: document.querySelector('.find')?.className ?? null,
    hasReplaceAll: !!document.querySelector('.find__replace-all, .find__controls button')
  }
})
console.log(JSON.stringify(out, null, 1))

const html = await page.evaluate(() => document.querySelector('.find__controls')?.outerHTML ?? '')
console.log('CONTROLS:', html.replace(/>\s+</g, '><').slice(0, 1400))

await app.close()
profile.cleanup()
