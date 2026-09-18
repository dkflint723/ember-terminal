// Retake the two screenshots the README shows.
//
// They were composed by hand, and a picture composed by hand goes stale quietly:
// the title bar's pill kept a chord that had already moved when the shot was
// taken, and the Claude chip kept advertising a mode and an effort level that had
// been removed. Nobody notices, because nobody re-reads a screenshot.
//
// So it is a script. It opens a clean profile on this repository, runs the four
// commands the pictures have always shown — a log, a table, a move, and one that
// fails so a failure and an exit code are both visible — and captures the terminal
// and the IDE at the size the README expects.
//
// Run: npm run shots
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const OUT = path.join(APP_DIR, 'docs')
const profile = newProfile('shots')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, APP_DIR],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
page.on('pageerror', (e) => console.log('PAGE ERROR:', e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 60_000 })
await sleep(2000)

/*
 * The size the existing pictures are, in the units a screenshot comes out in.
 *
 * setContentSize takes device-independent pixels and the capture is in real ones,
 * so on a scaled display asking for 1800 gives you 2063. Divided through by the
 * ratio the page reports, the file lands on the size the README already expects.
 */
const dpr = await page.evaluate(() => window.devicePixelRatio)
await app.evaluate(
  ({ BrowserWindow }, size) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    win.setPosition(0, 0)
    win.setContentSize(size.w, size.h)
  },
  { w: Math.round(1800 / dpr), h: Math.round(1125 / dpr) }
)
await sleep(1500)

const run = async (command, settle = 2200) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 6 })
  await page.keyboard.press('Enter')
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline) {
    await sleep(300)
    if ((await page.locator('.block--running').count()) === 0) break
  }
  await sleep(settle)
}

/*
 * Into the repository first, then clear that away.
 *
 * A shell opens in the home directory, where git log has nothing to say and every
 * command in the picture would be an error in red. The move itself is not part of
 * what the picture is showing, so it is hidden afterwards — and the notice that
 * says so is dismissed, since it would be in the shot too.
 */
await run(`Set-Location '${APP_DIR.replace(/'/g, "''")}'`, 800)
await page.keyboard.press('Control+Shift+K')
await sleep(900)
const dismiss = page.locator('.notice__close')
if ((await dismiss.count()) > 0) await dismiss.click()
await sleep(700)

// A log, a table, a move, and one that fails — so a failure and an exit code are
// both visible, which is what the original picture was showing.
/*
 * Trusted, because that is the state these pictures are of.
 *
 * A throwaway profile has never seen this folder, so the status bar carries a
 * Restricted chip — true, and a first-run state rather than the one the README is
 * describing. The originals were taken in a trusted workspace.
 */
await page.keyboard.press('Control+Shift+P')
await sleep(900)
await page.keyboard.type('Trust The Code', { delay: 12 })
await sleep(1200)
await page.keyboard.press('Enter')
await sleep(2000)

await run('git log --oneline -4')
await run('Get-ChildItem src/shared | Select-Object -First 4 Name, Length')
await run('cd src/main')
await run('Get-Item .\\does-not-exist.ts')

await page.evaluate(() => document.activeElement && document.activeElement.blur())
await sleep(1200)
fs.mkdirSync(OUT, { recursive: true })
await page.screenshot({ path: path.join(OUT, 'terminal.png') })
console.log('wrote docs/terminal.png')

// And the IDE half: a real file open, the explorer beside it.
await page.keyboard.press('Control+Shift+I')
await sleep(2500)
await page.keyboard.press('Control+P')
await sleep(900)
await page.keyboard.type('controller.ts', { delay: 12 })
await sleep(1800)
await page.keyboard.press('Enter')
await sleep(4000)
await page.evaluate(() => document.activeElement && document.activeElement.blur())
await sleep(1500)
await page.screenshot({ path: path.join(OUT, 'ide.png') })
console.log('wrote docs/ide.png')

await app.close()
profile.cleanup()
