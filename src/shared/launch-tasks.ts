import { powerShellLiteral } from './quote.ts'
import { resolveLaunchVariables, type LaunchContext } from './launch-vars.ts'

/**
 * A launch configuration's `preLaunchTask`, turned into something a shell can run —
 * or a sentence saying why it will not be.
 *
 * It was ignored without a word, so a TypeScript project whose configuration builds
 * first launched the JavaScript from the last build, and nothing said that the
 * build had not run (audit R16, DA-05). The tasks Ember can run faithfully are
 * run: an npm script, a TypeScript build, and a `shell` or `process` task from
 * .vscode/tasks.json. The rest — a background task, which never finishes; a task
 * that depends on others; a type that belongs to some VS Code extension — are
 * refused with the reason, and the debugger does not start.
 *
 * What comes back is PowerShell source for the command alone. Where it runs and how
 * its exit comes back is shared/debuggee.ts's business.
 */
export interface ResolvedTask {
  /** The task's name, as the configuration gave it. */
  label: string
  /** PowerShell source that runs it. */
  script: string
  /** Where it runs: the task's own folder, or the workspace. */
  cwd: string
  /** The task's environment, if it sets one. */
  env?: Record<string, string>
}

export type TaskResult = { ok: true; task: ResolvedTask } | { ok: false; reason: string }

interface TaskEntry {
  label?: unknown
  type?: unknown
  command?: unknown
  args?: unknown
  script?: unknown
  path?: unknown
  tsconfig?: unknown
  option?: unknown
  options?: { cwd?: unknown; env?: unknown }
  dependsOn?: unknown
  isBackground?: unknown
  windows?: unknown
}

/** A task's Windows-only settings laid over the rest, as VS Code does on Windows. */
export function forWindows<T extends Record<string, unknown>>(entry: T): T {
  const { windows, linux: _l, osx: _o, ...rest } = entry as Record<string, unknown>
  void _l
  void _o
  if (windows && typeof windows === 'object' && !Array.isArray(windows)) {
    const over = windows as Record<string, unknown>
    // `options` is merged a level down: a Windows `options.env` does not throw away the cwd.
    const options =
      rest.options && typeof rest.options === 'object' && over.options && typeof over.options === 'object'
        ? { ...(rest.options as object), ...(over.options as object) }
        : (over.options ?? rest.options)
    return { ...rest, ...over, ...(options !== undefined ? { options } : {}) } as T
  }
  return rest as T
}

/**
 * One argument as a PowerShell expression. A `${env:NAME}` in it is read from the
 * environment when the task runs, which is where VS Code reads it from too; the
 * rest is literal, so nothing in a path is taken for syntax.
 */
export function powerShellArgument(value: string): string {
  const parts: string[] = []
  let last = 0
  for (const m of value.matchAll(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
    if (m.index > last) parts.push(powerShellLiteral(value.slice(last, m.index)))
    parts.push(`$env:${m[1]}`)
    last = m.index + m[0].length
  }
  if (last < value.length || parts.length === 0) parts.push(powerShellLiteral(value.slice(last)))
  return parts.length === 1 ? parts[0] : `(${parts.join(' + ')})`
}

const joinPath = (dir: string, rel: string): string =>
  /^(?:[A-Za-z]:[\\/]|\\\\)/.test(rel)
    ? rel
    : `${dir.replace(/[\\/]+$/, '')}\\${rel.replace(/^[\\/]+|[\\/]+$/g, '').replace(/\//g, '\\')}`

const quoted = (name: string): string => `‘${name}’`

/** The task a configuration names, from tasks.json or from the names VS Code gives on its own. */
export function resolveTask(name: string, tasksJson: unknown, ctx: LaunchContext): TaskResult {
  const listed = Array.isArray((tasksJson as { tasks?: unknown })?.tasks)
    ? ((tasksJson as { tasks: unknown[] }).tasks.filter((t) => t && typeof t === 'object') as TaskEntry[]).map(
        (t) => forWindows(t as Record<string, unknown>) as TaskEntry
      )
    : []

  const npm = /^npm: (.+?)(?: - (.+))?$/.exec(name)
  const tsc = /^tsc: (build|watch) - (.+)$/.exec(name)
  let entry: TaskEntry | undefined = listed.find((t) => t.label === name)
  // `npm: build` is also how VS Code names a tasks.json entry that gives no label.
  if (!entry && npm) entry = listed.find((t) => t.type === 'npm' && t.script === npm[1] && t.label === undefined)
  if (!entry && npm) entry = { type: 'npm', script: npm[1], ...(npm[2] ? { path: npm[2] } : {}) }
  if (!entry && tsc) entry = { type: 'typescript', tsconfig: tsc[2], ...(tsc[1] === 'watch' ? { option: 'watch' } : {}) }
  if (!entry) return { ok: false, reason: `There is no task named ${quoted(name)} in .vscode/tasks.json.` }

  const resolved = resolveLaunchVariables(entry, ctx)
  if (!resolved.ok) {
    return { ok: false, reason: `The task ${quoted(name)} uses ${resolved.unsupported.join(', ')}, which Ember cannot fill in.` }
  }
  const t = resolved.value as TaskEntry

  if (t.dependsOn !== undefined) {
    return { ok: false, reason: `The task ${quoted(name)} depends on other tasks, and Ember runs only a single task before debugging.` }
  }
  if (t.isBackground === true || t.option === 'watch') {
    return { ok: false, reason: `The task ${quoted(name)} runs in the background and never finishes, so the debugger would never start.` }
  }

  const root = ctx.workspace
  let cwd = root
  const optionsCwd = t.options?.cwd
  if (typeof optionsCwd === 'string' && optionsCwd) cwd = joinPath(root, optionsCwd)
  const args = Array.isArray(t.args) ? t.args.map((a) => (typeof a === 'string' ? a : String((a as { value?: unknown })?.value ?? a))) : []
  const argText = args.map(powerShellArgument).join(' ')

  let script: string
  switch (t.type) {
    case 'npm': {
      if (typeof t.script !== 'string' || !t.script) return { ok: false, reason: `The npm task ${quoted(name)} names no script.` }
      if (typeof t.path === 'string' && t.path) cwd = joinPath(root, t.path)
      script = `& npm run ${powerShellLiteral(t.script)}`
      break
    }
    case 'typescript': {
      const config = typeof t.tsconfig === 'string' && t.tsconfig ? t.tsconfig : 'tsconfig.json'
      script = `& npx --no-install tsc -p ${powerShellLiteral(config)}`
      break
    }
    case 'shell': {
      if (typeof t.command !== 'string' || !t.command.trim()) return { ok: false, reason: `The task ${quoted(name)} has no command.` }
      // A shell task's command is shell source, written for the shell it runs in —
      // on Windows, PowerShell — so it goes in as it is. Its arguments are values.
      script = argText ? `${t.command} ${argText}` : t.command
      break
    }
    case 'process': {
      if (typeof t.command !== 'string' || !t.command.trim()) return { ok: false, reason: `The task ${quoted(name)} has no command.` }
      script = `& ${powerShellArgument(t.command)}${argText ? ` ${argText}` : ''}`
      break
    }
    default:
      return {
        ok: false,
        reason: `The task ${quoted(name)} is of type ${quoted(String(t.type ?? 'none'))}, which Ember does not run: only npm, typescript, shell and process tasks.`
      }
  }

  const rawEnv = t.options?.env
  const env =
    rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)
      ? Object.fromEntries(Object.entries(rawEnv as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
      : undefined
  return { ok: true, task: { label: name, script, cwd, ...(env && Object.keys(env).length > 0 ? { env } : {}) } }
}
