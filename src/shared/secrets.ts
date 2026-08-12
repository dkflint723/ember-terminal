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
 * True when the tail of the terminal output looks like an open request for a
 * secret. `tail` may contain multiple lines; only the last is considered.
 */
export function looksLikeSecretPrompt(tail: string): boolean {
  const lastLine = stripAnsi(tail).split('\n').pop() ?? ''
  // `\r` is used to redraw a line in place; only the final segment is on screen.
  const visible = lastLine.split('\r').pop() ?? ''
  if (!SECRET_PROMPT.test(visible)) return false
  return !NOT_A_PROMPT.some((re) => re.test(visible))
}
