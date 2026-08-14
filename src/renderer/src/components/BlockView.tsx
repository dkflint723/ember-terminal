import { memo } from 'react'
import type { Block } from '../state/store'

interface Props {
  block: Block
  onToggle: () => void
  onRerun: (command: string) => void
}

function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m ${s}s`
}

/**
 * The output HTML comes from xterm's serialize addon operating on bytes this app
 * captured from its own pty, so it is styling markup rather than remote content.
 */
export const BlockView = memo(function BlockView({ block, onToggle, onRerun }: Props) {
  const copy = (e: React.MouseEvent, text: string): void => {
    e.stopPropagation()
    void navigator.clipboard.writeText(text)
  }

  const statusLabel =
    block.status === 'running' ? 'running' : block.status === 'done' ? 'succeeded' : 'failed'

  return (
    <div
      className={`block block--${block.status}`}
      role="group"
      aria-label={`${block.command || 'interactive command'} — ${statusLabel}`}
    >
      {/* A div with a click handler is invisible to the keyboard: it cannot be
          tabbed to and Enter does nothing, so collapsing a block — and reaching the
          copy and re-run controls inside it — needed a mouse. */}
      <div
        className="block__head"
        role="button"
        tabIndex={0}
        aria-expanded={!block.collapsed}
        aria-label={`${block.collapsed ? 'Expand' : 'Collapse'} ${block.command || 'interactive command'}`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          // Space scrolls the pane otherwise, which is the opposite of activating.
          e.preventDefault()
          onToggle()
        }}
      >
        <span className="block__chevron">{block.collapsed ? '▶' : '▼'}</span>
        {/*
          Status carries a glyph as well as a colour. Colour alone is unreadable
          for anyone with a colour vision deficiency, and no palette can fix that
          — the shape has to differ too.
        */}
        <span className={`block__status block__status--${block.status}`} title={statusLabel}>
          {block.status === 'running' ? '●' : block.status === 'done' ? '✓' : '✕'}
        </span>
        <span className="block__cmd">{block.command || '(interactive)'}</span>

        <span className="block__actions">
          <button
            className="block__action"
            title="Copy command"
            onClick={(e) => copy(e, block.command)}
          >
            cmd
          </button>
          <button
            className="block__action"
            title="Copy output"
            onClick={(e) => copy(e, textFrom(block.output))}
          >
            out
          </button>
          <button
            className="block__action"
            title="Run again"
            onClick={(e) => {
              e.stopPropagation()
              onRerun(block.command)
            }}
          >
            ↻
          </button>
        </span>

        <span className="block__meta">
          {block.exitCode !== null && block.exitCode !== 0 && (
            <span className="block__exit">exit {block.exitCode}</span>
          )}
          <span>{formatDuration(block.durationMs)}</span>
        </span>
      </div>

      {!block.collapsed && (
        <div className="block__body">
          {block.status === 'running' ? (
            <span className="block__body--empty">running…</span>
          ) : block.interactive ? (
            <span className="block__body--empty">interactive session</span>
          ) : block.output ? (
            <div dangerouslySetInnerHTML={{ __html: block.output }} />
          ) : (
            <span className="block__body--empty">no output</span>
          )}
        </div>
      )}
    </div>
  )
})

/** Strip serialize-addon markup so "copy output" yields plain text. */
function textFrom(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.innerText
}
