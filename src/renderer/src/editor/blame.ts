import { monaco } from './monaco'
import { ago } from '../util/relative-time'

/**
 * Who last touched the line the caret is on, said at the end of that line.
 *
 * The current line rather than every line, which is the difference between a
 * question and a wall. Annotating a whole file means blaming its entire history
 * and then colouring a margin that competes with the code for attention; the
 * question people actually ask is about the line they are looking at, and asking
 * git only that is cheap enough to run as the caret moves.
 *
 * Nothing is drawn for a line nobody has committed, for a file git has never
 * heard of, or while the answer is still coming back. An annotation that flickers
 * between three states as you arrow down a file is worse than none.
 */

/** Long enough that arrowing through a file does not spawn a blame per row. */
const SETTLE_MS = 260

/** Where the annotation sits, and what it says. */
interface Attachment {
  dispose(): void
}

export function attachBlame(
  editor: monaco.editor.IStandaloneCodeEditor,
  context: () => { root: string | null; filePath: string | null }
): Attachment {
  const decorations = editor.createDecorationsCollection([])
  let timer = 0
  /*
   * Every request carries the generation it was made in, and a reply from an
   * older one is dropped. Without it a slow blame for line 10 can land after a
   * fast one for line 400 and annotate the wrong line — which is not a cosmetic
   * failure, it is the feature saying something untrue.
   */
  let generation = 0

  const clear = (): void => decorations.clear()

  const paint = async (): Promise<void> => {
    const mine = ++generation
    const { root, filePath } = context()
    const position = editor.getPosition()
    const model = editor.getModel()
    if (!root || !filePath || !position || !model) {
      clear()
      return
    }

    // A line being typed on has no committed author, and asking about one that
    // does not exist yet costs a process to be told so.
    if (position.lineNumber > model.getLineCount()) {
      clear()
      return
    }

    const line = await window.ember
      .gitBlameLine(root, filePath, position.lineNumber)
      .catch(() => null)
    if (mine !== generation) return
    if (!line || line.uncommitted || !line.summary) {
      clear()
      return
    }

    const column = model.getLineMaxColumn(position.lineNumber)
    decorations.set([
      {
        range: new monaco.Range(position.lineNumber, column, position.lineNumber, column),
        options: {
          after: {
            content: annotation(line.author, line.authoredAt, line.summary),
            inlineClassName: 'editor__blame'
          },
          // The annotation is not part of the document: it must not be selectable,
          // and a copy of the line must not carry it.
          showIfCollapsed: true
        }
      }
    ])
  }

  const schedule = (): void => {
    window.clearTimeout(timer)
    /*
     * Whatever is in flight is now about a place that has moved.
     *
     * Only `paint` bumped this, so for the whole window between an event and the
     * timer firing an older answer still satisfied the guard. Both the position
     * and the model are captured before the await, and the editor swaps models on
     * a tab switch — so a blame for one file could be applied to another, on a
     * line number that means something different there.
     */
    generation++
    clear()
    timer = window.setTimeout(() => void paint(), SETTLE_MS)
  }

  const listeners = [
    editor.onDidChangeCursorPosition(schedule),
    // The text moving under the caret changes the answer as surely as the caret
    // moving does — an edit above this line shifts which commit owns it.
    editor.onDidChangeModelContent(schedule),
    editor.onDidChangeModel(schedule)
  ]
  schedule()

  return {
    dispose(): void {
      window.clearTimeout(timer)
      generation++
      for (const l of listeners) l.dispose()
      decorations.clear()
    }
  }
}

/**
 * Monaco truncates the content of an `after` decoration at fifty characters and
 * says nothing about it — measured, not documented. So the budget is fifty, and
 * the parts that identify the commit are spent first.
 *
 * That is also why the gap between the code and the annotation is a CSS margin
 * rather than the leading spaces it started as: four spaces of indent cost four
 * characters of commit message, and Monaco renders them as hard spaces anyway.
 */
const BUDGET = 50

/** `author · age · summary`, with the summary taking whatever is left. */
function annotation(author: string, at: number, summary: string): string {
  const prefix = `${author} · ${ago(at)}`
  const room = BUDGET - prefix.length - 3
  if (room < 6) return prefix.slice(0, BUDGET)
  return `${prefix} · ${clip(summary, room)}`
}

/**
 * Enough of the subject to recognise the commit, not to read it. Broken on a word
 * where there is one near enough to the end to break on.
 */
function clip(summary: string, limit: number): string {
  if (summary.length <= limit) return summary
  const cut = summary.slice(0, limit - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > limit - 10 ? cut.slice(0, space) : cut).trimEnd()}…`
}
