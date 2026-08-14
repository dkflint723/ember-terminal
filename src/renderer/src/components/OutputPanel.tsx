import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'

/**
 * What the language servers have been saying.
 *
 * VS Code's Output view is where a tool's own logging goes, and the servers are
 * the only things here that log. It exists because a server that fails to start,
 * or refuses a file, otherwise says so only in a notice that has already gone —
 * and "intelligence is missing in this file" is very hard to diagnose blind.
 */
interface Line {
  id: number
  language: string
  text: string
}

const LIMIT = 500

export function OutputPanel(): React.JSX.Element {
  const [lines, setLines] = useState<Line[]>([])
  const [filter, setFilter] = useState<string>('all')
  const nextId = useRef(0)
  const body = useRef<HTMLDivElement>(null)
  const notice = useStore((s) => s.notice)

  useEffect(() => {
    return window.ember.onLspMessage((event) => {
      // Only the parts worth reading: a server's own log messages, and the fact
      // that one stopped. The rest is request traffic and would bury both.
      let text: string | null = null
      if (event.type === 'exit') {
        text = event.error ? `server stopped: ${event.error}` : 'server stopped'
      } else {
        const message = event.message as
          | { method?: unknown; params?: { message?: unknown; type?: unknown } }
          | undefined
        if (message?.method === 'window/logMessage' || message?.method === 'window/showMessage') {
          text = String(message.params?.message ?? '')
        }
      }
      if (!text) return
      setLines((prev) => {
        const line = { id: nextId.current++, language: event.language, text: text! }
        // Bounded, because a server in a failure loop can log without end and this
        // view is a tail rather than an archive.
        return [...prev, line].slice(-LIMIT)
      })
    })
  }, [])

  // Follow the tail, the way a log view is expected to.
  useEffect(() => {
    const el = body.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const languages = [...new Set(lines.map((l) => l.language))].sort()
  const shown = filter === 'all' ? lines : lines.filter((l) => l.language === filter)

  return (
    <div className="output">
      <div className="output__controls">
        <select
          className="output__pick"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label="Which server to show"
        >
          <option value="all">All servers</option>
          {languages.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button className="block__action" onClick={() => setLines([])} disabled={lines.length === 0}>
          clear
        </button>
      </div>

      <div className="output__body" ref={body}>
        {shown.length === 0 ? (
          <div className="probs--empty">
            Nothing logged yet. Language servers report here as they start and run.
          </div>
        ) : (
          shown.map((line) => (
            <div key={line.id} className="output__line">
              <span className="output__from">{line.language}</span>
              <span className="output__text">{line.text}</span>
            </div>
          ))
        )}
        {/* The last notice is repeated here so a message that has already faded is
            still recoverable, which is the whole reason to keep a log. */}
        {notice && <div className="output__line output__line--notice">{notice.text}</div>}
      </div>
    </div>
  )
}
