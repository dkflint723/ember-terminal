/**
 * What a paste is allowed to carry into a terminal, and when to ask first.
 *
 * Pasting into a shell is the one ordinary gesture that can run code nobody has
 * read. Two things make it dangerous rather than merely careless. A newline in the
 * clipboard is an Enter: text copied from a web page runs the moment it lands,
 * and the line that runs need not be the line that was visible — `git status` on
 * screen, a newline and `curl … | sh` scrolled out of sight beneath it. And an
 * escape character in the clipboard is not text at all: it is the start of a
 * sequence the terminal obeys, including the marker that ends a bracketed paste,
 * which is how pasted text talks its way out of being treated as text.
 *
 * So: the control characters come out, and a paste that would start running on
 * arrival is asked about. Bracketed paste is the shell saying "I will hold whatever you
 * give me until Enter" — where it is on, there is nothing to ask.
 *
 * Pure and free of DOM imports, so the rules can be exercised without a terminal.
 */

/**
 * Control characters that never belong in pasted text.
 *
 * Tab and newline are the two that do. Everything else in C0, DEL, and the C1
 * range is either invisible or an instruction: ESC most of all, which begins every
 * escape sequence there is — including `ESC [ 2 0 1 ~`, the end-of-paste marker.
 * Left in, that marker closes the bracket early and the rest of the clipboard
 * arrives as ordinary typing, which is the whole protection undone.
 */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g

/** A paste, as it will be handed to the terminal, and what it would do there. */
export interface CleanPaste {
  /** The text with control characters removed and line endings normalised. */
  text: string
  /** How many characters were taken out, so the person can be told rather than surprised. */
  removed: number
  /** Lines with something on them: what "12 lines" in the question means. */
  lines: number
  /** Whether this would start running the moment it arrives, rather than waiting for Enter. */
  runsOnArrival: boolean
}

/**
 * Clean a clipboard's text for a terminal, and say what it would do.
 *
 * `bracketed` is the terminal's own bracketed-paste mode, which the shell turns on
 * when its line editor will hold a paste as one literal block. It is read rather
 * than assumed: the same clipboard is harmless at a PSReadLine prompt and runs on
 * arrival at a program that reads stdin a line at a time.
 */
export function cleanPaste(raw: string, bracketed = false): CleanPaste {
  // Every line ending becomes one newline first, so a lone carriage return — which
  // is an Enter to a shell — cannot hide from the count or from the question.
  const normalised = raw.replace(/\r\n?/g, '\n')
  const text = normalised.replace(CONTROL, '')
  const removed = normalised.length - text.length
  const lines = text.split('\n').filter((line) => line.trim().length > 0).length
  return { text, removed, lines, runsOnArrival: !bracketed && text.includes('\n') }
}

/** Whether this paste is worth stopping for at all. */
export function needsAsking(clean: CleanPaste): boolean {
  return clean.runsOnArrival && clean.lines > 1
}

/**
 * The question to put to the person, naming what is about to happen and showing
 * the line it would start with.
 *
 * The first line is shown because it is the one thing a person can check against
 * what they meant to copy, and because the attack this guards against works by the
 * first line being innocent.
 */
export function pasteQuestion(clean: CleanPaste): string {
  return (
    `This paste is ${clean.lines} lines and will start running as soon as it arrives — ` +
    `the shell here is not holding pasted text until Enter.\n\nIt begins:\n\n  ${firstLine(clean)}` +
    `${removedNote(clean)}\n\nPaste it anyway?`
  )
}

/**
 * And the same for text already in the composer that Enter is about to run: a
 * block that was pasted there, or a recalled line somebody added to.
 *
 * Worded differently because nothing is arriving by surprise — it has been on
 * screen, and the person is pressing Enter on it — so the question is about what
 * it is about to do rather than about where it came from.
 */
export function runQuestion(clean: CleanPaste): string {
  return (
    `This will run ${clean.lines} lines, one after another.\n\nIt begins:\n\n  ${firstLine(clean)}` +
    `${removedNote(clean)}\n\nRun them?`
  )
}

/** The line a question shows: the one thing a person can check against what they meant. */
function firstLine(clean: CleanPaste): string {
  const first = clean.text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return first.length > 120 ? `${first.slice(0, 117)}…` : first
}

function removedNote(clean: CleanPaste): string {
  if (clean.removed === 0) return ''
  return `\n\n${clean.removed} control character${clean.removed === 1 ? '' : 's'} will be removed.`
}
