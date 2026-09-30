/**
 * Where a proposed file would be written, said plainly, and whether that is somewhere
 * to think twice about (audit R27, SE-05).
 *
 * A path in a proposal is the model's text. It was joined to the terminal's folder as
 * it stood — `..` and all — and written wherever that led, and the diff bar showed
 * only the file's name. A proposal could plant a git hook, a PowerShell profile or a
 * program in the Startup folder, and accepting it looked the same as accepting an
 * edit to the file in front of you.
 */

/** A proposal's path, made absolute against a folder and with `.` and `..` taken out. */
export function resolveProposalPath(raw: string, cwd: string): string {
  const text = raw.trim()
  const absolute = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') ? text : `${cwd.replace(/[\\/]+$/, '')}\\${text}`
  const unc = absolute.startsWith('\\\\')
  const parts = absolute.replace(/\//g, '\\').split('\\')
  const out: string[] = []
  // A drive's root, or a UNC path's server and share, stays put however many `..` there are.
  const fixed = unc ? 4 : 1
  parts.forEach((part, i) => {
    if (i < fixed) {
      out.push(part)
      return
    }
    if (part === '' || part === '.') return
    if (part === '..') {
      if (out.length > fixed) out.pop()
      return
    }
    out.push(part)
  })
  const joined = out.join('\\')
  return /^[A-Za-z]:$/.test(joined) ? `${joined}\\` : joined
}

const key = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** Whether a path is the folder or inside it, without regard to case or slashes. */
export function insideFolder(folder: string, p: string): boolean {
  const f = key(folder)
  const k = key(p)
  return f.length > 0 && (k === f || k.startsWith(`${f}\\`))
}

/**
 * Places where a file does more than sit there: each one runs on its own the next
 * time something ordinary happens. Checked on the resolved path, without case.
 */
const RISKS: { test: RegExp; says: string }[] = [
  { test: /\\\.git\\hooks\\/, says: 'This is a git hook: it runs on its own when git does.' },
  { test: /\\\.git\\config$/, says: 'This is a repository’s git configuration, which can name programs git runs.' },
  {
    test: /\\documents\\(windows)?powershell\\[^\\]*\.ps1$/,
    says: 'This is a PowerShell profile or script in your Documents: a profile runs every time PowerShell starts.'
  },
  {
    test: /\\start menu\\programs\\startup\\/,
    says: 'This is in the Startup folder: it runs every time you sign in to Windows.'
  },
  { test: /\\\.ssh\\/, says: 'This is in your .ssh folder, which holds your keys and who may sign in as you.' },
  { test: /\\\.vscode\\(tasks|launch)\.json$/, says: 'This tells an editor what to run.' }
]

export interface ProposalAssessment {
  /** The path, resolved, to show in full. */
  path: string
  /** Outside the project the proposal was made in, or no project to be inside. */
  outside: boolean
  /** Why the place itself matters, when it does. */
  risk: string | null
}

export function assessProposal(path: string, workspace: string | null): ProposalAssessment {
  const k = key(path)
  const risk = RISKS.find((r) => r.test.test(k))?.says ?? null
  return { path, outside: !workspace || !insideFolder(workspace, path), risk }
}
