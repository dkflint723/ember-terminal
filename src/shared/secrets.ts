/**
 * Detection of prompts that are asking for a secret.
 *
 * Windows ConPTY exposes no terminal echo flag, so there is no authoritative
 * signal that a program has turned echoing off — it has to be inferred from the
 * prompt text. That makes precision the priority: masking ordinary input is worse
 * than failing to mask, because the user loses the ability to see what they typed
 * and has no way to know why.
 *
 * Kept free of DOM and xterm imports so it can be exercised directly by a test.
 */

/** Escape sequences and control bytes, so matching sees what a human reads. */
export const ANSI_SEQUENCE =
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])|[\x00-\x08\x0b\x0c\x0e-\x1f]/g

/**
 * Anchored to the end of a line: an open prompt is always the last thing on it.
 * The bounded `[^\n]{0,80}` lets wording like "password for 'https://…'" through
 * without allowing a match to span an unrelated sentence.
 */
const SECRET_PROMPT =
  /(?:password|passphrase|passcode|\bpin\b|verification code|one-time code|authentication code|2fa code)[^\n]{0,80}:[ \t]*$/i

/** Prompts that merely mention a secret without asking for one right now. */
const NOT_A_PROMPT = [
  // Failure and status lines frequently end in a colon before a reason.
  /(?:incorrect|invalid|wrong|bad|failed|failure|error|denied|expired|mismatch)[^\n]{0,40}$/i,
  // Documentation and help output. Anchored to the start of the line: these words
  // lead a line when they are labels, and appear mid-line in ordinary text — an
  // unanchored "example" matches any host called example.com, which would leave a
  // genuine ssh password prompt unmasked.
  /^\s*(?:usage|example|note|warning|hint|see also|description)\b/i,
  // Prose about passwords rather than a request for one.
  /(?:changed|updated|saved|stored|copied|generated|created|reset)[^\n]{0,30}:[ \t]*$/i
]

export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, '')
}

/**
 * Credentials passed inline on a command line. Persistent history is forever, so
 * these commands are dropped rather than stored — a leak here outlives the session
 * that caused it, and the user has no reason to expect a shell command to be
 * archived to disk.
 *
 * Deliberately conservative: it only matches shapes that carry a value, so
 * `git push` and `--password-stdin` (which is the safe form) are kept.
 */
const INLINE_SECRET = [
  // --password=x, --token x, -p x, PASSWORD=x, api_key: x
  /(?:--?)(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth)(?:[=:]|\s+)\S/i,
  /\b(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN)=\S/,
  // mysql/psql style flag with the value attached: -pMyPassword
  /(?:^|\s)-p\S{3,}/,
  // Bearer tokens and basic-auth URLs.
  /Authorization:\s*(?:Bearer|Basic)\s+\S/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i
]

/**
 * Credential shapes that identify themselves wherever they appear.
 *
 * Separate from INLINE_SECRET because those need a surrounding flag to be
 * recognised — `--token x` — whereas these are self-describing, which is what
 * makes them safe to look for in a wall of command output. Nothing here matches on
 * length or entropy alone: a rule like "40 hex characters" would redact commit
 * hashes and checksums, which is worse than useless in a terminal.
 */
const KNOWN_SECRET = [
  // Anthropic, OpenAI, GitHub, Slack, Google, AWS.
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Anything a flag or an assignment marks as a credential, value only.
  /((?:--?)(?:password|passwd|pwd|token|secret|api[-_]?key|access[-_]?key|auth)(?:[=:]|\s+))\S+/gi,
  /\b((?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN)=)\S+/g,
  /(Authorization:\s*(?:Bearer|Basic)\s+)\S+/gi,
  // The credentials in a URL, keeping the rest of it readable.
  /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(?=@)/gi,
  // Private keys, which are worth removing wholesale rather than by line.
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g
]

/**
 * Replace credentials in text that is about to be stored.
 *
 * Command output goes into a history database that outlives the session, and a
 * command like `aws configure list` or a curl that echoes its own headers puts a
 * live key on screen without the command line ever mentioning one. Redacting is
 * the right trade here rather than refusing to store: the output is what makes
 * history searchable, and losing a line is better than keeping a key.
 *
 * Where a pattern captures its label, the label is kept — `TOKEN=[redacted]` says
 * far more about what happened than a blank space does.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const pattern of KNOWN_SECRET) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}[redacted]` : '[redacted]'
    )
  }
  return out
}

/** True when a command line appears to carry a credential in the clear. */
export function containsInlineSecret(command: string): boolean {
  // `--password-stdin` and friends read the secret from a pipe; nothing to leak.
  if (/--(?:password|token|secret)-stdin\b/i.test(command)) return false
  return INLINE_SECRET.some((re) => re.test(command))
}

/**
 * True when the tail of the terminal output looks like an open request for a
 * secret. `tail` may contain multiple lines; only the last one with anything on it
 * is considered.
 *
 * "Last line with anything on it" rather than simply "last line", because ConPTY
 * does not write a prompt and stop — it repaints. PowerShell's `Read-Host` arrives
 * as `\r\nPassword:` followed by an erase, another CRLF, and an absolute cursor move
 * back up to sit after the colon. Taken literally the last line is empty and the
 * prompt is on the one before, so an unconditional `.pop()` never matched it.
 *
 * This was intermittent rather than broken, which is what made it hard to see: when
 * a pty read happened to end at the colon the prompt was the last line and masking
 * worked, and when the trailing CRLF arrived in the same read it did not.
 */
export function looksLikeSecretPrompt(tail: string): boolean {
  const visible =
    stripAnsi(tail)
      // Normalised first: a line ending would otherwise survive as a trailing `\r`
      // and the redraw rule below would treat everything before it as overwritten.
      .replace(/\r\n/g, '\n')
      .split('\n')
      // `\r` alone redraws a line in place; only the final segment is on screen.
      .map((line) => line.split('\r').pop() ?? '')
      .filter((line) => line.trim() !== '')
      .pop() ?? ''

  if (!SECRET_PROMPT.test(visible)) return false
  return !NOT_A_PROMPT.some((re) => re.test(visible))
}
