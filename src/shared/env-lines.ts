import { bashLiteral, powerShellLiteral } from './quote.ts'

/**
 * The lines typed to activate a project's environment (renderer state/project-env.ts),
 * kept apart from the window so they can be run for real in a test.
 *
 * A .env is data, and is read as data: every line that is NAME=value sets NAME to the
 * value as written, quotes taken off, and nothing in it runs. The first bash line
 * sourced the file — `set -a; . .env` — which made `APP_NAME=My App` run `App`, and a
 * `$(…)` in a value run whatever it held.
 */
export type ActivatingShell = 'powershell' | 'bash'

const join = (root: string, ...parts: string[]): string => [root.replace(/[\\/]+$/, ''), ...parts].join('\\')
/** Git Bash's spelling of a Windows path: `/c/work/x`. */
export const gitBashPath = (p: string): string => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)

/**
 * Names a .env does not get to set, though they look like any other: the shell runs
 * what is in them (PROMPT_COMMAND, PS1's expansions, BASH_ENV), where a program is
 * found (PATH, PATHEXT, COMSPEC, PSModulePath), how a line is split (IFS), or what
 * Ember's own integration reads (EMBER_*). Skipped, line by line, in both shells.
 */
const RESERVED_SH = 'PROMPT_COMMAND|PS[0-4]|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|CDPATH|HISTFILE|PATH|PATHEXT|COMSPEC|PSModulePath|BASH_*|EMBER_*'
const RESERVED_PS = '^(PROMPT_COMMAND|PS[0-4]|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|IFS|CDPATH|HISTFILE|PATH|PATHEXT|COMSPEC|PSModulePath|BASH_.*|EMBER_.*)$'

/** Load a dotenv file into this shell, reading it rather than running it. */
export function dotenvLine(shell: ActivatingShell, root: string): string {
  if (shell === 'powershell') {
    // The name kept first: the -match that takes off quotes replaces $Matches.
    return (
      `Get-Content -Encoding UTF8 -LiteralPath ${powerShellLiteral(join(root, '.env'))} | ForEach-Object { ` +
      `if ($_ -match '^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$') { ` +
      `$n = $Matches[1]; $v = $Matches[2]; if ($n -notmatch '${RESERVED_PS}') { if ($v -match '^([''"])(.*)\\1$') { $v = $Matches[2] }; ` +
      `Set-Item -LiteralPath ('Env:' + $n) -Value $v } } }`
    )
  }
  const file = bashLiteral(gitBashPath(join(root, '.env')))
  // Each line matched as text and exported as text: `export "$n=$v"` assigns, never evaluates.
  return (
    `while IFS= read -r l || [ -n "$l" ]; do l=\${l%$'\\r'}; l=\${l#$'\\xef\\xbb\\xbf'}; ` +
    `[[ $l =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue; ` +
    `n=\${BASH_REMATCH[2]}; v=\${BASH_REMATCH[3]}; case $n in ${RESERVED_SH}) continue;; esac; v=\${v%"\${v##*[![:space:]]}"}; ` +
    `if [[ \${#v} -ge 2 && ( $v == \\"*\\" || $v == \\'*\\' ) ]]; then v=\${v:1:\${#v}-2}; fi; ` +
    `export "$n=$v"; done < ${file}`
  )
}

/** Activate a Python virtual environment in this shell. */
export function venvLine(shell: ActivatingShell, root: string): string {
  return shell === 'powershell'
    ? `& ${powerShellLiteral(join(root, '.venv', 'Scripts', 'Activate.ps1'))}`
    : `source ${bashLiteral(gitBashPath(join(root, '.venv', 'Scripts', 'activate')))}`
}

export const NODE_LINE: Record<ActivatingShell, string> = {
  powershell: 'fnm env --shell powershell | Out-String | Invoke-Expression; fnm use --install-if-missing',
  bash: 'eval "$(fnm env --shell bash)" && fnm use --install-if-missing'
}

export const TOOLS_LINE: Record<ActivatingShell, string> = {
  powershell: 'mise activate pwsh | Out-String | Invoke-Expression',
  bash: 'eval "$(mise activate bash)"'
}
