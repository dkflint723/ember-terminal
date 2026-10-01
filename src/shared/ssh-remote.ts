/**
 * Which machine a session is really on (audit R31).
 *
 * An ssh session looked like any other pane: the folder in the status bar was the
 * folder on this machine the session had been started from, which is not where any
 * command typed into it runs, and nothing said the pane was somewhere else at all.
 */

/** ssh's options that take a value, so the host is not mistaken for one of them. */
const TAKES_VALUE = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w', '-B'])

/**
 * The host an ssh profile connects to — from the profile's own word when it has one,
 * else read from `ssh … host …` — or null for a session on this machine.
 */
export function remoteHostOf(profile: { path: string; args: string[]; remote?: { host: string } } | undefined): string | null {
  if (!profile) return null
  if (profile.remote?.host) return profile.remote.host
  const program = (profile.path.split(/[\\/]/).pop() ?? '').toLowerCase()
  if (program !== 'ssh' && program !== 'ssh.exe') return null
  for (let i = 0; i < profile.args.length; i += 1) {
    const arg = profile.args[i]
    if (TAKES_VALUE.has(arg)) {
      i += 1
      continue
    }
    if (arg.startsWith('-')) continue
    // user@host: the host is what is shown.
    return arg.includes('@') ? arg.slice(arg.lastIndexOf('@') + 1) : arg
  }
  return null
}

/** The exit status ssh gives when the connection failed or was lost, as against the remote shell's. */
export const SSH_CONNECTION_LOST = 255

/** Seconds before each try at reconnecting, then it stops trying. */
export const RECONNECT_BACKOFF = [1, 2, 4, 8, 16, 30]

/** Tries in all, held or not, before it stops and leaves the pane to its Restart. */
export const RECONNECT_LIMIT = 20

/**
 * When to try again, or null to stop: the next wait in the backoff, starting over when
 * the last connection held — long enough, and with something typed into it.
 *
 * Time alone was not enough (QA): ssh also exits 255 for a password prompt left
 * unanswered until the server gives up (two minutes by default), or a server that
 * accepts and then cuts the connection, and each of those "held" for longer than the
 * cutoff, so it asked for the password again forever. Nobody typing means nobody is
 * there to have had a session, so the count goes on; and whatever happens, it stops
 * after RECONNECT_LIMIT tries.
 */
export function nextReconnect(
  attempt: number,
  heldForMs: number,
  seen: { typed: boolean; total: number } = { typed: true, total: 0 }
): { attempt: number; waitS: number; total: number } | null {
  if (seen.total >= RECONNECT_LIMIT) return null
  const fresh = heldForMs > 15_000 && seen.typed ? 0 : attempt
  if (fresh >= RECONNECT_BACKOFF.length) return null
  return { attempt: fresh + 1, waitS: RECONNECT_BACKOFF[fresh], total: seen.total + 1 }
}

/**
 * Whether what was last typed ends in ssh's own escape for closing the connection —
 * `~.` at the start of a line — which exits 255 like a lost connection, but on purpose.
 */
export const endsWithEscape = (typed: string): boolean => /(^|[\r\n])~\.$/.test(typed)
