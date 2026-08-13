// Moving the workspace while a language server is running.
//
// A server is started once per language and told its root in the handshake, so
// opening a different folder afterwards used to leave it indexing the previous
// one. Nothing looks broken when that happens — the answers are just about the
// wrong code — so this checks the traffic rather than the appearance.
//
// Run: node scripts/verify-lsp-root.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('lsp-root')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-lsproot-'))
const first = path.join(work, 'first')
const second = path.join(work, 'second')
fs.mkdirSync(first, { recursive: true })
fs.mkdirSync(second, { recursive: true })
fs.writeFileSync(path.join(first, 'sample.ts'), 'export const one = 1\n', 'utf8')
fs.writeFileSync(path.join(second, 'other.ts'), 'export const two = 2\n', 'utf8')
const logPath = path.join(work, 'lsp.log')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env, EMBER_LSP_LOG: logPath }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, first],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
const BENIGN = [/textDocument\/foldingRange failed/]
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const traffic = () =>
  fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean) : []

// Open a TypeScript file so a server starts, rooted at the first folder.
await page.keyboard.press('Control+p')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('sample')
await sleep(900)
await page.keyboard.press('Enter')
await page.waitForSelector('.pane.editor', { timeout: 25_000 })
await sleep(6000)

const handshake = traffic().find((l) => l.includes('"method":"initialize"'))
check('the server was told the first folder', handshake?.includes('first') === true, String(handshake).slice(0, 120))

// Move the terminal to the other folder, then re-root the tree onto it. The button
// is used rather than the folder picker because that one is an OS dialog.
// Terminal panes carry no modifier of their own; only editors do.
await page.locator('.pane:not(.editor)').first().click()
await page.click('.composer__input')
await page.keyboard.type(`cd "${second}"`, { delay: 5 })
await page.keyboard.press('Enter')
await sleep(3500)

await page.keyboard.press('Control+b')
await page.waitForSelector('.tree', { timeout: 10_000 })
await sleep(800)
const home = page.locator('.tree__head .icon-btn[title^="Use "]')
check('the tree offers the terminal directory as a root', (await home.count()) === 1)
await home.click()
await sleep(4000)

const moved = traffic().filter((l) => l.includes('didChangeWorkspaceFolders'))
check('the running server is told the workspace moved', moved.length >= 1, `${moved.length} sent`)
if (moved.length > 0) {
  check('the new folder is added', moved[0].includes('second'), moved[0].slice(0, 200))
  check('and the old one removed', moved[0].includes('first'), moved[0].slice(0, 200))
}

// Having moved, the folder left behind should be offered as a way back.
await page.keyboard.press('Control+Shift+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('Open Recent')
await sleep(900)
const recents = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.qp__item')).map((i) => i.textContent ?? '')
)
check(
  'the folder left behind is offered as a recent one',
  recents.some((r) => r.includes('first')),
  JSON.stringify(recents.slice(0, 5))
)
await page.keyboard.press('Escape')
await sleep(400)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('workspace root changes:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
