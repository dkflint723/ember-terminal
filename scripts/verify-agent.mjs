// The Claude panel: threads that stream, stop, remember, and propose.
//
// Driven against the deterministic fake backend (EMBER_FAKE_AI), which echoes
// the last message back with the turn count — so "follow-ups carry the thread"
// is a number the suite can read — and answers special phrases with a file
// fence or a run fence, so the proposal cards can be pressed all the way
// through the diff flow to a file on disk and a command in the terminal.
//
// Run: node scripts/verify-agent.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('agent')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-agent-'))
const env = { ...process.env, EMBER_FAKE_AI: '1', EMBER_FAKE_AI_SLOW: '1' }
delete env.ELECTRON_RUN_AS_NODE

const launch = () =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

let app = await launch()
let page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(1200)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const lastAssistant = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('.agent__turn--assistant .agent__text')].at(-1)?.textContent ??
      ''
  )
const waitAnswered = async (contains, ms = 20_000) => {
  const start = Date.now()
  for (;;) {
    const text = await lastAssistant()
    const streaming = await page.evaluate(
      () => document.querySelectorAll('.agent__cursor').length > 0
    )
    if (!streaming && text.includes(contains)) return text
    if (Date.now() - start > ms) return text
    await sleep(300)
  }
}
const ask = async (text) => {
  await page.locator('.agent__input').click()
  await page.keyboard.type(text, { delay: 3 })
  await page.keyboard.press('Enter')
}

// --- the panel opens, from the chord and the title bar ------------------------
await page.keyboard.press('Control+Shift+B')
await sleep(500)
check('Ctrl+Shift+B raises the panel', (await page.locator('.agent').count()) === 1)
check(
  'and the title-bar door reports it',
  (await page.locator('.titlebar__agent').getAttribute('aria-pressed')) === 'true'
)

// --- a question streams to an answer ------------------------------------------
await ask('hello there')
const first = await waitAnswered('hello there')
check(
  'the answer streams in and lands',
  first.includes('turns=1') && first.includes('hello there'),
  first
)

// --- a follow-up carries the thread -------------------------------------------
await ask('again')
const second = await waitAnswered('again')
check('the follow-up remembers the conversation', second.includes('turns=3'), second)

// --- stop means stop -----------------------------------------------------------
await ask('cancel-me ' + 'x'.repeat(400))
await sleep(700)
await page.locator('.agent__send', { hasText: 'Stop' }).click()
await sleep(800)
const stopped = await page.evaluate(() =>
  [...document.querySelectorAll('.agent__turn--assistant')].at(-1)?.textContent ?? ''
)
check('stopping mid-stream says stopped', stopped.includes('stopped'), stopped.slice(-80))
check('and no cursor keeps blinking', (await page.locator('.agent__cursor').count()) === 0)

// --- a file proposal goes through the diff to disk ------------------------------
const target = path.join(work, 'planted.ts')
await ask(`make-file:${target}`)
await waitAnswered('Done.')
check('the proposal arrives as a card', (await page.locator('.agent__card-path').count()) >= 1)
await page.locator('.agent__card .btn', { hasText: 'Open diff' }).last().click()
await sleep(1500)
check('the diff opens, waiting on a person', (await page.locator('.diff__accept').count()) === 1)
await page.locator('.diff__accept').click()
await sleep(1500)
check(
  'accepting writes the file',
  fs.existsSync(target) && fs.readFileSync(target, 'utf8').includes('planted = true')
)

// --- a run proposal reaches the terminal ---------------------------------------
await ask('run-echo please')
await waitAnswered('Run this')
await page.locator('.agent__card .btn', { hasText: 'Run' }).last().click()
await sleep(2600)
const ran = await page.evaluate(() =>
  [...document.querySelectorAll('.block__body .row')].some((r) =>
    r.textContent?.includes('panel-ran-this')
  )
)
check('Run puts the command through the session', ran)

// --- prose renders as prose, and links stay in hand ----------------------------
await ask('markdown-me')
await waitAnswered('second item')
const rendered = await page.evaluate(() => ({
  headings: document.querySelectorAll('.agent__heading').length,
  bold: document.querySelectorAll('.agent__text strong').length,
  code: document.querySelectorAll('.agent__text code').length,
  items: document.querySelectorAll('.agent__list li').length,
  link: document.querySelector('.agent__text a')?.getAttribute('data-url') ?? null
}))
check('a heading is a heading', rendered.headings >= 1, JSON.stringify(rendered))
check('bold is bold and code is code', rendered.bold >= 1 && rendered.code >= 1, JSON.stringify(rendered))
check('the list has its items', rendered.items === 2, JSON.stringify(rendered))
check('and the link knows where it points', rendered.link === 'https://example.com/docs', String(rendered.link))

// --- the thread filter sifts ----------------------------------------------------
await page.locator('.agent__filter').fill('markdown-me')
await sleep(400)
const sifted = await page.evaluate(() => ({
  dimmed: document.querySelectorAll('.agent__turn--dimmed').length,
  meta: [...document.querySelectorAll('.agent__meta')].map((m) => m.textContent).join(' ')
}))
check('non-matching turns step back', sifted.dimmed >= 1, JSON.stringify(sifted))
check('and the count says how many match', /\d+ of \d+ turns match/.test(sifted.meta), sifted.meta)
await page.locator('.agent__filter').fill('')
await sleep(300)
check('clearing brings everything back', (await page.locator('.agent__turn--dimmed').count()) === 0)

// --- the composer sends into the same thread -----------------------------------
const turnsBefore = await page.locator('.agent__turn').count()
await page.locator('.composer__input').click()
await page.keyboard.type('why is the sky the way that it is', { delay: 3 })
await sleep(500)
await page.keyboard.press('Enter')
await sleep(1500)
check(
  'an agent-shaped composer send lands in the thread',
  (await page.locator('.agent__turn').count()) === turnsBefore + 2,
  `${await page.locator('.agent__turn').count()} vs ${turnsBefore}`
)
await waitAnswered('sky')

// --- the conversation survives a restart ---------------------------------------
await sleep(2600)
await app.close()
await sleep(1000)
app = await launch()
page = await app.firstWindow()
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2000)
check('the panel comes back standing', (await page.locator('.agent').count()) === 1)
const restored = await page.evaluate(() =>
  [...document.querySelectorAll('.agent__turn--assistant .agent__text')].some((t) =>
    t.textContent?.includes('turns=3')
  )
)
check('with the conversation it held', restored)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('claude panel:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
