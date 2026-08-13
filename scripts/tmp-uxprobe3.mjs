// Throwaway UX probe #3. Delete when done.
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('uxprobe3')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ux3-'))

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
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

await page.keyboard.press('Control+Comma')
await page.waitForSelector('.modal', { timeout: 10_000 })
await sleep(1000)
await page.screenshot({ path: path.join(work, 'settings-open.png') })

// Type with the "modal" on screen.
await page.keyboard.type('echo LEAKED-THROUGH-MODAL')
await sleep(800)
out.whileModalOpen = await page.evaluate(() => ({
  modal: !!document.querySelector('.modal'),
  composerValue: document.querySelector('.composer__input')?.value ?? null,
  activeInsideModal: !!document.activeElement?.closest?.('.modal')
}))

// Enter, still with the dialog up.
await page.keyboard.press('Enter')
await sleep(3000)
out.afterEnter = await page.evaluate(() => ({
  modal: !!document.querySelector('.modal'),
  blocks: Array.from(document.querySelectorAll('.block__cmd')).map((b) => b.textContent)
}))
await page.screenshot({ path: path.join(work, 'settings-command-ran.png') })

console.log(JSON.stringify(out, null, 2))
console.log('shots in', work)
await app.close()
profile.cleanup()
