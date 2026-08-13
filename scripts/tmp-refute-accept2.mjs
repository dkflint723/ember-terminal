// Scratch probe 2: with auto-save switched on, does a pending auto-save fire after
// an accepted diff and clobber the accepted content with no further user action?
//
// Run: node scripts/tmp-refute-accept2.mjs
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('refute-accept2')
const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide')

// Auto-save on, with a window wide enough to accept a diff inside it.
fs.writeFileSync(
  path.join(profile.dir, 'settings.json'),
  JSON.stringify({ autoSaveAfterSeconds: 6 }, null, 2),
  'utf8'
)

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-refute2-'))
const target = path.join(work, 'doc.ts')
const ORIGINAL = 'export function helper(n: number): number {\n  return n * 2\n}\n'
const PROPOSED = 'export function helper(n: number): number {\n  return n * 3 // CLAUDE\n}\n'
fs.writeFileSync(target, ORIGINAL, 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const before = new Set(fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, target],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(2500)

const mine = (fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])
  .filter((f) => f.endsWith('.lock') && !before.has(f))
  .map((f) => ({ file: f, info: JSON.parse(fs.readFileSync(path.join(LOCK_DIR, f), 'utf8')) }))
  .filter((l) => l.info.ideName === 'Ember')
if (mine.length !== 1) {
  console.log('no lockfile; saw', mine.length)
  await app.close()
  process.exit(1)
}
const lock = mine[0]
const port = Number(lock.file.replace('.lock', ''))

function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { 'x-claude-code-ide-authorization': token }
  })
  const waiting = new Map()
  let id = 0
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m)
      waiting.delete(m.id)
    }
  })
  return {
    ws,
    open: () => new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej))),
    rpc(method, params) {
      const n = ++id
      return new Promise((res, rej) => {
        waiting.set(n, res)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }))
        setTimeout(() => rej(new Error(`${method} timed out`)), 30_000)
      })
    },
    start(name, args = {}) {
      const n = ++id
      const done = new Promise((res) => waiting.set(n, res))
      ws.send(
        JSON.stringify({ jsonrpc: '2.0', id: n, method: 'tools/call', params: { name, arguments: args } })
      )
      return done
    }
  }
}

const client = connect(lock.info.authToken)
await client.open()
await client.rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'refute-accept2', version: '0' }
})

const editorState = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane.editor:not(.diff)')
    return {
      dirty: pane?.getAttribute('data-dirty') ?? null,
      text: [...(pane?.querySelectorAll('.view-line') ?? [])].map((l) => l.textContent).join(' | ')
    }
  })

// The user types in the editor: this starts the auto-save countdown.
await page.click('.pane.editor:not(.diff) .view-lines')
await page.keyboard.press('Control+End')
await page.keyboard.type('// mine', { delay: 10 })
console.log('after typing:', JSON.stringify(await editorState()))

// Claude proposes; the user accepts, well inside the auto-save window.
const accepting = client.start('openDiff', {
  old_file_path: target,
  new_file_path: target,
  new_file_contents: PROPOSED,
  tab_name: 'x doc.ts (accept)'
})
await page.waitForSelector('.diff__accept', { timeout: 15_000 })
await page.locator('.diff__accept').first().click()
const reply = await accepting
console.log('verdict:', JSON.stringify(reply.result?.content?.[0]?.text))
await sleep(500)
console.log('disk right after accept has CLAUDE:', fs.readFileSync(target, 'utf8').includes('// CLAUDE'))
console.log('editor right after accept:', JSON.stringify(await editorState()))

// Nothing more from the user. Wait past the auto-save window.
await sleep(9000)
const after = fs.readFileSync(target, 'utf8')
console.log('disk after the auto-save window:', JSON.stringify(after))
console.log('CLAUDE change survived with no further user action:', after.includes('// CLAUDE'))

client.ws.close()
await app.close()
fs.rmSync(work, { recursive: true, force: true })
profile.cleanup()
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 3))
