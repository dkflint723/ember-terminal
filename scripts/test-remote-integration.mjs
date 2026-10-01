// The lines that put Ember's integration into a remote shell, run for real in a local
// bash, and the test for when a remote shell is at a prompt.
// Run: node scripts/test-remote-integration.mjs
//
// The visible line and the script it reads are fed to Git Bash as a remote shell
// would get them: the line first, then — once it has printed its signed marker —
// the lines of base64 and the `.` that ends them. The shell must come out with
// Ember's functions defined, the nonce set and not exported, and the visible line
// gone from its history. And a shell that is not bash must do nothing at all.
import './ts-resolve.mjs'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
const { loaderLine, payloadLines, looksLikePrompt, visibleText, loadMarker, REMOTE_TOKEN } = await import('../src/shared/remote-integration.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const N = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'resources', 'shell-integration', 'integration.bash'), 'utf8')

// --- the shapes -------------------------------------------------------------------------------
const line = loaderLine(N)
check('the visible line is one line, ended by Enter', line.endsWith('\r') && !line.slice(0, -1).includes('\n') && !line.slice(0, -1).includes('\r'))
check('it starts with a space, for a shell that keeps those out of history', line.startsWith(' '))
check('it carries the token the script finds it by', line.includes(REMOTE_TOKEN))
check('it is short enough to read on screen', line.length < 400, String(line.length))
const lines = payloadLines(script, N)
check('the script goes as short lines', lines.slice(0, -1).every((l) => l.length <= 76 && /^[A-Za-z0-9+/=]+$/.test(l)))
check('ended by a lone dot', lines.at(-1) === '.')
check('the load marker is signed', loadMarker(N) === `\x1b]633;Load;${N}\x07`)

// --- run for real, in bash, as the remote shell would -------------------------------------------
// Git Bash here; elsewhere (the CI's Linux job) the system's bash, which is what a
// remote host runs anyway.
const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', '/bin/bash', '/usr/bin/bash'].find((p) => fs.existsSync(p))
if (gitBash) {
  // An interactive bash with history on, reading the visible line and then the payload
  // from stdin — the order a person's terminal delivers them in. `stty` has no
  // terminal here; its complaints go to stderr and change nothing.
  const probe = [
    'declare -F __ember_prompt_command >/dev/null && echo FN=yes',
    'echo "NONCE=$__ember_nonce"',
    'echo "EXPORTED=$(env | grep -c ^EMBER_NONCE=)"',
    'echo "REMOTE=$__ember_remote"',
    `echo "INHISTORY=$(HISTTIMEFORMAT= history | grep -c 'ember-remote-integr[a]tion')"`
  ].join('\n')
  const stdin = `${line.slice(0, -1)}\n${lines.join('\n')}\n${probe}\n`
  const run = spawnSync(gitBash, ['--norc', '--noprofile', '-i'], { input: stdin, encoding: 'utf8', env: { ...process.env, HISTFILE: '/dev/null', HISTCONTROL: '' } })
  const out = run.stdout ?? ''
  check('the visible line says it is listening, signed', out.includes(loadMarker(N)), JSON.stringify(out.slice(0, 200)))
  check("Ember's functions are defined in the shell", out.includes('FN=yes'), JSON.stringify(out.slice(-400)))
  check('the nonce is set', out.includes(`NONCE=${N}`))
  check('and not exported to what runs there', out.includes('EXPORTED=0'), JSON.stringify(out.slice(-300)))
  check('the shell knows it is remote', out.includes('REMOTE=1'))
  check('the visible line is gone from its history', out.includes('INHISTORY=0'), JSON.stringify(out.slice(-300)))
  check('the remote directory is reported as remote, and only as that', out.includes('633;P;RemoteCwd=') && !out.includes('633;P;Cwd='), JSON.stringify(out.slice(-300)))

  // Keys pressed while the script was being read are read with it: what does not
  // decode to this session's script, nonce first, is not run (QA).
  const junk = Buffer.from('echo JUNK-RAN\n').toString('base64')
  const mixed = spawnSync(gitBash, ['--norc', '--noprofile', '-i'], { input: `${line.slice(0, -1)}\n${junk}\n.\necho after\n`, encoding: 'utf8', env: { ...process.env, HISTFILE: '/dev/null' } })
  check('what was read is not run unless it is the script this session sent', !(mixed.stdout ?? '').includes('JUNK-RAN') && (mixed.stdout ?? '').includes('after'), JSON.stringify((mixed.stdout ?? '').slice(-200)))
  const typedInto = spawnSync(gitBash, ['--norc', '--noprofile', '-i'], { input: `${line.slice(0, -1)}\nls\n${lines.join('\n')}\necho "FN=$(declare -F __ember_prompt_command)"\n`, encoding: 'utf8', env: { ...process.env, HISTFILE: '/dev/null' } })
  check('nor is the script, once keys were mixed into it', !(typedInto.stdout ?? '').includes('FN=__ember_prompt_command'), JSON.stringify((typedInto.stdout ?? '').slice(-200)))

  // A shell that is not bash: the line is a no-op, the marker never comes.
  // dash only: Git's sh.exe is bash under another name.
  const sh = ['C:\\Program Files\\Git\\usr\\bin\\dash.exe', '/bin/dash', '/usr/bin/dash'].find((p) => fs.existsSync(p))
  if (sh) {
    const other = spawnSync(sh, ['-i'], { input: `${line.slice(0, -1)}\necho after\n`, encoding: 'utf8' })
    check('in a shell that is not bash, nothing is loaded and nothing listens', !(other.stdout ?? '').includes('633;Load') && (other.stdout ?? '').includes('after'), JSON.stringify(other.stdout))
  }
} else {
  check('a bash is there to run it', false, 'none found')
}

// --- when to type: a prompt, and nothing else ----------------------------------------------------
const prompts = ['user@web1:~$ ', '[deploy@web1 app]$ ', 'root@box:/# ', 'web1% ', 'bash-5.2$ ', '\x1b[32muser@h\x1b[0m:\x1b[34m~\x1b[0m$ ', 'Last login: Tue\r\nuser@h:~$ ']
for (const p of prompts) check(`a prompt: ${JSON.stringify(p)}`, looksLikePrompt(p))
const notPrompts = ["user@web1's password: ", 'Enter passphrase for key /home/u/.ssh/id: ', 'Are you sure you want to continue connecting (yes/no/[fingerprint])? ', 'Welcome to Ubuntu\r\n', '', 'Verification code: ', 'building... 45% done', 'Last login: Tue Sep 30 from 10.0.0.1\r\n']
for (const p of notPrompts) check(`not a prompt: ${JSON.stringify(p)}`, !looksLikePrompt(p))
check('escapes and titles are not text', visibleText('\x1b]0;title\x07\x1b[1;32mok\x1b[0m') === 'ok')

console.log(`remote integration: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
