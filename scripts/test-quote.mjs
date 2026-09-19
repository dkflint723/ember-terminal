// Values said to a shell arrive as themselves — asked of the real shells.
// Run: node scripts/test-quote.mjs
//
// A quoter is only as good as the shell's own reading of what it produced, so this
// does not compare strings with other strings. Every nasty value is quoted for a
// shell, handed to that shell, and read back: it has to come out exactly as it went
// in, and nothing inside it may run. The directory command is walked into real
// folders with hostile names, and the shell has to end up in that folder with no
// marker file anywhere.
//
// A shell that is not installed is skipped and said so, and fails under
// EMBER_STRICT like every other skip.
import {
  Unquotable,
  argumentFor,
  changeDirectoryCommand,
  fillBlanks,
  quoteFor,
  shellKindOf,
  unsupportedShellOf
} from '../src/shared/quote.ts'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
const skipped = []

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-quote-'))
// The files an injected command would make — by exact name, since one of the
// hostile folders has the word in its own name.
const INJECTED = new Set(['marker-ps', 'marker-sh', 'marker-cd'])
const markers = () =>
  fs.readdirSync(work, { recursive: true }).filter((f) => INJECTED.has(path.basename(String(f))))

/** Values that have broken a quoter somewhere, or would. */
const VALUES = [
  'plain',
  'two words',
  'a$HOME',
  'a$(New-Item -ItemType File marker-ps)b',
  'a$(touch marker-sh)b',
  'a`nb',
  "it's",
  'Bob\u2019s Projects',
  '\u2018left\u2019 and \u201Alow\u201B',
  'say "hi"',
  'a; b',
  'a && b',
  'a | b',
  '[draft]',
  'caf\u00e9 \u65e5\u672c',
  'C:\\dir\\',
  '',
  '50% off',
  'bang!'
]

const SHELLS = {
  pwsh: { exe: 'pwsh', kind: 'powershell' },
  powershell: { exe: 'powershell', kind: 'powershell' },
  bash: { exe: path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), kind: 'bash' },
  cmd: { exe: process.env.ComSpec ?? 'cmd.exe', kind: 'cmd' }
}
const present = (exe) => spawnSync(exe, exe.endsWith('cmd.exe') ? ['/d', '/c', 'exit 0'] : ['-c', 'exit 0'], { windowsHide: true }).status === 0

// --- the quoters, against the shells that read them --------------------------------
for (const [name, shell] of Object.entries(SHELLS)) {
  if (!present(shell.exe)) {
    skipped.push(name)
    continue
  }
  const sayable = []
  for (const value of VALUES) {
    try {
      sayable.push({ value, quoted: quoteFor(shell.kind, value) })
    } catch (err) {
      // Only cmd refuses, and only what it cannot say.
      check(`${name} refuses only what it has to`, shell.kind === 'cmd' && err instanceof Unquotable && /[%!"]/.test(value), value)
    }
  }
  let heard = null
  if (shell.kind === 'powershell') {
    // Each literal is one element of an array, handed back as JSON.
    const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; @(${sayable.map((s) => s.quoted).join(', ')}) | ConvertTo-Json -Compress`
    const r = spawnSync(shell.exe, ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: work, encoding: 'utf8', windowsHide: true })
    try {
      heard = JSON.parse(r.stdout)
    } catch {
      check(`${name} parses the quoted values`, false, (r.stderr || r.stdout).split('\n')[0])
    }
  } else if (shell.kind === 'bash') {
    const script = `printf '%s\\0' ${sayable.map((s) => s.quoted).join(' ')}`
    const r = spawnSync(shell.exe, ['-c', script], { cwd: work, encoding: 'utf8', windowsHide: true })
    heard = r.stdout.split('\0').slice(0, -1)
  } else {
    // cmd hands the line to a program, whose own argv rules undo the quoting —
    // which is what happens to every argument a cmd user types.
    const echo = `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))"`
    const r = spawnSync(shell.exe, ['/d', '/s', '/c', `"${echo} ${sayable.map((s) => s.quoted).join(' ')}"`], {
      cwd: work,
      encoding: 'utf8',
      windowsHide: true,
      windowsVerbatimArguments: true
    })
    try {
      heard = JSON.parse(r.stdout)
    } catch {
      check(`${name} passes the quoted values`, false, (r.stderr || r.stdout).split('\n')[0])
    }
  }
  if (heard) {
    // PowerShell's JSON of a one-element array is the element; there are many here.
    check(`${name} hears as many values as it was given`, heard.length === sayable.length, `${heard.length} of ${sayable.length}`)
    sayable.forEach((s, i) => {
      check(`${name} hears ${JSON.stringify(s.value)} as itself`, heard[i] === s.value, `${JSON.stringify(heard[i])} from ${s.quoted}`)
    })
  }
  check(`nothing quoted for ${name} ran`, markers().length === 0, markers().join(', '))
}

// --- a saved command's blanks, wherever they stand --------------------------------------
// Alone, inside a longer quoted string, wrapped exactly in quotes, and in the middle
// of a bare word — each filled for a real shell and read back as the arguments it
// became. The first value tries to run something from every one of them.
const BLANKS = {
  powershell: {
    template: `[Console]::OutputEncoding = [Text.Encoding]::UTF8; @(Write-Output {{a}} "<{{b}}>" '[{{c}}]' "{{d}}" pre{{e}}post) | ConvertTo-Json -Compress`,
    values: { a: `it's $(New-Item -ItemType File marker-ps) "b"`, b: 'hello world', c: 'plain words', d: 'say "hi" & $(x)', e: 'mid dle' }
  },
  bash: {
    template: `printf '%s\\0' {{a}} "<{{b}}>" '[{{c}}]' "{{d}}" pre{{e}}post`,
    values: { a: `it's $(touch marker-sh) "b"`, b: 'hello world', c: 'plain words', d: 'say "hi" & $(x)', e: 'mid dle' }
  },
  cmd: {
    template: `"${process.execPath}" -e "process.stdout.write(JSON.stringify(process.argv.slice(1)))" {{a}} "<{{b}}>" "{{d}}" pre{{e}}post`,
    values: { a: "it's a & b", b: 'hello world', d: 'a & b | c', e: 'mid dle' }
  }
}
for (const [name, shell] of Object.entries(SHELLS)) {
  if (skipped.includes(name)) continue
  const { template, values } = BLANKS[shell.kind]
  const filled = fillBlanks(shell.kind, template, values)
  check(`${name} fills every blank`, 'command' in filled, JSON.stringify(filled))
  if (!('command' in filled)) continue
  const expected =
    shell.kind === 'cmd'
      ? [values.a, `<${values.b}>`, values.d, `pre${values.e}post`]
      : [values.a, `<${values.b}>`, `[${values.c}]`, values.d, `pre${values.e}post`]
  let got = null
  if (shell.kind === 'powershell') {
    const r = spawnSync(shell.exe, ['-NoProfile', '-NonInteractive', '-Command', filled.command], { cwd: work, encoding: 'utf8', windowsHide: true })
    try {
      got = JSON.parse(r.stdout)
    } catch {
      check(`${name} runs the filled command`, false, (r.stderr || r.stdout).split('\n')[0])
    }
  } else if (shell.kind === 'bash') {
    const r = spawnSync(shell.exe, ['-c', filled.command], { cwd: work, encoding: 'utf8', windowsHide: true })
    got = r.stdout.split('\0').slice(0, -1)
  } else {
    const r = spawnSync(shell.exe, ['/d', '/s', '/c', `"${filled.command}"`], { cwd: work, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    try {
      got = JSON.parse(r.stdout)
    } catch {
      check(`${name} runs the filled command`, false, (r.stderr || r.stdout).split('\n')[0])
    }
  }
  if (got) {
    check(`${name} hears each blank as the value given`, JSON.stringify(got) === JSON.stringify(expected), `${JSON.stringify(got)} from ${filled.command}`)
  }
  check(`nothing in ${name}'s blanks ran`, markers().length === 0, markers().join(', '))
}
// A value that would end the string the saved command put it in is refused.
const refused = (shell, template, value) => {
  const r = fillBlanks(shell, template, { v: value })
  return 'refused' in r && r.refused === 'v'
}
check('PowerShell refuses a quote inside a double-quoted blank', refused('powershell', 'git commit -m "fix: {{v}}"', 'a"b'))
check('and an expansion', refused('powershell', 'git commit -m "fix: {{v}}"', '$(Remove-Item x)'))
check('and a typographic double quote', refused('powershell', 'echo "x {{v}}"', 'a”b'))
check('bash refuses a quote inside a single-quoted blank', refused('bash', "echo 'x {{v}}'", "it's"))
check('cmd refuses what it cannot quote at all', refused('cmd', 'echo "{{v}}"', '50% off'))
check(
  'a safe value inside a string goes in as typed',
  JSON.stringify(fillBlanks('powershell', 'git commit -m "fix: {{v}}"', { v: 'the typo' })) ===
    JSON.stringify({ command: 'git commit -m "fix: the typo"' })
)
check(
  'an unknown blank is left for the person to see',
  JSON.stringify(fillBlanks('bash', 'deploy {{env}} {{other}}', { env: 'prod' })) ===
    JSON.stringify({ command: 'deploy prod {{other}}' }),
  JSON.stringify(fillBlanks('bash', 'deploy {{env}} {{other}}', { env: 'prod' }))
)

// --- bare where bare means the same ---------------------------------------------------
check('an ordinary name stays bare', argumentFor('powershell', 'build') === 'build')
check('a path stays bare', argumentFor('bash', 'src/app.test.ts') === 'src/app.test.ts')
check('a name with a separator is quoted', argumentFor('powershell', 'build; rm -rf ~') === "'build; rm -rf ~'")
check(
  'a PowerShell word that reads as a number is quoted',
  argumentFor('powershell', '1kb') === "'1kb'" && argumentFor('powershell', '.5') === "'.5'",
  `${argumentFor('powershell', '1kb')} ${argumentFor('powershell', '.5')}`
)
check('a leading dash is quoted', argumentFor('bash', '-rf') === "'-rf'")
check('an empty value is still one argument', argumentFor('bash', '') === "''")

// --- walking into folders with hostile names ---------------------------------------------
const FOLDERS = ['a$(New-Item marker-cd)b', 'Bob\u2019s Projects', '[draft]', "it's", 'two words', '50% off']
for (const name of FOLDERS) fs.mkdirSync(path.join(work, name))
const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

for (const [name, shell] of Object.entries(SHELLS)) {
  if (skipped.includes(name)) continue
  for (const folder of FOLDERS) {
    const target = path.join(work, folder)
    let command
    try {
      command = changeDirectoryCommand(shell.kind, target)
    } catch (err) {
      check(`${name} refuses only a folder it cannot say`, shell.kind === 'cmd' && err instanceof Unquotable, folder)
      continue
    }
    let where = ''
    if (shell.kind === 'powershell') {
      const r = spawnSync(shell.exe, ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${command}; (Get-Location).ProviderPath`], { cwd: work, encoding: 'utf8', windowsHide: true })
      where = r.stdout.trim()
    } else if (shell.kind === 'bash') {
      const r = spawnSync(shell.exe, ['-c', `${command} && pwd -W`], { cwd: work, encoding: 'utf8', windowsHide: true })
      where = r.stdout.trim()
    } else {
      // Reported by node, not by cmd's own `cd`: cmd writes a pipe in the console's
      // code page, where ’ prints as ' and the folder it is in reads as another.
      const report = `"${process.execPath}" -e "process.stdout.write(process.cwd())"`
      const r = spawnSync(shell.exe, ['/d', '/s', '/c', `"${command} && ${report}"`], { cwd: work, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
      where = r.stdout.trim()
    }
    check(`${name} walks into ${JSON.stringify(folder)}`, same(where, target), `${JSON.stringify(where)} via ${command}`)
  }
  check(`walking in with ${name} ran nothing`, markers().length === 0, markers().join(', '))
}

// --- which shell a profile speaks ---------------------------------------------------------
check('PowerShell integration speaks PowerShell', shellKindOf({ integration: 'powershell', path: 'x' }) === 'powershell')
check('bash integration speaks bash', shellKindOf({ integration: 'bash', path: 'x' }) === 'bash')
check('the Command Prompt is recognised by its executable', shellKindOf({ integration: 'none', path: 'C:\\Windows\\System32\\cmd.exe' }) === 'cmd')
check('an unknown shell is not guessed at', shellKindOf({ integration: 'none', path: 'C:\\tools\\nu.exe' }) === null)

// --- and the shells there is no script for, named by their executable --------------
check('zsh is named as a shell there is no script for', unsupportedShellOf({ path: 'C:\\msys64\\usr\\bin\\zsh.exe' }) === 'zsh')
check('and fish, wherever it lives', unsupportedShellOf({ path: '/usr/bin/fish' }) === 'fish')
check('bash is not one of them', unsupportedShellOf({ path: 'C:\\Program Files\\Git\\bin\\bash.exe' }) === null)
check('nor is a shell nobody has heard of', unsupportedShellOf({ path: 'C:\\tools\\mysh.exe' }) === null)

fs.rmSync(work, { recursive: true, force: true })
if (skipped.length > 0) console.log(`shells not installed, not asked: ${skipped.join(', ')}`)
const strictSkip = skipped.length > 0 && process.env.EMBER_STRICT
console.log('shell quoting:', failures === 0 && !strictSkip ? 'PASS' : 'FAIL')
process.exit(failures === 0 && !strictSkip ? 0 : 1)
