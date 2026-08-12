import { useEffect, useLayoutEffect, useRef } from 'react'
import { useStore, type TerminalPaneState } from '../state/store'
import { getController } from '../terminal/controller'
import { BlockView } from './BlockView'
import { InputEditor } from './InputEditor'

interface Props {
  pane: TerminalPaneState
  active: boolean
  onFocus: () => void
}

export function TerminalPane({ pane, active, onFocus }: Props): React.JSX.Element {
  const termHost = useRef<HTMLDivElement>(null)
  const liveWrap = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const toggleBlock = useStore((s) => s.toggleBlock)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const fontSize = useStore((s) => s.settings.fontSize)
  const palette = useStore((s) => s.theme.terminal)

  // The controller is created once per pane; later font and theme changes go
  // through setFont/setPalette rather than recreating the terminal.
  const controller = getController(pane.id, fontFamily, fontSize, palette)
  const raw = pane.mode === 'raw'
  const running = pane.blocks.at(-1)?.status === 'running'

  useLayoutEffect(() => {
    if (termHost.current) controller.attach(termHost.current)
  }, [controller])

  // One observer covers pane resize, window resize, and mode changes.
  useEffect(() => {
    const el = liveWrap.current
    if (!el) return
    const ro = new ResizeObserver(() => controller.refit())
    ro.observe(el)
    return () => ro.disconnect()
  }, [controller])

  useEffect(() => {
    controller.setFont(fontFamily, fontSize)
  }, [controller, fontFamily, fontSize])

  useEffect(() => {
    controller.refit()
    if (raw) controller.focus()
  }, [controller, raw, running])

  // Keep the newest block in view as output lands.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [pane.blocks.length, running])

  const rerun = (command: string): void => {
    if (command.trim().length > 0) controller.runCommand(command)
  }

  return (
    <div className={`pane ${active ? 'pane--active' : ''}`} onMouseDown={onFocus}>
      {!raw && (
        <div className="pane__scroll" ref={scroller}>
          {pane.blocks.length === 0 && !pane.integrationReady && (
            <div className="block">
              <div className="block__body block__body--empty">
                Starting shell… command blocks appear once shell integration loads.
              </div>
            </div>
          )}
          {pane.blocks.map((b) => (
            <BlockView
              key={b.id}
              block={b}
              onToggle={() => toggleBlock(pane.id, b.id)}
              onRerun={rerun}
            />
          ))}
        </div>
      )}

      {/*
        The live terminal is always mounted so xterm keeps its state; only its
        box changes. Full pane for full-screen programs, a strip while a command
        is running, collapsed to nothing when idle.
      */}
      <div
        ref={liveWrap}
        className={`live ${raw ? 'live--raw' : running ? '' : 'live--idle'}`}
        style={raw ? undefined : running ? { height: '42%' } : undefined}
      >
        <div ref={termHost} style={{ width: '100%', height: '100%' }} />
      </div>

      {!raw && <InputEditor pane={pane} controller={controller} />}
    </div>
  )
}
