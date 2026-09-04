import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
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
/**
 * One config line's arguments, the way ssh reads them.
 *
 * A value may be double-quoted so it can contain spaces, and an unquoted `#`
 * begins a comment that runs to the end of the line — OpenSSH splits these with
 * terminate_on_comment set. Splitting on whitespace instead turned
 * `Host build-box   # the CI box` into five hosts, four of them dead entries
 * called `#`, `the`, `CI` and `box`, each with a menu entry, a palette entry and
 * a settings entry that start a shell which immediately dies. And it never
 * offered `Host "my server"` at all.
 */
function args(text: string): string[] {
  const out: string[] = []
  let current = ''
  let quoting = false
  let started = false

  for (const ch of text) {
    if (ch === '"') {
      quoting = !quoting
      started = true
      continue
    }
    if (!quoting && ch === '#') break
    if (!quoting && (ch === ' ' || ch === '\t')) {
      if (started || current.length > 0) out.push(current)
      current = ''
      started = false
      continue
    }
    current += ch
  }
  if (started || current.length > 0) out.push(current)
  return out
}

/**
 * `*` and `?` against one name — the whole of the pattern language an Include
 * line uses in practice, and small enough not to want a dependency.
 */
function matches(pattern: string, name: string): boolean {
  let p = 0
  let n = 0
  let star = -1
  let mark = 0

  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p += 1
      n += 1
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p
      p += 1
      mark = n
    } else if (star >= 0) {
      p = star + 1
      mark += 1
      n = mark
    } else {
      return false
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1
  return p === pattern.length
}

/**
 * The files an Include pattern names.
 *
 * Relative paths are relative to `~/.ssh`, `~` is the home directory, and the
 * wildcards match within a single directory — which is the shape of every layout
 * people actually write.
 */
function included(pattern: string): string[] {
  let target = pattern
  if (target.startsWith('~')) target = join(homedir(), target.slice(1))
  if (!isAbsolute(target)) target = join(homedir(), '.ssh', target)

  const base = basename(target)
  if (!base.includes('*') && !base.includes('?')) return existsSync(target) ? [target] : []

  try {
    return readdirSync(dirname(target), { withFileTypes: true })
      .filter((entry) => entry.isFile() && matches(base, entry.name))
      .map((entry) => join(dirname(target), entry.name))
      .sort()
  } catch {
    // A directory that is not there includes nothing, which is not an error.
    return []
  }
}

/** Deep enough for any real layout, and shallow enough that a cycle cannot spin. */
const INCLUDE_DEPTH = 8

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

    for (const name of args(match[1])) {
      if (!name || name.startsWith('!')) continue
      if (name.includes('*') || name.includes('?')) continue
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/**
 * The hosts in a file and in everything it includes.
 *
 * `Include` is how real configs are organised — 1Password's agent setup, Colima,
 * corporate dotfiles, a `~/.ssh/config.d/*` directory — and ssh expands it before
 * matching any Host at all. Reading only the top file therefore offered nothing
 * whatever on those machines, with no diagnostic, so the feature did not look
 * partly right: it looked broken.
 */
function hostsIn(file: string, seen: Set<string>, depth: number): string[] {
  const key = file.toLowerCase()
  if (depth > INCLUDE_DEPTH || seen.has(key)) return []
  seen.add(key)

  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return []
  }

  const names = sshHosts(text)
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^include\s+(.+)$/i.exec(line)
    if (!match) continue

    for (const pattern of args(match[1])) {
      for (const file2 of included(pattern)) {
        for (const name of hostsIn(file2, seen, depth + 1)) {
          if (!names.includes(name)) names.push(name)
        }
      }
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

  return hostsIn(file, new Set(), 0).map((host) => ({
    id: `ssh-${host}`,
    name: host,
    path: 'ssh',
    args: [host],
    integration: 'none' as const,
    icon: 'ssh'
  }))
}
