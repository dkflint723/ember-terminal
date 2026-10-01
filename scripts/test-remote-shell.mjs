// When Ember types its integration into an ssh session, and when it must not.
// Run: node scripts/test-remote-shell.mjs
//
// The real watcher (main/remote-shell.ts) with its writes, settings and window
// faked, and the clock mocked. Each case below is a way QA found it typing without
// the consent it promises — into a REPL after a late yes, into another host from a
// pane never answered, onto the end of a half-typed `rm -rf build #`, for a host
// named `constructor` — and the cases it must still get right.
import './ts-resolve.mjs'
import { mock } from 'node:test'
const { RemoteIntegration, choiceFor } = await import('../src/main/remote-shell.ts')
const { loadMarker } = await import('../src/shared/remote-integration.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

mock.timers.enable({ apis: ['setTimeout'] })
const tick = (ms) => mock.timers.tick(ms)
const N = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

/** A watcher with everything around it recorded. */
const rig = (choices = {}) => {
  const writes = []
  const events = []
  const map = { ...choices }
  const r = new RemoteIntegration({
    write: (paneId, data) => writes.push({ paneId, data }),
    choice: (host) => choiceFor(map, host),
    setChoice: (host, c) => {
      map[host] = c
    },
    notify: (e) => events.push(e),
    script: () => 'echo script'
  })
  const loaders = (pane) => writes.filter((w) => (pane ? w.paneId === pane : true) && w.data.includes('ember-remote-integration'))
  return { r, writes, events, map, loaders }
}

// --- an undecided host: asked at the first prompt, nothing typed before the answer ----------
{
  const { r, writes, events, map, loaders } = rig()
  r.started('p', 'web1', N)
  r.data('p', 'Welcome\r\nuser@web1:~$ ')
  tick(600)
  check('an undecided host is asked at its first prompt', events.some((e) => e.state === 'ask' && e.host === 'web1'), JSON.stringify(events))
  check('and nothing is typed before the answer', writes.length === 0)
  r.answer('p', true)
  check('yes at the untouched first prompt types the visible line', loaders('p').length === 1)
  check('starting with Ctrl-U, so a line not empty is cleared, never finished', writes[0]?.data.startsWith('\x15'))
  check('and the yes is kept for the host', map.web1 === 'on')
  r.data('p', `x${loadMarker(N)}`)
  check('the script follows only on the signed marker', writes.length === 2 && /^[A-Za-z0-9+/=]+\r/.test(writes[1].data), JSON.stringify(writes.map((w) => w.data.slice(0, 20))))
  check('and the window is told it loaded', events.some((e) => e.state === 'loaded'))
}

// --- a host called after Object.prototype's own properties is not a yes ----------------------
for (const host of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
  const { r, writes, events } = rig()
  r.started('p', host, N)
  r.data('p', 'user@h:~$ ')
  tick(600)
  check(`a host named ${host} is asked, not taken for a yes`, writes.length === 0 && events.some((e) => e.state === 'ask'), JSON.stringify(writes))
}
check('choiceFor reads only a host’s own answer', choiceFor({}, 'constructor') === undefined && choiceFor({ web1: 'on' }, 'web1') === 'on' && choiceFor({ web1: 'maybe' }, 'web1') === undefined)

// --- a late yes: the pane has moved on, so nothing is typed now --------------------------------
{
  const { r, loaders, map } = rig()
  r.started('p', 'prod', N)
  r.data('p', 'deploy@prod:~$ ')
  tick(600)
  r.data('p', 'python3\r\nPython 3.12\r\n>>> ')
  tick(600)
  r.answer('p', true)
  check('a yes given after the screen changed types nothing into what is there now (a REPL)', loaders().length === 0)
  check('but is kept for the next connection', map.prod === 'on')
}

// --- typing ends the connection's chance; the answer still counts -----------------------------
{
  const { r, loaders, map } = rig()
  r.started('p', 'prod', N)
  r.data('p', 'deploy@prod:~$ ')
  tick(600)
  r.input('p', 'l')
  r.answer('p', true)
  check('after the person has typed, a yes types nothing', loaders().length === 0)
  check('and is kept', map.prod === 'on')
}

// --- a host said yes to: never onto a half-typed line ------------------------------------------
{
  const { r, loaders } = rig({ prod: 'on' })
  r.started('p', 'prod', N)
  r.data('p', 'deploy@prod:~$ ')
  r.input('p', 'rm -rf build #')
  r.data('p', 'rm -rf build #')
  tick(600)
  check('a half-typed line ending in # is never finished with the visible line', loaders().length === 0)
}
{
  const { r, loaders } = rig({ prod: 'on' })
  r.started('p', 'prod', N)
  r.data('p', 'deploy@prod:~$ ')
  r.input('p', '\x1b[I')
  r.input('p', '\x1b[O')
  tick(600)
  check('focus reports are the terminal, not a person: the line still goes', loaders().length === 1)
}

// --- two panes to one host: one yes, and the other pane is left alone --------------------------
{
  const { r, loaders } = rig()
  r.started('a', 'prod', N)
  r.started('b', 'prod', N)
  r.data('a', 'deploy@prod:~$ ')
  r.data('b', 'deploy@prod:~$ ')
  tick(600)
  r.answer('a', true)
  check('a yes in one pane loads that pane', loaders('a').length === 1)
  r.data('b', 'ssh db\r\nroot@db:~# ')
  tick(600)
  check('and nothing goes into the other, wherever it has got to (another host)', loaders('b').length === 0)
  r.answer('b', true)
  check('even when it is answered late', loaders('b').length === 0)
  check('an answer from a pane never asked is ignored', (() => {
    const t = rig()
    t.r.started('c', 'web9', N)
    t.r.answer('c', true)
    return t.map.web9 === undefined
  })())
}

// --- an asked watch ends; a host told no is never watched -------------------------------------
{
  const { r, loaders } = rig()
  r.started('p', 'prod', N)
  r.data('p', 'deploy@prod:~$ ')
  tick(600)
  tick(181_000)
  r.answer('p', true)
  check('an answer after the watch gave up types nothing', loaders().length === 0)
}
{
  const { r, writes, events } = rig({ prod: 'off' })
  r.started('p', 'prod', N)
  r.data('p', 'deploy@prod:~$ ')
  tick(600)
  check('a host told no is neither asked nor typed into', writes.length === 0 && events.length === 0)
}
{
  const { r, loaders } = rig({ prod: 'on' })
  r.started('p', 'prod', N)
  r.data('p', "deploy@prod's password: ")
  tick(600)
  check('a password prompt is not a prompt to type into', loaders().length === 0)
  r.data('p', '\r\nLast login: Tue\r\ndeploy@prod:~$ ')
  tick(600)
  check('the first real prompt after it is', loaders().length === 1)
}

// --- a load that does not answer: not bash, or only slow ----------------------------------------
{
  const { r, events, map } = rig({ shellbox: 'on' })
  r.started('p', 'shellbox', N)
  r.data('p', 'box% ')
  tick(600)
  r.data('p', ' [ -n "$BASH_VERSION" ] && { ... } # ember-remote-integration\r\nbox% ')
  tick(8_100)
  check('back at a prompt with no word: not bash, and the host is turned off', map.shellbox === 'off' && events.some((e) => e.state === 'unsupported'), JSON.stringify(events))
}
{
  const { r, events, map } = rig({ far: 'on' })
  r.started('p', 'far', N)
  r.data('p', 'u@far:~$ ')
  tick(600)
  tick(8_100)
  check('silence is only slow: the yes stands for next time', map.far === 'on' && events.some((e) => e.state === 'slow'), JSON.stringify(events))
}

{
  // A banner line ending in `#`, a pause, the line typed — and eaten by a "press
  // Enter" before the shell ever read it; then the real prompt. Nothing proves the
  // shell is not bash, so the yes stands (QA).
  const { r, events, map } = rig({ gate: 'on' })
  r.started('p', 'gate', N)
  r.data('p', '#####################')
  tick(600)
  r.data('p', '\r\nPress Enter to continue\r\nu@gate:~$ ')
  tick(8_100)
  check('a prompt after typed-ahead something else ate is not "not bash"', map.gate === 'on' && events.some((e) => e.state === 'slow'), JSON.stringify(events))
}
{
  const { r, loaders } = rig({ prod: 'on' })
  r.started('p', 'prod', N)
  r.data('p', 'deploy@prod:~$ ')
  r.input('p', '\x1bP')
  tick(600)
  check('Alt+Shift+P is a person typing, and ends the chance', loaders().length === 0)
}

mock.timers.reset()
console.log(`remote shell: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
