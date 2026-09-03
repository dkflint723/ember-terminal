import { monaco } from './monaco'
import { useStore } from '../state/store'

/**
 * The suggestion that appears ahead of the caret, greyed out, waiting for Tab.
 *
 * Off unless the user turned it on, and answered by whichever backend they chose —
 * a model on this machine, an OpenAI-compatible endpoint, or Claude. This file
 * does not care which: it asks main for text and draws it.
 *
 * Most of what it does is decline to ask.
 *
 * That is not caution, it is where the quality is. A raw model dropped into an
 * editor is accepted about eighteen per cent of the time; the shipped products
 * reach roughly thirty by suppressing requests rather than by improving the model.
 * JetBrains' completion model is a hundred million parameters, and a small filter
 * deciding *when not to ask* bought them more than half again their acceptance
 * rate. Every rule below is a cheap version of that, and each one also declines to
 * spend whatever the chosen provider charges.
 *
 * The split between the two halves here matters. Monaco's provider answers
 * immediately, from what is already known; the asking happens beside it, on its
 * own clock. Waiting inside the provider is the obvious design and the wrong one:
 * the editor cancels a provider on the next keystroke, and a provider still
 * awaiting a network call when that happens leaves an unhandled `Canceled` inside
 * Monaco's own event emitter — a real error in the page, several times a sentence.
 */

/** Context sent either side of the caret. Enough to be useful, bounded to stay quick. */
const PREFIX_CHARS = 3000
const SUFFIX_CHARS = 1000

/**
 * Answers already given, keyed by the text before the caret.
 *
 * This is what lets the provider be synchronous, and it doubles as the reason the
 * same question is never paid for twice: arrowing away and back, or undoing and
 * redoing, asks something already answered. Small on purpose — a way not to pay
 * twice, not a memory of the session.
 */
const CACHE_LIMIT = 40
const cache = new Map<string, string>()

/** Where a suggestion was last turned down, so the same spot is not asked twice. */
let declinedAt: string | null = null

/*
 * How the fetching half tells the editor there is something new to show.
 *
 * Monaco provides this precisely so a provider can answer late without being
 * asked again by force. Reaching for `editor.trigger('editor.action.inlineSuggest.trigger')`
 * instead — the obvious move — supersedes whatever request is already in flight,
 * and the superseded one surfaces as an unhandled `Canceled` inside Monaco's own
 * emitter: a real error in the page, several times a sentence. Measured, not
 * guessed: with suggestions off the same typing produced none, and with the manual
 * trigger it produced three.
 */
const refresh = new monaco.Emitter<void>()

let registered = false

/**
 * The provider. Synchronous by construction: it either knows the answer or says it
 * has none, and never leaves Monaco waiting.
 */
export function registerGhost(): void {
  if (registered) return
  registered = true

  monaco.languages.registerInlineCompletionsProvider(
    { pattern: '**' },
    {
      provideInlineCompletions(model, position) {
        const decision = consider(model, position)
        if (!decision.ask) return { items: [] }

        const text = cache.get(decision.prefix)
        if (!text) return { items: [] }
        return { items: [{ insertText: text, range: at(position) }] }
      },

      /*
       * A suggestion that reached the end of its life without being taken marks its
       * spot, so the next look at the same place does not offer what was just
       * declined. Anything that moves the caret clears it by being a different spot.
       */
      handleEndOfLifetime(_completions, completion, reason): void {
        const Kind = monaco.languages.InlineCompletionEndOfLifeReasonKind
        if (reason.kind !== Kind.Rejected && reason.kind !== Kind.Ignored) return
        const range = (completion as { range?: monaco.IRange }).range
        const model = monaco.editor.getEditors()[0]?.getModel()
        if (!range || !model) return
        declinedAt = spotOf(model.uri.toString(), range.startLineNumber, range.startColumn)
      },

      /** Required by the contract even when there is nothing to release. */
      disposeInlineCompletions(): void {},

      onDidChangeInlineCompletions: refresh.event
    }
  )
}

/**
 * The asking half, attached to one editor.
 *
 * Waits for the caret to rest, decides whether the moment is worth spending on,
 * fetches, and only then asks Monaco to look again — at which point the provider
 * above finds the answer waiting and returns it without blocking anything.
 */
/*
 * Request ids, counted once for the whole window rather than per editor.
 *
 * Main keys its abort controllers by id alone, and this counter used to start at
 * zero inside every attachGhost — so a second pane's first request aborted the
 * first pane's live one, which is worse than not cancelling at all.
 */
let nextRequestId = 0

export function attachGhost(editor: monaco.editor.IStandaloneCodeEditor): { dispose(): void } {
  let timer = 0

  /*
   * The request this editor is waiting on, so it can be called off.
   *
   * The whole design says the caller cancels on every keystroke — main carries an
   * abort controller per request and says so, and there is a `ghostCancel` on the
   * bridge for it. Nothing ever called it. Every superseded request therefore ran
   * to completion: paid for in full on the paid providers, and on a local one
   * queued ahead of the only answer still wanted, so typing at speed produced no
   * suggestions at all rather than late ones.
   */
  let inFlight: number | null = null

  const callOff = (): void => {
    if (inFlight === null) return
    window.ember.ghostCancel(inFlight)
    inFlight = null
  }

  const consider2 = (): void => {
    window.clearTimeout(timer)
    // The caret moved or the text changed, so whatever is being asked is about a
    // place that no longer exists.
    callOff()
    const settings = useStore.getState().settings
    if (!settings.ghostEnabled) return

    const rest = Math.max(0, Math.min(settings.ghostDebounceMs ?? 200, 2000))
    timer = window.setTimeout(() => void fetchFor(), rest)
  }

  const fetchFor = async (): Promise<void> => {
    const model = editor.getModel()
    const position = editor.getPosition()
    if (!model || !position || !editor.hasTextFocus()) return

    const decision = consider(model, position)
    if (!decision.ask || cache.has(decision.prefix)) return

    const id = ++nextRequestId
    inFlight = id
    const result = await window.ember
      .ghostComplete(id, {
        prefix: decision.prefix,
        suffix: decision.suffix,
        language: model.getLanguageId()
      })
      .catch(() => null)
    if (inFlight === id) inFlight = null
    if (!result || !result.ok) return

    remember(decision.prefix, result.text.trim() ? result.text : '')
    if (!result.text.trim()) return

    // Still where it was asked about? A caret that moved on has a different
    // question, and the answer to this one will be waiting if it comes back.
    const now = editor.getPosition()
    if (!now || !now.equals(position)) return
    /*
     * Tell the editor first. If a suggestion session is already open this is all
     * that is needed, and it is the mechanism Monaco provides for exactly this.
     *
     * Starting one from nothing still needs the trigger action, which is the only
     * way in — and which supersedes whatever request is in flight, surfacing the
     * superseded one as an unhandled `Canceled` inside Monaco's own emitter. So it
     * is used as little as possible: deferred off this task, only if the caret has
     * not moved, and only when there is no session for the event above to have
     * reached.
     */
    refresh.fire()
    window.setTimeout(() => {
      if (!editor.getPosition()?.equals(position)) return
      if (document.querySelector('.ghost-text-decoration')) return
      editor.trigger('ghost', 'editor.action.inlineSuggest.trigger', {})
    }, 0)
  }

  const listeners = [
    editor.onDidChangeCursorPosition(consider2),
    editor.onDidChangeModelContent(consider2)
  ]

  return {
    dispose(): void {
      window.clearTimeout(timer)
      // A closed pane is not waiting for an answer, and on a paid provider the
      // request outlives the editor that wanted it.
      callOff()
      for (const l of listeners) l.dispose()
    }
  }
}

interface Decision {
  ask: boolean
  prefix: string
  suffix: string
}

const NO: Decision = { ask: false, prefix: '', suffix: '' }

/**
 * Whether this moment is worth asking about, and with what context.
 *
 * Shared by both halves so they cannot disagree: the fetcher must not spend on a
 * position the provider would refuse to draw.
 */
function consider(model: monaco.editor.ITextModel, position: monaco.Position): Decision {
  if (declinedAt === spotOf(model.uri.toString(), position.lineNumber, position.column)) return NO

  /*
   * Never over the suggest widget. Ember's language servers already answer with
   * real completions, and two overlapping popups — one a list, one a ghost — is the
   * state where neither can be read and Tab means two different things.
   */
  if (suggestWidgetOpen()) return NO

  const line = model.getLineContent(position.lineNumber)
  const before = line.slice(0, position.column - 1)
  const after = line.slice(position.column - 1)

  /*
   * Not in front of code that is already written. A completion inserted before
   * existing text is nearly always wrong, and it is the shape people reject
   * fastest — a caret there is usually editing, not asking for more.
   */
  if (after.trim().length > 0) return NO

  /*
   * Not part-way through an identifier. The language server owns that case, answers
   * it faster, and answers it from the symbol table rather than from a guess.
   */
  if (/[A-Za-z_$][A-Za-z0-9_$]+$/.test(before) && !/[.\s([{,:;=]$/.test(before)) return NO

  const offset = model.getOffsetAt(position)
  const whole = model.getValue()
  const prefix = whole.slice(Math.max(0, offset - PREFIX_CHARS), offset)

  // Nothing to go on. A model given three characters of a file invents a file.
  if (prefix.trim().length < 3) return NO

  return { ask: true, prefix, suffix: whole.slice(offset, offset + SUFFIX_CHARS) }
}

function at(position: monaco.Position): monaco.Range {
  return new monaco.Range(
    position.lineNumber,
    position.column,
    position.lineNumber,
    position.column
  )
}

function spotOf(uri: string, line: number, column: number): string {
  return `${uri}:${line}:${column}`
}

function remember(prefix: string, text: string): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(prefix, text)
}

/**
 * Whether the language server's completion list is on screen.
 *
 * Read from the DOM rather than from Monaco's suggest controller, which is not
 * part of the public API: the widget is a real element with a stable class, and
 * asking the page what it is showing is simpler and harder to get wrong than
 * reaching into an internal service that may be renamed.
 */
function suggestWidgetOpen(): boolean {
  const widget = document.querySelector('.suggest-widget')
  if (!widget) return false
  return widget.classList.contains('visible') || widget.getBoundingClientRect().height > 4
}
