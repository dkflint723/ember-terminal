import { pathKey } from '@shared/paths'
import { powerShellLiteral, bashLiteral } from '@shared/quote'
import { typeIntoTerminal } from '../terminal/typing'
import { mayRunAt } from './trust'
import { useStore, workspaceRoot } from './store'

/**
 * A project's own environment, activated in its sessions once the person has said so
 * (audit R32).
 *
 * A Python project's `.venv`, a Node project's `.nvmrc`, a `.tool-versions`, a `.env`:
 * each session had to be pointed at them by hand, every time. Now a session starting
 * in a trusted project folder that has any of them is offered to activate them — once
 * per folder, the answer remembered, so the next session in that folder is activated
 * without asking, or never offered again.
 *
 * Only in a trusted folder, since activating one runs that project's code. Only what
 * can act on the file is offered: `.nvmrc` when fnm is installed, `.tool-versions`
 * when mise is. Activation is a line typed into the shell at its prompt, through the
 * same rule as every command typed on the person's behalf, and the line names the
 * file, never what is in it: a .env's values are read by the shell, not typed.
 */
export type EnvKind = 'venv' | 'node' | 'tools' | 'dotenv'

export interface EnvFound {
  kind: EnvKind
  /** What it is, for the question: ".venv", ".env". */
  name: string
  /** The line that activates it in this shell. */
  line: string
}

const NAMES: Record<EnvKind, string> = { venv: '.venv', node: '.nvmrc', tools: '.tool-versions', dotenv: '.env' }

const join = (root: string, ...parts: string[]): string => [root.replace(/[\\/]+$/, ''), ...parts].join('\\')
const posix = (p: string): string => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d: string) => `/${d.toLowerCase()}`)

/** What this folder has that this shell can activate. */
export async function detectProjectEnv(root: string, shell: 'powershell' | 'bash'): Promise<EnvFound[]> {
  const exists = (...parts: string[]): Promise<boolean> => window.ember.pathExists(join(root, ...parts))
  const [venvPs, venvSh, nvmrc, toolVersions, dotenv, tools] = await Promise.all([
    exists('.venv', 'Scripts', 'Activate.ps1'),
    exists('.venv', 'Scripts', 'activate'),
    exists('.nvmrc'),
    exists('.tool-versions'),
    exists('.env'),
    window.ember.envTools()
  ])
  const found: EnvFound[] = []
  if (shell === 'powershell') {
    if (venvPs) found.push({ kind: 'venv', name: NAMES.venv, line: `& ${powerShellLiteral(join(root, '.venv', 'Scripts', 'Activate.ps1'))}` })
    if (nvmrc && tools.fnm) found.push({ kind: 'node', name: NAMES.node, line: 'fnm env --shell powershell | Out-String | Invoke-Expression; fnm use --install-if-missing' })
    if (toolVersions && tools.mise) found.push({ kind: 'tools', name: NAMES.tools, line: 'mise activate pwsh | Out-String | Invoke-Expression' })
    if (dotenv) {
      found.push({
        kind: 'dotenv',
        name: NAMES.dotenv,
        // Read by the shell from the file: the values never pass through what is typed.
        line:
          `Get-Content -LiteralPath ${powerShellLiteral(join(root, '.env'))} | ForEach-Object { ` +
          `if ($_ -match '^\\s*(?:export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$') { ` +
          // The name kept first: the -match that takes off quotes replaces $Matches.
          `$n = $Matches[1]; $v = $Matches[2]; if ($v -match '^([''"])(.*)\\1$') { $v = $Matches[2] }; ` +
          `Set-Item -LiteralPath ('Env:' + $n) -Value $v } }`
      })
    }
  } else {
    if (venvSh) found.push({ kind: 'venv', name: NAMES.venv, line: `source ${bashLiteral(posix(join(root, '.venv', 'Scripts', 'activate')))}` })
    if (nvmrc && tools.fnm) found.push({ kind: 'node', name: NAMES.node, line: 'eval "$(fnm env --shell bash)" && fnm use --install-if-missing' })
    if (toolVersions && tools.mise) found.push({ kind: 'tools', name: NAMES.tools, line: 'eval "$(mise activate bash)"' })
    if (dotenv) found.push({ kind: 'dotenv', name: NAMES.dotenv, line: `set -a; . ${bashLiteral(posix(join(root, '.env')))}; set +a` })
  }
  return found
}

/** Every pane this window has already considered, so a session is asked about once. */
const considered = new Set<string>()

/**
 * A session has started: activate what the folder's answer says to, and ask about
 * what it has not been asked about. Called once a pane's shell is at its first prompt.
 */
export async function considerProjectEnv(paneId: string): Promise<void> {
  if (considered.has(paneId)) return
  const s = useStore.getState()
  const pane = s.terminalPane(paneId)
  const root = workspaceRoot(s)
  // Not yet: the folder and where the shell is arrive a moment apart. Considered once
  // both are known, and only then — a session that starts elsewhere is not asked on cd.
  if (!pane || !root || !pane.cwd) return
  considered.add(paneId)
  if (s.settings.projectEnvironments === false) return
  if (pathKey(pane.cwd).replace(/\/$/, '') !== pathKey(root).replace(/\/$/, '')) return
  const integration = s.profiles.find((p) => p.id === pane.profileId)?.integration
  if (integration !== 'powershell' && integration !== 'bash') return
  if (!mayRunAt(root).trusted) return

  const found = await detectProjectEnv(root, integration)
  if (found.length === 0) return
  const choices = s.settings.projectEnvChoices?.[pathKey(root)] ?? {}
  const yes = found.filter((f) => choices[f.kind] === 'yes')
  const unasked = found.filter((f) => choices[f.kind] === undefined)

  const activate = (list: EnvFound[]): void => {
    if (list.length === 0) return
    const sent = typeIntoTerminal(paneId, list.map((f) => f.line).join(integration === 'powershell' ? '; ' : ' && '))
    if (!sent.ok) useStore.getState().setNotice('The project environment was not activated: that terminal was not at its prompt.', 'info')
  }
  const remember = (list: EnvFound[], answer: 'yes' | 'no'): void => {
    const all = useStore.getState().settings.projectEnvChoices ?? {}
    const mine = { ...(all[pathKey(root)] ?? {}) }
    for (const f of list) mine[f.kind] = answer
    void window.ember.setSettings({ projectEnvChoices: { ...all, [pathKey(root)]: mine } })
  }

  if (unasked.length === 0) {
    activate(yes)
    return
  }
  const names = unasked.map((f) => f.name).join(' and ')
  useStore.getState().setNotice(`This folder has ${names}. Activate ${unasked.length === 1 ? 'it' : 'them'} in this terminal, and in new ones here?`, 'info', [
    {
      label: 'Activate',
      run: () => {
        remember(unasked, 'yes')
        activate([...yes, ...unasked])
      }
    },
    {
      label: 'Not for this folder',
      run: () => {
        remember(unasked, 'no')
        activate(yes)
      }
    }
  ])
}
