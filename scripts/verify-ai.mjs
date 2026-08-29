// The chat wire, end to end against a stub of the Anthropic API.
//
// The SDK takes its base URL from ANTHROPIC_BASE_URL and the app takes its key
// from ANTHROPIC_API_KEY, so the whole streaming path — the panel, the request
// main builds, the SSE events coming back — runs against localhost with
// nothing changed in the app. What the stub RECEIVES is asserted too: a
// request that reached the API but asked for the wrong thing would otherwise
// look exactly like a working feature.
//
// Run: node scripts/verify-ai.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as http from 'node:http'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('ai')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const received = []
let mode = 'stream' // or 'reject'

/** A minimal but honest Anthropic SSE reply: the event sequence the SDK parses. */
const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => (raw += c))
  req.on('end', () => {
    const body = JSON.parse(raw || '{}')
    received.push(body)

    if (mode === 'reject') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }))
      return
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    send('message_start', {
      type: 'message_start',
      message: {
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 }
      }
    })
    send('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' }
    })
    for (const piece of ['stub says: ', `you sent ${body.messages.length} message(s)`]) {
      send('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: piece }
      })
    }
    send('content_block_stop', { type: 'content_block_stop', index: 0 })
    send('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 }
    })
    send('message_stop', { type: 'message_stop' })
    res.end()
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const env = {
  ...process.env,
  ANTHROPIC_API_KEY: 'sk-ember-verify',
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`
}
delete env.ELECTRON_RUN_AS_NODE
delete env.EMBER_FAKE_AI

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
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const ask = async (text) => {
  await page.locator('.agent__input').click()
  await page.keyboard.type(text, { delay: 3 })
  await page.keyboard.press('Enter')
  await sleep(2500)
}
const lastAnswer = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('.agent__turn--assistant .agent__text')].at(-1)?.textContent ??
      ''
  )

await page.keyboard.press('Control+Shift+B')
await sleep(500)

// --- the request says what it should, and the stream lands --------------------
await ask('first question')
const first = received.at(-1)
check('a request reached the API', received.length >= 1)
check('streaming was asked for', first?.stream === true)
check('with the configured model', typeof first?.model === 'string' && first.model.length > 0, first?.model)
check(
  'the system prompt teaches the proposal fences',
  String(first?.system ?? '').includes('path=<path>') && String(first?.system ?? '').includes('run'),
  String(first?.system ?? '').slice(0, 80)
)
check('the question is the last message', first?.messages?.at(-1)?.content === 'first question')
check('the streamed answer assembled in the panel', (await lastAnswer()).includes('you sent 1 message(s)'), await lastAnswer())

// --- the thread crosses the wire ----------------------------------------------
await ask('second question')
const second = received.at(-1)
check(
  'the follow-up carries the conversation',
  second?.messages?.length === 3,
  `${second?.messages?.length} messages`
)
check('and says so on screen', (await lastAnswer()).includes('you sent 3 message(s)'), await lastAnswer())

// --- a refusal wears words, not a spinner --------------------------------------
mode = 'reject'
await ask('third question')
await sleep(1500)
const errorText = await page.evaluate(
  () => [...document.querySelectorAll('.agent__error')].at(-1)?.textContent ?? ''
)
check('an auth failure says what happened', errorText.includes('API key'), errorText)
check('and nothing keeps streaming', (await page.locator('.agent__cursor').count()) === 0)

await app.close()
server.close()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
console.log('chat wire:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
