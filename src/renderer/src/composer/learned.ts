import { useStore } from '../state/store'

/**
 * The chords the composer offers to teach, and stops advertising once they have
 * been pressed.
 *
 * The footer used to list five of these permanently. That is a legend, and a legend
 * earns its space only while it is still teaching something — after the first week
 * it is five lines of chrome under the one line anybody is looking at. Warp does
 * not draw one at all, which is right for someone who already knows the app and
 * wrong for someone opening it for the first time.
 *
 * So the hint retires when its chord is used. Pressing it is the proof that it was
 * read, nothing is timed out, and a chord that is never pressed is never taken
 * away — the person who has not learned it is exactly the person still being
 * taught.
 *
 * Names rather than a count, so the set can grow without the stored value quietly
 * meaning something else.
 */
export type Chord =
  /** Ctrl+K — pin the reading of the line. */
  | 'pin'
  /** Ctrl+Enter — send to the agent whatever the line looks like. */
  | 'ask'
  /** Ctrl+Up — attach the last failed block. */
  | 'attach'
  /** Escape — let go of the attachments. */
  | 'detach'
  /** Shift+Enter — a newline instead of a send. */
  | 'newline'
  /** Ctrl+C — interrupt what is running. */
  | 'interrupt'
  /** Shift+Tab — leave the terminal from the keyboard. */
  | 'leave'
  /** Ctrl+D — end of input. */
  | 'eof'

/**
 * Whether each chord still needs advertising, and how to say one was used.
 *
 * `learn` is a fire-and-forget write: the hint going away is not worth blocking a
 * keystroke on, and a failed write only means the line is still offered next time.
 * Already-known chords are dropped here rather than in main, so pressing Ctrl+C
 * forty times is one message and thirty-nine no-ops.
 */
export function useLearned(): { knows: (c: Chord) => boolean; learn: (c: Chord) => void } {
  const learned = useStore((s) => s.settings.learnedChords)

  const knows = (c: Chord): boolean => learned.includes(c)
  const learn = (c: Chord): void => {
    /*
     * Read from the store rather than from the value this render closed over. Two
     * chords pressed inside one render — Ctrl+Up then Escape, which is a normal
     * pair — would otherwise both see the old list and send two messages, and main
     * unions them anyway but the second is pure noise.
     */
    if (useStore.getState().settings.learnedChords.includes(c)) return
    void window.ember.noteLearnedChord(c).then((next) => useStore.getState().applySettings(next))
  }

  return { knows, learn }
}
