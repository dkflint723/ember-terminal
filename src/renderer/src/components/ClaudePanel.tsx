import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'

/**
 * Claude, in the right-hand sidebar.
 *
 * The composer's Ctrl+K asks for one command and puts it on the prompt; this is
 * for the questions that are not a command — why something is shaped the way it
 * is, what to do next, what a file is for. It keeps the exchange on screen, which
 * Ctrl+K deliberately does not: that one answers into the prompt and vanishes.
 *
 * The conversation is per-window and not written to disk. It is a working surface,
 * and a transcript that outlived the session would be a store of whatever happened
 * to be pasted into it.
 */
interface Turn {
  id: number
  from: 'you' | 'claude'
  text: string
  failed?: boolean
}

export function ClaudePanel(): React.JSX.Element {
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const nextId = useRef(0)
  const body = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  const panes = useStore((s) => s.panes)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const profiles = useStore((s) => s.profiles)
  const toggleSecondary = useStore((s) => s.toggleSecondary)

  // The shell and directory the question is being asked from, so answers are about
  // this machine rather than a generic one.
  const tab = tabs.find((t) => t.id === activeTabId)
  const pane = tab ? panes[tab.activePaneId] : undefined
  const terminal =
    pane?.kind === 'terminal'
      ? pane
      : Object.values(panes).find((p) => p.kind === 'terminal')
  const shell =
    profiles.find((p) => p.id === (terminal?.kind === 'terminal' ? terminal.profileId : ''))?.name ??
    'PowerShell'
  const cwd = terminal?.kind === 'terminal' ? terminal.cwd : window.ember.homeDir

  useEffect(() => {
    const el = body.current
    if (el) el.scrollTop = el.scrollHeight
  }, [turns.length, busy])

  const send = async (): Promise<void> => {
    const question = draft.trim()
    if (!question || busy) return
    setDraft('')
    setTurns((prev) => [...prev, { id: nextId.current++, from: 'you', text: question }])
    setBusy(true)

    const res = await window.ember.ai({ intent: question, shell, cwd, mode: 'chat' })
    setBusy(false)
    setTurns((prev) => [
      ...prev,
      {
        id: nextId.current++,
        from: 'claude',
        // A refusal or an outage is shown in the thread rather than as a toast, so
        // it sits next to the question it belongs to.
        text: res.ok ? (res.explanation ?? '') : (res.error ?? 'Claude could not answer.'),
        failed: !res.ok
      }
    ])
  }

  return (
    <div className="claude">
      <div className="claude__head">
        <span className="sidebar__title">Claude</span>
        {turns.length > 0 && (
          <button className="block__action" onClick={() => setTurns([])} disabled={busy}>
            clear
          </button>
        )}
        <button
          className="icon-btn"
          title="Close (Ctrl+Shift+B)"
          aria-label="Close Claude"
          onClick={() => toggleSecondary(false)}
        >
          ✕
        </button>
      </div>

      <div className="claude__body" ref={body}>
        {turns.length === 0 && (
          <div className="claude__empty">
            Ask about the code, the error on screen, or what to do next.
            <div className="claude__where">
              {shell} · {cwd}
            </div>
          </div>
        )}
        {turns.map((turn) => (
          <div key={turn.id} className={`claude__turn claude__turn--${turn.from}`}>
            <div className="claude__who">{turn.from === 'you' ? 'You' : 'Claude'}</div>
            <div className={`claude__text ${turn.failed ? 'claude__text--failed' : ''}`}>
              {turn.text}
            </div>
          </div>
        ))}
        {busy && <div className="claude__turn claude__thinking">Thinking…</div>}
      </div>

      <div className="claude__composer">
        <textarea
          ref={box}
          className="claude__box"
          rows={3}
          placeholder="Ask Claude"
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter breaks the line — the same bargain the
            // terminal composer makes, so the two do not disagree.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
            if (e.key === 'Escape') toggleSecondary(false)
          }}
        />
        <div className="composer__hint">
          <span>
            <kbd>Enter</kbd> send
          </span>
          <span>
            <kbd>Shift</kbd> <kbd>Enter</kbd> newline
          </span>
        </div>
      </div>
    </div>
  )
}
