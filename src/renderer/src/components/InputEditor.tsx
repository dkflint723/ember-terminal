import { useEffect, useRef, useState } from 'react'
import type { AiResponse } from '@shared/types'
import type { TerminalController } from '../terminal/controller'
import type { TerminalPaneState } from '../state/store'

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
  const ref = useRef<HTMLTextAreaElement>(null)

  const running = pane.blocks.at(-1)?.status === 'running'

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

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
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
    return (
      <div className="composer">
        <div className="composer__meta">
          <span className="composer__badge composer__badge--warn">running</span>
          <span className="composer__cwd">input goes to the running program</span>
        </div>
        <div className="composer__row">
          <span className="composer__sigil">›</span>
          <textarea
            className="composer__input"
            rows={1}
            placeholder="send to process…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                controller.send(`${e.currentTarget.value}\r`)
                e.currentTarget.value = ''
              } else if (e.ctrlKey && e.key.toLowerCase() === 'c') {
                e.preventDefault()
                controller.send('\x03')
              } else if (e.ctrlKey && e.key.toLowerCase() === 'd') {
                e.preventDefault()
                controller.send('\x04')
              }
            }}
          />
        </div>
        <div className="composer__hint">
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

  return (
    <div className="composer">
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
          onChange={(e) => setValue(e.target.value)}
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

function plainText(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.innerText.slice(0, 4000)
}
