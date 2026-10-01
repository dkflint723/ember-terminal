// The Claude panel: threads that stream, stop, remember, propose, and hand the
// API a window it will accept.
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
import { closeApp, watchRunning } from './harness.mjs'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('agent')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// By its long name: a runner's temp folder is spelled short, and a shell reports it long.
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-agent-')))
const env = { ...process.env, EMBER_FAKE_AI: '1', EMBER_FAKE_AI_SLOW: '1' }
delete env.ELECTRON_RUN_AS_NODE

const launch = (folder = []) =>
  electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    // Opened on a project, as it is used: a proposal inside it is an ordinary edit,
    // and one outside it is not (see the scenarios after the first proposal).
    args: [APP_DIR, profile.arg, ...folder],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  })

// The folder on the first launch only: named again on the restart, it would open a
// session of its own rather than bring back the one that held the conversation.
let app = await launch([work])
let page = await app.firstWindow()
await watchRunning(app)
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
// The panel must never buy its width from the columns beside it: a long
// unbreakable output line once let the content track overflow the grid and
// crush the rail and the session list to slivers.
const squeezed = await page.evaluate(() => ({
  rail: Math.round(document.querySelector('.activity')?.getBoundingClientRect().width ?? 0),
  sessions: Math.round(document.querySelector('.sessions')?.getBoundingClientRect().width ?? 0)
}))
check('the rail keeps its ground beside the panel', squeezed.rail >= 40, JSON.stringify(squeezed))
check('and the session list its width', squeezed.sessions >= 200, JSON.stringify(squeezed))
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

/*
 * --- a proposal outside the project: shown in full, and a second click ------------
 *
 * The path is the model's text, and it was joined to the terminal's folder `..` and
 * all, written wherever that led, and shown in the bar by its name alone (audit R27).
 */
const openProposal = async (text) => {
  await ask(`make-file:${text}`)
  await waitAnswered('Done.')
  await page.locator('.agent__card .btn', { hasText: 'Open diff' }).last().click()
  await page.waitForSelector('.diff__accept', { timeout: 10_000 })
  await sleep(600)
}
const where = () => page.evaluate(() => document.querySelector('.diff__where')?.textContent ?? '')
const escaped = path.join(path.dirname(work), `${path.basename(work)}-escaped.ts`)
await openProposal(`..\\${path.basename(work)}-escaped.ts`)
check('a proposal outside the project says so', (await where()).includes('Outside this project'), await where())
check('with the path it would be written to, in full, .. taken out', (await where()).toLowerCase().includes(escaped.toLowerCase()), await where())
await page.locator('.diff__accept').click()
await sleep(1200)
check('the first accept writes nothing', !fs.existsSync(escaped))
check('and asks for a second', (await page.locator('.diff__accept', { hasText: 'accept anyway' }).count()) === 1)
// Still there to press only where the first click asked rather than wrote.
if (await page.locator('.diff__accept').count()) await page.locator('.diff__accept').click()
await sleep(1500)
check('the second writes it', fs.existsSync(escaped))
fs.rmSync(escaped, { force: true })
// Armed and left, then a revised proposal for the same file: it starts unarmed again.
await openProposal(`..\\${path.basename(work)}-escaped.ts`)
await page.locator('.diff__accept').click()
await sleep(600)
await openProposal(`..\\${path.basename(work)}-escaped.ts`)
check('a revised proposal is not accepted by one click on an arming left from before', (await page.locator('.diff__accept', { hasText: 'accept anyway' }).count()) === 0)
while (await page.locator('.diff__reject').count()) {
  await page.locator('.diff__reject').last().click()
  await sleep(500)
}
check('and nothing was written', !fs.existsSync(escaped))

// --- a file Ember cannot read is not written over ----------------------------------
const blob = path.join(work, 'blob.ts')
const blobBytes = Buffer.from([0x00, 0x13, 0x37, 0x00, 0xff, 0xfe, 0x00, 0x00, 0x01, 0x02, 0x03, 0x00])
fs.writeFileSync(blob, blobBytes)
await openProposal(blob)
check('a file that is there but unreadable is not shown as new', (await page.locator('.editor__lang', { hasText: 'Unreadable' }).count()) === 1)
check('and says it will not be overwritten', (await where()).includes('won’t overwrite it'), await where())
await page.locator('.diff__accept').click({ force: true })
await sleep(1200)
check('accept writes nothing over it', Buffer.compare(fs.readFileSync(blob), blobBytes) === 0)
if (await page.locator('.diff__reject').count()) await page.locator('.diff__reject').last().click()
await sleep(500)

// --- and an accepted change can be put back ------------------------------------------
const kept = path.join(work, 'kept.ts')
fs.writeFileSync(kept, 'export const kept = 1\n', 'utf8')
await openProposal(kept)
await page.locator('.diff__accept').click()
await sleep(1500)
check('an accepted change to a file is written', fs.readFileSync(kept, 'utf8').includes('planted = true'))
page.once('dialog', (d) => void d.accept())
await page.click('.composer__input')
await page.keyboard.press('Control+Shift+P')
await page.waitForSelector('.qp__box', { timeout: 10_000 })
await page.locator('.qp__box').fill('Revert last accepted change')
await sleep(400)
await page.locator('.qp__box').press('Enter')
await sleep(2000)
// A palette with no such command stays open, and would stand in front of what follows.
if (await page.locator('.qp__box').count()) await page.keyboard.press('Escape')
check('Revert last accepted change puts it back as it was', fs.readFileSync(kept, 'utf8') === 'export const kept = 1\n', JSON.stringify(fs.readFileSync(kept, 'utf8')))

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

/*
 * --- a command that cannot be undone is labelled, and takes a second press ---------
 *
 * Nothing said which proposals deleted for good, ran code from the internet or asked
 * for administrator rights (audit R29). The first press arms Run; a -WhatIf preview
 * shows what would happen and does nothing; the second press runs it.
 */
const victim = path.join(work, 'victim.txt')
fs.writeFileSync(victim, 'still here\n', 'utf8')
await ask(`run-cmd:Remove-Item '${victim}'`)
await waitAnswered('Run this')
const card = page.locator('.agent__card').last()
const labels = await card.locator('.risk__label').allTextContents()
check('the card says it cannot be undone, and why', labels.some((l) => /cannot be undone/.test(l) && /deletes files/.test(l)), JSON.stringify(labels))
await card.locator('.btn', { hasText: /^Run$/ }).click()
await sleep(2000)
check('the first press runs nothing', fs.existsSync(victim))
check('and arms Run, saying so', (await card.locator('.btn', { hasText: 'Run anyway' }).count()) === 1 && (await card.locator('.risk__armed').count()) === 1)
const previewButton = card.locator('.btn', { hasText: 'Preview with -WhatIf' })
check('a -WhatIf preview is offered', (await previewButton.count()) === 1)
if (await previewButton.count()) {
  await previewButton.click()
  await sleep(3500)
  check('and previewing changes nothing', fs.existsSync(victim) && fs.readFileSync(victim, 'utf8') === 'still here\n')
  const said = await page.evaluate(() => [...document.querySelectorAll('.block__body')].some((b) => /What if/i.test(b.textContent ?? '')))
  check('while saying what it would have done', said)
}
// Only where the first press armed it: a build without labels ran it already.
if (await card.locator('.btn', { hasText: 'Run anyway' }).count()) await card.locator('.btn', { hasText: 'Run anyway' }).click()
await sleep(3000)
check('the second press runs it', !fs.existsSync(victim))

// Run again has no card to label, so it asks — and declining runs nothing.
fs.writeFileSync(victim, 'back again\n', 'utf8')
let asked = ''
page.once('dialog', (d) => {
  asked = d.message()
  void d.dismiss()
})
const removalBlock = page.locator('.block:not(.block--agent)', { hasText: 'Remove-Item' }).last()
// Pressed through its own handler: the button is shown on hover, and the pane here
// sits beside the Claude panel, where a hover does not reliably reach it.
if (await removalBlock.count()) await removalBlock.locator('button[title="Run again"]').dispatchEvent('click')
await sleep(2500)
check('Run again on it asks first, saying what it risks', /cannot be undone/.test(asked) && /deletes files/.test(asked), JSON.stringify(asked.slice(0, 160)))
check('and declining runs nothing', fs.existsSync(victim))

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

// --- the window handed over always starts on a user turn -----------------------
/*
 * Only assistant turns can be dropped before the thread is cut to sixteen, so
 * one drop shifts the window's parity and it can begin on an assistant message —
 * which the Messages API refuses with a 400, losing the whole answer. Fourteen
 * turns stand by this point; the errored turn plus two more asks push the kept
 * list past sixteen, which is the only place the fault can show. The fake
 * reports the role it was handed first because that is what the API validates.
 */
await ask('fail-me please')
await sleep(2500)
check('a failed turn shows its error', (await page.locator('.agent__error').count()) === 1)
await ask('filler that pushes the window along')
await waitAnswered('filler')
await ask('and now the probe')
const probed = await waitAnswered('probe')
check(
  'the history handed over starts on a user turn',
  probed.includes('first=user'),
  probed.slice(0, 160)
)

// --- the conversation survives a restart ---------------------------------------
await sleep(2600)
/*
 * A question asked in a second window is answered in that window.
 *
 * Replies went to the primary window unconditionally, so a panel opened anywhere
 * else streamed forever while its answer was delivered into a panel nobody was
 * looking at — and Stop could not help, because the turn it would have stopped
 * was never the one on screen. Ember has had more than one window for a while:
 * Ctrl+Shift+N opens one, and dragging a tab out makes one.
 */
await page.evaluate(() => window.ember.newWindow())
const otherWindow = await app.waitForEvent('window', { timeout: 30_000 })
await otherWindow.waitForSelector('.pane', { timeout: 40_000 })
await sleep(3000)
await otherWindow.keyboard.press('Control+Shift+B')
await sleep(800)
await otherWindow.locator('.agent__input').click()
await otherWindow.keyboard.type('over here instead', { delay: 3 })
await otherWindow.keyboard.press('Enter')

let overThere = ''
for (let i = 0; i < 70; i += 1) {
  overThere = await otherWindow.evaluate(
    () =>
      [...document.querySelectorAll('.agent__turn--assistant .agent__text')].at(-1)?.textContent ??
      ''
  )
  const streaming = await otherWindow.evaluate(
    () => document.querySelectorAll('.agent__cursor').length > 0
  )
  if (!streaming && overThere.includes('over here instead')) break
  await sleep(300)
}
check(
  'a question asked in a second window is answered in that window',
  overThere.includes('over here instead'),
  JSON.stringify(overThere.slice(0, 140))
)

/*
 * And it goes away again before the restart below.
 *
 * Two windows are two sessions in the session file, and the one that comes back
 * first is not promised to be either of them — so leaving this one open made the
 * conversation check after the restart a coin toss between a thread with three
 * turns in it and a thread with one.
 */
await otherWindow.evaluate(() => window.close())
await sleep(1500)

const firstUnclosed = await closeApp(app)
if (firstUnclosed) failures.push(`before the restart: ${firstUnclosed}`)
await sleep(1000)
app = await launch()
page = await app.firstWindow()
await watchRunning(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 })
await sleep(2000)
check('the panel comes back standing', (await page.locator('.agent').count()) === 1)
const restored = await page.evaluate(() =>
  [...document.querySelectorAll('.agent__turn--assistant .agent__text')].some((t) =>
    t.textContent?.includes('turns=3')
  )
)
check('with the conversation it held', restored)

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
console.log('claude panel:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
