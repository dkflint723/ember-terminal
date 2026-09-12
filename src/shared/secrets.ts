/**
 * Detection of prompts that are asking for a secret, and of credentials in text
 * about to be written down or sent somewhere.
 *
 * Windows ConPTY exposes no terminal echo flag, so there is no authoritative
 * signal that a program has turned echoing off — it has to be inferred from the
 * prompt text. That makes precision the priority: masking ordinary input is worse
 * than failing to mask, because the user loses the ability to see what they typed
 * and has no way to know why.
 *
 * The same argument runs through the credential patterns below. A rule like "forty
 * hex characters" would redact every commit hash and checksum in a terminal, which
 * is worse than useless; nothing here matches on length or entropy alone.
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

/** What stands in for a credential, wherever one is taken out. */
export const REDACTED = '[redacted]'

/**
 * Whether applying this text would write a redaction the file never had.
 *
 * The file a model is shown has its credentials taken out, so a whole-file
 * proposal can come back with the word where the key was — and accepting it would
 * write that over the key. Asked of what is on disk rather than blanket-refused,
 * because a file that genuinely contains the word is entitled to keep it.
 */
export function inventsRedaction(proposed: string, onDisk: string): boolean {
  return proposed.includes(REDACTED) && !onDisk.includes(REDACTED)
}

/** The words that mark whatever follows them as a credential. */
const NAME =
  '(?:password|passwd|pwd|token|secret|api[-_]?key|apikey|access[-_]?key|secret[-_]?key|auth[-_]?token|auth|client[-_]?secret|credential)'

/** The same names as an environment variable is spelled, which is upper case. */
const ENV_NAME =
  '(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|APIKEY|ACCESS_KEY|SECRET_KEY|AUTH_TOKEN|CLIENT_SECRET|ANTHROPIC_API_KEY|OPENAI_API_KEY|GITHUB_TOKEN|GH_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY|AZURE_CLIENT_SECRET)'

/**
 * Credential shapes that identify themselves wherever they appear.
 *
 * Every one of these is a vendor's own prefix and length, which is what makes it
 * safe to look for in a wall of command output: nothing else is shaped like them.
 * A private key is here too, as the one multi-line shape worth taking whole.
 *
 * Written without the global flag and copied with it below, because a global
 * regular expression remembers where it stopped — the same object used for both
 * `test` and `replace` skips every other call, which is the kind of bug that
 * leaks one key in two.
 */
const KEY_SHAPES = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/,
  // The newer OpenAI prefixes carry a hyphen the older rule below stops dead at.
  /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{16,}/,
  /\bsk-[A-Za-z0-9]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{20,}/,
  // Long-lived and temporary AWS identifiers alike; the shape is fixed at 20.
  /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/,
  // Exactly 36, because npm_config_* and npm_lifecycle_* fill the environment of
  // every npm script and a looser rule redacts all of them.
  /\bnpm_[A-Za-z0-9]{36}\b/,
  // A JWT: two base64 objects and a signature. Both segments must start `eyJ`,
  // which is `{"` encoded, so ordinary base64 does not qualify.
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/
]

/**
 * Credentials that need their label to be recognised, and the label is kept.
 *
 * `TOKEN=[redacted]` says far more about what happened than a blank space does,
 * so each of these captures the part that names the thing and replaces only the
 * value. The flag forms are anchored to a word start: without that, `--?secret`
 * matches the tail of `kubectl get secret my-secret -o yaml`, and an ordinary
 * command would be dropped from history for containing a hyphen.
 */
const LABELLED = [
  new RegExp(`((?<=^|\\s)--?${NAME}(?:[=:]|\\s+))\\S+`, 'i'),
  new RegExp(`((?:\\$env:)?\\b${ENV_NAME}\\s*=\\s*)\\S+`, ''),
  new RegExp(`(\\b(?:export|set|setx)\\s+[A-Za-z_][A-Za-z0-9_]*${NAME}[A-Za-z0-9_]*\\s*[= ]\\s*)\\S+`, 'i'),
  new RegExp(`(\\b(?:export|set|setx)\\s+${NAME}[A-Za-z0-9_]*\\s*[= ]\\s*)\\S+`, 'i'),
  /(x-api-key\s*:\s*)\S+/i,
  /(Authorization:\s*(?:Bearer|Basic)\s+)\S+/i,
  // Connection strings, which put the credential in a named field between semicolons.
  /((?:AccountKey|SharedAccessKey|SharedAccessSignature|Password|Pwd)\s*=\s*)[^;\s"']+/i,
  // The credentials in a URL, keeping the rest of it readable.
  /([a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+(?=@)/i,
  // mysql and psql take the value attached to the flag: -pMyPassword.
  /((?<=^|\s)-p)\S{3,}/
]

const withGlobal = (re: RegExp): RegExp =>
  re.flags.includes('g') ? re : new RegExp(re.source, `${re.flags}g`)
const KEY_SHAPES_G = KEY_SHAPES.map(withGlobal)
const LABELLED_G = LABELLED.map(withGlobal)

/**
 * Replace credentials in text that is about to be stored, shown in a toast, or
 * sent to a model.
 *
 * Command output goes into a history database that outlives the session, and a
 * command like `aws configure list` or a curl that echoes its own headers puts a
 * live key on screen without the command line ever mentioning one. Redacting is
 * the right trade wherever the text is only ever read: the output is what makes
 * history searchable, and losing a value is better than keeping a key.
 *
 * It is the wrong trade wherever the text comes back and is written down again —
 * a suggestion, a rewritten selection — because `[redacted]` would land in the
 * file. Those ask `hasSecret` and decline instead.
 */
export function redactSecrets(text: string): string {
  let out = text
  for (const re of KEY_SHAPES_G) out = out.replace(re, REDACTED)
  for (const re of LABELLED_G) {
    out = out.replace(re, (match, prefix?: string) =>
      typeof prefix === 'string' ? `${prefix}${REDACTED}` : REDACTED
    )
  }
  return out
}

/** A vendor's own key shape, or a private key block: no label needed. */
export function containsKeyShape(text: string): boolean {
  return KEY_SHAPES.some((re) => re.test(text))
}

/** Anything `redactSecrets` would change — the question a round trip has to ask. */
export function hasSecret(text: string): boolean {
  return containsKeyShape(text) || LABELLED.some((re) => re.test(text))
}

/**
 * Credentials passed inline on a command line. Persistent history is forever, so
 * these commands are dropped rather than stored — a leak here outlives the session
 * that caused it, and the user has no reason to expect a shell command to be
 * archived to disk.
 *
 * Deliberately narrower than `hasSecret`: it only matches shapes that carry a
 * value, so `git push` and `--password-stdin` (which is the safe form) are kept.
 * A key typed as a bare argument — `./deploy.sh sk-ant-…` — has no label at all,
 * and is caught by its own shape.
 */
const INLINE_SECRET = [
  new RegExp(`(?<=^|\\s)--?${NAME}(?:[=:]|\\s+)\\S`, 'i'),
  new RegExp(`(?:\\$env:)?\\b${ENV_NAME}\\s*=\\s*\\S`, ''),
  new RegExp(`\\b(?:export|set|setx)\\s+[A-Za-z_][A-Za-z0-9_]*${NAME}[A-Za-z0-9_]*\\s*[= ]\\s*\\S`, 'i'),
  new RegExp(`\\b(?:export|set|setx)\\s+${NAME}[A-Za-z0-9_]*\\s*[= ]\\s*\\S`, 'i'),
  /(?<=^|\s)-p\S{3,}/,
  /x-api-key\s*:\s*\S/i,
  /Authorization:\s*(?:Bearer|Basic)\s+\S/i,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i
]

/** True when a command line appears to carry a credential in the clear. */
export function containsInlineSecret(command: string): boolean {
  // `--password-stdin` and friends read the secret from a pipe; nothing to leak.
  if (/--(?:password|token|secret)-stdin\b/i.test(command)) return false
  return INLINE_SECRET.some((re) => re.test(command)) || containsKeyShape(command)
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
