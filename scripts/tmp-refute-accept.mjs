// Scratch probe: does accepting a Claude Code diff leave the editor buffer stale,
// and does the next editor save revert the accepted change?
//
// Run: node scripts/tmp-refute-accept.mjs
import { _electron as electron } from 'playwright-core'
import { newProfile } from './profile.mjs'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('refute-accept')
const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-refute-'))
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
  clientInfo: { name: 'refute-accept', version: '0' }
})

const editorState = () =>
  page.evaluate(() => {
    const pane = document.querySelector('.pane.editor:not(.diff)')
    return {
      panes: document.querySelectorAll('.pane.editor:not(.diff)').length,
      path: pane?.getAttribute('data-editor-path') ?? null,
      dirty: pane?.getAttribute('data-dirty') ?? null,
      text: [...(pane?.querySelectorAll('.view-line') ?? [])]
        .map((l) => l.textContent)
        .join(' | ')
    }
  })

console.log('editor before:', JSON.stringify(await editorState()))

// --- accept a proposal, with no user edits in the buffer --------------------
const accepting = client.start('openDiff', {
  old_file_path: target,
  new_file_path: target,
  new_file_contents: PROPOSED,
  tab_name: 'x doc.ts (accept)'
})
await page.waitForSelector('.diff__accept', { timeout: 15_000 })
await sleep(900)
await page.locator('.diff__accept').first().click()
const reply = await accepting
await sleep(1200)

console.log('verdict:', JSON.stringify(reply.result?.content?.[0]?.text))
const diskAfterAccept = fs.readFileSync(target, 'utf8')
console.log('disk after accept has CLAUDE:', diskAfterAccept.includes('// CLAUDE'))
console.log('editor after accept:', JSON.stringify(await editorState()))

// --- the user now saves from the editor pane bar ---------------------------
const saveBtn = page.locator('.pane.editor:not(.diff) .editor__bar button', { hasText: 'save' }).first()
console.log('save button count:', await page.locator('.pane.editor:not(.diff) .editor__bar button').count())
await saveBtn.click()
await sleep(1500)
const diskAfterSave = fs.readFileSync(target, 'utf8')
console.log('disk after user save:', JSON.stringify(diskAfterSave))
console.log('CLAUDE change survived the save:', diskAfterSave.includes('// CLAUDE'))
console.log('editor after save:', JSON.stringify(await editorState()))

// --- second round: does an auto-save fire without any user action? ---------
// autoSaveAfterSeconds defaults to 0 (off), so this only asks whether accepting
// alone schedules anything. Restore the file and accept again, then wait.
fs.writeFileSync(target, ORIGINAL, 'utf8')
const accepting2 = client.start('openDiff', {
  old_file_path: target,
  new_file_path: target,
  new_file_contents: PROPOSED,
  tab_name: 'x doc.ts (accept 2)'
})
await page.waitForSelector('.diff__accept', { timeout: 15_000 })
await sleep(700)
await page.locator('.diff__accept').first().click()
await accepting2
await sleep(4000)
console.log(
  'disk 4s after accept, no user action, still CLAUDE:',
  fs.readFileSync(target, 'utf8').includes('// CLAUDE')
)

client.ws.close()
await app.close()
fs.rmSync(work, { recursive: true, force: true })
profile.cleanup()
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 3))
