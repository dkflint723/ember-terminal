/**
 * Blocks for commands on another machine (audit R31, phase 2).
 *
 * An ssh session is a plain terminal because Ember's blocks come from a script it
 * puts into the shell it starts, and the shell here is on a host this app has no
 * business writing to. Unless the person says it may: for a host they have said yes
 * to, Ember types its bash integration into the remote shell once it is at a
 * prompt, each time they connect. Nothing is installed or written there; the script
 * lives in that one shell and is gone with it.
 *
 * Typing it is done in two steps, so the session does not fill with base64. A short
 * line is typed and seen: it turns echo off, says it is listening with a signed
 * marker, reads lines until a lone `.`, turns echo back on and runs what it read.
 * The script follows only once the marker has been seen — before then, the terminal
 * would still echo it — as base64 in short lines, so no terminal's line limit is
 * reached. The script then takes the visible line back out of the shell's history.
 *
 * Only bash. The line does nothing in a shell that is not (`[ -n "$BASH_VERSION" ]`),
 * so the marker never comes, and the host is not asked again.
 *
 * Pure: no node, no DOM, nothing imported, so the rules are tested directly.
 */

/** In the visible line and nowhere else, so the script can find that line in history. */
export const REMOTE_TOKEN = 'ember-remote-integration'

/** The marker the visible line prints once echo is off and it is reading. */
export const loadMarker = (nonce: string): string => `\x1b]633;Load;${nonce}\x07`

/**
 * The line typed and seen. Starts with a space, which keeps it out of history for a
 * shell set to ignore such lines; the script removes it where that is not set.
 */
export function loaderLine(nonce: string): string {
  return (
    ` [ -n "$BASH_VERSION" ] && { stty -echo; printf '\\033]633;Load;%s\\007' ${nonce}; __eb=; ` +
    `while IFS= read -r __el && [ "$__el" != . ]; do __eb="$__eb$__el"; done; stty echo; ` +
    // Run only if what was read is the script this session sent, which begins with its
    // nonce: keys pressed while it was being read are read too, and are not run (QA).
    `__es="$(printf %s "$__eb" | base64 -d 2>/dev/null)"; case "$__es" in "EMBER_NONCE=${nonce}"*) eval "$__es" ;; esac; ` +
    `unset __eb __el __es; } # ${REMOTE_TOKEN}\r`
  )
}

/**
 * The script, as it goes over: what the remote shell needs before Ember's own
 * script, the script inside a function — its guards `return`, which at the top level
 * of an `eval` does not stop anything — and the lines of base64 the visible line reads.
 */
export function payloadLines(script: string, nonce: string): string[] {
  const body = [
    // The nonce as a shell variable, read by the script and not exported: nothing
    // the person runs on that host inherits it.
    `EMBER_NONCE=${nonce}`,
    '__ember_remote=1',
    // The visible line out of history, if it went in: it is the newest entry, and it
    // carries the token.
    '__ember_h="$(HISTTIMEFORMAT= history 1 2>/dev/null)"',
    `case "$__ember_h" in *${REMOTE_TOKEN}*) history -d "$(printf %s "$__ember_h" | sed 's/^ *\\([0-9]*\\).*/\\1/')" 2>/dev/null ;; esac`,
    'unset __ember_h',
    '__ember_remote_load() {',
    script.replace(/\r\n/g, '\n'),
    '}',
    '__ember_remote_load',
    'unset -f __ember_remote_load',
    ''
  ].join('\n')
  const encoded = base64(body)
  const lines: string[] = []
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76))
  lines.push('.')
  return lines
}

/** UTF-8 to base64, without Buffer or btoa's Latin-1 limit, so this stays pure. */
function base64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += abc[(n >> 18) & 63] + abc[(n >> 12) & 63]
    out += i + 1 < bytes.length ? abc[(n >> 6) & 63] : '='
    out += i + 2 < bytes.length ? abc[n & 63] : '='
  }
  return out
}

/** Terminal output as the text it shows: escapes and control characters out. */
export function visibleText(data: string): string {
  return data
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]/g, '')
    .replace(/\x1b[=>78DEHMNOZc]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

/**
 * Whether the screen ends at what looks like a shell prompt: the last line, ending
 * in `$`, `#`, `%` or `>` with at most a space after. A password or passphrase
 * prompt ends in `:`, a host-key question in `?` — neither is typed into.
 */
export function looksLikePrompt(screenTail: string): boolean {
  const lines = visibleText(screenTail).split(/\r?\n|\r/)
  let last = lines.pop() ?? ''
  // A final newline leaves an empty last line: the prompt is not drawn yet.
  if (last.trim().length === 0) return false
  last = last.replace(/\s+$/, (s) => (s.length > 1 ? '' : s))
  if (last.length > 300) return false
  return /[$#%>] ?$/.test(last) && !/[:?] ?$/.test(last)
}
