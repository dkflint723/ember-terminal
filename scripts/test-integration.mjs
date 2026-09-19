// Which integration markers are believed, and which are refused.
// Run: node scripts/test-integration.mjs
//
// Any program that can print can print an escape sequence, so before this the
// pane's working directory and the command recorded against a block were both
// writable by output. Each case below is a marker Ember's own shell would send,
// paired with the forgery nearest to it — the same bytes with no nonce, the wrong
// nonce, or the nonce somewhere it does not count.
import { isNonce, looksLocalDir, parseEmberMarker, unescapeField } from '../src/shared/integration.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const N = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const OTHER = '00112233445566778899aabbccddeeff'
const parse = (data, nonce = N) => parseEmberMarker(data, nonce)

// --- what our own shell sends ------------------------------------------------------------
cases += 5
check('ready is read', parse(`Ready;${N}`)?.kind === 'ready', JSON.stringify(parse(`Ready;${N}`)))
check('output start is read', parse(`C;${N}`)?.kind === 'output', JSON.stringify(parse(`C;${N}`)))
const done = parse(`D;3;${N}`)
check('a finish carries its exit code', done?.kind === 'finished' && done.exitCode === 3, JSON.stringify(done))
const cmd = parse(`E;git status;${N}`)
check('a command is read', cmd?.kind === 'command' && cmd.text === 'git status', JSON.stringify(cmd))
const cwd = parse(`P;Cwd=C:\\projects\\ember;${N}`)
check('a directory is read', cwd?.kind === 'cwd' && cwd.path === 'C:\\projects\\ember', JSON.stringify(cwd))

// --- and the same thing said by anything else ----------------------------------------------
cases += 8
check('no nonce at all is refused', parse('Ready') === null)
check('a command with no nonce is refused', parse('E;rm -rf /') === null)
check('a directory with no nonce is refused', parse('P;Cwd=C:\\somewhere') === null)
check('the wrong nonce is refused', parse(`P;Cwd=C:\\somewhere;${OTHER}`) === null)
check('a nonce that is only a prefix is refused', parse(`Ready;${N.slice(0, 16)}`) === null)
// The nonce is the last field, so one buried mid-string proves nothing.
check('a nonce in the middle is refused', parse(`E;${N};echo hello`) === null)
check('an empty nonce is refused', parse('Ready;', '') === null)
check('a pane with no nonce believes nothing', parse(`Ready;${N}`, '') === null)

cases += 3
check('an unknown kind is refused', parse(`X;anything;${N}`) === null)
check('a P that is not Cwd is refused', parse(`P;Title=whatever;${N}`) === null)
check('an empty command is refused rather than recorded blank', parse(`E; ;${N}`) === null)

// --- escaping, which is what makes the last field unambiguous --------------------------------
cases += 3
const tricky = parse(`E;echo a\\x3bb;${N}`)
check(
  'a semicolon inside a command survives as one field',
  tricky?.kind === 'command' && tricky.text === 'echo a;b',
  JSON.stringify(tricky)
)
const deep = parse(`P;Cwd=C:\\\\a\\\\b;${N}`)
check('a path comes back with single backslashes', deep?.kind === 'cwd' && deep.path === 'C:\\a\\b', JSON.stringify(deep))
check('an escaped newline is put back', unescapeField('one\\x0atwo') === 'one\ntwo', JSON.stringify(unescapeField('one\\x0atwo')))

// --- what a nonce looks like ------------------------------------------------------------------
cases += 4
check('sixteen bytes of hex is a nonce', isNonce(N))
check('upper case is not', !isNonce(N.toUpperCase()))
check('too short is not', !isNonce(N.slice(0, 30)))
check('empty is not', !isNonce(''))

// --- and which directories may be followed ------------------------------------------------------
cases += 11
check('a drive path passes', looksLocalDir('C:\\Users\\dkfli\\projects'))
check('a drive path with forward slashes passes', looksLocalDir('D:/work/ember'))
check('a bare drive root passes', looksLocalDir('C:\\'))
check('a UNC path is refused', !looksLocalDir('\\\\evil\\share'))
check('a UNC path in forward slashes is refused', !looksLocalDir('//evil/share'))
check('a WSL UNC path is refused too', !looksLocalDir('\\\\wsl$\\Ubuntu\\home\\me'))
// Both spellings of it. `wslpath -w` hands out the newer one, so a check that knew
// only the older form would have gone on passing while the path it was written to
// refuse walked past it.
check(
  'and the newer spelling of the same thing',
  !looksLocalDir('\\\\wsl.localhost\\FedoraLinux-44\\home\\flint')
)
check('a relative path is refused', !looksLocalDir('projects\\ember'))
check('a POSIX path is refused, having nothing here to check it against', !looksLocalDir('/home/me'))
check('an empty path is refused', !looksLocalDir(''))
check(
  'a path carrying control characters is refused',
  !looksLocalDir(`C:\\a${String.fromCharCode(13)}b`)
)

console.log(
  failures === 0
    ? `integration markers: ${cases} cases PASS`
    : `integration markers: ${failures} checks FAILED of ${cases} cases`
)
process.exit(failures === 0 ? 0 : 1)
