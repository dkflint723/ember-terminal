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
export type ComposerChord =
  /** Ctrl+Enter — send to the agent whatever the line looks like. */
  | 'composer.ask'
  /** Ctrl+Up — attach the last failed block. */
  | 'composer.attach'
  /** Escape — let go of the attachments. */
  | 'composer.detach'
  /** Shift+Enter — a newline instead of a send. */
  | 'composer.newline'
  /** Ctrl+C — interrupt what is running. */
  | 'running.interrupt'
  /** Shift+Tab — leave the terminal from the keyboard. */
  | 'running.leave'
  /** Ctrl+D — end of input. */
  | 'running.eof'

/**
 * Whether each chord still needs advertising, and how to say one was used.
 *
 * Plain strings rather than one union, because they come from two namespaces that
 * are each typed at their own end: `ComposerChord` above for the keys this
 * component owns, and the id of a `Command` for the ones the registry owns. Both
 * are dotted and cannot collide — Ctrl+K is `composer.pin` in the registry, which
 * is why it is not in the union above.
 *
 * `learn` is a fire-and-forget write: the hint going away is not worth blocking a
 * keystroke on, and a failed write only means the line is still offered next time.
 * Already-known chords are dropped here rather than in main, so pressing Ctrl+C
 * forty times is one message and thirty-nine no-ops.
 */
export function useLearned(): { knows: (c: string) => boolean; learn: (c: string) => void } {
  const learned = useStore((s) => s.settings.learnedChords)
  return { knows: (c) => learned.includes(c), learn: noteChord }
}

/**
 * The same write, for the places that are not components.
 *
 * The store is read here rather than closed over, which is what lets this be one
 * function for both callers: two chords pressed inside one render would otherwise
 * both see the list as it was and send two messages for it. Main unions them
 * anyway, so the second is only noise, but it is noise on every keystroke.
 */
export function noteChord(chord: string): void {
  if (useStore.getState().settings.learnedChords.includes(chord)) return
  void window.ember
    .noteLearnedChord(chord)
    .then((next) => useStore.getState().applySettings(next))
}
