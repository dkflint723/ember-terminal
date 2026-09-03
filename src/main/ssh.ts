import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ShellProfile } from '../shared/types.js'

/**
 * The hosts you already told ssh about.
 *
 * A terminal is judged on this, and Ember could technically do it already —
 * `ssh myserver` is a command like any other, and a custom profile can run it.
 * What it could not do is *know* about them, so every connection was something to
 * remember and type.
 *
 * They arrive as shell profiles rather than as a list of their own, which is the
 * whole trick: a profile is already something the new-session menu offers, the
 * command palette lists, the session file restores and the settings dropdown can
 * default to. Making a host a profile earns all of that without a line of new UI.
 *
 * `~/.ssh/config` is the source, and deliberately the only one. It is the file ssh
 * itself reads, so anything in it is already known to work, and nothing here has
 * to be kept in step with it. Ember never writes to it.
 */

/** Where OpenSSH looks, which is where a person will have put it. */
function configPath(): string {
  return join(homedir(), '.ssh', 'config')
}

/**
 * The `Host` names worth offering.
 *
 * Only the names: everything else — user, port, key, jump host — is ssh's
 * business, and reading it here would mean re-implementing a resolution order
 * that already exists and getting it subtly wrong. `ssh <name>` applies the whole
 * file, including anything this parser does not understand.
 *
 * Patterns are skipped. `Host *` is a settings block rather than somewhere to
 * connect, and `Host web-*` names a shape, not a machine — offering either would
 * put an entry in the menu that cannot be opened.
 */
export function sshHosts(text: string): string[] {
  const names: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    // `Host` is case-insensitive in ssh_config, and takes several names at once.
    const match = /^host\s+(.+)$/i.exec(line)
    if (!match) continue

    for (const name of match[1].split(/\s+/)) {
      const clean = name.trim()
      if (!clean || clean.startsWith('!')) continue
      if (clean.includes('*') || clean.includes('?')) continue
      if (!names.includes(clean)) names.push(clean)
    }
  }
  return names
}

/**
 * Those hosts as profiles, or none where there is no config to read.
 *
 * Integration is `none` on purpose. Ember's blocks come from a script it injects
 * into the shell it starts, and the shell here is on another machine — one this
 * app has no business writing to. So an ssh session is a plain terminal, which is
 * what the pane already says out loud when integration is absent.
 */
export function sshProfiles(): ShellProfile[] {
  const file = configPath()
  if (!existsSync(file)) return []

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    // Unreadable is the same as absent: this is a convenience, not a dependency.
    return []
  }

  return sshHosts(text).map((host) => ({
    id: `ssh-${host}`,
    name: host,
    path: 'ssh',
    args: [host],
    integration: 'none' as const,
    icon: 'ssh'
  }))
}
