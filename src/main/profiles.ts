import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ShellProfile } from '../shared/types.js'

/**
 * Probe the machine for shells that are actually installed. We only surface
 * profiles whose executable exists so the launcher never offers a dead entry.
 */
export function detectProfiles(): ShellProfile[] {
  const found: ShellProfile[] = []
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows'
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const localAppData = process.env.LOCALAPPDATA ?? ''

  const candidates: (Omit<ShellProfile, 'id'> & { id: string })[] = [
    {
      id: 'pwsh',
      name: 'PowerShell',
      path: join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      args: ['-NoLogo'],
      integration: 'powershell',
      icon: 'pwsh'
    },
    {
      id: 'windows-powershell',
      name: 'Windows PowerShell',
      path: join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoLogo'],
      integration: 'powershell',
      icon: 'pwsh'
    },
    {
      id: 'cmd',
      name: 'Command Prompt',
      path: join(sysRoot, 'System32', 'cmd.exe'),
      args: [],
      integration: 'none',
      icon: 'cmd'
    },
    {
      id: 'git-bash',
      name: 'Git Bash',
      path: join(programFiles, 'Git', 'bin', 'bash.exe'),
      args: ['--login', '-i'],
      integration: 'bash',
      icon: 'bash'
    },
    {
      id: 'wsl',
      name: 'WSL',
      path: join(sysRoot, 'System32', 'wsl.exe'),
      args: [],
      integration: 'bash',
      icon: 'linux'
    }
  ]

  for (const c of candidates) {
    if (existsSync(c.path)) found.push(c)
  }

  // Windows Terminal ships pwsh via the Store in some installs; check the
  // per-user location as a fallback before giving up on PowerShell 7.
  if (!found.some((p) => p.id === 'pwsh') && localAppData) {
    const storePwsh = join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe')
    if (existsSync(storePwsh)) {
      found.unshift({
        id: 'pwsh',
        name: 'PowerShell',
        path: storePwsh,
        args: ['-NoLogo'],
        integration: 'powershell',
        icon: 'pwsh'
      })
    }
  }

  return found
}
