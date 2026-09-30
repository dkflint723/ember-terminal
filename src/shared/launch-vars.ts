/**
 * Variables in a launch.json, resolved the way VS Code resolves them — or refused.
 *
 * Only five were ever substituted; `${env:…}`, `${userHome}`, `${input:…}` and the
 * rest passed through as literal text, so a configuration written for VS Code ran
 * with a program path of `${userHome}/…` and failed in a way that said nothing about
 * why (audit R16, DA-05). What can be known is resolved; what cannot — a
 * `${command:…}`, which is another extension's code, or an `${input:…}`, which asks
 * a question Ember has no way to put — refuses the launch, naming the variable.
 *
 * `${env:NAME}` is left for main, which holds the environment: the window has no
 * business reading it, and a value resolved there never passes through it.
 */
export interface LaunchContext {
  /** The open folder, or '' when there is none. */
  workspace: string
  /** The file in the active editor, if any. */
  file: string | null
  /** The caret's line in it, 1-based. */
  line?: number
  /** The selected text in it. */
  selection?: string
  /** The user's home folder. */
  home: string
}

export type Resolved = { ok: true; value: unknown } | { ok: false; unsupported: string[] }

const baseOf = (p: string): string => p.split(/[\\/]/).pop() ?? ''
const dirOf = (p: string): string => p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))
const extOf = (p: string): string => {
  const base = baseOf(p)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}
const relative = (root: string, p: string): string => {
  const norm = (s: string): string => s.replace(/\//g, '\\').replace(/\\+$/, '')
  const r = norm(root)
  const f = norm(p)
  return r && f.toLowerCase().startsWith(`${r.toLowerCase()}\\`) ? f.slice(r.length + 1) : f
}

function variable(name: string, ctx: LaunchContext): string | undefined {
  const file = ctx.file ?? ''
  switch (name) {
    case 'workspaceFolder':
    case 'workspaceRoot':
    case 'fileWorkspaceFolder':
      return ctx.workspace
    case 'workspaceFolderBasename':
      return baseOf(ctx.workspace)
    case 'file':
      return file
    case 'fileBasename':
      return baseOf(file)
    case 'fileBasenameNoExtension': {
      const base = baseOf(file)
      const ext = extOf(file)
      return ext ? base.slice(0, -ext.length) : base
    }
    case 'fileExtname':
      return extOf(file)
    case 'fileDirname':
      return file ? dirOf(file) : ''
    case 'fileDirnameBasename':
      return file ? baseOf(dirOf(file)) : ''
    case 'relativeFile':
      return file ? relative(ctx.workspace, file) : ''
    case 'relativeFileDirname':
      return file ? relative(ctx.workspace, dirOf(file)) : ''
    case 'cwd':
      return ctx.workspace
    case 'lineNumber':
      return ctx.line !== undefined ? String(ctx.line) : ''
    case 'selectedText':
      return ctx.selection ?? ''
    case 'userHome':
      return ctx.home
    case 'pathSeparator':
    case '/':
      return '\\'
    default:
      return undefined
  }
}

const PATTERN = /\$\{([^}]+)\}/g

/** Resolve every variable in a configuration, or say which ones cannot be. */
export function resolveLaunchVariables(config: unknown, ctx: LaunchContext): Resolved {
  const unsupported = new Set<string>()
  const walk = (value: unknown, depth: number): unknown => {
    // A launch.json nested past all reason passes through untouched past here.
    if (depth > 32) return value
    if (typeof value === 'string') {
      return value.replace(PATTERN, (whole, name: string) => {
        // For main, which holds the environment.
        if (name.startsWith('env:')) return whole
        const found = variable(name, ctx)
        if (found === undefined) {
          unsupported.add(whole)
          return whole
        }
        return found
      })
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1))
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, depth + 1)]))
    }
    return value
  }
  const value = walk(config, 0)
  return unsupported.size > 0 ? { ok: false, unsupported: [...unsupported] } : { ok: true, value }
}

/**
 * `${env:NAME}`, in main: the variable's value, or '' when it is not set, as VS Code
 * does. Names are matched without case, as Windows matches them.
 */
export function resolveEnvVariables(config: unknown, env: Record<string, string | undefined>): unknown {
  const lower = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v ?? '']))
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 32) return value
    if (typeof value === 'string') {
      return value.replace(/\$\{env:([^}]+)\}/g, (_whole, name: string) => lower.get(name.toLowerCase()) ?? '')
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, depth + 1))
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, depth + 1)]))
    }
    return value
  }
  return walk(config, 0)
}
