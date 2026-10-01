// The lines that activate a project's environment, run for real. Run: node scripts/test-env-lines.mjs
//
// A .env is data. The first bash loader sourced it, so `APP_NAME=My App` ran `App`
// and `N=$(touch x)` ran touch (found in QA). Each loader here is run in the real shell
// against a hostile .env — BOM, CRLF, spaces, both quotes, export, `=` in a value, a
// `$(…)` and a backtick — and must set what the file says, as text, and run nothing.
import './ts-resolve.mjs'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
const { dotenvLine } = await import('../src/shared/env-lines.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ember-envlines-')))
const lines = [
  '# a comment',
  'APP_NAME=My App',
  'GREETING="hello world"',
  "QUOTED='single q'",
  'RUN1=$(echo pwned > PWNED1)',
  'RUN2=`echo pwned > PWNED2`',
  'B = spaced',
  'export E=exported',
  'EQ=a=b',
  'TRAIL=keep   ',
  // Names that would run something, or move where programs are found: never set.
  'PROMPT_COMMAND=echo pwned > PWNED3',
  'PS1=$(echo pwned > PWNED4)> ',
  'PATH=C:\\evil',
  'EMBER_NONCE=forged'
]
fs.writeFileSync(path.join(root, '.env'), '\ufeff' + lines.join('\r\n') + '\r\n', 'utf8')
const want = { APP_NAME: 'My App', GREETING: 'hello world', QUOTED: 'single q', RUN1: '$(echo pwned > PWNED1)', RUN2: '`echo pwned > PWNED2`', B: 'spaced', E: 'exported', EQ: 'a=b', TRAIL: 'keep' }
const names = Object.keys(want)
const reserved = ['PROMPT_COMMAND', 'PS1', 'EMBER_NONCE']

const shells = []
const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => fs.existsSync(p))
// The reserved names are read back as values: `bash -c` is not interactive, so a
// prompt never runs, and what matters is that the file did not set them.
if (gitBash) shells.push({ name: 'Git Bash', exe: gitBash, kind: 'bash', show: [...names, ...reserved].map((n) => `printf '%s\\n' "${n}=$${n}"`).join('; ') })
for (const exe of ['powershell.exe', 'pwsh.exe']) {
  shells.push({ name: exe, exe, kind: 'powershell', show: [...names, ...reserved].map((n) => `Write-Output "${n}=$env:${n}"`).join('; ') })
}

for (const shell of shells) {
  for (const f of ['PWNED1', 'PWNED2', 'PWNED3', 'PWNED4']) fs.rmSync(path.join(root, f), { force: true })
  const script = `${dotenvLine(shell.kind, root)}; ${shell.show}`
  const args = shell.kind === 'bash' ? ['-c', script] : ['-NoProfile', '-Command', script]
  const run = spawnSync(shell.exe, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...Object.fromEntries(names.map((n) => [n, ''])) } })
  if (run.error) continue
  const got = Object.fromEntries((run.stdout ?? '').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  for (const n of names) check(`${shell.name}: ${n} is ${JSON.stringify(want[n])}`, got[n] === want[n], `${JSON.stringify(got[n])} ${run.stderr ? `(${run.stderr.trim().slice(0, 120)})` : ''}`)
  check(`${shell.name}: names that would run something are not set from it`, !(got.PROMPT_COMMAND ?? '').includes('pwned') && !(got.PS1 ?? '').includes('pwned') && got.EMBER_NONCE !== 'forged', JSON.stringify({ p: got.PROMPT_COMMAND, s: got.PS1, e: got.EMBER_NONCE }))
  check(`${shell.name}: nothing in the file ran`, !['PWNED1', 'PWNED2', 'PWNED3', 'PWNED4'].some((f) => fs.existsSync(path.join(root, f))))
}
check('at least one shell was there to run it', shells.length > 0)

fs.rmSync(root, { recursive: true, force: true })
console.log(`env lines: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
