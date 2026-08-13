// Probe: corrupt / partial session.json and settings.json on launch.
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-corrupt-'))
const userData = path.join(work, 'userData')
fs.mkdirSync(userData, { recursive: true })
const sessionFile = path.join(userData, 'session.json')
const settingsFile = path.join(userData, 'settings.json')
const file = path.join(work, 'a.ts')
fs.writeFileSync(file, 'export const a = 1\n', 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const launch = (args = []) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, `--user-data-dir=${userData}`, ...args],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

const errors = []
async function look(label, waitMs = 6000) {
  const app = await launch()
  const page = await app.firstWindow()
  page.on('pageerror', (e) => errors.push(`${label}: pageerror ${e.message}`))
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: console ${m.text().slice(0, 200)}`)
  })
  await page.waitForSelector('.app', { timeout: 30_000 })
  await sleep(waitMs)
  const state = await page.evaluate(() => ({
    tabs: document.querySelectorAll('.tab').length,
    panes: document.querySelectorAll('.pane').length,
    empty: !!document.querySelector('.empty'),
    emptyText: document.querySelector('.empty')?.textContent ?? null
  }))
  console.log(`\n### ${label}\n`, JSON.stringify(state))
  await app.close()
  await sleep(1200)
  return state
}

// Build a real session first.
{
  const app = await launch([file])
  const page = await app.firstWindow()
  await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
  await sleep(4000)
  await app.close()
  await sleep(1500)
}
const good = fs.readFileSync(sessionFile, 'utf8')
console.log('baseline session bytes:', good.length)

// --- A: session.json is not valid JSON at all -------------------------------
fs.writeFileSync(sessionFile, good.slice(0, Math.floor(good.length / 2)), 'utf8')
await look('A: session.json truncated (invalid JSON)')

// --- B: valid JSON, version 1, tabs present, panes key missing --------------
{
  const s = JSON.parse(good)
  delete s.panes
  fs.writeFileSync(sessionFile, JSON.stringify(s), 'utf8')
}
await look('B: session.json valid JSON but "panes" key missing')

// --- C: valid JSON, a tab whose root is null --------------------------------
{
  const s = JSON.parse(good)
  s.tabs = s.tabs.map((t) => ({ ...t, root: null }))
  fs.writeFileSync(sessionFile, JSON.stringify(s), 'utf8')
}
await look('C: session.json tab.root = null')

// --- D: valid JSON, an editor pane with documents missing -------------------
{
  const s = JSON.parse(good)
  s.panes = s.panes.map((p) => (p.kind === 'editor' ? { ...p, documents: undefined } : p))
  fs.writeFileSync(sessionFile, JSON.stringify(s), 'utf8')
}
await look('D: session.json editor pane with no "documents"')

console.log('\nerrors seen:', JSON.stringify(errors, null, 2))

// --- E: settings.json ------------------------------------------------------
fs.rmSync(sessionFile, { force: true })
const custom = {
  fontFamily: 'Custom Mono',
  fontSize: 22,
  defaultProfileId: null,
  themeId: 'ember-light',
  anthropicApiKey: 'sk-ant-PLAINTEXT-TEST',
  aiModel: 'claude-opus-5',
  restoreSession: true,
  notifyAfterSeconds: 30,
  autoSaveAfterSeconds: 5,
  recentFolders: ['C:\\somewhere']
}
fs.writeFileSync(settingsFile, JSON.stringify(custom, null, 2), 'utf8')
const half = JSON.stringify(custom, null, 2)
fs.writeFileSync(settingsFile, half.slice(0, Math.floor(half.length * 0.6)), 'utf8')
console.log('\nsettings.json before launch (truncated mid-write simulation):')
console.log(fs.readFileSync(settingsFile, 'utf8'))
await look('E: settings.json truncated', 7000)
console.log('settings.json AFTER launch:')
console.log(fs.readFileSync(settingsFile, 'utf8'))

// --- F: an older settings.json missing keys added later ---------------------
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ fontFamily: 'Old Mono', fontSize: 15, themeId: 'ember-light' }, null, 2),
  'utf8'
)
await look('F: settings.json from an older build (missing keys)', 7000)
console.log('settings.json AFTER launch:')
console.log(fs.readFileSync(settingsFile, 'utf8'))

// --- G: settings.json with a null where an array is expected ----------------
fs.writeFileSync(
  settingsFile,
  JSON.stringify({ fontSize: 15, themeId: 'ember-light', recentFolders: null }, null, 2),
  'utf8'
)
await look('G: settings.json recentFolders = null', 7000)
console.log('settings.json AFTER launch:')
console.log(fs.readFileSync(settingsFile, 'utf8'))
console.log('\nerrors seen (all):', JSON.stringify(errors, null, 2))
console.log('workdir:', work)
