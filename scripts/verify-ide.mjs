// Claude Code IDE integration, exercised the way the CLI exercises it: discover
// the app through its lockfile, connect over the websocket with the token, and
// drive the MCP tools.
//
// The client here is deliberately a real MCP client rather than a call into the
// app's own code. The whole feature is a contract with a program written by someone
// else, and the only useful question is whether that program's moves work.
//
// Run: node scripts/verify-ide.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import WebSocket from 'ws'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const LOCK_DIR = path.join(os.homedir(), '.claude', 'ide')

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ide-'))
const target = path.join(work, 'greet.ts')
const ORIGINAL = 'export function greet(name: string): string {\n  return "hi " + name\n}\n'
fs.writeFileSync(target, ORIGINAL, 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

// Locks that already existed belong to other editors and must not be touched.
const before = new Set(fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, target],
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
await page.waitForSelector('.monaco-editor', { timeout: 30_000 })
await sleep(2500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

// --- discovery -------------------------------------------------------------
const mine = (fs.existsSync(LOCK_DIR) ? fs.readdirSync(LOCK_DIR) : [])
  .filter((f) => f.endsWith('.lock') && !before.has(f))
  .map((f) => ({ file: f, info: JSON.parse(fs.readFileSync(path.join(LOCK_DIR, f), 'utf8')) }))
  .filter((l) => l.info.ideName === 'Ember')

check('published exactly one lockfile', mine.length === 1, `saw ${mine.length}`)
if (mine.length !== 1) {
  await app.close()
  console.log(failures.map((f) => `  - ${f}`).join('\n'))
  console.log('claude code ide: FAIL')
  process.exit(1)
}

const lock = mine[0]
const port = Number(lock.file.replace('.lock', ''))
check('lock names the workspace', lock.info.workspaceFolders?.[0] === work, JSON.stringify(lock.info.workspaceFolders))
check('lock declares ws transport', lock.info.transport === 'ws', lock.info.transport)
check('lock carries a token', typeof lock.info.authToken === 'string' && lock.info.authToken.length > 10)

// --- a minimal MCP client --------------------------------------------------
function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { 'x-claude-code-ide-authorization': token }
  })
  const waiting = new Map()
  const notes = []
  let id = 0
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString())
    if (m.id !== undefined && waiting.has(m.id)) {
      waiting.get(m.id)(m)
      waiting.delete(m.id)
    } else if (m.method) notes.push(m)
  })
  return {
    ws,
    notes,
    open: () => new Promise((res, rej) => (ws.on('open', res), ws.on('error', rej))),
    rpc(method, params) {
      const mine = ++id
      return new Promise((res, rej) => {
        waiting.set(mine, res)
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }))
        setTimeout(() => rej(new Error(`${method} timed out`)), 30_000)
      })
    },
    call: async function (name, args = {}) {
      const m = await this.rpc('tools/call', { name, arguments: args })
      return m.result
    },
    // openDiff does not answer until a person does, so it is started and awaited
    // separately rather than blocking the rest of the script.
    start(name, args = {}) {
      const mine = ++id
      const done = new Promise((res) => waiting.set(mine, res))
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: mine, method: 'tools/call', params: { name, arguments: args } }))
      return done
    }
  }
}

// --- an unauthorised client is refused -------------------------------------
const intruder = connect('not-the-token')
let refused = false
try {
  await intruder.open()
  await intruder.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '0' } })
} catch {
  refused = true
}
if (!refused) {
  // The socket may open before the close frame lands; a closed socket is the tell.
  await sleep(800)
  refused = intruder.ws.readyState !== WebSocket.OPEN
}
check('rejects a bad token', refused)

// --- handshake and tool surface --------------------------------------------
const client = connect(lock.info.authToken)
await client.open()
const init = await client.rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'verify-ide', version: '0' }
})
check('initialize answers', !!init.result?.serverInfo, JSON.stringify(init.result).slice(0, 90))

const listed = await client.rpc('tools/list', {})
const names = (listed.result?.tools ?? []).map((t) => t.name).sort()
const REQUIRED = [
  'close_tab', 'closeAllDiffTabs', 'getCurrentSelection', 'getDiagnostics',
  'getLatestSelection', 'getOpenEditors', 'getWorkspaceFolders', 'openDiff', 'openFile'
]
const missing = REQUIRED.filter((n) => !names.includes(n))
check('exposes the tools the CLI expects', missing.length === 0, `missing ${missing.join(', ')}`)

// --- reads ------------------------------------------------------------------
const parse = (result) => JSON.parse(result.content[0].text)

const folders = parse(await client.call('getWorkspaceFolders'))
check('reports the workspace', folders.rootPath === work, folders.rootPath)

const open = parse(await client.call('getOpenEditors'))
check('lists the open editor', open.tabs?.some((t) => t.path === target), JSON.stringify(open.tabs))

// Selection is pushed as it changes, so it needs a real one to have happened.
await page.click('.view-lines')
await page.keyboard.press('Control+A')
await sleep(600)
const selection = parse(await client.call('getCurrentSelection'))
check('reports the selection', selection.success === true && selection.text.includes('greet'), JSON.stringify(selection).slice(0, 100))
check('selection was pushed as a notification', client.notes.some((n) => n.method === 'selection_changed'), client.notes.map((n) => n.method).join(','))

// --- openDiff, rejected -----------------------------------------------------
const REJECTED = 'export function greet(): void {}\n'
const rejecting = client.start('openDiff', {
  old_file_path: target,
  new_file_path: target,
  new_file_contents: REJECTED,
  tab_name: '✻ greet.ts (reject)'
})
await page.waitForSelector('.pane.diff', { timeout: 15_000 })
await sleep(900)
check('proposal pane says it is waiting', await page.locator('.diff__waiting').count() > 0)
await page.screenshot({ path: path.join(SHOT_DIR, '30-claude-proposal.png') })

await page.locator('.diff__reject').first().click()
const rejectedReply = await rejecting
check('reject answers DIFF_REJECTED', rejectedReply.result?.content?.[0]?.text === 'DIFF_REJECTED', JSON.stringify(rejectedReply.result).slice(0, 90))
check('reject left the file alone', fs.readFileSync(target, 'utf8') === ORIGINAL)

// --- openDiff, accepted -----------------------------------------------------
const ACCEPTED = 'export function greet(name: string): string {\n  return `hi ${name}`\n}\n'
const accepting = client.start('openDiff', {
  old_file_path: target,
  new_file_path: target,
  new_file_contents: ACCEPTED,
  tab_name: '✻ greet.ts (accept)'
})
await page.waitForSelector('.diff__accept', { timeout: 15_000 })
await sleep(900)
await page.locator('.diff__accept').first().click()
const acceptedReply = await accepting
const blocks = acceptedReply.result?.content ?? []
check('accept answers FILE_SAVED', blocks[0]?.text === 'FILE_SAVED', JSON.stringify(blocks).slice(0, 90))
check('accept returns the saved contents', blocks[1]?.text === ACCEPTED)
check('accept wrote the file', fs.readFileSync(target, 'utf8') === ACCEPTED)

await sleep(800)
check('proposal pane closed after a verdict', (await page.locator('.pane.diff').count()) === 0)

// --- shutdown removes the lockfile -----------------------------------------
client.ws.close()
await app.close()
await sleep(1200)
check('lockfile removed on exit', !fs.existsSync(path.join(LOCK_DIR, lock.file)))

fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('claude code ide:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
