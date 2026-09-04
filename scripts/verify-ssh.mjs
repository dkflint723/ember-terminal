// The hosts you already told ssh about.
//
// A terminal is judged on this, and Ember could technically do it before — `ssh
// myserver` is a command like any other. What it could not do is know about them,
// so every connection was something to remember and type.
//
// They arrive as shell profiles rather than as a list of their own, which is the
// whole trick: a profile is already something the new-session menu offers, the
// palette lists, the session file restores and the settings dropdown defaults to.
// So what this checks is that they really are profiles — offered, openable, and
// honest about what they are — rather than that a parser returns some strings.
//
// A throwaway home directory, because the real ~/.ssh/config belongs to the user
// and this must neither read it nor write near it.
//
// Run: node scripts/verify-ssh.mjs
import { _electron as electron } from 'playwright-core'
import { placeTopRight } from './place-window.mjs'
import { newProfile } from './profile.mjs'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const profile = newProfile('ssh')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const failures = []
const check = (label, ok, detail) => {
  if (!ok) failures.push(`${label}${detail !== undefined ? ` — ${detail}` : ''}`)
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-ssh-home-'))
fs.mkdirSync(path.join(home, '.ssh'))
fs.writeFileSync(
  path.join(home, '.ssh', 'config'),
  [
    '# A comment, and a settings block that is not a place to connect.',
    'Host *',
    '  ServerAliveInterval 60',
    '',
    'Host build-box',
    '  HostName 10.0.0.4',
    '  User ada',
    '',
    'host lowercase-keyword',
    '  HostName example.net',
    '',
    'Host first second',
    '  HostName shared.example.net',
    '',
    '# A pattern names a shape rather than a machine.',
    'Host web-*',
    '  User deploy',
    '',
    '# ssh drops an unquoted # and everything after it on a config line.',
    'Host commented   # the CI box',
    '  HostName 10.0.0.9',
    '',
    '# And a value may be quoted so that it can hold a space.',
    'Host "my server"',
    '  HostName 10.0.0.10',
    '',
    '# Include is how real configs are organised, and ssh expands it first.',
    'Include config.d/*.conf',
    ''
  ].join('\n')
)

fs.mkdirSync(path.join(home, '.ssh', 'config.d'))
fs.writeFileSync(
  path.join(home, '.ssh', 'config.d', 'work.conf'),
  ['Host from-an-include', '  HostName 10.0.0.11', ''].join('\n')
)

const app = await electron.launch({
  executablePath: path.join(APP_DIR, 'node_modules/electron/dist/electron.exe'),
  args: [APP_DIR, profile.arg],
  cwd: APP_DIR,
  // os.homedir() reads this on Windows, which is how the app is pointed at a
  // config that is not the user's own.
  env: { ...env, USERPROFILE: home, HOME: home },
  timeout: 60_000
})
const page = await app.firstWindow()
await placeTopRight(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
await page.waitForSelector('.pane', { timeout: 40_000 })
await sleep(2500)

const profiles = await page.evaluate(() => window.ember.listProfiles())
const ssh = profiles.filter((p) => p.id.startsWith('ssh-'))
const names = ssh.map((p) => p.name)

check('the hosts in the config are offered', names.includes('build-box'), JSON.stringify(names))
check('whatever case the keyword was written in', names.includes('lowercase-keyword'), JSON.stringify(names))
check(
  'and a line naming several hosts offers each of them',
  names.includes('first') && names.includes('second'),
  JSON.stringify(names)
)

/*
 * Patterns are not places. `Host *` is a settings block and `Host web-*` names a
 * shape — offering either would put an entry in the menu that cannot be opened.
 */
check('a wildcard block is not offered as somewhere to go', !names.includes('*'), JSON.stringify(names))
check('nor is a pattern', !names.some((n) => n.includes('*')), JSON.stringify(names))

const box = ssh.find((p) => p.name === 'build-box')
check('a host runs ssh, with the host as its argument', box?.path === 'ssh' && box?.args?.[0] === 'build-box', JSON.stringify(box))

/*
 * And it says it is a plain terminal. Ember's blocks come from a script injected
 * into the shell it starts, and this shell is on another machine — one this app
 * has no business writing to. Claiming integration it cannot deliver would leave
 * a pane waiting for command boundaries that never arrive.
 */
check('and does not claim shell integration it cannot have', box?.integration === 'none', String(box?.integration))

/*
 * A line's arguments are read the way ssh reads them.
 *
 * Splitting on whitespace made every token a hostname, so an inline comment
 * became four more profiles — `#`, `the`, `CI`, `box` — each with a menu entry
 * that starts a shell which immediately dies, and a quoted name was offered as
 * two broken halves instead of the one host that was configured.
 */
check('an inline comment is a comment, not four more hosts', names.includes('commented'), JSON.stringify(names))
check(
  'and none of its words become hosts of their own',
  !names.some((n) => ['#', 'the', 'CI', 'box'].includes(n)),
  JSON.stringify(names)
)
check(
  'a quoted name is one host with a space in it',
  names.includes('my server'),
  JSON.stringify(names)
)

/*
 * And Include is followed. It is how real configs are organised — 1Password's
 * agent setup, Colima, corporate dotfiles, a config.d directory — and ssh expands
 * it before matching any Host, so a config that delegates everything offered
 * nothing at all, with nothing to say why.
 */
check(
  'a host reached through an Include is offered too',
  names.includes('from-an-include'),
  JSON.stringify(names)
)

/*
 * And a session whose shell is gone says so rather than quietly becoming another.
 *
 * An ssh profile's id comes from the text of the config, so renaming a host means
 * a restored pane asks for something that no longer exists. That fell back to the
 * first profile in the list — PowerShell on this machine — in a pane still
 * wearing the name of the server.
 */
const gone = await page.evaluate(() =>
  window.ember.spawn({ paneId: 'ssh-gone-probe', profileId: 'ssh-was-renamed', cols: 80, rows: 24 })
)
check(
  'a session whose shell is gone is refused, not silently swapped',
  gone?.ok === false && String(gone.error).includes('ssh-was-renamed'),
  JSON.stringify(gone)
)

/*
 * The point of making them profiles: the menu that offers a new session offers
 * them too, with no code of its own.
 */
await page.locator('.sessions__add, .sessions button').first().click({ force: true })
await sleep(700)
const offered = await page.evaluate(() =>
  [...document.querySelectorAll('.titlebar__menu-item')].map((e) => e.textContent ?? '')
)
check(
  'the new-session menu offers them alongside the shells',
  offered.some((t) => t.includes('build-box')),
  JSON.stringify(offered.slice(0, 8))
)
await page.keyboard.press('Escape')

await app.close()
profile.cleanup()
fs.rmSync(home, { recursive: true, force: true })
for (const f of failures) console.log(`  - ${f}`)
if (errors.length) console.log('page errors:', errors.slice(0, 3).join(' | '))
console.log('ssh hosts:', failures.length === 0 && errors.length === 0 ? 'PASS' : 'FAIL')
process.exit(failures.length === 0 && errors.length === 0 ? 0 : 1)
