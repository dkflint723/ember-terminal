/**
 * Which machine a session is really on (audit R31).
 *
 * An ssh session looked like any other pane: the folder in the status bar was the
 * folder on this machine the session had been started from, which is not where any
 * command typed into it runs, and nothing said the pane was somewhere else at all.
 */

/** ssh's options that take a value, so the host is not mistaken for one of them. */
const TAKES_VALUE = new Set(['-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w', '-B'])

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

/**
 * When to try again, or null to stop: the next wait in the backoff, starting over when
 * the last connection held long enough to have been a connection at all.
 */
export function nextReconnect(attempt: number, heldForMs: number): { attempt: number; waitS: number } | null {
  const fresh = heldForMs > 15_000 ? 0 : attempt
  if (fresh >= RECONNECT_BACKOFF.length) return null
  return { attempt: fresh + 1, waitS: RECONNECT_BACKOFF[fresh] }
}
