import { useEffect, useRef, useState } from 'react'
import { activeDocument, useStore } from '../state/store'
import type { AgentTurn, AiChatEvent } from '@shared/types'
import { openLocalProposal } from '../state/ide'
import { modelUri, monaco } from '../editor/monaco'
import { existingController } from '../terminal/controller'

/**
 * The conversation surface: Claude's side of the window.
 *
 * Blocks keep the one-shot asks — a question about a failure belongs in the
 * terminal's own timeline, beside the command it is about. What blocks cannot
 * hold is a conversation: follow-ups interleaved between commands turn two
 * timelines into noise. So the thread lives here, one per session, restored
 * with it: streaming answers, a way to stop them, and the model's proposals as
 * cards that feed the same accept/reject diff flow the CLI integration uses.
 */

/*
 * One subscription routes every stream to its turn. Deltas are buffered and
 * flushed on a short timer rather than patched one by one — a fast stream can
 * deliver dozens of events a second, and each patch is a store update.
 */
const routes = new Map<string, { tabId: string; turnId: string; text: string }>()
let subscribed = false
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flushRoutes(): void {
  flushTimer = null
  const s = useStore.getState()
  for (const [, route] of routes) {
    s.threadPatch(route.tabId, route.turnId, { text: route.text })
  }
}

function onChatEvent(event: AiChatEvent): void {
  const route = routes.get(event.requestId)
  if (!route) return
  if (event.delta) {
    route.text += event.delta
    if (!flushTimer) flushTimer = setTimeout(flushRoutes, 50)
  }
  if (event.done) {
    routes.delete(event.requestId)
    const s = useStore.getState()
    s.threadPatch(route.tabId, route.turnId, {
      text: route.text,
      status: event.done === 'complete' ? 'done' : event.done === 'cancelled' ? 'cancelled' : 'error',
      error: event.error
    })
  }
}

function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.ember.onAiChatEvent(onChatEvent)
}

/** The terminal a thread's context comes from: active if it is one, else first. */
function contextPane(): { id: string; cwd: string; profileId: string } | null {
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  if (!tab) return null
  const active = s.panes[tab.activePaneId]
  const pane =
    active?.kind === 'terminal'
      ? active
      : Object.values(s.panes).find((p) => p.kind === 'terminal')
  return pane?.kind === 'terminal'
    ? { id: pane.id, cwd: pane.cwd, profileId: pane.profileId }
    : null
}

/** How much of the active file rides along as context. */
const FILE_CONTEXT_CAP = 30_000

/**
 * Send a prompt into the active session's thread, opening the panel to answer.
 * Exported for the composer: Ctrl+Enter there and typing here are one path.
 */
export function sendToAgent(prompt: string, attached?: string[]): void {
  const trimmed = prompt.trim()
  if (!trimmed) return
  const s = useStore.getState()
  const tab = s.tabs.find((t) => t.id === s.activeTabId)
  if (!tab) return
  s.toggleAgent(true)

  // The request carries the thread as it stood, then the new question.
  const history = tab.thread
    .filter((t) => t.text.trim().length > 0 && t.status !== 'error')
    .slice(-16)
    .map((t) => ({ role: t.role, text: t.text }))

  const turnId = crypto.randomUUID()
  s.threadAppend(tab.id, {
    id: crypto.randomUUID(),
    role: 'user',
    text: trimmed,
    at: Date.now(),
    status: 'done'
  })
  s.threadAppend(tab.id, {
    id: turnId,
    role: 'assistant',
    text: '',
    at: Date.now(),
    status: 'streaming'
  })

  const pane = contextPane()
  const active = s.panes[tab.activePaneId]
  let activeFile: { path: string; text: string } | undefined
  if (s.mode === 'ide' && active?.kind === 'editor') {
    const doc = activeDocument(active)
    if (doc.filePath) {
      // The buffer, not the file: unsaved edits are exactly the part of the
      // context a question about the open file is most likely to be about.
      const model = monaco.editor.getModel(modelUri(doc.filePath))
      const text = (model?.getValue() ?? doc.savedContent).slice(0, FILE_CONTEXT_CAP)
      activeFile = { path: doc.filePath, text }
    }
  }

  routes.set(turnId, { tabId: tab.id, turnId, text: '' })
  ensureSubscribed()
  window.ember.aiChat({
    requestId: turnId,
    messages: [...history, { role: 'user', text: trimmed }],
    cwd: pane?.cwd ?? '',
    shell: pane?.profileId ?? '',
    activeFile,
    attached
  })
}

/** A turn's text, split into prose and the fenced proposals inside it. */
type Segment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; lang: string; body: string }
  | { kind: 'file'; path: string; lang: string; body: string }
  | { kind: 'run'; body: string }

function segmentsOf(text: string): Segment[] {
  const out: Segment[] = []
  const fence = /```([^\n]*)\n([\s\S]*?)```/g
  let last = 0
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) })
    const info = m[1].trim()
    const body = m[2]
    const path = info.match(/path=(\S+)/)?.[1]
    if (info === 'run' || info.startsWith('run ')) out.push({ kind: 'run', body: body.trim() })
    else if (path) out.push({ kind: 'file', path, lang: info.split(/\s/)[0] ?? '', body })
    else out.push({ kind: 'code', lang: info, body })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) })
  return out
}

/** A model path, resolved the way a person reading it would resolve it. */
function resolveAgainstCwd(raw: string): string {
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return raw
  const cwd = contextPane()?.cwd ?? ''
  return `${cwd.replace(/[\\/]+$/, '')}\\${raw.replace(/^\.[\\/]/, '')}`
}

export function AgentPanel(): React.JSX.Element | null {
  const tab = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId))
  const width = useStore((s) => s.agentWidth)
  const setAgentWidth = useStore((s) => s.setAgentWidth)
  const toggleAgent = useStore((s) => s.toggleAgent)
  const threadClear = useStore((s) => s.threadClear)
  const [draft, setDraft] = useState('')
  /** A sieve over the thread: matching turns stay lit, the rest step back. */
  const [filter, setFilter] = useState('')
  const scroll = useRef<HTMLDivElement>(null)

  const thread = tab?.thread ?? []
  const streaming = thread.some((t) => t.status === 'streaming')

  // The newest words stay on screen while they arrive.
  useEffect(() => {
    const el = scroll.current
    if (el) el.scrollTop = el.scrollHeight
  }, [thread])

  if (!tab) return null

  const send = (): void => {
    if (streaming) return
    sendToAgent(draft)
    setDraft('')
  }

  const stop = (): void => {
    const live = thread.find((t) => t.status === 'streaming')
    if (live) window.ember.aiChatCancel(live.id)
  }

  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const onMove = (ev: MouseEvent): void => {
      setAgentWidth(window.innerWidth - ev.clientX)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <aside className="agent" style={{ width }} aria-label="Claude">
      <div className="agent__resize" role="separator" aria-orientation="vertical" onMouseDown={startResize} />
      <div className="agent__head">
        <span className="agent__title">✦ Claude</span>
        <input
          className="agent__filter"
          placeholder="Search thread…"
          aria-label="Search this conversation"
          value={filter}
          spellCheck={false}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="agent__spacer" />
        <button
          className="icon-btn"
          title="Clear this session's conversation"
          aria-label="Clear conversation"
          onClick={() => threadClear(tab.id)}
        >
          ⌫
        </button>
        <button
          className="icon-btn"
          title="Close (Ctrl+Shift+B)"
          aria-label="Close the Claude panel"
          onClick={() => toggleAgent(false)}
        >
          ✕
        </button>
      </div>

      <div className="agent__scroll" ref={scroll}>
        {thread.length === 0 && (
          <div className="agent__empty">
            A conversation for this session. Ask here, or send the composer&rsquo;s text
            over with <kbd>Ctrl</kbd> <kbd>Enter</kbd> — answers stream, follow-ups
            remember, and proposals arrive as things you can apply.
          </div>
        )}
        {filter.trim().length > 0 && (
          <div className="agent__meta">
            {thread.filter((t) => t.text.toLowerCase().includes(filter.trim().toLowerCase())).length}{' '}
            of {thread.length} turns match
          </div>
        )}
        {thread.map((turn) => (
          <div
            key={turn.id}
            className={`agent__turn agent__turn--${turn.role} ${
              filter.trim().length > 0 &&
              !turn.text.toLowerCase().includes(filter.trim().toLowerCase())
                ? 'agent__turn--dimmed'
                : ''
            }`}
          >
            <div className="agent__who">{turn.role === 'user' ? 'you' : '✦ claude'}</div>
            {turn.role === 'user' ? (
              <div className="agent__text">{turn.text}</div>
            ) : (
              <TurnBody turn={turn} />
            )}
            {turn.status === 'cancelled' && <div className="agent__meta">stopped</div>}
            {turn.status === 'error' && (
              <div className="agent__error">{turn.error ?? 'The request failed.'}</div>
            )}
          </div>
        ))}
      </div>

      <div className="agent__foot">
        {/* One box that is the input: the button lives inside its border, so the
            panel does not spend a column of empty space keeping it company. */}
        <div className="agent__inputbox">
          <textarea
            className="agent__input"
            placeholder={streaming ? 'Answering — your next question can wait here…' : 'Ask about this session…'}
            value={draft}
            rows={2}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="agent__foot-actions">
            {streaming ? (
              <button className="btn agent__send" onClick={stop} aria-label="Stop answering">
                Stop
              </button>
            ) : (
              <button
                className="btn agent__send"
                onClick={send}
                disabled={draft.trim().length === 0}
                aria-label="Send to Claude"
              >
                Send
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  )
}

/*
 * Markdown, at the size a panel needs and no larger: headings, lists, bold,
 * italics, inline code, and links that open in the browser. No dependency —
 * a renderer this small is easier to trust than a bundle, and everything it
 * cannot parse falls through as the plain text it was.
 */
function inlineProse(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\(https?:[^\s)]+\))/g
  let last = 0
  let n = 0
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const token = m[0]
    const key = `${keyBase}-${n++}`
    if (token.startsWith('`')) {
      out.push(<code key={key}>{token.slice(1, -1)}</code>)
    } else if (token.startsWith('**')) {
      out.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else if (token.startsWith('[')) {
      const label = token.slice(1, token.indexOf(']'))
      const url = token.slice(token.indexOf('(') + 1, -1)
      out.push(
        <a
          key={key}
          href={url}
          data-url={url}
          onClick={(e) => {
            e.preventDefault()
            window.ember.openExternal(url)
          }}
        >
          {label}
        </a>
      )
    } else {
      out.push(<em key={key}>{token.slice(1, -1)}</em>)
    }
    last = m.index + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function renderProse(text: string, keyBase: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  const lines = text.split('\n')
  let list: string[] = []
  let n = 0

  const flushList = (): void => {
    if (list.length === 0) return
    const items = list
    list = []
    out.push(
      <ul key={`${keyBase}-ul${n++}`} className="agent__list">
        {items.map((item, i) => (
          <li key={i}>{inlineProse(item, `${keyBase}-li${n}-${i}`)}</li>
        ))}
      </ul>
    )
  }

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    if (bullet) {
      list.push(bullet[1])
      continue
    }
    flushList()
    const heading = line.match(/^(#{1,3})\s+(.*)$/)
    if (heading) {
      out.push(
        <div key={`${keyBase}-h${n++}`} className="agent__heading">
          {inlineProse(heading[2], `${keyBase}-ht${n}`)}
        </div>
      )
      continue
    }
    out.push(
      <span key={`${keyBase}-p${n++}`}>
        {inlineProse(line, `${keyBase}-pt${n}`)}
        {'\n'}
      </span>
    )
  }
  flushList()
  return out
}

function TurnBody({ turn }: { turn: AgentTurn }): React.JSX.Element {
  return (
    <div className="agent__text">
      {segmentsOf(turn.text).map((seg, i) => {
        if (seg.kind === 'text') return <span key={i}>{renderProse(seg.text, `s${i}`)}</span>
        if (seg.kind === 'code')
          return (
            <pre key={i} className="agent__code">
              {seg.body}
            </pre>
          )
        if (seg.kind === 'run')
          return (
            <div key={i} className="agent__card">
              <pre className="agent__code">{seg.body}</pre>
              <div className="agent__card-actions">
                <button
                  className="btn"
                  onClick={() => {
                    // A click is consent: this runs in the session's terminal.
                    const pane = contextPane()
                    if (pane) existingController(pane.id)?.runCommand(seg.body)
                  }}
                >
                  Run
                </button>
                <button className="btn" onClick={() => void navigator.clipboard.writeText(seg.body)}>
                  Copy
                </button>
              </div>
            </div>
          )
        return (
          <div key={i} className="agent__card">
            <div className="agent__card-path">{seg.path}</div>
            <pre className="agent__code agent__code--clamped">{seg.body}</pre>
            <div className="agent__card-actions">
              <button
                className="btn"
                onClick={() => void openLocalProposal(resolveAgainstCwd(seg.path), seg.body)}
              >
                Open diff
              </button>
            </div>
          </div>
        )
      })}
      {turn.status === 'streaming' && <span className="agent__cursor">▍</span>}
    </div>
  )
}
