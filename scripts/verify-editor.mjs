// Editor-pane checks. Kept separate from scripts/verify.mjs because it must launch
// the app with a file argument, and because loading Monaco makes it slow.
// Run: node scripts/verify-editor.mjs
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

// A scratch copy, so a failed run cannot leave edits in a tracked file.
const FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-')), 'sample.ts')
const ORIGINAL = `// Sample file for the editor pane test.
interface Point { x: number; y: number }

export function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}
`
fs.writeFileSync(FILE, ORIGINAL, 'utf8')

const log = (...a) => console.log(...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, FILE],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})

const errors = []
const page = await app.firstWindow()
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console] ${m.text()}`)
})

await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 30_000 })
// The pane exists only because the file was passed on the command line.
await page.waitForSelector('.editor', { timeout: 30_000 })
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(2500)

const state = () =>
  page.evaluate(() => {
    const ed = document.querySelector('.editor')
    return {
      panes: document.querySelectorAll('.pane').length,
      terminalStillThere: !!document.querySelector('.composer__input'),
      editorPath: ed?.getAttribute('data-editor-path') ?? null,
      dirty: ed?.getAttribute('data-dirty') ?? null,
      language: ed?.querySelector('.editor__lang')?.textContent ?? null,
      tabLabel: document.querySelector('.tab--active .tab__label')?.textContent ?? null,
      // Distinct colours across tokens is the observable form of highlighting.
      distinctTokenColours: new Set(
        Array.from(document.querySelectorAll('.view-line span[class*="mtk"]')).map(
          (s) => getComputedStyle(s).color
        )
      ).size
    }
  })

const opened = await state()
log('opened →', JSON.stringify(opened))
await page.screenshot({ path: path.join(SHOT_DIR, '14-editor.png') })

await page.click('.view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('\nconst edited = true\n', { delay: 8 })
await sleep(900)
const typed = await state()
log('after typing →', JSON.stringify({ dirty: typed.dirty }))

await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('.editor__bar .block__action')).find((x) =>
    x.textContent?.includes('save')
  )
  b?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})
await sleep(2000)

const onDisk = fs.readFileSync(FILE, 'utf8')
const saved = await state()
log(
  'after save →',
  JSON.stringify({
    dirty: saved.dirty,
    diskChanged: onDisk !== ORIGINAL,
    diskHasEdit: onDisk.includes('const edited = true')
  })
)
await page.screenshot({ path: path.join(SHOT_DIR, '15-editor-saved.png') })

const pass =
  opened.panes === 2 &&
  opened.terminalStillThere &&
  opened.editorPath === FILE &&
  opened.language === 'typescript' &&
  opened.tabLabel === 'sample.ts' &&
  opened.distinctTokenColours >= 4 &&
  opened.dirty === 'false' &&
  typed.dirty === 'true' &&
  saved.dirty === 'false' &&
  onDisk.includes('const edited = true')

log('editor pane:', pass ? 'PASS' : 'FAIL')
log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 5))

await app.close()
fs.rmSync(path.dirname(FILE), { recursive: true, force: true })
process.exit(pass && errors.length === 0 ? 0 : 1)
