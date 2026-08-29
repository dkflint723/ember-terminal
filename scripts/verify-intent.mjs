// What the composer thinks you are typing, and what it carries with it.
//
// One input line now serves two different machines, and the only thing standing
// between "why did that fail?" and PowerShell looking for a program called "why" is
// a guess remade on every keystroke. That guess is worth proving twice over: that it
// is right on the obvious cases, and that Enter honours what the label said. A label
// reading 'agent' while Enter sends to the shell is worse than no label at all,
// because it invites the very mistake it appears to prevent.
//
// The override is checked for the same reason from the other side. Ctrl+K exists for
// the times the guess is wrong, so it has to hold for exactly as long as the buffer
// it was pressed on and not a keystroke longer — an override that outlived the line
// would quietly misroute the next thing typed, and nobody re-reads a label they have
// already agreed with.
//
// Attaching is checked hardest at its least interesting-looking point. Ctrl+Up
// gathers a failed command up to ask about and Esc lets go of it, but Esc in a text
// input means "get rid of that", and the one thing it must not get rid of here is
// the half-written question the attachments were gathered for. A detach that emptied
// the line would still look like the feature working, so the typed text is read back
// afterwards rather than assumed.
//
// The Anthropic API is stubbed on localhost the way verify-ai.mjs does it: what is
// being proven is where a line of typing goes, not what comes back from it.
//
// Run: node scripts/verify-intent.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const SHOT_DIR = process.env.SCREENSHOT_DIR || path.join(APP_DIR, '.shots')
fs.mkdirSync(SHOT_DIR, { recursive: true })
const profile = newProfile('intent')
// An empty directory to stand in, so the commands that have to fail fail because
// the file is missing rather than because of anything in the repository.
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-intent-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/*
 * A stub Anthropic, so asking is as repeatable as running echo.
 *
 * Every question here is asked to find out where it was routed, and a real request
 * would make the block holding it different on every run — and would need a key.
 */
const server = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              command: 'Get-ChildItem',
              note: 'Lists what is here.',
              destructive: false
            })
          }
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 }
      })
    )
  })
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))

const env = {
  EMBER_FAKE_AI: '1',
  ...process.env,
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
  ANTHROPIC_API_KEY: 'sk-ant-stub-key-for-verification'
}
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg, work],
  cwd: APP_DIR,
  env,
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)

const errors = []
page.on('pageerror', (e) => {
  // Reported as it happens as well as in the summary: an error that tears the
  // renderer down makes every later check fail for reasons of its own, and the
  // summary then describes the wreckage rather than the cause.
  console.log('!! page error:', e.message.split('\n')[0])
  errors.push(e.message)
})
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 45_000 })
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

/**
 * Poll until the condition holds or until the clock runs out, and say which it was.
 *
 * Returns rather than throws, and the caller decides whether the timeout was a
 * failure. A wait that can only end one way is not a check: a loop that breaks on
 * success alone spends its entire budget on precisely the absence it was written to
 * catch, and then reports it as the machine being slow.
 */
const until = async (holds, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await holds()) return true
    if (Date.now() >= deadline) return false
    await sleep(150)
  }
}

/**
 * Everything the composer is currently saying about what Enter will do.
 *
 * The 'autodetected' word is specified as sitting beside the intent label without
 * saying which side of the label's own element it lands on, so it is taken out of
 * the label before the label is read — otherwise a word drawn inside the span would
 * make the label read 'shellautodetected' and every comparison below would be about
 * the markup rather than about the classification.
 */
const composer = () =>
  page.evaluate(() => {
    const clean = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const root = document.querySelector('.composer')
    const intent = root?.querySelector('.composer__intent') ?? null
    let label = null
    if (intent) {
      const copy = intent.cloneNode(true)
      copy.querySelectorAll('.composer__auto').forEach((n) => n.remove())
      label = clean(copy)
    }
    return {
      label,
      auto: clean(root?.querySelector('.composer__auto')) || null,
      attach: clean(root?.querySelector('.composer__attach')) || null,
      chips: root?.querySelectorAll('.composer__attach').length ?? 0,
      value: root?.querySelector('.composer__input')?.value ?? null
    }
  })

/**
 * Read the composer back until it says what is expected of it, or until the wait is
 * spent, and hand back what it said either way.
 *
 * Classification is debounced to keystroke idle, so a read taken straight after the
 * last character still answers for the buffer before it. Every caller asserts on the
 * returned text rather than on whether this returned early, which is what keeps the
 * wrong answer visible instead of being reported as a timeout.
 */
const composerUntil = async (holds, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs
  let seen = await composer()
  while (!holds(seen) && Date.now() < deadline) {
    await sleep(120)
    seen = await composer()
  }
  return seen
}

const settle = (want, timeoutMs = 3000) => composerUntil((c) => c.label === want, timeoutMs)

const commandBlocks = () => page.locator('.block:not(.block--agent)')
const userTurns = () => page.locator('.agent__turn--user')

/** Empty the buffer the way a person does, so whatever clearing resets is reset. */
const clearInput = async () => {
  await page.click('.composer__input')
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await sleep(200)
}

/**
 * Type a fresh buffer and wait for the label to catch up with it.
 *
 * The flat wait before the poll is not padding. Polling for the expected reading
 * returns the instant it sees it, and when the previous buffer was read the same way
 * — two commands in a row, say — the very first read is the old answer and matches,
 * so the check would pass without the new line ever having been classified. Idling
 * past any plausible debounce first means whatever is read afterwards is about this
 * buffer, and the poll is then only there to absorb a slow one.
 */
const typed = async (text, want) => {
  await clearInput()
  await page.keyboard.type(text, { delay: 8 })
  await sleep(400)
  return settle(want)
}

/**
 * Run a command and wait for its block to finish.
 *
 * Waited on rather than slept through because a running program swaps the whole
 * composer out for the one that talks to it, and that one has no intent label — a
 * reading taken while a command is still going would be a reading of nothing.
 */
const run = async (command, timeoutMs = 30_000) => {
  const before = await commandBlocks().count()
  await clearInput()
  await page.keyboard.type(command, { delay: 6 })
  await page.keyboard.press('Enter')
  const done = await until(
    async () =>
      (await commandBlocks().count()) > before &&
      (await page.locator('.block--running').count()) === 0,
    timeoutMs
  )
  await sleep(400)
  return done
}

/** The panel's thread: how many turns stand, and what the newest pair holds. */
const thread = () =>
  page.evaluate(() => {
    const clean = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
    const turns = [...document.querySelectorAll('.agent__turn')]
    const users = [...document.querySelectorAll('.agent__turn--user .agent__text')]
    const answers = [...document.querySelectorAll('.agent__turn--assistant .agent__text')]
    return {
      turns: turns.length,
      lastUser: clean(users[users.length - 1]),
      lastAnswer: clean(answers[answers.length - 1]),
      panelOpen: document.querySelectorAll('.agent').length
    }
  })

// --- the reading, on a command and on a question -----------------------------
const empty = await composer()
check('an empty line is pointed at the shell', empty.label === 'shell', JSON.stringify(empty))

const command = await typed('git status', 'shell')
check('a command reads as a command', command.label === 'shell', JSON.stringify(command))
check('and says it worked that out itself', command.auto === 'autodetected', String(command.auto))
await page.screenshot({ path: path.join(SHOT_DIR, '77-intent-shell.png') })

/*
 * The same buffer, changed in place with the caret rather than with a mode key.
 *
 * This is the check for "it keeps up": an interrogative put in front of a command
 * that was reading as a command has to turn it into a question about that command,
 * with nothing pressed to say so.
 */
await page.keyboard.press('Home')
await page.keyboard.type('why does ', { delay: 8 })
const flipped = await settle('agent')
check(
  'a question about that command reads as a question',
  flipped.label === 'agent',
  JSON.stringify(flipped)
)
check('with nothing pressed to make it one', flipped.auto === 'autodetected', String(flipped.auto))

const question = await typed('why did that fail?', 'agent')
check('a plain question reads as one too', question.label === 'agent', JSON.stringify(question))
check('and it is autodetected as well', question.auto === 'autodetected', String(question.auto))
await page.screenshot({ path: path.join(SHOT_DIR, '78-intent-agent.png') })

// --- and the override that overrules it ---------------------------------------
await page.keyboard.press('Control+K')
const overridden = await settle('shell')
check('Ctrl+K overrules the reading', overridden.label === 'shell', JSON.stringify(overridden))
check(
  'and stops claiming the reading is its own',
  overridden.auto === null,
  String(overridden.auto)
)

/*
 * Sticky means sticky. The next keystroke reclassifies the buffer, and the override
 * has to survive that or it is not an override but a pause.
 *
 * The wait is inverted deliberately: it ends the moment the label slips back, so the
 * failure costs a moment and the success costs the whole second and a bit.
 */
await page.keyboard.type(' please', { delay: 8 })
const stuck = await composerUntil((c) => c.label !== 'shell' || c.auto !== null, 1200)
check('the override holds while the line is edited', stuck.label === 'shell', JSON.stringify(stuck))
check('and stays silent about autodetection', stuck.auto === null, String(stuck.auto))

// Clearing is what ends it — the override belongs to the buffer, and there is no
// buffer left. Proved by retyping the question the override was contradicting: if
// it had survived, the label would still read 'shell'.
const reclassified = await typed('why did that fail?', 'agent')
check(
  'clearing the line forgets the override',
  reclassified.label === 'agent',
  JSON.stringify(reclassified)
)
check(
  'and hands the reading back to the classifier',
  reclassified.auto === 'autodetected',
  String(reclassified.auto)
)

// --- Enter does what the label said it would ----------------------------------
const startCommands = await commandBlocks().count()
const startAgents = await userTurns().count()

const toShell = await typed('echo intent-shell-marker', 'shell')
check('the line reads as a command before it is sent', toShell.label === 'shell', JSON.stringify(toShell))
await page.keyboard.press('Enter')
const ran = await until(
  async () =>
    (await commandBlocks().count()) > startCommands &&
    (await page.locator('.block--running').count()) === 0,
  25_000
)
check('Enter on a shell reading runs it', ran)
const shellBlock = await page.evaluate(() => {
  const list = document.querySelectorAll('.block:not(.block--agent)')
  const block = list[list.length - 1]
  if (!block) return null
  return {
    command: (block.querySelector('.block__cmd')?.textContent ?? '').trim(),
    body: (block.querySelector('.block__body')?.textContent ?? '').replace(/\s+/g, ' ').trim()
  }
})
check(
  'as a command block of its own',
  shellBlock?.command === 'echo intent-shell-marker',
  JSON.stringify(shellBlock)
)
check('that really ran', shellBlock?.body.includes('intent-shell-marker') === true, JSON.stringify(shellBlock))
check(
  'and nothing was asked',
  (await userTurns().count()) === startAgents,
  `${await userTurns().count()} turns`
)

const toAgent = await typed('why did that fail?', 'agent')
check('the line reads as a question before it is sent', toAgent.label === 'agent', JSON.stringify(toAgent))
await page.keyboard.press('Enter')
const askedIt = await until(async () => (await userTurns().count()) > startAgents, 20_000)
check('Enter on an agent reading asks into the panel', askedIt)
const asked = await thread()
check('which stands open to answer', asked.panelOpen === 1, JSON.stringify(asked.panelOpen))
check(
  'with the question in the thread',
  asked.lastUser.includes('why did that fail?'),
  JSON.stringify(asked.lastUser)
)
check(
  'and the shell never saw it',
  (await commandBlocks().count()) === startCommands + 1,
  `${await commandBlocks().count()} command blocks`
)

/*
 * Ctrl+Enter is the way past a reading that is right about the words and wrong about
 * the wish — "echo something" is a command by every rule there is, and asking about
 * it must not require arguing with the label first.
 */
const beforeForced = { commands: await commandBlocks().count(), turns: await userTurns().count() }
const forced = await typed('echo intent-forced-marker', 'shell')
check('the line reads as a command', forced.label === 'shell', JSON.stringify(forced))
await page.keyboard.press('Control+Enter')
const forcedAsked = await until(
  async () => (await userTurns().count()) > beforeForced.turns,
  20_000
)
check('Ctrl+Enter asks anyway', forcedAsked)
check(
  'carrying the line as the question',
  (await thread()).lastUser.includes('intent-forced-marker'),
  JSON.stringify((await thread()).lastUser)
)
check(
  'and the shell still never saw it',
  (await commandBlocks().count()) === beforeForced.commands,
  `${await commandBlocks().count()} command blocks`
)

// --- gathering failures up to ask about ---------------------------------------
check('a command that cannot work lands as a block', await run('Get-Item .\\gone-a.txt'))
check('and a second one after it', await run('Get-Item .\\gone-b.txt'))
check('as does a command that works', await run('echo kept-c'))
const failedSoFar = await page.locator('.block--failed').count()
check('two of the three are failures', failedSoFar === 2, `${failedSoFar} failed`)

const held = await typed('why did these fail?', 'agent')
check('the question is typed first', held.value === 'why did these fail?', JSON.stringify(held.value))
check('with nothing attached to it yet', held.attach === null, String(held.attach))

await page.keyboard.press('Control+ArrowUp')
const one = await composerUntil((c) => c.attach !== null, 4000)
check(
  'Ctrl+Up attaches the last failure',
  /(^|\s)1 block attached\b/.test(one.attach ?? ''),
  JSON.stringify(one.attach)
)

await page.keyboard.press('Control+ArrowUp')
const two = await composerUntil((c) => /2 blocks/.test(c.attach ?? ''), 4000)
check(
  'pressing again walks back to the one before',
  /(^|\s)2 blocks attached\b/.test(two.attach ?? ''),
  JSON.stringify(two.attach)
)
// One chip counting them, not one chip apiece: the composer is a place to type, and
// a row that grows a chip per attachment is a row that moves the input around.
check('counted in a single chip', two.chips === 1, `${two.chips} chips`)
/*
 * Attaching must not touch the buffer either, and this is asserted here rather than
 * left to the Esc check below so the two failures cannot be mistaken for each other.
 *
 * There is a specific way to get this wrong. A bare ArrowUp with the caret at the
 * start recalls history, Chromium's own Ctrl+ArrowUp moves the caret to the start,
 * and the second attach therefore arrives at exactly the position that triggers a
 * recall — so a Ctrl+Up that does not take the key for itself replaces the question
 * with an old command and every check after this one is about the wrong line.
 */
check(
  'and attaching leaves the line alone',
  two.value === 'why did these fail?',
  JSON.stringify(two.value)
)
await page.screenshot({ path: path.join(SHOT_DIR, '79-intent-attached.png') })

/*
 * The half of this most likely to be got wrong.
 *
 * Escape in a text input means "get rid of that", and here it means get rid of the
 * attachments — not the sentence they were gathered for. A detach that also emptied
 * the line would cost someone the question they had half written and would still
 * look exactly like the feature working, so the text is read back rather than
 * assumed.
 */
await page.keyboard.press('Escape')
const detached = await composerUntil((c) => c.attach === null, 3000)
check('Esc lets go of all of them', detached.attach === null, JSON.stringify(detached.attach))
check(
  'and leaves the question that was being written',
  detached.value === 'why did these fail?',
  JSON.stringify(detached.value)
)

// --- and what an attachment does to the block it makes ------------------------
check('one more command that cannot work', await run('Get-Item .\\gone-d.txt'))
check('and one that can, after it', await run('echo kept-e'))
const failedByNow = await page.locator('.block--failed').count()
check('so the newest failure is not the newest block', failedByNow === 3, `${failedByNow} failed`)

const beforeAsk = await userTurns().count()
const ready = await typed('why did that just fail?', 'agent')
check('the question reads as a question', ready.label === 'agent', JSON.stringify(ready))
await page.keyboard.press('Control+ArrowUp')
const attached = await composerUntil((c) => c.attach !== null, 4000)
check(
  'one press attaches one block',
  /(^|\s)1 block attached\b/.test(attached.attach ?? ''),
  JSON.stringify(attached.attach)
)

await page.keyboard.press('Enter')
const landed = await until(async () => (await userTurns().count()) > beforeAsk, 20_000)
check('sending it lands in the thread', landed)
/*
 * The chips moved off the screen and onto the wire: the panel's turns carry no
 * attachment badges, so what was attached is proven by what the model was
 * GIVEN. The fake backend echoes the count and the first line of the first
 * attachment, which is where the block's command and its elision marker live.
 */
// Wait for the stream to FINISH, not merely begin: the head fingerprint sits
// at the end of the reply, and reading it mid-stream races the fake's pacing.
const answered = await until(async () => {
  const t = await thread()
  const still = await page.evaluate(() => document.querySelectorAll('.agent__cursor').length > 0)
  return !still && t.lastAnswer.includes('attached=')
}, 20_000)
check('and the request carried the attachments', answered)
const conversation = await thread()
/*
 * Not exactly one: the wire carries the chip AND the session's recent tail,
 * the way the ask flow always fed the model — the chip's promise is not "only
 * this" but "this first". The head assertion below is that promise.
 */
check(
  'chips and tail together',
  /attached=[1-9]/.test(conversation.lastAnswer),
  JSON.stringify(conversation.lastAnswer)
)
const head = conversation.lastAnswer.match(/head="([^"]*)"/)?.[1] ?? ''
// The discriminating half: Ctrl+Up reaches past the command that worked to the
// one that did not, so a head naming kept-e would mean it took the last block.
check(
  'naming the failure rather than the command after it',
  head.includes('gone-d') && !head.includes('kept-e'),
  JSON.stringify(head)
)

/*
 * '(elided)' has to mean something rather than always or never be there.
 *
 * Read against the block the attachment came from, not against a length: the output
 * is cut the way the block's own body is cut, so the two have to agree. Comparing
 * them catches both directions — a chip claiming an elision for output that was kept
 * whole, and a chip staying quiet about one that was not.
 */
const elisions = await page.evaluate(
  () =>
    Array.from(document.querySelectorAll('.block:not(.block--agent)'))
      .reverse()
      .find((b) => (b.querySelector('.block__cmd')?.textContent ?? '').includes('gone-d'))
      ?.querySelectorAll('.block__elided').length ?? null
)
check(
  'and the elision is claimed only when there was one',
  elisions !== null && head.includes('[output elided]') === elisions > 0,
  `head ${JSON.stringify(head)}, block elisions ${elisions}`
)

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
server.close()
for (const f of failures) console.log(`  - ${f}`)
console.log('intent and attachments:', failures.length === 0 ? 'PASS' : 'FAIL')
console.log('page errors:', errors.length === 0 ? '(none)' : errors.slice(0, 4))
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
