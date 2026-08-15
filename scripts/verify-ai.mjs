// Ask Claude, end to end.
//
// The Anthropic SDK takes its base URL from ANTHROPIC_BASE_URL and the app takes
// its key from ANTHROPIC_API_KEY, so the whole path — Ctrl+K, the request main
// builds, the proposal the composer renders — runs against a stub on localhost
// with nothing in the app changed for testing and no real key or network needed.
//
// What the stub receives is asserted too. A request that reached the API but asked
// for the wrong thing would otherwise look exactly like a working feature.
//
// Run: node scripts/verify-ai.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const profile = newProfile('ai')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** What the next request should get back, set by each case before it runs. */
let reply = { status: 200, body: {} }
const received = []

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => {
    raw += chunk
  })
  req.on('end', () => {
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      // Recorded as unparseable rather than dropped, so a malformed body shows up
      // as a failure instead of an empty list.
    }
    received.push({ url: req.url, headers: req.headers, body: parsed })
    // A case can refuse a particular request rather than every one of them, which
    // is how the zero-token probe's fallback is exercised.
    const refusal = reply.reject?.(parsed) ?? null
    // The rate-limit headers ride along with every answer, which is the only place
    // the API says what is left — so the stub sends them like the real one does.
    res.writeHead(refusal?.status ?? reply.status, {
      'content-type': 'application/json',
      ...(refusal ? {} : (reply.headers ?? {}))
    })
    res.end(JSON.stringify(refusal?.body ?? reply.body))
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const message = (text, extra = {}) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
  ...extra
})

const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
  ANTHROPIC_API_KEY: 'sk-ant-stub-key-for-verification'
}
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
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/**
 * Type the request and send it, switching to asking first only if the composer is
 * not already there. Ctrl+K toggles, so pressing it unconditionally would drop back
 * to the shell and send the intent to PowerShell as a command.
 */
const ask = async (intent) => {
  await page.click('.composer__input')
  if ((await page.locator('.composer__row--ai').count()) === 0) {
    await page.keyboard.press('Control+K')
    await sleep(600)
  }
  await page.keyboard.type(intent, { delay: 5 })
  await page.keyboard.press('Enter')
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    if ((await page.locator('.composer__proposal').count()) > 0) return
  }
}

/** Clear a proposal if it has actions; an error one has none to clear. */
const dismiss = async () => {
  const button = page.locator('.composer__proposal-actions .btn', { hasText: 'Dismiss' })
  if (await button.count()) await button.click()
  await sleep(500)
}

// --- a command comes back and is offered, not run ----------------------------
reply = {
  status: 200,
  body: message(
    JSON.stringify({
      command: 'Get-ChildItem -Recurse -Filter *.log',
      note: 'Lists every log file below here.',
      destructive: false
    })
  )
}
await ask('find all log files')

check('Ctrl+K switches the composer to asking', true)
const proposed = await page.locator('.composer__proposal-cmd').textContent().catch(() => null)
check(
  'the command Claude returned is shown',
  proposed?.includes('Get-ChildItem') === true,
  String(proposed)
)
const note = await page.locator('.composer__proposal-note').textContent().catch(() => null)
check('with its note', note?.includes('log file') === true, String(note))
check(
  'and it is offered rather than run',
  (await page.locator('.composer__proposal-actions .btn').count()) >= 2
)

// --- what actually went to the API -------------------------------------------
const first = received[0]
check('a request reached the API', received.length >= 1, `${received.length} requests`)
if (first) {
  check('it went to the messages endpoint', first.url?.includes('/v1/messages') === true, first.url)
  check('it carried the key', first.headers['x-api-key'] === env.ANTHROPIC_API_KEY)
  check(
    'it asked for a structured command',
    first.body?.output_config?.format?.type === 'json_schema',
    JSON.stringify(first.body?.output_config ?? null)
  )
  check(
    'the system prompt names the shell and directory',
    typeof first.body?.system === 'string' && /working directory/i.test(first.body.system),
    String(first.body?.system).slice(0, 80)
  )
  check(
    'the request carries the intent',
    JSON.stringify(first.body?.messages ?? '').includes('find all log files'),
    JSON.stringify(first.body?.messages ?? null).slice(0, 120)
  )
  check('it names the model in effect', first.body?.model === 'claude-opus-5', String(first.body?.model))
  check(
    'and the effort it was set to',
    first.body?.output_config?.effort === 'low',
    JSON.stringify(first.body?.output_config ?? null)
  )
}

/*
 * --- switching model and effort ----------------------------------------------
 *
 * Both lived where they could not be reached mid-question: the model as a text box
 * in the settings dialog, the effort as a constant in main. Asserted through the
 * stub rather than through the chip's own label, because the only thing that
 * matters is what the next request actually asks for.
 */
await dismiss()
const chip = () =>
  page.evaluate(() => ({
    label: document.querySelector('.chip--claude')?.textContent?.trim() ?? null,
    open: !!document.querySelector('.claude__menu'),
    // Which rows the menu will not let you pick.
    disabledEfforts: Array.from(document.querySelectorAll('.claude__menu .claude__item'))
      .filter((b) => b.disabled)
      .map((b) => b.querySelector('.claude__name')?.textContent ?? '')
  }))

const pick = async (name) => {
  if (!(await chip()).open) {
    await page.click('.chip--claude')
    await sleep(400)
  }
  await page.locator('.claude__item', { hasText: new RegExp(`^${name}`) }).first().click()
  await sleep(700)
}

await page.click('.chip--claude')
await sleep(500)
await page.screenshot({ path: path.join(SHOT_DIR, '75-claude-switcher.png') })

const before = await chip()
check('the switcher says what is in effect', before.label?.includes('Opus 5') === true, before.label)
check('including the effort', before.label?.includes('low') === true, before.label)

await pick('Sonnet 5')
await pick('xhigh')
const after = await chip()
check('picking a model shows it', after.label?.includes('Sonnet 5') === true, after.label)
check('picking an effort shows it', after.label?.includes('xhigh') === true, after.label)
await page.keyboard.press('Escape')
await sleep(300)

reply = {
  status: 200,
  body: message(
    JSON.stringify({ command: 'Get-Date', note: 'Prints the time.', destructive: false })
  )
}
await ask('what time is it')
const switched = received[received.length - 1]
check('the next request uses the model picked', switched?.body?.model === 'claude-sonnet-5', String(switched?.body?.model))
check(
  'and the effort picked',
  switched?.body?.output_config?.effort === 'xhigh',
  JSON.stringify(switched?.body?.output_config ?? null)
)

// A model that takes no effort level must not be sent one — that is a 400, not a
// setting the API ignores.
await dismiss()
await pick('Haiku 4.5')
const haiku = await chip()
check(
  'a model without effort control greys the levels out',
  haiku.disabledEfforts.includes('xhigh'),
  JSON.stringify(haiku.disabledEfforts)
)
check('and stops claiming one', haiku.label?.includes('xhigh') !== true, haiku.label)
await page.keyboard.press('Escape')
await sleep(300)

reply = {
  status: 200,
  body: message(
    JSON.stringify({ command: 'Get-Location', note: 'Prints the directory.', destructive: false })
  )
}
await ask('where am i')
const noEffort = received[received.length - 1]
check('so no effort is sent for it', noEffort?.body?.output_config?.effort === undefined, JSON.stringify(noEffort?.body?.output_config ?? null))
check('though the model still is', noEffort?.body?.model === 'claude-haiku-4-5', String(noEffort?.body?.model))

/*
 * --- what is left ------------------------------------------------------------
 *
 * There is no endpoint that reports rate limits; they arrive in the headers of
 * ordinary answers. So the check is that a request's headers are kept and shown,
 * that "check now" goes and gets a fresh set, and that a 429 is reported as the
 * thing someone is looking for rather than swallowed.
 */
await dismiss()
const usage = () =>
  page.evaluate(() => ({
    rows: Array.from(document.querySelectorAll('.usage__row')).map((r) =>
      (r.textContent ?? '').replace(/\s+/g, ' ').trim()
    ),
    notes: Array.from(document.querySelectorAll('.usage__note')).map((n) =>
      (n.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
  }))

const openMenu = async () => {
  if ((await page.locator('.claude__menu').count()) === 0) {
    await page.click('.chip--claude')
    await sleep(500)
  }
}

// The requests so far went out without limit headers, so there is nothing to show
// and the menu has to say that rather than draw an empty meter.
await openMenu()
const empty = await usage()
check(
  'with no reading yet, it says so',
  empty.notes.join(' ').includes('Nothing asked yet'),
  JSON.stringify(empty.notes)
)

reply = {
  status: 200,
  headers: {
    'anthropic-ratelimit-requests-limit': '1000',
    'anthropic-ratelimit-requests-remaining': '994',
    'anthropic-ratelimit-requests-reset': new Date(Date.now() + 120_000).toISOString(),
    'anthropic-ratelimit-input-tokens-limit': '80000',
    'anthropic-ratelimit-input-tokens-remaining': '61000',
    'anthropic-ratelimit-input-tokens-reset': new Date(Date.now() + 60_000).toISOString(),
    'anthropic-ratelimit-output-tokens-limit': '16000',
    'anthropic-ratelimit-output-tokens-remaining': '15200',
    'anthropic-ratelimit-output-tokens-reset': new Date(Date.now() + 60_000).toISOString()
  },
  body: message(JSON.stringify({ command: 'Get-Date', note: 'The time.', destructive: false }))
}
await page.keyboard.press('Escape')
await sleep(300)
await ask('what is the time')
await dismiss()

await openMenu()
const shown = await usage()
check('a request with limit headers fills it in', shown.rows.length === 3, JSON.stringify(shown.rows))
check(
  'requests remaining are shown against the limit',
  shown.rows.some((r) => r.includes('requests') && r.includes('994') && r.includes('1000')),
  JSON.stringify(shown.rows)
)
check(
  'and tokens in a readable size',
  shown.rows.some((r) => r.includes('input') && r.includes('61k')),
  JSON.stringify(shown.rows)
)
check(
  'with the age of the reading',
  shown.notes.join(' ').includes('As of'),
  JSON.stringify(shown.notes)
)
// Read without scrolling: the meters are the first thing in the menu.
check(
  'and it is what the menu opens on',
  await page.evaluate(() => {
    const menu = document.querySelector('.claude__menu')
    const row = document.querySelector('.usage__row')
    if (!menu || !row) return false
    return row.getBoundingClientRect().bottom <= menu.getBoundingClientRect().bottom
  })
)
await page.screenshot({ path: path.join(SHOT_DIR, '76-claude-usage.png') })

// "Check now" makes the smallest request there is and reads its headers.
const beforeCheck = received.length
reply = {
  status: 200,
  headers: {
    'anthropic-ratelimit-requests-limit': '1000',
    'anthropic-ratelimit-requests-remaining': '42',
    'anthropic-ratelimit-requests-reset': new Date(Date.now() + 300_000).toISOString()
  },
  body: { ...message(''), content: [], stop_reason: 'max_tokens' }
}
await page.locator('.claude__check').click()
await sleep(2500)
const checked = await usage()
check('check now asks the API', received.length > beforeCheck, `${received.length - beforeCheck} requests`)
const probe = received[received.length - 1]
check('with the smallest request it can', probe?.body?.max_tokens === 0, JSON.stringify(probe?.body?.max_tokens))
check(
  'and shows what came back',
  checked.rows.some((r) => r.includes('requests') && r.includes('42')),
  JSON.stringify(checked.rows)
)

/*
 * Not every model and thinking combination accepts a zero-token request, so the
 * probe asks for one token when the smallest one is refused. Checked here because
 * the fallback is the path that runs against a real API often enough to matter,
 * and the stub is the only place it can be made to happen on demand.
 */
const beforeFallback = received.length
let firstProbe = true
reply = {
  status: 200,
  headers: {
    'anthropic-ratelimit-requests-limit': '1000',
    'anthropic-ratelimit-requests-remaining': '777',
    'anthropic-ratelimit-requests-reset': new Date(Date.now() + 60_000).toISOString()
  },
  body: { ...message(''), content: [], stop_reason: 'max_tokens' },
  reject: () => {
    // Refuse the zero-token probe once, the way a model that will not take one does.
    if (!firstProbe) return null
    firstProbe = false
    return {
      status: 400,
      body: { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: 0' } }
    }
  }
}
await page.locator('.claude__check').click()
await sleep(3000)
const fellBack = await usage()
check(
  'a refused zero-token probe falls back to asking for one',
  received.length - beforeFallback === 2,
  `${received.length - beforeFallback} requests`
)
check(
  'and the fallback is what reads the limits',
  fellBack.rows.some((r) => r.includes('requests') && r.includes('777')),
  JSON.stringify(fellBack.rows)
)

// A refusal to serve is the reading people go looking for, so it is kept.
reply = {
  status: 429,
  headers: {
    'retry-after': '37',
    'anthropic-ratelimit-requests-limit': '1000',
    'anthropic-ratelimit-requests-remaining': '0',
    'anthropic-ratelimit-requests-reset': new Date(Date.now() + 37_000).toISOString()
  },
  body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }
}
await page.locator('.claude__check').click()
await sleep(2500)
const limited = await usage()
check(
  'a rate limit is reported rather than swallowed',
  limited.notes.join(' ').includes('37s'),
  JSON.stringify(limited.notes)
)
check(
  'with nothing left against the limit',
  limited.rows.some((r) => r.includes('requests') && r.includes('0 / 1000')),
  JSON.stringify(limited.rows)
)

// Back to the default, and openable from the palette as well as the chip.
await page.keyboard.press('Escape')
await sleep(300)
await pick('Opus 5')
await page.keyboard.press('Escape')
await sleep(300)
await page.keyboard.press('Control+Shift+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('model and effort')
await sleep(400)
await page.keyboard.press('Enter')
await sleep(700)
check('the palette opens the switcher too', (await chip()).open === true)
await page.keyboard.press('Escape')
await sleep(300)

// --- a destructive command is marked ------------------------------------------
await dismiss()
reply = {
  status: 200,
  body: message(
    JSON.stringify({
      command: 'Remove-Item -Recurse -Force .',
      note: 'Deletes everything here.',
      destructive: true
    })
  )
}
await ask('delete everything in this folder')
const warned = await page.locator('.composer__proposal-note').textContent().catch(() => null)
check('a destructive command is flagged', warned?.includes('⚠') === true, String(warned))

// --- a rejected key reads as one ----------------------------------------------
await dismiss()
reply = {
  status: 401,
  body: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }
}
await ask('anything at all')
const authError = await page.locator('.composer__error').textContent().catch(() => null)
check(
  'a rejected key says so plainly',
  authError?.includes('API key was rejected') === true,
  String(authError)
)

// --- a refusal is not an error ------------------------------------------------
reply = {
  status: 200,
  body: message('', { stop_reason: 'refusal', stop_details: { category: 'harmful_content' } })
}
await ask('something it will decline')
const refusal = await page.locator('.composer__error').textContent().catch(() => null)
check('a refusal is explained as one', refusal?.includes('declined') === true, String(refusal))

await app.close()
profile.cleanup()
server.close()
for (const f of failures) console.log(`  - ${f}`)
console.log('ask claude:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
