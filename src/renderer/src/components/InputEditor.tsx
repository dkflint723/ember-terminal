import { useEffect, useRef, useState } from 'react'
import type { CompletionItem, CompletionResult } from '@shared/types'
import { commonPrefix } from '@shared/completion'
import type { TerminalController } from '../terminal/controller'
import { textFromHtml } from '../terminal/serialize'
import { classifyIntent, type Intent } from '../composer/intent'
import {
  useStore,
  type AttachedBlock,
  type CommandBlock,
  type TerminalPaneState
} from '../state/store'
import { sendToAgent } from './AgentPanel'
import { refreshGitForCwd } from '../state/git'

interface Props {
  pane: TerminalPaneState
  controller: TerminalController
}

/**
 * A real editor for the command line: multi-line, history, and a line that can be
 * either a command or a question — read as one or the other rather than switched
 * between. Replaces the shell's own readline for typing, but keystrokes still
 * reach the pty whenever a program is actually reading stdin.
 */

export function InputEditor({ pane, controller }: Props): React.JSX.Element {
  const [value, setValue] = useState('')

  /*
   * What Enter will do, and which of the two decided it.
   *
   * The composer used to hold a mode that Ctrl+K flipped and nothing else touched,
   * so the wrong one was always one forgotten keypress away — a question sent to
   * the shell, or a command sent to Claude. The buffer is read instead: `detected`
   * is what it looks like, `override` is set only when the user has said otherwise
   * about this particular buffer, and an override wins. The label names which of
   * them is speaking, so a reading that was guessed never passes for a decision.
   */
  const [detected, setDetected] = useState<Intent>('shell')
  const [override, setOverride] = useState<Intent | null>(null)
  /**
   * What the label says. Only the label: every key that acts on the buffer reads it
   * again for itself, because `detected` is deliberately a moment behind and a key
   * pressed inside that moment would otherwise be routed by the previous buffer.
   */
  const intent: Intent = override ?? detected
  /**
   * The same reading, for the one effect that must not depend on it.
   *
   * Ctrl+K arrives through the store rather than through this component, so its
   * effect cannot close over `detected` without re-running on every keystroke.
   */
  const detectedRef = useRef<Intent>('shell')
  /** The line history put back, while the buffer is still that line. See `recall`. */
  const recalled = useRef<string | null>(null)

  /*
   * Blocks the question is being asked about.
   *
   * Held by id rather than by value: the block is the thing being pointed at, and
   * its output is read at send time from wherever it actually lives, so a chip
   * cannot go stale against the block it names.
   */
  const [attachments, setAttachments] = useState<AttachedBlock[]>([])

  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)

  /*
   * The repository this pane is standing in is read here and reported elsewhere.
   *
   * The branch and the count are the status bar's to draw now, but the asking
   * still belongs to the pane: each shell knows when it has been cd'd somewhere
   * else, and finding out at the next poll would mean seeing the last project's
   * branch for a beat after arriving in a new one.
   */
  useEffect(() => {
    void refreshGitForCwd(pane.cwd)
  }, [pane.cwd])

  const [completion, setCompletion] = useState<{ result: CompletionResult; index: number } | null>(
    null
  )
  const [suggestion, setSuggestion] = useState<string | null>(null)
  const ref = useRef<HTMLTextAreaElement>(null)
  /** Guards against a slow completion reply landing after the input moved on. */
  const completionSeq = useRef(0)

  // Only a command can be running. A conversation sitting at the end of the list
  // is an exchange with the agent, not a program holding the keyboard, so it must
  // not swap the composer out for the send-to-process one.
  const last = pane.blocks.at(-1)
  const running = last?.kind === 'command' && last.status === 'running'

  /*
   * A chip only counts while the block behind it is still in the list.
   *
   * Cleared with Ctrl+L, or pushed off the end of the pane's cap, and the output it
   * promised to send no longer exists — so the chips are filtered here rather than
   * pruned in an effect, and every reader below counts the same live ones.
   */
  const attached = attachments.filter((a) => pane.blocks.some((b) => b.id === a.blockId))
  const hasFailed = pane.blocks.some((b) => b.kind === 'command' && b.status === 'failed')

  const pending = useStore((st) => st.pendingInput[pane.id])
  const clearBlocks = useStore((st) => st.clearBlocks)

  // History search hands a command over rather than running it, so the user can
  // read and edit it before committing.
  useEffect(() => {
    if (pending === undefined) return
    setValue(pending)
    // What arrives here came out of the shell's history, or is a sign-in command
    // the settings panel typed for the user. Either way it is a command already,
    // and is pinned as one for the same reason a recalled line is — see recall().
    setOverride('shell')
    useStore.getState().clearPendingInput(pane.id)
    const el = ref.current
    if (el) {
      el.focus()
      requestAnimationFrame(() => el.setSelectionRange(pending.length, pending.length))
    }
  }, [pending, pane.id])

  // Grow with content instead of scrolling a one-line box.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  /*
   * Read the buffer on an idle, never on the keystroke.
   *
   * Classifying is cheap and synchronous, so the delay is not about the cost of the
   * answer — it is about not asking forty times a second, and about the label not
   * flickering through three readings while a word is still being typed. Eighty
   * milliseconds is under the pause between words and well over the pause between
   * characters. The cleanup also drops the pending timer when the pane closes.
   *
   * The answer is mirrored into a ref as it is set, for Ctrl+K alone — see the note
   * on that effect for why it reads the label's reading and not the buffer's.
   */
  useEffect(() => {
    // An override is a decision about one buffer. Emptying the input ends that
    // buffer, so whatever is typed next is read fresh rather than inheriting it.
    if (value.length === 0) setOverride(null)
    else if (recalled.current !== null && value !== recalled.current) {
      // Editing away from a recalled line ends the pin that came with it. The pin
      // belongs to that line, not to the composer: someone who presses Up to look
      // at their last command and then types a question over it has decided
      // nothing, and without this the question goes to the shell.
      recalled.current = null
      setOverride(null)
    }
    const handle = window.setTimeout(() => {
      const next = classifyIntent(value)
      detectedRef.current = next
      setDetected(next)
    }, 80)
    return () => window.clearTimeout(handle)
  }, [value])

  // Suggest the most recent matching command from history as ghost text. Only for
  // a single line: the overlay mirrors the input's metrics to align the ghost, and
  // that alignment cannot be trusted once the text wraps.
  useEffect(() => {
    if (intent !== 'shell' || value.includes('\n') || value.trim().length < 2) {
      setSuggestion(null)
      return
    }
    const handle = window.setTimeout(() => {
      void window.ember.suggestHistory(value, pane.cwd).then((s) => setSuggestion(s))
    }, 110)
    return () => window.clearTimeout(handle)
  }, [value, intent, pane.cwd])

  const submitShell = (): void => {
    const command = value
    if (command.trim().length === 0) return
    setHistory((h) => [...h.filter((c) => c !== command.trim()), command.trim()].slice(-500))
    setHistoryIdx(null)
    setValue('')
    setSuggestion(null)
    /*
     * The chips go with the buffer they were gathered for.
     *
     * Running a command is not asking about the failure they point at, and the
     * question they belonged to has just left the input — so keeping them would
     * leave "attached" standing over a line nobody chose them for, and the next
     * question would quietly ship a failure it was never shown carrying.
     */
    setAttachments([])
    controller.runCommand(command)
  }

  /**
   * Put back a line that has already been a command.
   *
   * A history entry is by construction something that ran, so it is recalled as one.
   * Left to the classifier it would be read fresh, and a line that only reached the
   * shell in the first place because Ctrl+K pinned it — `where is the config`, which
   * reads as English — would come back as a question, with Enter sending a command
   * out of the command history to Claude.
   *
   * The pin is attached to the recalled line rather than to the composer, and the
   * effect above lets go of it as soon as the buffer stops being that line. Pinning
   * the composer instead would mean anyone who pressed Up to remind themselves what
   * they last ran, then typed over it, was silently still pinned to the shell —
   * which is most of what Up is for.
   */
  const recall = (command: string): void => {
    recalled.current = command
    setValue(command)
    setOverride('shell')
  }

  /**
   * A request to point this composer at Claude, from wherever it was pressed.
   *
   * The request is consumed rather than watched. `askRequest` is store state that
   * outlives the press, and this composer is unmounted and mounted again every time
   * the pane runs a full-screen program — so an effect that acted on whatever was
   * standing there would pin an intent on the way back out of `vim`, and take the
   * focus with it, for a press made ten minutes ago. Remembering the last counter
   * seen is what makes a press a press.
   *
   * What it does with the request is the caller's word. Everything labelled "ask
   * Claude" means agent outright and says so; Ctrl+K means "the reading on screen is
   * wrong", so it flips the reading on screen — the label's, deliberately, and not a
   * fresh look at the buffer. Those two disagree for the 80ms the classifier is
   * behind by, and in that window a fresh look inverts the key: the footer offers to
   * pin the opposite of what the label shows, so a press lands on the reading the
   * user could not have been reacting to and Enter then does the expensive wrong
   * thing. Reading the label costs a press made mid-word looking like it only
   * removed the word "autodetected"; the press is still visible, still correct on
   * the next one, and never sends a command to the model.
   *
   * Either way it pins the override rather than a mode, so there is nothing left
   * behind to trip over: emptying the input unpins it.
   */
  const askRequest = useStore((s) => s.askRequest)
  const seenAsk = useRef(askRequest?.n ?? 0)
  useEffect(() => {
    if (!askRequest || askRequest.paneId !== pane.id) return
    if (askRequest.n <= seenAsk.current) return
    seenAsk.current = askRequest.n
    // Updated as a function of the current override rather than the one this effect
    // closed over: it re-runs only when a request arrives, so the captured value is
    // whatever it was the last time one did.
    const { how } = askRequest
    setOverride((o) => {
      if (how === 'agent') return 'agent'
      return (o ?? detectedRef.current) === 'agent' ? 'shell' : 'agent'
    })
    ref.current?.focus()
  }, [askRequest?.n, askRequest?.paneId, askRequest?.how, pane.id])

  /**
   * Attach the next failed command back, so a question carries the failure with it.
   *
   * One press per block, walking backwards, which is what makes a second press mean
   * "the one before that" rather than the same one again. Running out is not a
   * failure — there is simply nothing older left to point at.
   */
  const attachEarlier = (): void => {
    const taken = new Set(attached.map((a) => a.blockId))
    for (let i = pane.blocks.length - 1; i >= 0; i--) {
      const block = pane.blocks[i]
      if (block.kind !== 'command' || block.status !== 'failed' || taken.has(block.id)) continue
      setAttachments([
        ...attached,
        { blockId: block.id, command: block.command, elided: blockOutput(block.output).elided }
      ])
      return
    }
  }

  /*
   * Ask, and put the question in the list.
   *
   * The answer used to appear as a card inside the composer, which meant it lived
   * as far from the command it was about as every other command — and vanished the
   * moment anything else was typed. It is a block now: the prompt lands in the
   * list immediately, the answer fills in underneath it, and both stay where they
   * happened.
   *
   * Nothing here tracks the wait any more either. The composer used to keep a
   * `busy` flag alive for the length of the request purely to spin a 9px ring
   * beside the intent label, which reported the same wait the block already
   * reports in words a couple of inches above it. Progress lives in the block.
   */
  const askAi = async (requestMode: 'command' | 'explain'): Promise<void> => {
    const typed = value.trim()
    if (requestMode === 'command' && typed.length === 0) return
    const prompt = requestMode === 'explain' && typed.length === 0 ? 'Why did that fail?' : typed

    /*
     * Read the chips before the composer is emptied, and empty them with it.
     *
     * The block is the record of what this question was asked about, so the chips
     * move into it rather than staying here — left in the row they would quietly
     * ride along with the next question too, and nothing on screen would say that
     * the second answer had been given the first question's context.
     */
    const sent = attached
    setValue('')
    setOverride(null)
    setAttachments([])

    /*
     * Into the thread, not into a block. The conversation lives in the panel
     * now — streaming, cancellable, and able to remember its own follow-ups —
     * so the composer's part is to gather what the question was asked about
     * and hand it over. The attached chips and the recent tail become plain
     * text context, the same facts the block flow used to send.
     */
    const chosen = new Set(sent.map((a) => a.blockId))
    const recent = [
      ...sent.flatMap((a) => {
        const block = pane.blocks.find((b) => b.id === a.blockId)
        return block && block.kind === 'command' ? [block] : []
      }),
      ...pane.blocks
        .slice(-3)
        .filter(
          (b): b is CommandBlock =>
            b.kind === 'command' && b.status !== 'running' && !chosen.has(b.id)
        )
        ].map((b) => {
      // The same elision-aware rendering the block flow always sent, so the
      // model is told when a long output was cut rather than left to guess.
      const c = asContext(b)
      const cut = c.elided ? ' [output elided]' : ''
      return `$ ${c.command} (exit ${c.exitCode})${cut}
${c.output}`
    })

    sendToAgent(prompt, recent)
  }

  /** Replace the span the backend nominated, and put the caret after it. */
  const applyCompletion = (text: string, result: CompletionResult): void => {
    const start = Math.max(0, result.replaceIndex)
    const before = value.slice(0, start)
    const after = value.slice(start + Math.max(0, result.replaceLength))
    setValue(before + text + after)
    const caret = before.length + text.length
    // The textarea has not re-rendered yet, so defer moving the caret.
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret))
  }

  const requestCompletions = async (): Promise<void> => {
    const el = ref.current
    if (!el) return
    const cursor = el.selectionStart ?? value.length
    const seq = ++completionSeq.current

    const result = await window.ember.complete({
      profileId: pane.profileId,
      cwd: pane.cwd,
      input: value,
      cursor
    })
    // Discard a reply the user has already typed past.
    if (seq !== completionSeq.current) return

    if (result.items.length === 0) {
      setCompletion(null)
      return
    }
    if (result.items.length === 1) {
      applyCompletion(result.items[0].text, result)
      setCompletion(null)
      return
    }

    // Insert whatever part is unambiguous, then let the list resolve the rest.
    const token = value.slice(result.replaceIndex, result.replaceIndex + result.replaceLength)
    const prefix = commonPrefix(result.items.map((i) => i.text))
    if (prefix.length > token.length) applyCompletion(prefix, result)
    setCompletion({ result, index: 0 })
  }

  /** The part of a history suggestion that is not yet typed. */
  const ghost =
    suggestion && suggestion.startsWith(value) && suggestion !== value
      ? suggestion.slice(value.length)
      : ''

  const acceptSuggestion = (): void => {
    if (!ghost) return
    setValue(value + ghost)
    setSuggestion(null)
    const caret = value.length + ghost.length
    requestAnimationFrame(() => ref.current?.setSelectionRange(caret, caret))
  }

  const acceptCompletion = (item: CompletionItem, result: CompletionResult): void => {
    applyCompletion(item.text, result)
    setCompletion(null)
    ref.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    /*
     * What this keypress is about to act on, read from the buffer in hand.
     *
     * `detected` is 80ms behind on purpose so the word beside the input does not
     * flicker through three readings while one is being typed, but a key pressed
     * inside that window must not be routed by the buffer before it: select all,
     * paste `git status` over a question, press Enter, and the debounced reading
     * would still say 'agent' and spend a model call on a line meant to run.
     * Classifying is pure and costs under a microsecond, so the keys that act ask
     * again and only the label waits.
     */
    const live: Intent = override ?? classifyIntent(value)

    // Ahead of everything else, including the completion list: Ctrl+Up is not one
    // of the list's arrow keys, and a list open over a half-typed command is
    // exactly the moment someone reaches for the error they are fixing.
    if (e.ctrlKey && e.key === 'ArrowUp') {
      e.preventDefault()
      attachEarlier()
      return
    }

    // The completion list owns these keys while it is open.
    if (completion) {
      const items = completion.result.items
      const move = (delta: number): void =>
        setCompletion({
          ...completion,
          index: (completion.index + delta + items.length) % items.length
        })

      if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
        e.preventDefault()
        move(1)
        return
      }
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault()
        move(-1)
        return
      }
      // Ctrl+Enter is excepted: it is documented as the one chord that always
      // asks, so it has to mean that here too rather than accepting whatever the
      // list happens to be pointing at. It falls through to the branch below.
      if (e.key === 'Enter' && !e.ctrlKey) {
        e.preventDefault()
        acceptCompletion(items[completion.index], completion.result)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setCompletion(null)
        return
      }
    }

    // Accept a history suggestion the way fish does: Right or End at the end of
    // the line. Deliberately not Tab, which belongs to shell completion.
    if (ghost && (e.key === 'ArrowRight' || e.key === 'End')) {
      const el = e.currentTarget
      if (el.selectionStart === value.length && el.selectionStart === el.selectionEnd) {
        e.preventDefault()
        acceptSuggestion()
        return
      }
    }

    /*
     * Tab completes, whichever way the line reads.
     *
     * It must never fall through to the browser, which would move focus out of the
     * input entirely — the behaviour that made the editor feel broken — so once the
     * key is taken it has to be spent on something. Gating the completion on the
     * reading spent it on nothing: `kill the proc` reads as a question because of
     * the "the", and Tab there simply vanished. A path or a command name is worth
     * finishing inside a question too — half of what gets asked about is a file —
     * and a completion that finds nothing quietly closes, which is the same silence
     * the shell reading already gives for a token with no matches.
     */
    if (e.key === 'Tab') {
      e.preventDefault()
      void requestCompletions()
      return
    }

    // Shift+Enter always inserts a newline, whichever way the line reads.
    if (e.key === 'Enter' && e.shiftKey) return

    // Ctrl+Enter is the agent regardless of how the buffer reads. Autodetection
    // gets the ordinary cases right, and this is the answer to the one it does
    // not: a question that looks exactly like a command goes to Claude in one
    // chord, without arguing with the label first.
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault()
      // Reaching here with a list open means the list is being abandoned, and its
      // replacement span points into a buffer that is about to be emptied.
      setCompletion(null)
      void askAi('command')
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      if (live === 'agent') void askAi('command')
      else submitShell()
      return
    }

    /*
     * Escape used to dismiss the proposal card first. There is nothing here to
     * dismiss now — the proposal is a block, dismissed from its own buttons — so
     * what it undoes is the attachments, and otherwise it is still the way back to
     * the terminal it has always been.
     *
     * It deliberately does not pin the intent. Doing that made Escape on a question
     * move no focus at all and leave a shell override behind on a line the user was
     * still going to send to Claude, so reaching the terminal took two presses and
     * the first one silently changed where Enter went. Pinning is Ctrl+K's.
     */
    if (e.key === 'Escape') {
      e.preventDefault()
      // The text is deliberately left alone: detaching undoes Ctrl+Up, and taking
      // a half-written question with it would be a second, larger undo that the
      // key was not pressed for.
      if (attached.length > 0) {
        setAttachments([])
        return
      }
      controller.focus()
      return
    }

    // Ctrl+K is handled globally rather than here, so it behaves the same wherever
    // focus happens to be — see the askRequest effect above.

    // Ctrl+C with nothing selected interrupts the running program.
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault()
      controller.send('\x03')
      return
    }

    /*
     * Clear the blocks, rather than send a bare carriage return.
     *
     * Sending one asked the shell to redraw, and its prompt handler then reported a
     * command boundary for a command that was never run — so every Ctrl+L left an
     * empty "(interactive)" block behind holding a copy of the previous command's
     * screen. Clearing the list here is also what the key actually means in a
     * terminal that keeps its output in blocks.
     */
    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      clearBlocks(pane.id)
      return
    }

    // History only when the caret is on the first/last line, so arrows still
    // navigate a multi-line command.
    const el = e.currentTarget
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && history.length > 0) {
      e.preventDefault()
      const next = historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(next)
      recall(history[next])
      return
    }
    if (e.key === 'ArrowDown' && el.selectionStart === el.value.length && historyIdx !== null) {
      e.preventDefault()
      const next = historyIdx + 1
      if (next >= history.length) {
        setHistoryIdx(null)
        // Back past the newest entry is an empty line, not a recalled one, and an
        // empty buffer is what ends an override anyway.
        setValue('')
      } else {
        setHistoryIdx(next)
        recall(history[next])
      }
    }
  }

  // While a program is running, typing should go straight to it rather than
  // queueing up a new command line.
  if (running) {
    return <RunningInput pane={pane} controller={controller} />
  }

  return (
    <div className="composer">
      {completion && (
        <div className="complete">
          <div className="complete__list">
            {completion.result.items.map((item, i) => (
              <button
                key={`${item.text}-${i}`}
                className={`complete__item ${i === completion.index ? 'complete__item--on' : ''}`}
                // Mouse-down, not click: the input must not lose focus first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  acceptCompletion(item, completion.result)
                }}
              >
                <span className="complete__label">{item.label}</span>
                <span className="complete__type">{shortType(item.type)}</span>
              </button>
            ))}
          </div>
          <div className="complete__foot">
            <span>
              {completion.result.items.length} matches ·{' '}
              {completion.result.source === 'powershell' ? 'PowerShell' : 'paths'}
            </span>
            <span>
              <kbd>Tab</kbd> next · <kbd>Enter</kbd> accept · <kbd>Esc</kbd> dismiss
            </span>
          </div>
        </div>
      )}

      {/*
        Where you are, which branch and how much is uncommitted used to be chips
        along here. They are standing facts about the session rather than anything
        to do with what is being typed, so they live in the status bar now and the
        composer is an input again. What is left is the pane telling you about
        itself — a shell still starting, or one that has exited — which is about
        this composer and belongs to it.
      */}
      {(pane.integration === 'pending' || pane.exited) && (
        <div className="composer__meta">
          {pane.integration === 'pending' && (
            <span className="composer__badge" title="Waiting for the shell to report a prompt">
              starting…
            </span>
          )}
          {pane.exited && (
            <>
              <span className="composer__badge composer__badge--warn">
                exited {pane.exitCode ?? ''}
              </span>
              {/*
                A shell that has gone used to leave the pane with nothing to do but
                be closed — which threw away its blocks as well, and they are the
                reason to still be looking at it. The pane is the same pane: the
                history stays and the new shell opens where the old one was.
              */}
              <button
                className="block__action"
                data-restart="shell"
                title="Start a new shell in this pane"
                onClick={() => controller.restart()}
              >
                restart
              </button>
            </>
          )}
        </div>
      )}

      <div className={`composer__row ${intent === 'agent' ? 'composer__row--ai' : ''}`}>
        <span className="composer__sigil">{intent === 'agent' ? '✦' : '❯'}</span>
        <div className="composer__field">
          {/*
            Always rendered, even with nothing to show. React reconciles unkeyed
            children by position, so conditionally inserting this div ahead of the
            textarea remounts the textarea and silently drops focus.
          */}
          <div className="composer__ghost" aria-hidden="true">
            {ghost && (
              <>
                <span className="composer__ghost-typed">{value}</span>
                <span className="composer__ghost-rest">{ghost}</span>
              </>
            )}
          </div>
          <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          spellCheck={false}
          autoFocus
          value={value}
          placeholder={
            intent === 'agent' ? 'describe what you want to do…' : pane.exited ? 'shell exited' : ''
          }
          onChange={(e) => {
            setValue(e.target.value)
            // Any edit invalidates an open list; its replacement span is stale.
            if (completion) setCompletion(null)
            completionSeq.current++
          }}
          onKeyDown={onKeyDown}
          />
        </div>
        {/*
          How many failures the question is carrying, counted rather than listed.

          The chips themselves belong to the block, where they are still readable
          tomorrow; here they would crowd the row for the few seconds between
          attaching and sending, and what matters in those seconds is only that
          something is attached.
        */}
        {attached.length > 0 && (
          <span className="composer__attach">
            {attached.length === 1 ? '1 block attached' : `${attached.length} blocks attached`}
          </span>
        )}

        {/*
          What pressing Enter will do, said before it is pressed.

          The word beside it is the difference between a reading and a decision: the
          composer classifies what is typed, and a guess that presents itself as a
          setting is worse than no label at all. Ctrl+K removes the word by making
          the choice a real one.
        */}
        <span className={`composer__intent ${intent === 'agent' ? 'composer__intent--ai' : ''}`}>
          {intent}
        </span>
        {override === null && <span className="composer__auto">autodetected</span>}
      </div>

      <div className="composer__hint">
        <span>
          <kbd>Ctrl</kbd> <kbd>K</kbd> {intent === 'agent' ? 'pin shell' : 'pin agent'}
        </span>
        <span>
          <kbd>Ctrl</kbd> <kbd>Enter</kbd> send to agent
        </span>
        {hasFailed && (
          <span>
            <kbd>Ctrl</kbd> <kbd>↑</kbd> attach failed block
          </span>
        )}
        {attached.length > 0 && (
          <span>
            <kbd>Esc</kbd> detach all
          </span>
        )}
        <span>
          <kbd>Shift</kbd> <kbd>Enter</kbd> newline
        </span>
        {hasFailed && (
          <button className="block__action" onClick={() => void askAi('explain')}>
            explain last error
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Input for a program that is already running. Split out from the main composer
 * because it has different rules: no history, no AI, and when the program is
 * asking for a secret the value must be masked and never retained.
 */
/**
 * The keys a program reads one at a time, and what they are on the wire.
 *
 * Normal-mode sequences rather than application-mode ones. A program that has set
 * DECCKM strictly wants `ESC O A`, but every terminal UI library in use accepts
 * both spellings, and choosing wrongly here is a menu that ignores an arrow —
 * exactly what this is fixing. Measured against `ollama`, whose menu moves.
 */
const KEY_SEQUENCES: Record<string, string> = {
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D',
  Home: '\x1b[H',
  End: '\x1b[F',
  PageUp: '\x1b[5~',
  PageDown: '\x1b[6~',
  Escape: '\x1b',
  Tab: '\t',
  Backspace: '\x7f'
}

function RunningInput({ pane, controller }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const secretRef = useRef<HTMLInputElement>(null)
  const runningRef = useRef<HTMLTextAreaElement>(null)
  const secret = pane.awaitingSecret

  /*
   * Take the focus the composer just lost.
   *
   * Starting a command swaps this component in for the one the user was typing
   * into, and the element they were focused on goes with it — so focus fell to the
   * document body and every key here, including the Ctrl+C this very panel
   * advertises as "interrupt", reached nothing at all. A running program could not
   * be stopped from the keyboard.
   *
   * Only when nothing else has taken focus in the meantime, so a command finishing
   * while the user is typing in the editor does not drag them back to the terminal.
   */
  useEffect(() => {
    const active = document.activeElement
    if (active && active !== document.body) return
    runningRef.current?.focus()
  }, [secret])

  const submit = (): void => {
    if (secret) {
      // Read straight from the DOM node and clear it. A React-controlled value
      // would be mirrored into the element's value attribute, leaving the secret
      // in the serialized DOM even though it renders masked.
      const node = secretRef.current
      if (!node) return
      controller.sendSecret(node.value)
      node.value = ''
      return
    }
    controller.send(`${value}\r`)
    setValue('')
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    /*
     * With nothing typed, the keys belong to the program.
     *
     * This panel is a line editor: it buffers what you type and sends it on Enter,
     * which is right for anything reading lines — a REPL, a prompt, a password. It
     * is wrong for a program reading one key at a time, and there is no signal
     * separating the two, because a menu drawn without taking the alternate screen
     * looks to this app exactly like a command printing output. `ollama` with no
     * arguments draws one: the arrow keys went into this box and moved a caret,
     * while the highlight in the menu above never moved.
     *
     * An empty buffer is the honest test. Nothing typed means there is nothing here
     * for an arrow to do, so the program should have it; once there is a line in
     * progress the keys edit that line, which is what somebody typing expects.
     * Never while a secret is being asked for — those keystrokes belong to nobody.
     */
    const sequence = KEY_SEQUENCES[e.key]
    if (sequence && !secret && value.length === 0 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      controller.send(sequence)
      return
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      submit()
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      setValue('')
      if (secretRef.current) secretRef.current.value = ''
      controller.send('\x03')
      return
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      controller.send('\x04')
    }
  }

  return (
    <div className="composer">
      <div className="composer__meta">
        <span className="composer__badge composer__badge--warn">running</span>
        {secret ? (
          <span className="composer__cwd">input hidden — sent straight to the program</span>
        ) : (
          <span className="composer__cwd">input goes to the running program</span>
        )}
      </div>
      <div className={`composer__row ${secret ? 'composer__row--secret' : ''}`}>
        <span className="composer__sigil">{secret ? '🔒' : '›'}</span>
        {/*
          A textarea cannot mask its content, so a secret prompt swaps in a
          password input. Both are controlled, so the value is cleared from React
          state on submit rather than lingering in the DOM.
        */}
        {secret ? (
          <input
            ref={secretRef}
            className="composer__input"
            type="password"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            // Intentionally uncontrolled — see submit().
            defaultValue=""
            onKeyDown={onKeyDown}
          />
        ) : (
          <textarea
            ref={runningRef}
            className="composer__input"
            rows={1}
            spellCheck={false}
            placeholder="send to process…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
          />
        )}
      </div>
      <div className="composer__hint">
        {secret && <span>not saved to history</span>}
        <span>
          <kbd>Ctrl</kbd> <kbd>C</kbd> interrupt
        </span>
        <span>
          <kbd>Shift</kbd> <kbd>Tab</kbd> leave terminal
        </span>
        <span>
          <kbd>Ctrl</kbd> <kbd>D</kbd> end input
        </span>
      </div>
    </div>
  )
}

/** Compress PowerShell's CompletionResultType names into a short badge. */
function shortType(type: string): string {
  switch (type) {
    case 'ProviderContainer':
      return 'dir'
    case 'ProviderItem':
      return 'file'
    case 'Command':
      return 'cmd'
    case 'ParameterName':
      return 'param'
    case 'ParameterValue':
      return 'value'
    case 'Property':
      return 'prop'
    case 'Method':
      return 'method'
    case 'Variable':
      return 'var'
    case 'Type':
      return 'type'
    case 'Keyword':
      return 'kw'
    default:
      return type.toLowerCase().slice(0, 6)
  }
}

/** How much of one block's output travels with a question. */
const OUTPUT_LIMIT = 4000

/**
 * The text of a block's rendered output, and whether it is all of it.
 *
 * Elision is not decided here, and deliberately so. A long capture has already
 * lost its beginning by the time it is a block — the offscreen terminal says so
 * with a .block__elided line at the top of the output it kept — and the cap below
 * is the second cut, the one this file has always made before handing output to
 * the model. Both are reported, so what a chip calls elided is what was actually
 * dropped rather than a third rule invented alongside them.
 */
function blockOutput(html: string): { text: string; elided: boolean } {
  const text = textFromHtml(html)
  return {
    text: text.slice(0, OUTPUT_LIMIT),
    elided: text.length > OUTPUT_LIMIT || html.includes('block__elided')
  }
}

/**
 * One command as the model reads it: what ran, where, how it ended, what it said.
 *
 * Whether it was cut is carried as a flag rather than left to be inferred from the
 * length. Main caps these too, and its cap is the same 4000 — so a length test
 * there can never fire for anything sent from here, and a log that was cut would
 * reach the model ending mid-line with nothing saying so. It would then answer
 * about the last thing it could see, which for a build failure is a downstream
 * symptom rather than the first error. One flag says it once, and the chip beside
 * the question and the text the model is given agree about the same block.
 */
function asContext(block: CommandBlock): {
  command: string
  output: string
  exitCode: number
  cwd: string
  elided: boolean
} {
  const { text, elided } = blockOutput(block.output)
  return {
    command: block.command,
    output: text,
    exitCode: block.exitCode ?? 0,
    cwd: block.cwd,
    elided
  }
}
