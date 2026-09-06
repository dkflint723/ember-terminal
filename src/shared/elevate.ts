/**
 * The PowerShell that raises an administrator window, built as a value.
 *
 * A process cannot elevate itself, so the only way across the integrity boundary is
 * `Start-Process -Verb RunAs`, and the only way to reach that is a PowerShell whose
 * whole program is one string. That string crosses two parsers on its way to the
 * elevated Ember, and the first version quoted for one of them.
 *
 * Here rather than beside the caller because running it means raising a real consent
 * prompt, which no test can answer — so the only part that can be held to account is
 * the part that builds it, and that part has to be reachable without an Electron
 * window. See scripts/test-elevate-command.mjs.
 */

/**
 * A string as one PowerShell single-quoted literal.
 *
 * Doubling is how PowerShell escapes a quote inside one, and single quotes are used
 * rather than double so that `$`, backtick and the rest are inert — an argument is
 * data, and nothing in it should be read as a variable to expand.
 */
export function powerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * A string as one argv token for the process that will be started.
 *
 * `Start-Process -ArgumentList` joins its elements with a single space and adds no
 * quoting of its own, and that joined line is what the elevated Ember parses as its
 * argv. So a path with a space in it — `C:\\Users\\First Last\\…`, which is an
 * ordinary Windows account name — arrived as two arguments.
 *
 * The failure that makes this worth two lines is not a crash. If only the
 * `--user-data-dir=` splits, the elevated Ember still launches; it just adopts a
 * truncated root, writes its "I am on screen" marker under the wrong directory, and
 * twenty-five seconds later the ordinary window announces that Windows never started
 * a window the user is looking at, and advises a reboot.
 *
 * The rule is CreateProcess's, not the shell's: backslashes are literal except in
 * the run immediately before a quote, where they double, and a trailing run doubles
 * because the closing quote follows it.
 */
export function commandLineArgument(value: string): string {
  const escaped = value
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, '$1$1')
  return `"${escaped}"`
}

/**
 * The whole command, both layers applied in the right order.
 *
 * Each argument is wrapped for the child first and quoted for PowerShell second,
 * because that is the order they are read in: PowerShell removes its own quoting to
 * hand `Start-Process` a list of strings, and those strings become the child's
 * command line verbatim.
 *
 * A declined prompt is classified inside PowerShell rather than out here, on
 * ERROR_CANCELLED (1223) rather than on the exit code alone: a missing executable, a
 * policy refusing to elevate, and a child killed by a signal all produce non-zero
 * too, and every one of them used to be reported to the user as "you declined". The
 * number rather than the message, because matching English text would be the same
 * bug again on a Windows that is not in English.
 */
export function buildAdminCommand(exe: string, args: string[]): string {
  const list = args.map((a) => powerShellLiteral(commandLineArgument(a))).join(',')
  return (
    `try { Start-Process -FilePath ${powerShellLiteral(exe)}` +
    (list ? ` -ArgumentList ${list}` : '') +
    ' -Verb RunAs -ErrorAction Stop } ' +
    'catch { if ($_.Exception.NativeErrorCode -eq 1223) { exit 2 } ' +
    'else { [Console]::Error.WriteLine($_.Exception.Message); exit 3 } }'
  )
}
