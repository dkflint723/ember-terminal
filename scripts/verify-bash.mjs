// bash, on both sides of the machine: Git Bash and a WSL distro.
//
// The roadmap item this belongs to asks for these two to move from experimental to
// supported, and support without a suite is a claim. Neither shell had one: nothing
// in scripts/ had ever launched WSL, and the Git Bash checks that existed sat
// behind an `if` that registered nothing when it was false.
//
// What the suite is really for is that readiness does not mean what it looks like.
// A pane reaches `ready` on a bare OSC 133;A, which any program can print and which
// carries no nonce. WSL reached it that way for its whole existence while every one
// of Ember's own signed markers was being discarded on arrival — the nonce lives in
// the Windows environment, and nothing in the Windows environment crosses into a
// distro unless WSLENV names it. A pane that worked and a pane that did nothing
// looked identical from outside. `data-authenticated` is the difference, and every
// check here that matters reads it rather than `data-integration`.
//
// Run: node scripts/verify-bash.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('bash')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-bash-'))

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration]', { timeout: 40_000 })
await sleep(1500)

const failures = []
const skipped = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const profiles = await page.evaluate(() => window.ember.listProfiles())

/** Open a session on a named profile, through the menu a person would use. */
const openSession = async (name) => {
  await page.locator('.sessions__new').click()
  await sleep(500)
  const entry = page.locator('.sessions__menu .titlebar__menu-item', { hasText: name })
  const offered = (await entry.count()) > 0
  check(`${name} is offered in the new-session menu`, offered)
  if (!offered) {
    await page.keyboard.press('Escape')
    return false
  }
  await entry.first().click()
  await sleep(2500)
  return true
}

/** Wait for the pane to settle, and report both halves of what "settled" means. */
// Long, because a stopped WSL distro has to boot before its shell says anything,
// and the pane now waits for that rather than writing it off.
const settle = async (ms = 60_000) => {
  for (let i = 0; i < ms / 500; i++) {
    const now = await page.evaluate(() => {
      const pane = document.querySelector('.pane[data-integration]')
      return {
        integration: pane?.getAttribute('data-integration') ?? 'none',
        authenticated: pane?.getAttribute('data-authenticated') ?? 'no'
      }
    })
    if (now.integration === 'ready' && now.authenticated === 'yes') return now
    if (now.integration === 'absent') return now
    await sleep(500)
  }
  return page.evaluate(() => {
    const pane = document.querySelector('.pane[data-integration]')
    return {
      integration: pane?.getAttribute('data-integration') ?? 'none',
      authenticated: pane?.getAttribute('data-authenticated') ?? 'no'
    }
  })
}

const run = async (command, wait = 3000) => {
  await page.locator('.composer__input').first().focus()
  await page.keyboard.type(command, { delay: 8 })
  await page.keyboard.press('Enter')
  await sleep(wait)
}

const blocks = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane__scroll .block')].map((b) => ({
      cmd: (b.querySelector('.block__cmd')?.textContent ?? '').trim(),
      body: (b.querySelector('.block__body')?.textContent ?? '').trim().slice(0, 200)
    }))
  )

/**
 * Everything that has to be true of a bash pane, whichever bash it is.
 *
 * Written once because the two shells differ only in how the script reaches them —
 * an rcfile argument for Git Bash, an environment variable and a boot string for
 * WSL — and not at all in what they are then supposed to do.
 */
const assertBashPane = async (label, { expectWindowsCwd }) => {
  const state = await settle()
  check(`${label} reaches integration`, state.integration === 'ready', JSON.stringify(state))
  /*
   * The assertion the whole suite exists for. Unsigned OSC 133 also reaches
   * `ready`, so without this a shell whose markers are every one of them being
   * discarded passes the line above.
   */
  check(
    `${label} markers are signed, not merely present`,
    state.authenticated === 'yes',
    JSON.stringify(state)
  )
  if (state.authenticated !== 'yes') return

  // A prompt with nothing typed at it has produced no commands.
  const atRest = await blocks()
  check(`${label} starts with no blocks it invented`, atRest.length === 0, JSON.stringify(atRest.slice(0, 3)))

  await run('echo ember-bash-marker')
  const after = await blocks()
  const last = after[after.length - 1]
  check(`${label} makes a block for a command`, after.length >= 1, String(after.length))
  /*
   * Named after what was typed. This is what an array-valued PROMPT_COMMAND broke:
   * the hook chained at the front armed the capture before the user's own prompt
   * hooks ran, so the first of those became the command and what the user typed was
   * never seen at all.
   */
  check(
    `${label} names the block after the command that was typed`,
    last?.cmd === 'echo ember-bash-marker',
    JSON.stringify(last?.cmd)
  )
  check(`${label} puts the output in it`, (last?.body ?? '').includes('ember-bash-marker'), JSON.stringify(last?.body))
  check(
    `${label} names no block after something nobody typed`,
    after.every((b) => !b.cmd.includes('PROMPT_COMMAND') && !b.cmd.includes('printf')),
    JSON.stringify(after.map((b) => b.cmd))
  )

  await run('false')
  const exitShown = await page.evaluate(
    () => [...document.querySelectorAll('.pane__scroll .block')].at(-1)?.querySelector('.block__exit')?.textContent ?? ''
  )
  check(`${label} carries a failing exit code back`, exitShown.includes('1'), JSON.stringify(exitShown))

  // The user's own shell is still theirs: the rc file replays the chain rather
  // than replacing it, which is the whole reason it is generated rather than fixed.
  await run('type -t __ember_prompt_command')
  const kind = (await blocks()).at(-1)
  check(`${label} installed its hooks`, (kind?.body ?? '').includes('function'), JSON.stringify(kind?.body))

  if (expectWindowsCwd) {
    await run('pwd')
    const shown = await page.evaluate(
      () => document.querySelector('[data-status="cwd"]')?.textContent?.trim() ?? ''
    )
    check(
      `${label} reports a directory this side of the machine can open`,
      shown.includes('\\'),
      shown
    )
  }
}

// --- Git Bash ------------------------------------------------------------------
if (!profiles.some((p) => p.id === 'git-bash')) {
  skipped.push('Git Bash')
} else if (await openSession('Git Bash')) {
  await assertBashPane('Git Bash', { expectWindowsCwd: true })
}

// --- WSL -----------------------------------------------------------------------
//
// The directory is asserted only where it can be true. A distro standing in /mnt
// reports a drive path, which this side can open; standing anywhere else it reports
// a \\wsl.localhost UNC, which is refused on purpose and is a separate question.
if (!profiles.some((p) => p.id === 'wsl')) {
  skipped.push('WSL')
} else if (await openSession('WSL')) {
  await assertBashPane('WSL', { expectWindowsCwd: false })
}

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
if (skipped.length > 0) console.log(`shells not installed, not asked: ${skipped.join(', ')}`)
const strictSkip = skipped.length > 0 && !!process.env.EMBER_STRICT
const passed = failures.length === 0 && pageErrors.length === 0 && !strictSkip
console.log('bash on both sides:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
