import { memo, useRef } from 'react'
import { useStore, type CommandBlock } from '../state/store'
import { linkHitAt, setLinkHighlight, type LinkHit } from '../terminal/links'

interface Props {
  block: CommandBlock
  onToggle: () => void
  onRerun: (command: string) => void
  /** True while this block's head is the one pinned to the top of the list. */
  stuck?: boolean
}

/**
 * When the command was run, to the second.
 *
 * A duration says how long something took but not when it happened, which is the
 * question asked of a list you have scrolled back into — "was this before or after
 * I changed that file".
 */
function formatTime(at: number): string {
  const d = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
export const BlockView = memo(function BlockView({ block, onToggle, onRerun, stuck }: Props) {
  /*
   * A path or URL under the pointer opens; everything else stays plain text.
   * The work runs at most once a frame, and only the block being pointed at
   * pays for it — the hit test is bounded to this body by linkHitAt itself.
   */
  const hoverFrame = useRef(0)

  const onBodyMove = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const x = e.clientX
    const y = e.clientY
    cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = requestAnimationFrame(() => {
      const hit = linkHitAt(el, x, y)
      setLinkHighlight(hit ? hit.range : null)
      if (hit) el.dataset.link = hit.kind
      else delete el.dataset.link
    })
  }

  const onBodyLeave = (e: React.MouseEvent<HTMLDivElement>): void => {
    cancelAnimationFrame(hoverFrame.current)
    setLinkHighlight(null)
    delete e.currentTarget.dataset.link
  }

  /*
   * Activation is read from the press itself, not from the browser's `click`.
   *
   * Chromium declines to synthesize a click for a real press-and-release on
   * these serialized rows — observed directly: pointerdown, mousedown and
   * mouseup all arrive on the row and no click ever follows, while the same
   * gesture on the head's span forms one. Rather than depend on a synthesis
   * rule that plainly excludes this content, the body does what a terminal
   * does: notes where the press started, and if the release is the same place
   * a moment later with nothing selected, that was a click.
   */
  const pressAt = useRef<{ x: number; y: number; at: number } | null>(null)

  const onBodyDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (e.button === 0) pressAt.current = { x: e.clientX, y: e.clientY, at: Date.now() }
  }

  const onBodyUp = (e: React.MouseEvent<HTMLDivElement>): void => {
    const press = pressAt.current
    pressAt.current = null
    if (!press || e.button !== 0) return
    // A drag is a selection; a slow press is a hesitation. Neither navigates.
    if (Math.abs(e.clientX - press.x) > 4 || Math.abs(e.clientY - press.y) > 4) return
    if (Date.now() - press.at > 600) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    const hit = linkHitAt(e.currentTarget, e.clientX, e.clientY)
    if (!hit) return
    e.stopPropagation()
    if (hit.kind === 'url') {
      window.ember.openExternal(hit.url ?? '')
      return
    }
    void openFileHit(hit, block.cwd)
  }

  const copy = (e: React.MouseEvent, text: string): void => {
    e.stopPropagation()
    void navigator.clipboard.writeText(text)
  }

  const statusLabel =
    block.status === 'running' ? 'running' : block.status === 'done' ? 'succeeded' : 'failed'

  return (
    <div
      className={`block block--${block.status}`}
      // Read by the ruler, which measures where each block sits rather than being
      // told — the list is the thing that knows its own layout.
      data-block-id={block.id}
      role="group"
      aria-label={`${block.command || 'interactive command'} — ${statusLabel}`}
    >
      {/* A div with a click handler is invisible to the keyboard: it cannot be
          tabbed to and Enter does nothing, so collapsing a block — and reaching the
          copy and re-run controls inside it — needed a mouse. */}
      <div
        className={`block__head ${stuck ? 'block__head--stuck' : ''}`}
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
        <span className="block__chevron">{block.collapsed ? '▸' : '▼'}</span>
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

        {/* Exit code, then time of day, then duration — the order they are asked
            about in: what happened, when, and how long it took. */}
        <span className="block__meta">
          {block.exitCode !== null && block.exitCode !== 0 && (
            <span className="block__exit">exit {block.exitCode}</span>
          )}
          <span className="block__time">{formatTime(block.startedAt)}</span>
          <span>{formatDuration(block.durationMs)}</span>
        </span>
      </div>

      {!block.collapsed && (
        <div
          className="block__body"
          onMouseMove={onBodyMove}
          onMouseLeave={onBodyLeave}
          onMouseDown={onBodyDown}
          onMouseUp={onBodyUp}
        >
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

/**
 * Resolve a clicked path against the directory its command ran in, prove it
 * exists, and hand it to the app to reveal. The existence check is what keeps a
 * false positive quiet: compiler output is full of things shaped like paths,
 * and a click on one that leads nowhere should cost a small notice, not an
 * empty editor tab.
 */
async function openFileHit(hit: LinkHit, cwd: string): Promise<void> {
  const raw = hit.path ?? ''
  const absolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\')
  const full = absolute
    ? raw
    : `${cwd.replace(/[\\/]+$/, '')}\\${raw.replace(/^\.[\\/]/, '')}`
  if (!(await window.ember.pathExists(full))) {
    useStore.getState().setNotice(`${raw} is not there from this block's directory`, 'info')
    return
  }
  window.dispatchEvent(
    new CustomEvent('ember:open-path', {
      detail: { path: full, line: hit.line ?? 1, column: hit.column ?? 1 }
    })
  )
}

/** Strip serialize-addon markup so "copy output" yields plain text. */
function textFrom(html: string): string {
  const el = document.createElement('div')
  el.innerHTML = html
  return el.innerText
}
