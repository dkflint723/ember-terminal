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
// Every command is waited for rather than given three seconds. The fixed wait was
// read as "running…" and as a missing exit code on the runner, and neither was
// slowness: the line had never reached bash, because the pty was resized on the
// same Enter (see runCommand). A command that never arrives still never finishes,
// so the wait fails it exactly as before; what it no longer does is fail a command
// that took three seconds and a tenth.
//
// Run: node scripts/verify-bash.mjs
import { _electron as electron } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
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
await watchRunning(app)
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

const blocks = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane__scroll .block')].map((b) => ({
      cmd: (b.querySelector('.block__cmd')?.textContent ?? '').trim(),
      body: (b.querySelector('.block__body')?.textContent ?? '').trim().slice(0, 200),
      running: b.classList.contains('block--running')
    }))
  )

/**
 * Type a command, and wait until its block has finished — or until it plainly is
 * not going to. Twenty seconds is several hundred times what any of these takes; a
 * block still running at the end of it is reported by the checks that follow, in
 * their own words, as it always was.
 */
const run = async (command, limit = 20_000) => {
  const before = (await blocks()).length
  await page.locator('.composer__input').first().focus()
  await page.keyboard.type(command, { delay: 8 })
  await page.keyboard.press('Enter')
  const until = Date.now() + limit
  while (Date.now() < until) {
    const now = await blocks()
    if (now.length > before && !now.at(-1).running) return
    await sleep(100)
  }
}

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
  skipped.push({ shell: 'Git Bash', why: 'not installed' })
} else if (await openSession('Git Bash')) {
  await assertBashPane('Git Bash', { expectWindowsCwd: true })
}

// --- WSL -----------------------------------------------------------------------
//
// The directory is asserted only where it can be true. A distro standing in /mnt
// reports a drive path, which this side can open; standing anywhere else it reports
// a \\wsl.localhost UNC, which is refused on purpose and is a separate question.
//
// wsl.exe being there is not WSL being there. A hosted Windows runner has WSL 2.7
// installed and no distribution in it, so the profile is offered, the pane starts,
// wsl.exe prints "has no installed distributions" and exits -1 — and this suite
// reported that as integration that never arrived, every night. So the distros are
// asked for first, and a machine with none is a machine without this shell: skipped
// with what wsl.exe said, and fatal under EMBER_STRICT like any other missing shell,
// unless EMBER_HOSTED says this is a runner that cannot have one.
const wslDistros = () => {
  const r = spawnSync('wsl.exe', ['--list', '--quiet'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, WSL_UTF8: '1' },
    windowsHide: true
  })
  // Without WSL_UTF8 honoured the listing is UTF-16LE, which reads as NULs between letters.
  const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.replace(/\0/g, '')
  const lines = said.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  // It can also succeed and list nothing, which is the same answer with nothing to quote.
  return r.status === 0 ? { names: lines, said: lines.length ? '' : 'the list was empty' } : { names: [], said: lines[0] ?? String(r.error ?? r.status) }
}
if (!profiles.some((p) => p.id === 'wsl')) {
  skipped.push({ shell: 'WSL', why: 'wsl.exe is not installed' })
} else {
  const distros = wslDistros()
  if (distros.names.length === 0) {
    skipped.push({ shell: 'WSL', why: `no distribution installed (wsl --list: ${distros.said})`, hostedOk: true })
  } else if (await openSession('WSL')) {
    await assertBashPane('WSL', { expectWindowsCwd: false })
  }
}

/*
 * Closed with a bound. A window with a command it believes is running asks before
 * it closes, and nobody here answers: two of five nights this suite sat at that
 * question until the gate killed it at twenty minutes, printing nothing at all —
 * which read as the suite having hung rather than as a command that never ran.
 * The bound this suite kept for itself is the harness's now, which also says which
 * command it was asking about and kills the whole tree rather than Electron alone.
 */
const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
for (const s of skipped) console.log(`not asked: ${s.shell} — ${s.why}`)
const excused = (s) => s.hostedOk && !!process.env.EMBER_HOSTED
const strictSkip = !!process.env.EMBER_STRICT && skipped.some((s) => !excused(s))
const passed = failures.length === 0 && pageErrors.length === 0 && !strictSkip
console.log('bash on both sides:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
