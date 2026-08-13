// The packaged build, checked as a packaged build.
//
// Everything else here runs from source, where `resources/` sits in the repo and
// every path resolves. A packaged app resolves those same files somewhere else
// entirely, and for a while it resolved them somewhere that did not exist: the
// installed app found zero themes and never loaded its shell integration, so it had
// no blocks, no exit codes and no timings — while the dev build was perfect.
//
// Nothing caught it because nothing ran the packaged app. This does.
//
// Run: node scripts/verify-packaged.mjs        (uses release/win-unpacked)
//      EMBER_EXE=<path to Ember.exe> node scripts/verify-packaged.mjs
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const exe = process.env.EMBER_EXE ?? path.join(APP_DIR, 'release/win-unpacked/Ember.exe')

if (!fs.existsSync(exe)) {
  console.log('packaged build: SKIP — no packaged build (run `npm run package` first)')
  process.exit(0)
}

const profile = newProfile('packaged')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-packaged-'))
fs.writeFileSync(path.join(work, 'sample.ts'), 'export const value = 1\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: exe,
  args: [profile.arg, work],
  cwd: path.dirname(exe),
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
const errors = []
const BENIGN = [/textDocument\/foldingRange failed/]
page.on('pageerror', (e) => {
  if (!BENIGN.some((re) => re.test(e.message))) errors.push(e.message)
})

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const where = await app.evaluate(({ app: a }) => ({
  isPackaged: a.isPackaged,
  resourcesPath: process.resourcesPath
}))
check('it really is a packaged build', where.isPackaged === true, JSON.stringify(where))

// --- themes ------------------------------------------------------------------
// Shipped inside the asar rather than beside it, they are invisible to the code
// that looks for them, and every theme silently becomes no theme.
const themes = await page.evaluate(() => window.ember.listThemes())
check('the built-in themes are found', themes.length >= 5, `${themes.length} found`)
check(
  'including the default one the app starts on',
  themes.some((t) => t.id === 'ember-dark'),
  JSON.stringify(themes.map((t) => t.id))
)

// --- shell integration -------------------------------------------------------
// The integration script is read from the same resources tree. Without it there are
// no blocks, no exit codes and no timings, which is most of what this app is.
await page.waitForSelector('.pane', { timeout: 30_000 })
let integration = 'none'
for (let i = 0; i < 40; i++) {
  await sleep(1000)
  const state = await page.evaluate(
    () => document.querySelector('.pane')?.getAttribute('data-integration') ?? null
  )
  integration = state ?? 'none'
  if (integration === 'ready') break
  if (integration === 'absent') break
}
check('shell integration loads', integration === 'ready', integration)

// A theme that lists but is never applied is the same as no theme. Read after the
// pane is up, since the theme is applied as the window settles.
const applied = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement)
  return { bg: cs.getPropertyValue('--bg').trim(), inlineVars: document.documentElement.style.length }
})
check(
  'a theme is actually applied to the document',
  applied.inlineVars > 10 && applied.bg.length > 0,
  JSON.stringify(applied)
)

// --- ripgrep -----------------------------------------------------------------
// The binary is unpacked beside the asar, not inside it. Search, quick open and the
// workspace file list all depend on reaching it.
const listed = await page.evaluate((root) => window.ember.listFiles(root), work)
check('ripgrep runs, so the file list works', Array.isArray(listed) && listed.length > 0, `${Array.isArray(listed) ? listed.length : 'not an array'} files`)

// --- the editor still works out of the asar ----------------------------------
// Monaco and the workspace file list both come out of the asar, so opening a file
// exercises them. Reported as a failure rather than thrown, so the resource checks
// above still get their say.
try {
  await page.keyboard.press('Control+p')
  await page.waitForSelector('.qp__box', { timeout: 15_000 })
  await page.locator('.qp__box').fill('sample')
  await page.waitForSelector('.qp__item', { timeout: 20_000 })
  await sleep(600)
  await page.keyboard.press('Enter')
  await page.waitForSelector('.pane.editor', { timeout: 30_000 })
  await sleep(1200)
  check('a file opens in the editor', (await page.locator('.pane.editor').count()) === 1)
} catch (err) {
  check('a file opens in the editor', false, String(err).split('\n')[0])
}

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('packaged build:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
