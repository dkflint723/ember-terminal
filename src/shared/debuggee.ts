import { powerShellLiteral } from './quote.ts'

/**
 * The line typed into a shell pane to run a program a debug adapter asked to have
 * run in a terminal (`runInTerminal`).
 *
 * It used to set the adapter's environment in the user's own shell, change to its
 * directory, run the program, and then delete the variables it had set — which
 * deleted any the user had set themselves under the same name, NODE_OPTIONS above
 * all. And Ctrl+C stops a whole line of PowerShell, so after an interrupted run the
 * clean-up never ran: js-debug's bootloader stayed in NODE_OPTIONS, and every node
 * started from that shell afterwards tried to attach to a debugger. The directory
 * change was never undone either. (Audit R16, DA-01.)
 *
 * So the program runs in a child of the same PowerShell as the pane, and the
 * environment and the directory are set inside that child, where they end with it
 * whatever way it ends. The pane's shell sets nothing and so has nothing to clean up.
 *
 * The environment's values are not in the line at all. They can be secrets — a
 * launch.json's `env` is where a token goes — and a typed line is kept by Ember's
 * history, by Share, and by PSReadLine's own history file. Main writes them to a
 * temporary file and passes its path; the child reads it and deletes it first
 * thing. The line itself is encoded so that paths with any character in them pass
 * through PowerShell's parsing intact.
 *
 * No profile for the child: a debuggee should start the same way every time, and
 * the user's aliases are not the program's business.
 */
export interface DebuggeeRequest {
  args: string[]
  cwd?: string
  /** A JSON file of name to value (null to unset), read and deleted by the child. */
  envFile?: string
  /** The environment itself: for tests, and for adapters asked without main's file. */
  env?: Record<string, string | null>
}

/** A command line past this length is refused: Windows allows 32,767 characters. */
export const MOST_LINE = 30_000

/** A value said in PowerShell without being interpreted; newlines cannot end the line. */
const literal = (v: string): string => powerShellLiteral(v.replace(/[\r\n]/g, ' '))

/** The script the child runs: environment, directory, program, and its exit code back. */
export function debuggeeScript(req: DebuggeeRequest): string | null {
  const args = req.args.map(String)
  if (args.length === 0) return null
  return childScript(req, `& ${args.map(literal).join(' ')}`)
}

/** Environment, directory, then `run` — PowerShell source — and its exit code back. */
function childScript(req: { cwd?: string; envFile?: string; env?: Record<string, string | null> }, run: string): string {
  const parts: string[] = []
  if (req.envFile) {
    const file = literal(req.envFile)
    parts.push(
      // UTF-8 said outright: Windows PowerShell 5.1 reads a file without a BOM as
      // the ANSI code page, and a value of café arrived as cafÃ©.
      /*
       * And refused when it is not there. A stop in the moment before the child read
       * it deletes it, and so does running the same line again from PowerShell's
       * own history; either way the program would have started without the
       * debugger's hook or its configuration's environment, undebugged, with one
       * red line to say so.
       */
      `try { $e = Get-Content -Raw -Encoding UTF8 -LiteralPath ${file} -ErrorAction Stop | ConvertFrom-Json } catch { [Console]::Error.WriteLine('This debugging run has ended; its program is not started again on its own.'); exit 1 }`,
      `Remove-Item -LiteralPath ${file} -ErrorAction SilentlyContinue`,
      // Only a plain name: anything else is not an environment variable anyone meant.
      "foreach ($p in $e.PSObject.Properties) { if ($p.Name -match '^[A-Za-z_][A-Za-z0-9_]*$') { if ($null -eq $p.Value) { Remove-Item \"Env:$($p.Name)\" -ErrorAction SilentlyContinue } else { Set-Item \"Env:$($p.Name)\" ([string]$p.Value) } } }"
    )
  }
  for (const [key, value] of Object.entries(req.env ?? {})) {
    // Only a plain name: the key cannot be quoted the way a value can.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    parts.push(value === null ? `Remove-Item Env:${key} -ErrorAction SilentlyContinue` : `$env:${key}=${literal(String(value))}`)
  }
  // -LiteralPath: a plain path is a wildcard pattern to Set-Location.
  if (req.cwd) parts.push(`Set-Location -LiteralPath ${literal(String(req.cwd))}`)
  parts.push(run)
  /*
   * The program's exit code, and a failure when there was none to give: a program
   * that could not be found leaves $LASTEXITCODE unset, and `exit $LASTEXITCODE`
   * then reported success.
   */
  parts.push('$ok = $?', 'if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }', 'if ($ok) { exit 0 } else { exit 1 }')
  return parts.join('; ')
}

/** PowerShell's -EncodedCommand: the script as UTF-16LE, in base64. */
export function encodePowerShell(script: string): string {
  let binary = ''
  for (let i = 0; i < script.length; i += 1) {
    const code = script.charCodeAt(i)
    binary += String.fromCharCode(code & 0xff, code >> 8)
  }
  return btoa(binary)
}

/**
 * The line for the pane: the same PowerShell it is running, as a child, given the
 * script. `(Get-Process -Id $PID).Path` is whichever PowerShell the pane is —
 * Windows PowerShell or PowerShell 7 — so the child speaks the same dialect.
 */
export function debuggeeLine(req: DebuggeeRequest): string | null {
  const script = debuggeeScript(req)
  if (script === null) return null
  return `& (Get-Process -Id $PID).Path -NoProfile -EncodedCommand ${encodePowerShell(script)}`
}

/**
 * The line for a launch configuration's preLaunchTask: the task's own command, run
 * the same way — in a child, in the task's folder, with the task's environment from
 * a file — so a build that changes directory or sets a variable leaves the pane's
 * shell as it was, and its exit code is the block's.
 */
export function taskLine(req: { script: string; cwd?: string; envFile?: string }): string {
  return `& (Get-Process -Id $PID).Path -NoProfile -EncodedCommand ${encodePowerShell(childScript(req, req.script))}`
}

/** The task's block: named for the task, a comment, and not kept in history. */
export function taskLabel(label: string): string {
  return `# preLaunchTask: ${label.replace(/[\r\n]/g, ' ')}`
}

/**
 * What the block is called: a comment naming the program, which says what ran and
 * does nothing if it is run again — rerunning a debuggee without its debugger would
 * only have started it unattached. File names only, nothing from the environment.
 *
 * The program and the first thing after it that is not a flag: js-debug puts the
 * runtime's own flags ahead of the script — `--experimental-network-inspection`,
 * where the Node running it has one — and the block was named for that instead.
 */
export function debuggeeLabel(req: DebuggeeRequest): string {
  const base = (a: string): string => a.split(/[\\/]/).pop() ?? ''
  const [program, ...rest] = req.args.map(String)
  const script = rest.find((a) => !a.startsWith('-'))
  const names = [program, script].filter((a): a is string => a !== undefined).map(base)
  return `# debugging: ${names.join(' ').replace(/[\r\n]/g, ' ')}`
}
