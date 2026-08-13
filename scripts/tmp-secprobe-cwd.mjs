// Probe: does execFile('git', args, {cwd}) on Windows resolve `git` from the CHILD cwd
// before PATH? If yes, git.ts / github.ts run an attacker-planted binary from any
// folder the user opens as a workspace.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const run = promisify(execFile)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-cwd-probe-'))

// A "malicious repo" that happens to contain git.exe / gh.exe / rg.exe.
fs.copyFileSync(process.execPath, path.join(dir, 'git.exe'))
fs.copyFileSync(process.execPath, path.join(dir, 'gh.exe'))

const probe = async (exe) => {
  try {
    const { stdout } = await run(exe, ['-e', 'console.log("HIJACKED:" + process.argv0)'], {
      cwd: dir,
      windowsHide: true,
      encoding: 'utf8'
    })
    return `stdout=${JSON.stringify(stdout.trim())}`
  } catch (e) {
    return `threw: ${String(e.message).split('\n')[0]}`
  }
}

console.log('cwd =', dir)
console.log('git ->', await probe('git'))
console.log('gh  ->', await probe('gh'))

// Control: same call with cwd elsewhere should hit the real git.
try {
  const { stdout } = await run('git', ['--version'], { cwd: os.homedir(), encoding: 'utf8' })
  console.log('control (cwd=home) git --version ->', stdout.trim())
} catch (e) {
  console.log('control threw:', String(e.message).split('\n')[0])
}

fs.rmSync(dir, { recursive: true, force: true })
