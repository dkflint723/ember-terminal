/**
 * Shell-integration markers, and whether to believe them.
 *
 * Blocks are cut out of the byte stream at markers the shell prints, and until
 * now anything that could print could print those markers. `cat` a file holding
 * the right escape sequence, or run a program that echoes its argument, and the
 * pane's working directory changed, the command recorded against a block changed,
 * or a block opened that nothing would ever close. Nothing exotic is needed: the
 * sequence is seven printable characters and an escape.
 *
 * So each spawn gets a nonce — sixteen random bytes as hex, handed to the shell in
 * its environment and never written anywhere else — and Ember's own markers carry
 * it as their last field. Output can carry it too, of course, if it has seen it;
 * but output that has seen the environment of the shell it is running in is
 * already inside the trust boundary, and nothing here can help.
 *
 * The nonce is the LAST field because the scripts escape every `;` inside a value,
 * so splitting on `;` is unambiguous however strange the command or the path.
 *
 * Pure, and free of node and DOM imports, so the rules can be exercised directly.
 */

/** What a shell told us, once it has proved it was our shell that said it. */
export type EmberMarker =
  | { kind: 'ready' }
  | { kind: 'cwd'; path: string }
  | { kind: 'command'; text: string }
  | { kind: 'output' }
  | { kind: 'finished'; exitCode: number }

/** Thirty-two hex characters: sixteen bytes, as `randomBytes(16).toString('hex')` writes them. */
export function isNonce(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value)
}

/** Undo the escaping the integration scripts apply to values. */
export function unescapeField(value: string): string {
  return value
    .replace(/\\x3b/gi, ';')
    .replace(/\\x0a/gi, '\n')
    .replace(/\\x0d/gi, '\r')
    .replace(/\\x1b/gi, '\x1b')
    .replace(/\\x07/gi, '\x07')
    .replace(/\\\\/g, '\\')
}

/**
 * Read one OSC 633 payload, or refuse it.
 *
 * Null means "not ours": no nonce, the wrong nonce, or a shape this does not
 * know. Refusing is always safe — the pane carries on with the markers it does
 * believe — which is why every branch that cannot prove itself ends here.
 *
 * A plain `===` compares the nonce. Timing is not a concern: the attacker in this
 * story is a line of output, which gets one guess per line printed and learns
 * nothing from how long the comparison took.
 */
export function parseEmberMarker(data: string, nonce: string): EmberMarker | null {
  if (!isNonce(nonce)) return null
  const fields = data.split(';')
  if (fields.length < 2) return null
  const given = fields[fields.length - 1]
  if (given !== nonce) return null

  const body = fields.slice(0, -1)
  const kind = body[0]

  if (kind === 'Ready' && body.length === 1) return { kind: 'ready' }
  if (kind === 'C' && body.length === 1) return { kind: 'output' }
  if (kind === 'D') {
    const code = Number.parseInt(body[1] ?? '0', 10)
    return { kind: 'finished', exitCode: Number.isNaN(code) ? 0 : code }
  }
  if (kind === 'E') {
    const text = unescapeField(body.slice(1).join(';')).trim()
    return text.length === 0 ? null : { kind: 'command', text }
  }
  if (kind === 'P') {
    const field = body.slice(1).join(';')
    if (!field.startsWith('Cwd=')) return null
    const path = unescapeField(field.slice('Cwd='.length))
    return path.length === 0 ? null : { kind: 'cwd', path }
  }
  return null
}

/**
 * Whether a path a shell reported is one Ember may follow, by its shape alone.
 *
 * The string is judged before the filesystem is touched, because touching it is
 * the harm: a UNC path sends a blocking network round trip into the middle of the
 * UI, and the working directory is re-read by the git poll every few seconds, so a
 * single forged `\\\\evil\\share` becomes a permanent stall — and a request to a
 * host of somebody else's choosing, with this machine's credentials.
 *
 * Only a local drive path passes. A POSIX path is not rejected because it is
 * strange but because nothing on this side can check it: the integration scripts
 * report Windows paths through cygpath or wslpath for exactly that reason, and a
 * shell that cannot produce one keeps the directory it had.
 */
export function looksLocalDir(path: string): boolean {
  if (path.length === 0 || path.length > 4096) return false
  // UNC in either slash, before anything else looks at it.
  if (/^\\\\/.test(path) || /^\/\//.test(path)) return false
  // A drive letter and a separator: the one shape that can be handed to statSync.
  if (!/^[A-Za-z]:[\\/]/.test(path)) return false
  // Control characters have no business in a path and are how quoting gets broken.
  return !/[\x00-\x1f]/.test(path)
}
