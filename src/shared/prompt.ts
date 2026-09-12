/**
 * The system prompt a chat is asked under, built once for every door.
 *
 * There are two ways a question reaches a model — the Anthropic API when a key is
 * set, and the Claude Code CLI when one is not — and each of them used to assemble
 * this for itself. They drifted, in the way two copies of one thing always do: the
 * API path grew the attached blocks and the open file, and the CLI path did not.
 * So for everyone signed in through the CLI rather than with a key, which is the
 * ordinary case, "explain last error" sent the question and threw the error away.
 *
 * It survived because the attachment checks all run against `EMBER_FAKE_AI`, which
 * short-circuits before either real path — so the covered path was not the used
 * one. The answer to that is not another check on the same seam: it is that there
 * is one builder now, and a door cannot forget to call what it does not have.
 *
 * Pure, and in `shared` rather than beside either caller, so it can be checked
 * without an Electron window or a model at the other end.
 */

// The `.ts` extension on purpose: the unit tests run this file through Node's own
// type stripping, which resolves a specifier as written and has no `.js` to find.
import { redactSecrets } from './secrets.ts'

/** Only the parts of a chat request that shape the system prompt. */
export interface ChatContext {
  /** The shell the question was asked from, for the model to talk about. */
  shell: string
  /** Where that shell is standing. */
  cwd: string
  /** The file being edited, buffer and all, when the question is asked in the IDE. */
  activeFile?: { path: string; text: string }
  /** Command blocks the user attached, already rendered to plain text. */
  attached?: string[]
}

/**
 * How the model is told what it is looking at, and what it is being asked for.
 *
 * Separate from the explain prompt because that one is written for a failure that
 * just happened and answers in a short paragraph — right for "why did that break",
 * wrong for "how should I structure this". This one can be asked anything,
 * including questions with no command in the answer at all.
 */
export function chatSystem(ctx: ChatContext): string {
  const sections = [
    [
      'You are helping someone inside their terminal and editor. They can see their',
      `files, their shell (${ctx.shell}) and their working directory (${ctx.cwd}).`,
      '',
      'Answer the question that was asked, at the length it deserves — a sentence when',
      'a sentence will do. Show commands and code in fenced blocks so they can be read',
      'and copied. Where you are unsure about their setup, say so rather than assuming.'
    ].join('\n'),
    [
      'When you propose changing a file, put its complete new content in a fenced',
      'block whose info string is `lang path=<path>`. When you propose a shell',
      'command to run, put it alone in a fenced block whose info string is `run`.'
    ].join('\n')
  ]

  /*
   * The context goes last, because it is by far the longest part: a screen of
   * somebody's build output above the instructions would bury them.
   */
  /*
   * Both of them scrubbed on the way out.
   *
   * The file is the buffer as it stands — an .env under the caret is exactly the
   * file someone asks a question about — and the attachments are whatever those
   * commands printed, headers and all. Redacted rather than withheld, because the
   * model only reads these: what it proposes comes back as a fenced block the
   * person accepts, and the editor refuses one that gained a redaction the file
   * never had.
   */
  if (ctx.activeFile) {
    sections.push(
      `The user is editing ${ctx.activeFile.path}:\n${redactSecrets(ctx.activeFile.text)}`
    )
  }
  for (const block of ctx.attached ?? []) {
    if (block.trim().length > 0) {
      sections.push(`Attached terminal output:\n${redactSecrets(block)}`)
    }
  }

  return sections.join('\n\n')
}
