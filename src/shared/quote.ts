/**
 * Saying a value to a shell so that it arrives as itself.
 *
 * Ember types commands into shells on the user's behalf — a `cd` from the directory
 * picker, a script from package.json, a test file's path, a value for a saved
 * command's blank — and every one of them used to be built by pasting the value into
 * the line. A folder cloned as `$(iex (irm …))` ran its code when someone walked
 * into it through the picker, because `cd "…"` is a double-quoted string and both
 * PowerShell and bash expand `$(…)` inside those. The one quoter that did use single
 * quotes doubled only the ASCII one, and PowerShell closes a string on any of four
 * typographic single quotes too — measured, on pwsh 7 and Windows PowerShell 5.1
 * alike, `'Bob’s Projects'` is a parse error — so an ordinary name like O’Brien
 * broke out of it.
 *
 * One quoter per shell, here, used by everything that types.
 */

/** The shells Ember knows how to quote for. */
export type ShellKind = 'powershell' | 'bash' | 'cmd'

/** A value this shell has no way to say, which is refused rather than guessed at. */
export class Unquotable extends Error {
  readonly value: string
  readonly shell: ShellKind

  constructor(value: string, shell: ShellKind) {
    super(`Command Prompt has no way to quote ${JSON.stringify(value)}.`)
    this.name = 'Unquotable'
    this.value = value
    this.shell = shell
  }
}

/**
 * PowerShell's single quotes: the ASCII one and the four typographic ones its
 * tokenizer also treats as the same character — ‘ ’ ‚ ‛.
 */
const POWERSHELL_SINGLE_QUOTES = /['\u2018\u2019\u201A\u201B]/g

/**
 * A single-quoted PowerShell string: nothing inside is expanded — not `$`, not a
 * backtick, not `$(…)` — and each single quote of any kind is doubled, which is how
 * PowerShell writes one inside such a string.
 */
export function powerShellLiteral(value: string): string {
  return `'${value.replace(POWERSHELL_SINGLE_QUOTES, (q) => q + q)}'`
}

/** A single-quoted POSIX shell string, closing and reopening around each `'`. */
export function bashLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * A double-quoted Command Prompt argument, where that can be said at all.
 *
 * cmd has no quoting that holds everything: `%NAME%` expands inside double quotes,
 * `!` does under delayed expansion, and a `"` inside a quoted argument cannot be
 * escaped. Anything with one of those, or a line break, is refused — better a
 * button that says it cannot than a command that runs something else.
 *
 * What cmd passes on is read by the program's own argument parser, where a run of
 * backslashes before a quote halves — so a trailing one, `"C:\dir\"`, escaped the
 * closing quote and swallowed the next argument. A trailing run is doubled.
 */
export function cmdLiteral(value: string): string {
  if (/[%!"\r\n]/.test(value)) throw new Unquotable(value, 'cmd')
  return `"${value.replace(/(\\+)$/, '$1$1')}"`
}

/** One value, quoted for this shell. Throws Unquotable for what cmd cannot say. */
export function quoteFor(shell: ShellKind, value: string): string {
  if (shell === 'powershell') return powerShellLiteral(value)
  if (shell === 'bash') return bashLiteral(value)
  return cmdLiteral(value)
}

/*
 * Characters that mean nothing to the shell, so a value made only of them reads
 * the same bare as quoted. The backslash is plain for PowerShell and cmd and an
 * escape for bash; nothing may lead with a character a shell treats specially at
 * the start of a word, like `-`, `~`, `@` or `=`. PowerShell also reads a bare word
 * that starts like a number as one — `1kb` arrives as 1024, `.5` as 0.5 — so there
 * it has to start with a letter.
 */
const BARE: Record<ShellKind, RegExp> = {
  powershell: /^[A-Za-z_][A-Za-z0-9_./\\:=+-]*$/,
  cmd: /^[A-Za-z0-9_./\\][A-Za-z0-9_./\\:=+-]*$/,
  bash: /^[A-Za-z0-9_./][A-Za-z0-9_./:=+-]*$/
}

/**
 * One value as one argument, quoted only when it has to be — so a block reads
 * `npm run build`, the way a person would type it, and a script called
 * `build; rm -rf ~` is still only ever the name of a script.
 */
export function argumentFor(shell: ShellKind, value: string): string {
  return value.length > 0 && BARE[shell].test(value) ? value : quoteFor(shell, value)
}

/** Each shell's quote characters, opening and closing alike, by the kind of string. */
const QUOTES: Record<ShellKind, { single: string; double: string }> = {
  powershell: { single: '\'\u2018\u2019\u201A\u201B', double: '"\u201C\u201D\u201E' },
  bash: { single: "'", double: '"' },
  // cmd has no single-quoted strings: ' is an ordinary character there.
  cmd: { single: '', double: '"' }
}

/** What can end or expand a string of each kind, and so may not be put inside one. */
const UNSAFE_INSIDE: Record<ShellKind, { single: RegExp; double: RegExp }> = {
  powershell: { single: /['\u2018\u2019\u201A\u201B\r\n]/, double: /["\u201C\u201D\u201E`$\r\n]/ },
  bash: { single: /['\r\n]/, double: /["\\`$\r\n]/ },
  cmd: { single: /[\r\n]/, double: /["%!\r\n]/ }
}

/**
 * A saved command with its blanks filled, or the name of the blank that could not
 * be filled safely.
 *
 * A blank is one value, and where it stands decides how it goes in:
 * - on its own, or inside a bare word like `--env={{env}}`, it is quoted for the
 *   shell when it needs to be, so a message with spaces and quotes in it arrives
 *   as one argument and `prod` still reads as `prod`;
 * - wrapped exactly in quotes, `"{{message}}"`, the quotes are taken as saying the
 *   same thing and replaced by the shell's own quoting, rather than doubled;
 * - inside a longer quoted string, `"fix: {{what}}"`, the saved command has already
 *   decided the quoting, so the value goes in as typed — provided nothing in it can
 *   end that string or expand inside it. Otherwise it is refused, because a value
 *   that breaks out of its string is a value that runs.
 */
export function fillBlanks(
  shell: ShellKind,
  command: string,
  values: Record<string, string>
): { command: string } | { refused: string } {
  const quotes = QUOTES[shell]
  const kindOf = (c: string | undefined): 'single' | 'double' | null =>
    c === undefined ? null : quotes.single.includes(c) ? 'single' : quotes.double.includes(c) ? 'double' : null
  /** Which kind of string is left open after this text, starting from `state`. */
  const after = (state: 'single' | 'double' | null, text: string): 'single' | 'double' | null => {
    let s = state
    for (const c of text) {
      const kind = kindOf(c)
      if (s === null && kind !== null) s = kind
      else if (s !== null && kind === s) s = null
    }
    return s
  }
  const blank = /\{\{\s*([^}]+?)\s*\}\}/g
  let out = ''
  let from = 0
  // Which kind of string the text so far leaves open, carried from blank to blank.
  let inside: 'single' | 'double' | null = null

  for (let m = blank.exec(command); m !== null; m = blank.exec(command)) {
    const name = m[1]
    if (!(name in values)) continue
    const value = values[name]
    const before = command.slice(from, m.index)
    const end = m.index + m[0].length

    // Scanned in two parts so the last character can be seen opening a string: a
    // blank is wrapped exactly when that character opens one and the character
    // after the blank closes it.
    const beforeLast = after(inside, before.slice(0, -1))
    inside = after(beforeLast, before.slice(-1))
    const wrapped = beforeLast === null && inside !== null && kindOf(command[end]) === inside

    try {
      if (wrapped) {
        // The opening quote is left out and the closing one skipped: the shell's
        // own quoting stands in for both.
        out += before.slice(0, -1) + quoteFor(shell, value)
        from = end + 1
        inside = null
        blank.lastIndex = from
        continue
      }
      if (inside === null) {
        // Bare when bare means the same, as everywhere else: `deploy prod`.
        out += before + argumentFor(shell, value)
      } else {
        if (UNSAFE_INSIDE[shell][inside].test(value)) return { refused: name }
        out += before + value
      }
    } catch {
      return { refused: name }
    }
    from = end
  }
  return { command: out + command.slice(from) }
}

/**
 * The command that moves a shell to a directory, with the path as data.
 *
 * `-LiteralPath` for PowerShell because a plain path is a wildcard pattern to
 * Set-Location, and a folder called `[draft]` would otherwise match something else
 * or nothing. `/d` for cmd because without it `cd` does not change drives.
 */
export function changeDirectoryCommand(shell: ShellKind, path: string): string {
  if (shell === 'powershell') return `Set-Location -LiteralPath ${powerShellLiteral(path)}`
  if (shell === 'bash') return `cd -- ${bashLiteral(path)}`
  return `cd /d ${cmdLiteral(path)}`
}

/**
 * Which of the shells above a profile speaks, or null when Ember cannot say.
 *
 * Integration names the dialect for the two that have one. Otherwise only the
 * Command Prompt is recognised, by its executable; a custom shell with no
 * integration could be anything, and quoting for the wrong shell is how a value
 * stops being a value.
 */
/**
 * A shell Ember can start but has no integration script for, by executable name.
 *
 * Named rather than inferred from the dialect: a profile for zsh can carry any
 * dialect its owner picked in Settings, and it is the executable that decides what
 * the script would land in. Returned as the plain name so a notice can use it.
 */
export function unsupportedShellOf(profile: { path: string } | undefined): string | null {
  if (!profile) return null
  const exe = profile.path.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? ''
  return exe === 'zsh' || exe === 'fish' || exe === 'nu' || exe === 'elvish' || exe === 'xonsh' ? exe : null
}

export function shellKindOf(profile: { integration: string; path: string } | undefined): ShellKind | null {
  if (!profile) return null
  if (profile.integration === 'powershell') return 'powershell'
  if (profile.integration === 'bash') return 'bash'
  const exe = profile.path.split(/[\\/]/).pop()?.toLowerCase()
  return exe === 'cmd.exe' || exe === 'cmd' ? 'cmd' : null
}
