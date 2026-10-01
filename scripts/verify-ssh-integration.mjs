// Blocks for commands on an ssh host, for a host the person said yes to (audit R31,
// phase 2).
//
// A real sshd (ssh-test-server.mjs: inside WSL, this user, a localhost port, its own
// keys) and Windows' own ssh.exe. What has to hold:
//   - the first time a host reaches a prompt, the person is asked, and nothing is
//     typed into that host before they answer;
//   - after yes, commands there are blocks — output, exit codes — signed with this
//     session's nonce, and the remote directory is shown and never taken as local;
//   - the visible line Ember typed is not left in the remote shell's history, and
//     the screen did not fill with the script;
//   - the answer is kept: the next session to that host loads without asking;
//   - a host whose shell is not bash is tried once, said so, and not tried again.
//
// Without an SSH server to run against it says why and passes, unless
// EMBER_REQUIRE_SSHD is set (CI sets it where it provides one).
//
// Run: node scripts/verify-ssh-integration.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile, seedDirs } from './profile.mjs'
import { closeApp, watchPageErrors, watchRunning } from './harness.mjs'
import { SSH_EXE, startSshServer } from './ssh-test-server.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

const server = await startSshServer()
if (!server.ok) {
  console.log(`ssh integration: no SSH server to run against — ${server.why}`)
  if (process.env.EMBER_REQUIRE_SSHD) {
    console.log('ssh integration: FAIL (EMBER_REQUIRE_SSHD is set)')
    process.exit(1)
  }
  console.log('ssh integration: PASS (nothing to run against)')
  process.exit(0)
}

// A second name for the same server whose session runs python, not bash: a remote
// shell that is not bash, with a prompt ending in `>`.
const PY = 'ember-test-python'
fs.appendFileSync(server.configFile, fs.readFileSync(server.configFile, 'utf8').replace(`Host ${server.host}`, `Host ${PY}`))

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('ssh-integration')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const bash = { id: 'ssh-test', name: 'SSH test', path: SSH_EXE, args: ['-F', server.configFile, server.host], integration: 'none' }
const python = { id: 'ssh-python', name: 'SSH python', path: SSH_EXE, args: ['-F', server.configFile, '-t', PY, 'exec python3 -q -i'], integration: 'none' }
for (const d of seedDirs(profile.dir)) {
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ customProfiles: [bash, python], defaultProfileId: bash.id }), 'utf8')
}

const pageErrors = []
const app = watchPageErrors(
  await electron.launch({ executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'), args: [APP_DIR, profile.arg], cwd: APP_DIR, env, timeout: 60_000 }),
  pageErrors
)
const page = await app.firstWindow()
await watchRunning(app)
await placeTopRight(app)

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}
const waitFor = async (test, ms) => {
  for (const until = Date.now() + ms; Date.now() < until; ) {
    if (await test()) return true
    await sleep(250)
  }
  return test()
}
const notice = () => page.evaluate(() => document.querySelector('.notice__text')?.textContent ?? '')
const paneState = () =>
  page.evaluate(() => {
    const p = document.querySelector('.pane[data-integration]')
    return { integration: p?.getAttribute('data-integration'), authenticated: p?.getAttribute('data-authenticated') }
  })
const settingsNow = () => page.evaluate(async () => (await window.ember.getSettings()).remoteIntegration ?? {})
const lastBlock = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll('.pane__scroll .block')].at(-1)
    return b ? { cmd: (b.querySelector('.block__cmd')?.textContent ?? '').trim(), body: (b.querySelector('.block__body')?.textContent ?? '').trim(), exit: (b.querySelector('.block__exit')?.textContent ?? '').trim(), running: b.classList.contains('block--running') } : null
  })
const run = async (command) => {
  const before = await page.evaluate(() => document.querySelectorAll('.pane__scroll .block').length)
  await page.locator('.composer__input').first().focus()
  await page.keyboard.type(command, { delay: 5 })
  await page.keyboard.press('Enter')
  await waitFor(async () => {
    const n = await page.evaluate(() => document.querySelectorAll('.pane__scroll .block').length)
    return n > before && !(await lastBlock())?.running
  }, 20_000)
  return lastBlock()
}
const openSession = async (name) => {
  await page.locator('.sessions__new').click()
  await sleep(400)
  await page.locator('.sessions__menu .titlebar__menu-item', { hasText: name }).first().click()
}

// --- asked first, and nothing typed before the answer ----------------------------------------
const asked = await waitFor(async () => (await notice()).includes(`Show blocks for commands on ${server.host}`), 45_000)
check('the first prompt on a host asks whether to show blocks for it', asked, await notice())
check('and nothing is loaded before the answer', (await paneState()).integration !== 'ready', JSON.stringify(await paneState()))

// Answered only if asked: on a build that never asks there is nothing to press, and
// the checks below say what did not happen rather than a click timing out.
if (asked) await page.locator('.notice__action', { hasText: `Yes, for ${server.host}` }).click()
const loaded = asked && await waitFor(async () => {
  const s = await paneState()
  return s.integration === 'ready' && s.authenticated === 'yes'
}, 30_000)
check('after yes, the remote shell reports blocks, signed with this session’s nonce', loaded, JSON.stringify(await paneState()))
check('the answer is kept for the host', (await settingsNow())[server.host] === 'on', JSON.stringify(await settingsNow()))

if (loaded) {
  const ok = await run('echo remote-$((40 + 2))')
  check('a command there is a block with its output', ok?.body.includes('remote-42') && !ok.running, JSON.stringify(ok))
  const failed = await run('false')
  check('and its exit code', failed?.exit.includes('1'), JSON.stringify(failed))
  await run('cd /tmp')
  const chip = await waitFor(async () => (await page.locator('[data-status="remote"]').textContent())?.includes('/tmp'), 10_000)
  check('the remote directory is shown, as remote', chip, await page.locator('[data-status="remote"]').textContent())
  check('and no local folder is claimed for the session', (await page.locator('[data-status="cwd"]').count()) === 0)
  const hist = await run(`HISTTIMEFORMAT= history | grep -c 'ember-remote-integr[a]tion'`)
  check('the line Ember typed is not left in the remote history', /^0\b/.test(hist?.body ?? ''), JSON.stringify(hist))
  const env2 = await run('env | grep -c ^EMBER_NONCE=')
  check('the nonce is not exported to what runs there', /^0\b/.test(env2?.body ?? ''), JSON.stringify(env2))
  const wall = await page.evaluate(() => /[A-Za-z0-9+/]{200,}/.test(document.querySelector('.pane')?.textContent ?? ''))
  check('the screen did not fill with the script', !wall)
}

// --- kept: the next session to the host loads without asking ---------------------------------
await openSession('SSH test')
const again = await waitFor(async () => {
  const s = await paneState()
  return s.integration === 'ready' && s.authenticated === 'yes'
}, 45_000)
check('the next session to that host loads without asking', again && !(await notice()).includes('Show blocks'), `${JSON.stringify(await paneState())} ${await notice()}`)

// --- a shell that is not bash: tried once, said, not again --------------------------------------
await openSession('SSH python')
const askedPy = await waitFor(async () => (await notice()).includes(`Show blocks for commands on ${PY}`), 45_000)
check('a host whose shell is not bash is asked about too', askedPy, await notice())
if (askedPy) {
  await page.locator('.notice__action', { hasText: `Yes, for ${PY}` }).click()
  const said = await waitFor(async () => (await notice()).includes('did not answer as bash'), 20_000)
  check('and, not being bash, it is said so', said, await notice())
  check('and not tried there again', (await settingsNow())[PY] === 'off', JSON.stringify(await settingsNow()))
  check('and its pane stays a plain terminal', (await paneState()).integration !== 'ready', JSON.stringify(await paneState()))
}

const unclosed = await closeApp(app)
if (unclosed) failures.push(unclosed)
server.stop()
profile.cleanup()
for (const f of failures) console.log(`  - ${f}`)
if (pageErrors.length > 0) console.log('page errors:', pageErrors.slice(0, 4).join(' | '))
const passed = failures.length === 0 && pageErrors.length === 0
console.log('ssh integration:', passed ? 'PASS' : 'FAIL')
process.exit(passed ? 0 : 1)
