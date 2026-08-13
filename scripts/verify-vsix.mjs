// Importing colour themes from a .vsix.
//
// The archive is built from a real installed extension rather than hand-written, so
// the layout, the manifest and the `include` chains are whatever a genuine
// extension actually ships.
//
// Run: node scripts/verify-vsix.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import AdmZip from 'adm-zip'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('vsix')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })

const skip = (why) => {
  console.log(`vsix import: SKIP — ${why}`)
  process.exit(0)
}

/** Any installed extension that contributes themes will do. */
const extensionsDir = path.join(os.homedir(), '.vscode', 'extensions')
let source = null
if (fs.existsSync(extensionsDir)) {
  for (const name of fs.readdirSync(extensionsDir)) {
    const manifest = path.join(extensionsDir, name, 'package.json')
    if (!fs.existsSync(manifest)) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (parsed.contributes?.themes?.length) {
        source = { dir: path.join(extensionsDir, name), themes: parsed.contributes.themes }
        break
      }
    } catch {
      // Unreadable manifest; try the next one.
    }
  }
}
if (!source) skip('no installed extension contributes themes')

// Repackaged into a .vsix, which is a zip with everything under `extension/`.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-vsix-'))
const vsix = path.join(work, 'sample.vsix')
const zip = new AdmZip()
zip.addLocalFolder(source.dir, 'extension')
zip.writeZip(vsix)
console.log(`packed ${path.basename(source.dir)} with ${source.themes.length} theme(s)`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.app', { timeout: 30_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const before = await page.evaluate(() => window.ember.listThemes())

// The file picker cannot be driven from a test, so the import is invoked through
// the path-taking channel the picker itself calls once a file has been chosen.
const installed = await page.evaluate((file) => window.ember.importThemeFrom(file), vsix)
check('the import reports success', installed.ok === true, JSON.stringify(installed))
check('and installed at least one theme', (installed.count ?? 0) >= 1, JSON.stringify(installed))

await sleep(800)
const after = await page.evaluate(() => window.ember.listThemes())
check('the theme list grew', after.length > before.length, `${before.length} → ${after.length}`)

const added = after.filter((t) => !before.some((b) => b.id === t.id))
check('the new themes are user themes', added.every((t) => t.id.startsWith('user:')), JSON.stringify(added.slice(0, 3)))
check('and carry a name and type', added.every((t) => t.name && (t.type === 'dark' || t.type === 'light')), JSON.stringify(added.slice(0, 3)))

// A theme has to resolve, and its content has to have survived the archive.
// Deliberately not asserting a background colour: plenty of contributed themes
// style only tokens and inherit the rest, which is legitimate — the two in the C#
// extension are exactly that.
if (added.length > 0) {
  const applied = await page.evaluate(async (id) => {
    const theme = await window.ember.getTheme(id)
    return theme ? { name: theme.name, type: theme.type } : null
  }, added[0].id)
  check('an imported theme resolves', applied !== null, JSON.stringify(applied))
  check('with a usable type', applied?.type === 'dark' || applied?.type === 'light', JSON.stringify(applied))

  const stored = fs
    .readdirSync(path.join(profile.dir, 'themes'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(profile.dir, 'themes', f), 'utf8')))
  check('the theme files carry real content', stored.some((t) => (t.tokenColors?.length ?? 0) > 0 || Object.keys(t.colors ?? {}).length > 0), `${stored.length} files`)
  // The include chain has to be resolved on the way in, since the file it points
  // at does not travel out of the archive with it.
  check('and no unresolved include remains', stored.every((t) => t.include === undefined), JSON.stringify(stored.map((t) => t.include)))
}

await page.screenshot({ path: path.join(SHOT_DIR, '105-vsix.png') })
await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('vsix import:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
