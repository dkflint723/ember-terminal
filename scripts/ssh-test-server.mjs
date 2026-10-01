// A throwaway SSH server for suites: sshd inside a WSL distro, run as this user on a
// localhost port, with its own config, host key and authorized key, all deleted
// afterwards. Nothing on Windows is configured and nothing in the distro is left
// running. Needs openssh-server in the distro (Fedora: dnf install openssh-server).
//
// startSshServer() resolves to { ok, host, configFile, stop() } — `configFile` is an
// ssh_config for Windows' own ssh.exe naming the server as `host` — or to
// { ok: false, why } when there is no distro, no sshd, or it would not start.
import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as net from 'node:net'

/*
 * The client a Windows user has: Windows' own OpenSSH, by its full path. A bare
 * `ssh.exe` finds Git's MSYS build first wherever Git's usr\bin is on PATH (as it is
 * in a Git Bash a suite is run from), and that build, under conpty, loses the first
 * key typed after a terminal resize — measured with no Ember in the path: 7 lines of
 * 12 into plain bash, against 0 of 12 for Windows' ssh.exe. That is Git's ssh, not
 * Ember, and not what a person gets from Windows.
 */
export const SSH_EXE = fs.existsSync('C:\\Windows\\System32\\OpenSSH\\ssh.exe') ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : 'ssh.exe'

const wslRun = (script, opts = {}) =>
  spawnSync('wsl.exe', ['-e', 'sh', '-c', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts })

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

const reachable = (port) =>
  new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port }, () => {
      sock.once('data', (d) => {
        sock.destroy()
        resolve(String(d).startsWith('SSH-'))
      })
    })
    sock.setTimeout(1500, () => {
      sock.destroy()
      resolve(false)
    })
    sock.on('error', () => resolve(false))
  })

export async function startSshServer() {
  if (process.platform !== 'win32') return { ok: false, why: 'not Windows' }
  const probe = wslRun('command -v /usr/sbin/sshd >/dev/null 2>&1 && id -un')
  if (probe.status !== 0) return { ok: false, why: `no sshd in the WSL distro (${(probe.stderr || probe.stdout || '').replace(/\0/g, '').trim().slice(0, 120) || 'not installed'})` }
  const user = probe.stdout.replace(/\0/g, '').trim()
  const port = await freePort()

  // The client's key and known hosts on this side, where Windows' ssh.exe reads them.
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-sshc-'))
  const key = path.join(local, 'id_ed25519')
  const gen = spawnSync('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { encoding: 'utf8', windowsHide: true })
  if (gen.status !== 0) return { ok: false, why: `ssh-keygen failed: ${gen.stderr}` }
  const pub = fs.readFileSync(`${key}.pub`, 'utf8').trim()

  // The server's files inside the distro, where sshd will accept their permissions.
  const dir = wslRun('mktemp -d /tmp/ember-sshd-XXXXXX').stdout.replace(/\0/g, '').trim()
  if (!dir.startsWith('/tmp/ember-sshd-')) return { ok: false, why: 'could not make a directory in the distro' }
  const setup = [
    `cd ${dir}`,
    `ssh-keygen -q -t ed25519 -N '' -f ${dir}/host_key`,
    `printf '%s\\n' '${pub}' > ${dir}/authorized_keys`,
    `chmod 600 ${dir}/authorized_keys ${dir}/host_key`,
    `printf '%s\\n' 'Port ${port}' 'ListenAddress 127.0.0.1' 'HostKey ${dir}/host_key' 'AuthorizedKeysFile ${dir}/authorized_keys' 'PidFile ${dir}/sshd.pid' 'StrictModes no' 'UsePAM no' 'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitUserEnvironment no' 'LogLevel ERROR' > ${dir}/sshd_config`
  ].join(' && ')
  const made = wslRun(setup)
  if (made.status !== 0) return { ok: false, why: `server setup failed: ${made.stderr}` }

  // Kept in the foreground, so the distro stays up while it runs and it dies with us.
  const server = spawn('wsl.exe', ['-e', '/usr/sbin/sshd', '-D', '-e', '-f', `${dir}/sshd_config`], { windowsHide: true, env: { ...process.env, MSYS_NO_PATHCONV: '1' } })
  let serverErr = ''
  server.stderr.on('data', (d) => (serverErr += String(d)))

  let up = false
  for (const until = Date.now() + 20_000; Date.now() < until && !up; ) {
    up = await reachable(port)
    if (!up) await new Promise((r) => setTimeout(r, 300))
  }
  const stop = () => {
    try {
      wslRun(`[ -f ${dir}/sshd.pid ] && kill $(cat ${dir}/sshd.pid) 2>/dev/null; rm -rf ${dir}`)
    } catch {
      // Gone already.
    }
    try {
      server.kill()
    } catch {
      // Gone already.
    }
    fs.rmSync(local, { recursive: true, force: true })
  }
  // Stopped however the suite ends — a crash included, which left servers running in
  // the distro. Synchronous all the way down, as an exit handler has to be; once only.
  let stopped = false
  const stopOnce = () => {
    if (stopped) return
    stopped = true
    stop()
  }
  process.on('exit', stopOnce)
  if (!up) {
    stopOnce()
    return { ok: false, why: `sshd did not answer on ${port}: ${serverErr.replace(/\0/g, '').trim().slice(0, 300)}` }
  }

  const host = 'ember-test-host'
  const configFile = path.join(local, 'ssh_config')
  fs.writeFileSync(
    configFile,
    [
      `Host ${host}`,
      '  HostName 127.0.0.1',
      `  Port ${port}`,
      `  User ${user}`,
      `  IdentityFile ${key.replace(/\\/g, '/')}`,
      '  IdentitiesOnly yes',
      `  UserKnownHostsFile ${path.join(local, 'known_hosts').replace(/\\/g, '/')}`,
      '  StrictHostKeyChecking accept-new',
      '  LogLevel ERROR',
      ''
    ].join('\n')
  )
  return { ok: true, host, port, configFile, stop: stopOnce }
}

// Run directly: start one, prove a login works, and stop it.
if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  const s = await startSshServer()
  if (!s.ok) {
    console.log('no server:', s.why)
    process.exit(1)
  }
  const r = spawnSync(SSH_EXE, ['-F', s.configFile, s.host, 'echo logged-in-as-$(id -un) on $(hostname)'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  console.log('ssh exit', r.status, (r.stdout || '').trim(), (r.stderr || '').trim().slice(0, 300))
  s.stop()
  process.exit(r.status === 0 ? 0 : 1)
}
