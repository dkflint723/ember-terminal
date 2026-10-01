// Which machine a session is on, and when to try reconnecting. Run: node scripts/test-ssh-remote.mjs
import { endsWithEscape, isTerminalReply, nextReconnect, RECONNECT_BACKOFF, RECONNECT_LIMIT, remoteHostOf } from '../src/shared/ssh-remote.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
const host = (path, args, remote) => remoteHostOf({ path, args, remote })

check('a profile that says so is on its host', host('ssh', ['x'], { host: 'build-box' }) === 'build-box')
check('ssh host', host('ssh', ['web1']) === 'web1')
check('ssh.exe by its full path', host('C:\\Windows\\System32\\OpenSSH\\ssh.exe', ['web1']) === 'web1')
check('user@host gives the host', host('ssh', ['deploy@web1']) === 'web1')
check('past options and their values', host('ssh', ['-p', '2222', '-i', 'C:\\k\\id', '-o', 'ConnectTimeout=5', '-v', 'web1', 'uptime']) === 'web1', String(host('ssh', ['-p', '2222', '-i', 'C:\\k\\id', '-o', 'ConnectTimeout=5', '-v', 'web1', 'uptime'])))
check('a jump host is not the host', host('ssh', ['-J', 'bastion', 'inner']) === 'inner')
check('a local shell is on no host', host('pwsh.exe', ['-NoLogo']) === null)
check('nor is a shell with ssh in its name', host('C:\\tools\\sshd-helper.exe', ['web1']) === null)
check('nor no profile', remoteHostOf(undefined) === null)

check('the first loss waits a second', JSON.stringify(nextReconnect(0, 2_000)) === JSON.stringify({ attempt: 1, waitS: 1, total: 1 }))
check('then longer', nextReconnect(3, 2_000)?.waitS === 8)
check('and gives up after the last', nextReconnect(RECONNECT_BACKOFF.length, 2_000) === null)
check('a connection that held starts the count again', JSON.stringify(nextReconnect(5, 60_000)) === JSON.stringify({ attempt: 1, waitS: 1, total: 1 }))
// QA: a password prompt nobody answered "held" for two minutes, and was asked again forever.
check('one nobody typed into did not hold, however long', nextReconnect(RECONNECT_BACKOFF.length, 130_000, { typed: false, total: 6 }) === null)
check('and twenty short tries in a row is the end', nextReconnect(0, 2_000, { typed: true, total: RECONNECT_LIMIT }) === null)
check('the count in all goes up', nextReconnect(0, 2_000, { typed: true, total: 7 })?.total === 8)
check('~. at the start of a line is ssh closed on purpose', endsWithEscape('\r~.') && endsWithEscape('ls\r~.'))
check('but not ~. inside a line', !endsWithEscape('\recho ~.') && !endsWithEscape('\r~'))
// QA: the twenty was a lifetime's, so a session that drops every night stopped coming back.
check('a connection that held starts the count in all again too', nextReconnect(0, 6 * 3600_000, { typed: true, total: RECONNECT_LIMIT })?.total === 1)
check('~. sent with its Enter from the composer is closed on purpose', endsWithEscape('\r~.\r'))
check('the terminal answering for itself is not typing', ['\x1b[I', '\x1b[O', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b[0n', '\x1b[12;40R', '\x1b[<0;10;5M', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1bP1$r0m\x1b\\'].every(isTerminalReply))
check('and Alt with ] P _ ^ is a key, not the start of a reply', !['\x1b]', '\x1bP', '\x1b_', '\x1b^', '\x1b]x', '\x1bPq'].some(isTerminalReply))
check('but keys are, arrows and Escape included', !['a', '\r', '\x1b', '\x1b[A', '\x1bOB', '\x1b[3~', '\x1bb', '~.'].some(isTerminalReply))
check('-P takes a value', host('ssh', ['-P', 'tag', 'web1']) === 'web1')

console.log(`ssh remote: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
