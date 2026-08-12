import { useEffect, useRef, useState } from 'react'
import type { AiResponse, CompletionItem, CompletionResult } from '@shared/types'
import { commonPrefix } from '@shared/completion'
import type { TerminalController } from '../terminal/controller'
import { useStore, type TerminalPaneState } from '../state/store'

interface Props {
  pane: TerminalPaneState
  controller: TerminalController
}

type Mode = 'shell' | 'ai'

/**
 * A real editor for the command line: multi-line, history, and a natural-language
 * mode. Replaces the shell's own readline for typing, but keystrokes still reach
 * the pty whenever a program is actually reading stdin.
 */
export function InputEditor({ pane, controller }: Props): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('shell')
  const [value, setValue] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [historyIdx, setHistoryIdx] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [proposal, setProposal] = useState<AiResponse | null>(null)
  const [completion, setCompletion] = useState<{ result: CompletionResult; index: number } | null>(
    null
  )
  const ref = useRef<HTMLTextAreaElement>(null)
  /** Guards against a slow completion reply landing after the input moved on. */
  const completionSeq = useRef(0)

  const running = pane.blocks.at(-1)?.status === 'running'
  const pending = useStore((st) => st.pendingInput[pane.id])

  // History search hands a command over rather than running it, so the user can
  // read and edit it before committing.
  useEffect(() => {
    if (pending === undefined) return
    setValue(pending)
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

  const submitShell = (): void => {
    const command = value
    if (command.trim().length === 0) return
    setHistory((h) => [...h.filter((c) => c !== command.trim()), command.trim()].slice(-500))
    setHistoryIdx(null)
    setValue('')
    setProposal(null)
    controller.runCommand(command)
  }

  const askAi = async (requestMode: 'command' | 'explain'): Promise<void> => {
    const intent = value.trim()
    if (requestMode === 'command' && intent.length === 0) return

    setBusy(true)
    setProposal(null)

    // Give the model the failing commands it needs to explain an error.
    const recent = pane.blocks
      .slice(-3)
      .filter((b) => b.status !== 'running')
      .map((b) => ({
        command: b.command,
        output: plainText(b.output),
        exitCode: b.exitCode ?? 0
      }))

    const res = await window.ember.ai({
      intent: requestMode === 'explain' && intent.length === 0 ? 'Why did that fail?' : intent,
      shell: pane.profileId,
      cwd: pane.cwd,
      recent,
      mode: requestMode
    })

    setBusy(false)
    setProposal(res)
  }

  const acceptProposal = (run: boolean): void => {
    const command = proposal?.command
    if (!command) return
    setProposal(null)
    setMode('shell')
    if (run) {
      setValue('')
      controller.runCommand(command)
    } else {
      setValue(command)
      ref.current?.focus()
    }
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

  const acceptCompletion = (item: CompletionItem, result: CompletionResult): void => {
    applyCompletion(item.text, result)
    setCompletion(null)
    ref.current?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
      if (e.key === 'Enter') {
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

    // Tab must never fall through to the browser, which would move focus out of
    // the input entirely — the behaviour that made the editor feel broken.
    if (e.key === 'Tab') {
      e.preventDefault()
      if (mode === 'shell') void requestCompletions()
      return
    }

    // Shift+Enter always inserts a newline, in either mode.
    if (e.key === 'Enter' && e.shiftKey) return

    if (e.key === 'Enter') {
      e.preventDefault()
      if (mode === 'ai') void askAi('command')
      else submitShell()
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      if (proposal) setProposal(null)
      else if (mode === 'ai') setMode('shell')
      else controller.focus()
      return
    }

    // Ctrl+K toggles natural language mode.
    if (e.ctrlKey && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      setMode((m) => (m === 'ai' ? 'shell' : 'ai'))
      return
    }

    // Ctrl+C with nothing selected interrupts the running program.
    if (e.ctrlKey && e.key.toLowerCase() === 'c' && !window.getSelection()?.toString()) {
      e.preventDefault()
      controller.send('\x03')
      return
    }

    if (e.ctrlKey && e.key.toLowerCase() === 'l') {
      e.preventDefault()
      controller.runCommand('')
      return
    }

    // History only when the caret is on the first/last line, so arrows still
    // navigate a multi-line command.
    const el = e.currentTarget
    if (e.key === 'ArrowUp' && el.selectionStart === 0 && history.length > 0) {
      e.preventDefault()
      const next = historyIdx === null ? history.length - 1 : Math.max(0, historyIdx - 1)
      setHistoryIdx(next)
      setValue(history[next])
      return
    }
    if (e.key === 'ArrowDown' && el.selectionStart === el.value.length && historyIdx !== null) {
      e.preventDefault()
      const next = historyIdx + 1
      if (next >= history.length) {
        setHistoryIdx(null)
        setValue('')
      } else {
        setHistoryIdx(next)
        setValue(history[next])
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

      <div className="composer__meta">
        <span className="composer__cwd">{pane.cwd}</span>
        {pane.integration === 'pending' && (
          <span className="composer__badge" title="Waiting for the shell to report a prompt">
            starting…
          </span>
        )}
        {pane.exited && (
          <span className="composer__badge composer__badge--warn">
            exited {pane.exitCode ?? ''}
          </span>
        )}
      </div>

      <div className={`composer__row ${mode === 'ai' ? 'composer__row--ai' : ''}`}>
        <span className="composer__sigil">{mode === 'ai' ? '✦' : '❯'}</span>
        <textarea
          ref={ref}
          className="composer__input"
          rows={1}
          spellCheck={false}
          autoFocus
          value={value}
          placeholder={
            mode === 'ai' ? 'describe what you want to do…' : pane.exited ? 'shell exited' : ''
          }
          onChange={(e) => {
            setValue(e.target.value)
            // Any edit invalidates an open list; its replacement span is stale.
            if (completion) setCompletion(null)
            completionSeq.current++
          }}
          onKeyDown={onKeyDown}
        />
        {busy && <span className="spinner" />}
      </div>

      {proposal && (
        <div className="composer__proposal">
          {proposal.ok ? (
            <>
              {proposal.command && (
                <div className="composer__proposal-cmd">{proposal.command}</div>
              )}
              {proposal.explanation && (
                <div className="composer__proposal-note">{proposal.explanation}</div>
              )}
              {proposal.command && (
                <div className="composer__proposal-actions">
                  <button className="btn btn--primary" onClick={() => acceptProposal(true)}>
                    Run
                  </button>
                  <button className="btn" onClick={() => acceptProposal(false)}>
                    Edit first
                  </button>
                  <button className="btn" onClick={() => setProposal(null)}>
                    Dismiss
                  </button>
                </div>
              )}
            </>
          ) : (
            <div className="composer__error">{proposal.error}</div>
          )}
        </div>
      )}

      <div className="composer__hint">
        <span>
          <kbd>Ctrl</kbd> <kbd>K</kbd> {mode === 'ai' ? 'shell' : 'ask Claude'}
        </span>
        <span>
          <kbd>Shift</kbd> <kbd>Enter</kbd> newline
        </span>
        {pane.blocks.some((b) => b.status === 'failed') && (
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
function RunningInput({ pane, controller }: Props): React.JSX.Element {
  const [value, setValue] = useState('')
  const secretRef = useRef<HTMLInputElement>(null)
  const secret = pane.awaitingSecret

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

function plainText(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.innerText.slice(0, 4000)
}
