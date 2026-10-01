// Which machine a session is on, and when to try reconnecting. Run: node scripts/test-ssh-remote.mjs
import { nextReconnect, RECONNECT_BACKOFF, remoteHostOf } from '../src/shared/ssh-remote.ts'

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

check('the first loss waits a second', JSON.stringify(nextReconnect(0, 2_000)) === JSON.stringify({ attempt: 1, waitS: 1 }))
check('then longer', nextReconnect(3, 2_000)?.waitS === 8)
check('and gives up after the last', nextReconnect(RECONNECT_BACKOFF.length, 2_000) === null)
check('a connection that held starts the count again', JSON.stringify(nextReconnect(5, 60_000)) === JSON.stringify({ attempt: 1, waitS: 1 }))

console.log(`ssh remote: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
