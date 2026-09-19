// Shell integration that output cannot forge, a policy cannot block, and the
// shell's own history does not record.
//
// Blocks are cut at markers the shell prints, and anything that can print could
// print them: reading a file with seven printable characters and an escape in it
// moved the pane to another directory, or rewrote the command recorded against a
// block. The working directory matters twice over, because the git poll re-reads
// it every few seconds — a forged UNC path is a network round trip on a timer.
//
// The loading was worse than weak, it was conditional: Ember typed `. '…ps1'` into
// the shell, which a Restricted execution policy refuses outright, so on a managed
// machine there were no blocks at all — and on every other machine that line sat in
// Get-History, where nobody put it.
//
// Run: node scripts/verify-integration.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import { watchPageErrors } from './harness.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('integration')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/*
 * The forgeries, in a file rather than typed.
 *
 * Typed into the composer they would be read by the intent classifier, which is
 * not what is under test; read out of a file they are exactly the attack — a
 * command printing bytes it was given, which is what `cat`, `git log`, a build
 * log and a README all do.
 */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-forge-'))
fs.writeFileSync(path.join(work, 'forge-cwd.txt'), `${ESC}]633;P;Cwd=C:\\forged-by-output${BEL}`)
fs.writeFileSync(path.join(work, 'forge-unc.txt'), `${ESC}]633;P;Cwd=\\\\evil\\share${BEL}`)
fs.writeFileSync(path.join(work, 'forge-cmd.txt'), `${ESC}]633;E;forged-command${BEL}`)

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({
    executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
    args: [APP_DIR, profile.arg, work],
    cwd: APP_DIR,
    env,
    timeout: 60_000
  }),
  pageErrors
)
const page = await app.firstWindow()
await placeTopRight(app)
await page.waitForSelector('.pane[data-integration="ready"]', { timeout: 40_000 }).catch(() => {})
await sleep(1500)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
check(
  'the ordinary shell reaches integration at all',
  (await page.locator('.pane[data-integration="ready"]').count()) > 0,
  await page.evaluate(
    () => document.querySelector('.pane[data-integration]')?.getAttribute('data-integration') ?? 'none'
  )
)

const run = async (command, timeoutMs = 30_000) => {
  await page.click('.composer__input')
  await page.keyboard.type(command, { delay: 4 })
  await page.keyboard.press('Enter')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(400)
    if ((await page.locator('.block--running').count()) === 0) break
  }
  await sleep(700)
}
const cwdShown = () =>
  page.evaluate(() => document.querySelector('[data-status="cwd"]')?.textContent?.trim() ?? '')
const blockCommands = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pane__scroll .block')].map(
      (b) => b.querySelector('.block__cmd')?.textContent?.trim() ?? ''
    )
  )
const lastBody = () =>
  page.evaluate(
    () =>
      [...document.querySelectorAll('.pane__scroll .block')]
        .at(-1)
        ?.querySelector('.block__body')?.textContent ?? ''
  )

// --- nothing Ember did is in the shell's own history ------------------------------------
await run('Get-History | Out-String')
const history = await lastBody()
check(
  'the shell history holds nothing Ember typed into it',
  !/integration\.ps1|EMBER_INTEGRATION|base64\s+-d/i.test(history),
  history.replace(/\s+/g, ' ').slice(0, 200)
)

// --- output cannot move the pane ----------------------------------------------------------
/*
 * Sampled while the command is still running, not after it has finished.
 *
 * The prompt reports the real directory again the moment it returns, so a forged
 * one is put right within a second by the shell itself — which is why asking
 * afterwards passes even on a build that believed every word of it. That is how
 * the first version of this check managed to pass against the bug it was written
 * for. The command holds the pane open for three seconds instead, so the question
 * is asked while the answer still means something.
 */
const forgedWhileRunning = async (file, marker) => {
  await page.click('.composer__input')
  await page.keyboard.type(`Get-Content ${file}; Start-Sleep -Seconds 3`, { delay: 4 })
  await page.keyboard.press('Enter')
  await sleep(1800)
  const seen = (await cwdShown()).toLowerCase()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await sleep(400)
    if ((await page.locator('.block--running').count()) === 0) break
  }
  await sleep(600)
  return { seen, took: seen.includes(marker) }
}
const forgedLocal = await forgedWhileRunning('forge-cwd.txt', 'forged-by-output')
check('a working directory printed by a command is ignored', !forgedLocal.took, forgedLocal.seen)
const forgedUnc = await forgedWhileRunning('forge-unc.txt', 'evil')
check('and one that is not even local is ignored twice over', !forgedUnc.took, forgedUnc.seen)

// --- output cannot rewrite what a block says was run ----------------------------------------
await run('Get-Content forge-cmd.txt')
const commands = await blockCommands()
check(
  'a command printed by a command is not recorded as the command',
  !commands.some((c) => c.includes('forged-command')),
  JSON.stringify(commands.slice(-3))
)
check(
  'and the block still says what was actually run',
  commands.some((c) => c.includes('forge-cmd.txt')),
  JSON.stringify(commands.slice(-3))
)

// --- a machine whose policy refuses scripts still gets blocks ---------------------------------
// Taught through the dialog rather than written straight into settings: the
// sessions menu is built from the served list, and a profile poked into storage
// behind it is offered by nobody — which the first run of this proved by finding
// no such entry.
await page.keyboard.press('Control+,')
await page.waitForSelector('.modal', { timeout: 8_000 })
await page.locator('.btn', { hasText: 'Add shell…' }).click()
await sleep(400)
await page.locator('.shellrow__name').last().fill('Restricted PS')
await page.locator('.shellrow__path').last().fill('powershell.exe')
await page.locator('.shellrow__args').last().fill('-NoLogo -ExecutionPolicy Restricted')
await page.locator('.shellrow__dialect').last().selectOption('powershell')
await page.locator('.modal .btn', { hasText: 'Save' }).click()
await sleep(1400)
await page.click('.sessions__new')
await sleep(500)
const restricted = page.locator('.sessions__menu .titlebar__menu-item', { hasText: 'Restricted PS' })
check('the taught shell is offered', (await restricted.count()) === 1, `${await restricted.count()}`)
if ((await restricted.count()) === 1) {
  await restricted.click()
  await sleep(1500)
  let state = 'pending'
  for (let i = 0; i < 40; i++) {
    state = await page.evaluate(
      () =>
        document.querySelector('.pane[data-integration]')?.getAttribute('data-integration') ?? 'none'
    )
    if (state === 'ready') break
    await sleep(500)
  }
  check('a Restricted execution policy still reaches integration', state === 'ready', state)
}

// --- and Git Bash, which reports its directory in another language altogether -------------------
const hasGitBash = await page.evaluate(async () => {
  const all = await window.ember.listProfiles()
  return all.some((p) => p.id === 'git-bash')
})
/*
 * Not installed is a reason to skip, not a reason to pass.
 *
 * This half sat inside two nested ifs that registered no check between them: a
 * machine without Git Bash printed a line and went green, and so did one where
 * the menu simply did not offer the entry. The suite reported coverage it had
 * never run. Recorded now, and fatal under EMBER_STRICT — which is what the gate
 * sets — so the only place it stays quiet is a laptop that genuinely lacks it.
 */
const skipped = []
if (!hasGitBash) {
  skipped.push('Git Bash')
} else {
  await page.click('.sessions__new')
  await sleep(500)
  const bash = page.locator('.sessions__menu .titlebar__menu-item', { hasText: 'Git Bash' })
  const offered = (await bash.count()) > 0
  check('a profile that was detected is offered in the menu', offered)
  if (offered) {
    await bash.first().click()
    await sleep(2000)
    let bashState = 'pending'
    for (let i = 0; i < 40; i++) {
      bashState = await page.evaluate(
        () =>
          document.querySelector('.pane[data-integration]')?.getAttribute('data-integration') ??
          'none'
      )
      if (bashState === 'ready') break
      await sleep(500)
    }
    check('Git Bash reaches integration', bashState === 'ready', bashState)
    await run('pwd')
    const shownCwd = await cwdShown()
    /*
     * Judged by shape and by which directory it names, not by its first character:
     * the status bar shortens a long path, so what is on screen is
     * `…\AppData\Local\Temp\ember-forge-x` rather than the drive it starts with.
     * What separates the two answers is the separator — Git Bash left to itself
     * says `/c/users/…`, which nothing on this side can open, stat, or run git in.
     */
    check(
      'and reports its directory in a shape this side of the machine can open',
      shownCwd.includes('\\') && shownCwd.includes(path.basename(work)),
      shownCwd
    )
    const body = await lastBody()
    check('and its commands still make blocks with output in them', body.trim().length > 0, body.slice(0, 120))
  }
}

// --- and the way back, which is only a way back if it works ------------------------------------
//
// The old typed loading is kept for one release as the rollback for anyone whose
// profile disagrees with the encoded kind. An untested rollback is not one, so it
// is turned on here and the pane still has to arrive at integration — signed, as
// it happens, since the nonce travels in the environment either way and only the
// loading differs.
await page.evaluate(() => window.ember.setSettings({ integrationTypedFallback: true }))
await sleep(700)
await page.click('.sessions__new')
await sleep(500)
const fallbackEntry = page.locator('.sessions__menu .titlebar__menu-item', { hasText: 'PowerShell' })
if ((await fallbackEntry.count()) > 0) {
  await fallbackEntry.first().click()
  await sleep(2000)
  let fallbackState = 'pending'
  for (let i = 0; i < 40; i++) {
    fallbackState = await page.evaluate(
      () =>
        document.querySelector('.pane[data-integration]')?.getAttribute('data-integration') ?? 'none'
    )
    if (fallbackState === 'ready') break
    await sleep(500)
  }
  check('the typed fallback still reaches integration', fallbackState === 'ready', fallbackState)
} else {
  check('a PowerShell to fall back with is offered', false, 'no PowerShell entry in the menu')
}
await page.evaluate(() => window.ember.setSettings({ integrationTypedFallback: false }))

await app.close()
profile.cleanup()
fs.rmSync(work, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
if (skipped.length > 0) console.log(`shells not installed, not asked: ${skipped.join(', ')}`)
const strictSkip = skipped.length > 0 && !!process.env.EMBER_STRICT
const passed = failures.length === 0 && pageErrors.length === 0 && !strictSkip
console.log('shell integration that cannot be forged:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
