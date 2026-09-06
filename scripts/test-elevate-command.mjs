// The PowerShell that raises an administrator window, held to account.
// Run: node scripts/test-elevate-command.mjs
//
// Running this command means raising a real consent prompt, drawn by Windows on the
// secure desktop, which no test can answer. So the only part that can be checked is
// the part that builds it — which is why it is a pure function in shared rather than
// six lines inside an IPC handler.
//
// The bug that made it worth extracting: each argument was quoted for PowerShell and
// nothing else. But `Start-Process -ArgumentList` joins its elements with a single
// space and adds no quoting, and that joined line is what the elevated Ember parses
// as its argv — so `C:\Users\First Last\…`, an ordinary Windows account name, arrived
// as two arguments.
//
// And the failure that follows is not a crash, which is what makes it expensive. If
// only the `--user-data-dir=` splits, the elevated Ember still launches; it adopts a
// truncated root, writes its "I am on screen" marker under the wrong directory, and
// twenty-five seconds later the ordinary window announces that Windows never started
// a window the user is looking straight at, and advises them to reboot.
import { buildAdminCommand, commandLineArgument, powerShellLiteral } from '../src/shared/elevate.ts'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

// --- one argv token, whatever is in it -----------------------------------------
check(
  'a path with a space stays one argument',
  commandLineArgument(String.raw`C:\Users\First Last\terminal`) ===
    String.raw`"C:\Users\First Last\terminal"`,
  commandLineArgument(String.raw`C:\Users\First Last\terminal`)
)
check(
  'an ordinary flag is left alone but still wrapped',
  commandLineArgument('--admin-window') === '"--admin-window"',
  commandLineArgument('--admin-window')
)
/*
 * The CreateProcess rule, which is not the shell's: a backslash is literal except in
 * the run immediately before a quote, where the run doubles.
 */
check(
  'a quote inside an argument is escaped, not left to end it',
  commandLineArgument('say "hi"') === String.raw`"say \"hi\""`,
  commandLineArgument('say "hi"')
)
check(
  'and the backslashes before that quote double',
  commandLineArgument(String.raw`a\"b`) === String.raw`"a\\\"b"`,
  commandLineArgument(String.raw`a\"b`)
)
/*
 * A trailing backslash doubles too, because the closing quote follows it — without
 * this, `--user-data-dir=C:\profile\` ends with an escaped quote and swallows the
 * rest of the command line.
 */
check(
  'a trailing backslash doubles so it cannot escape the closing quote',
  commandLineArgument('C:\\profile\\') === '"C:\\profile\\\\"',
  commandLineArgument('C:\\profile\\')
)

// --- and PowerShell's own layer, underneath it ---------------------------------
check(
  'PowerShell quoting doubles an apostrophe rather than ending the string',
  powerShellLiteral("O'Brien") === "'O''Brien'",
  powerShellLiteral("O'Brien")
)
/*
 * Single quotes rather than double, so that `$`, backtick and the rest are inert.
 * An argument is data; nothing in it should be read as a variable to expand.
 */
check(
  'and a dollar sign is not something to expand',
  powerShellLiteral('$env:USERPROFILE') === "'$env:USERPROFILE'",
  powerShellLiteral('$env:USERPROFILE')
)

// --- the whole command, both layers, in the right order -------------------------
const command = buildAdminCommand(String.raw`C:\Program Files\Ember\Ember.exe`, [
  String.raw`C:\src\my app`,
  String.raw`--user-data-dir=C:\Users\First Last\AppData\Roaming\ember-terminal`,
  '--admin-window'
])

check(
  'the executable is quoted for PowerShell',
  command.includes(String.raw`-FilePath 'C:\Program Files\Ember\Ember.exe'`),
  command.slice(0, 140)
)
/*
 * The heart of it: each element is wrapped for the child FIRST and quoted for
 * PowerShell SECOND, because that is the order they are read in — PowerShell strips
 * its own quoting to hand Start-Process a list of strings, and those strings become
 * the child's command line verbatim.
 */
check(
  'and every argument carries its own quotes into the child command line',
  command.includes(String.raw`'"C:\src\my app"'`) &&
    command.includes(
      String.raw`'"--user-data-dir=C:\Users\First Last\AppData\Roaming\ember-terminal"'`
    ) &&
    command.includes(`'"--admin-window"'`),
  command
)
check(
  'the arguments are comma-separated, as -ArgumentList requires',
  /-ArgumentList '[^']*'(,'[^']*'){2} /.test(command),
  command
)

/*
 * No arguments at all is a real case — a packaged run carries none but the flag, and
 * a caller could pass none. An empty `-ArgumentList` is a parameter error, so the
 * switch has to be left off rather than written empty.
 */
const bare = buildAdminCommand(String.raw`C:\Ember.exe`, [])
check('no arguments means no -ArgumentList at all', !bare.includes('-ArgumentList'), bare)
check('while the rest of the command still stands', bare.includes('-Verb RunAs'), bare)

// --- and the classification the notice depends on -------------------------------
/*
 * A declined prompt is an ordinary answer and everything else is a fault, and they
 * used to be told apart by "PowerShell exited non-zero" — which a missing
 * executable, a policy refusing to elevate and a signal all produce too. On the
 * number rather than the message, because matching English would be the same bug
 * again on a Windows that is not in English.
 */
check(
  'a declined prompt is recognised by its error code, not its wording',
  command.includes('NativeErrorCode -eq 1223') && command.includes('exit 2'),
  command
)
check(
  'anything else exits differently and says why',
  command.includes('exit 3') && command.includes('[Console]::Error.WriteLine'),
  command
)
check(
  'and the failure is raised rather than swallowed',
  command.includes('-ErrorAction Stop'),
  command
)

console.log('elevate command:', failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
