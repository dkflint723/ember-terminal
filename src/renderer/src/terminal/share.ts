import { containsInlineSecret, redactSecrets } from '@shared/secrets'

/**
 * A block, as something you can paste somewhere else.
 *
 * Warp answers this with a hosted permalink. Ember has no server and is not going
 * to get one, so the question is not "how do we host a block" but "what does
 * somebody actually want when they share one" — and the honest answer is almost
 * always a message to a colleague or a comment on an issue. That is Markdown, in
 * the clipboard, now. No account, no link that rots, nothing that stops working
 * when a service does.
 *
 * The shape is the one every issue tracker already renders: a fenced `console`
 * block with the command on a prompt line above its output. Anyone reading it
 * knows what they are looking at without being told, and GitHub, GitLab and Slack
 * all highlight it.
 */

/** What this needs from a block, so it can be tested without one. */
export interface ShareableBlock {
  command: string
  status: 'running' | 'done' | 'failed'
  exitCode: number | null
  durationMs: number | null
  interactive: boolean
}

/** `2.4 s`, `340 ms`, `1 m 12 s` — the way somebody would say it out loud. */
function howLong(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return seconds > 0 ? `${minutes} m ${seconds} s` : `${minutes} m`
}

/**
 * How it went, in the line under the fence.
 *
 * Worth stating rather than leaving to be inferred from the output: the whole
 * reason a command gets shared is usually that it failed, and an exit code is the
 * part a reader wants first and the part a screenshot of a terminal never shows.
 */
function outcome(block: ShareableBlock): string {
  const took = block.durationMs !== null ? ` in ${howLong(block.durationMs)}` : ''
  if (block.status === 'running') return `_still running${took ? took.replace(' in ', ' after ') : ''}_`
  if (block.status === 'done') return `_exited 0${took}_`
  return block.exitCode !== null ? `_exited ${block.exitCode}${took}_` : `_failed${took}_`
}

/**
 * A fence long enough to hold the text inside it.
 *
 * Output is arbitrary bytes from arbitrary programs, and plenty of them print
 * three backticks — anything that renders Markdown, this app's own README, a
 * linter quoting a code sample. A three-tick fence around that closes early and
 * the rest of the output escapes into the message as prose.
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Credentials, removed as far as they can be recognised.
 *
 * The same redaction the history database gets, for the same reason and with one
 * difference that matters: a row in a local SQLite file is read by the person who
 * ran the command, and this is on its way to somebody else's screen. So where
 * redaction leaves a command still looking like it carries a credential, the
 * command is withheld rather than shared — history refuses to store such a block
 * at all, and being quieter than that here would be the wrong direction.
 *
 * What this does not do is guess. The patterns match shapes that name themselves;
 * there is no entropy rule, deliberately, because "forty hex characters" redacts
 * every commit hash and checksum in a terminal. A secret a script simply echoes,
 * wearing no label, will pass through — which is why the control says what it
 * removes rather than promising the text is safe.
 */
function safeCommand(command: string): string {
  const redacted = redactSecrets(command)
  if (containsInlineSecret(redacted)) return '# command withheld — it carried a credential'
  return redacted
}

/**
 * The block as Markdown, ready to paste.
 *
 * Deliberately without the working directory. It is the one field here that is
 * nearly always noise to a reader and nearly always carries the sender's user
 * name — `C:\Users\someone\...` — and a share that quietly tells a mailing list
 * who you are is a bad trade for a line of context that can be typed in a
 * sentence.
 */
export function markdownFrom(block: ShareableBlock, output: string): string {
  const command = block.command.trim() ? safeCommand(block.command.trim()) : '# (interactive)'

  /*
   * An interactive program's block holds a placeholder rather than a screen, so
   * saying that is more use than fencing an empty box. The final frame of vim is
   * meaningless anyway once it has put the screen back.
   */
  const body = block.interactive
    ? '# (interactive — nothing captured)'
    : redactSecrets(output).replace(/\s+$/, '')

  const fence = fenceFor(`${command}\n${body}`)
  const lines = [`${fence}console`, `$ ${command}`]
  if (body.length > 0) lines.push(body)
  lines.push(fence, '', outcome(block))
  return lines.join('\n')
}
