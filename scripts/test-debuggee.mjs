// What F5 types into your shell when a debug adapter asks for a terminal.
// Run: node scripts/test-debuggee.mjs
//
// The debuggee used to be run in the pane's own shell, with the adapter's
// environment set there and deleted afterwards — deleting a NODE_OPTIONS of the
// user's own, and never deleting js-debug's after a Ctrl+C (audit R16, DA-01). It
// now runs in a child of that shell, given everything inside an encoded script.
// This holds the line to that: nothing of the environment in the clear, and a
// script that does what the adapter asked. verify-jsdebug checks the shell itself.
import { debuggeeLabel, debuggeeLine, debuggeeScript, encodePowerShell } from '../src/shared/debuggee.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const decode = (line) => {
  const b64 = /-EncodedCommand (\S+)$/.exec(line)?.[1] ?? ''
  const bytes = Buffer.from(b64, 'base64')
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8))
  return out
}

const req = {
  args: ['C:\\Program Files\\nodejs\\node.exe', 'C:\\work\\[draft]\\app.js'],
  cwd: 'C:\\work\\[draft]',
  env: {
    NODE_OPTIONS: '--require C:/js-debug/bootloader.js',
    SECRET_TOKEN: 'marker-secret-value',
    REMOVE_ME: null,
    'bad;key': 'x',
    MULTI: 'one\ntwo'
  }
}
const line = debuggeeLine(req)
const script = decode(line)

// --- what reaches the pane ---------------------------------------------------------
check('the line runs the pane’s own PowerShell as a child', line.startsWith('& (Get-Process -Id $PID).Path -NoProfile -EncodedCommand '), line.slice(0, 80))
check('and sets nothing in the pane’s shell', !/\$env:|Remove-Item|Set-Location/.test(line.replace(/-EncodedCommand \S+$/, '')), line)
check('no value from the environment appears in it', !line.includes('marker-secret-value') && !line.includes('bootloader'), line.slice(0, 120))
check('it is one line', !/[\r\n]/.test(line))

// --- what the child runs -----------------------------------------------------------
check('the child sets the environment', script.includes("$env:NODE_OPTIONS='--require C:/js-debug/bootloader.js'"), script)
check('removes a variable the adapter unsets', script.includes('Remove-Item Env:REMOVE_ME -ErrorAction SilentlyContinue'), script)
check('refuses a key that is not a plain name', !script.includes('bad;key'), script)
check('keeps a newline in a value from ending the command', script.includes("$env:MULTI='one two'"), script)
check('goes to the directory by its literal name', script.includes("Set-Location -LiteralPath 'C:\\work\\[draft]'"), script)
check('runs the program', script.includes("& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\work\\[draft]\\app.js'"), script)
check('and hands back its exit code', script.includes('if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }'), script.slice(-120))
check('and a failure when there was none to give — a program not found', script.endsWith('if ($ok) { exit 0 } else { exit 1 }'), script.slice(-60))
check('in that order', script.indexOf('$env:NODE_OPTIONS') < script.indexOf('Set-Location') && script.indexOf('Set-Location') < script.indexOf('& '))

// --- the encoding PowerShell expects -----------------------------------------------
check('encoded as UTF-16LE base64', encodePowerShell('é') === Buffer.from('é', 'utf16le').toString('base64'), encodePowerShell('é'))
check('nothing to run is nothing typed', debuggeeLine({ args: [] }) === null && debuggeeScript({ args: [] }) === null)

// --- the environment from a file, which the child deletes ---------------------------
const fromFile = debuggeeLine({ args: ['node', 'app.js'], envFile: 'C:\\Temp\\ember-debuggee-1.json' })
const fileScript = decode(fromFile)
check('reads the environment file, as UTF-8 in either PowerShell', fileScript.includes("Get-Content -Raw -Encoding UTF8 -LiteralPath 'C:\\Temp\\ember-debuggee-1.json' -ErrorAction Stop | ConvertFrom-Json"), fileScript.slice(0, 140))
check('and refuses to start the program when the file is gone', /catch \{ .*exit 1 \}/.test(fileScript), fileScript.slice(0, 260))
check('deletes it before anything else runs', fileScript.indexOf('Remove-Item -LiteralPath') < fileScript.indexOf('& '), fileScript)
check('sets only plain names from it', fileScript.includes("-match '^[A-Za-z_][A-Za-z0-9_]*$'"))

// --- the block's name -----------------------------------------------------------------
const label = debuggeeLabel(req)
check('the block is named for its program, as a comment', label === '# debugging: node.exe app.js', label)
check('with nothing from the environment in it', !label.includes('marker-secret-value'))
const flagged = debuggeeLabel({ args: ['C:\\node\\node.exe', '--experimental-network-inspection', '--enable-source-maps', 'C:\\work\\app.js', '--port', '80'] })
check('named for the script, past the runtime’s own flags', flagged === '# debugging: node.exe app.js', flagged)
check('and for the program alone when there is nothing else', debuggeeLabel({ args: ['C:\\tools\\run.exe', '--fast'] }) === '# debugging: run.exe', debuggeeLabel({ args: ['C:\\tools\\run.exe', '--fast'] }))

/*
 * --- run for real, where there is PowerShell ------------------------------------------
 *
 * The text above can be right and the shell still read it differently: Windows
 * PowerShell 5.1 read the file as the ANSI code page, and café arrived as cafÃ©. So
 * on Windows the script runs, in each PowerShell there is.
 */
if (process.platform === 'win32') {
  const { spawnSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-debuggee-test-'))
  const prog = path.join(dir, 'show.js')
  fs.writeFileSync(prog, 'console.log(JSON.stringify([process.env.EMBER_T1, process.env.EMBER_T2]))\n')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const envFile = path.join(dir, `env-${shell}.json`)
    fs.writeFileSync(envFile, JSON.stringify({ EMBER_T1: 'café 日本', EMBER_T2: 'true' }), 'utf8')
    const run = (file) =>
      spawnSync(shell, ['-NoProfile', '-EncodedCommand', encodePowerShell(debuggeeScript({ args: [process.execPath, prog], envFile: file }))], {
        encoding: 'utf8'
      })
    const first = run(envFile)
    if (first.error) continue // this PowerShell is not installed
    check(`${shell}: the values arrive as they were written`, (first.stdout ?? '').trim() === '["café 日本","true"]', (first.stdout ?? '').trim())
    check(`${shell}: and the file is gone after`, !fs.existsSync(envFile))
    const again = run(envFile)
    check(`${shell}: run again without the file, the program does not start`, again.status === 1 && !(again.stdout ?? '').includes('['), `${again.status} ${(again.stdout ?? '').trim()}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`debuggee: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
