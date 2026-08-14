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
  const profileName = useStore((s) => s.profiles.find((p) => p.id === pane.profileId)?.name)

  // The controller is created once per pane; later font and theme changes go
  // through setFont/setPalette rather than recreating the terminal.
  const controller = getController(pane.id, fontFamily, fontSize, palette)

  // Two separate reasons to hand the whole pane to the terminal: a full-screen
  // program has taken over, or this shell never reports command boundaries and so
  // has no blocks to show. Both present as an ordinary terminal.
  const plain = pane.integration === 'absent'
  const raw = pane.mode === 'raw' || plain
  const running = !plain && pane.blocks.at(-1)?.status === 'running'

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

  /*
   * Shift+Tab leaves the terminal.
   *
   * xterm takes every key, so without somewhere to send focus the pane was a
   * keyboard trap: once in, there was no way out without a mouse. The composer is
   * the natural landing place — it is the same pane, and Tab from there reaches the
   * rest of the app normally.
   */
  useEffect(() => {
    controller.onEscapeFocus = () => {
      const composer = termHost.current
        ?.closest('.pane')
        ?.querySelector<HTMLElement>('.composer__input')
      if (composer) composer.focus()
      else termHost.current?.closest<HTMLElement>('.pane')?.focus()
    }
    return () => {
      controller.onEscapeFocus = null
    }
  }, [controller])

  // Keep the newest block in view as output lands.
  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [pane.blocks.length, running])

  const rerun = (command: string): void => {
    if (command.trim().length > 0) controller.runCommand(command)
  }

  return (
    <div
      className={`pane ${active ? 'pane--active' : ''}`}
      onMouseDown={onFocus}
      // Reflects shell-integration state for styling and for the verify harness,
      // which must not have to infer readiness from UI label text.
      data-integration={pane.integration}
    >
      {!raw && (
        <div className="pane__scroll" ref={scroller}>
          {pane.blocks.length === 0 && pane.integration === 'pending' && (
            <div className="block">
              <div className="block__body block__body--empty">
                Starting shell… command blocks appear once shell integration loads.
              </div>
            </div>
          )}
          {/* Once the shell is up and nothing has been run, the pane was simply
              blank — which says nothing about what this app does differently, or
              that there is an editor and a workspace a keystroke away. */}
          {pane.blocks.length === 0 && pane.integration === 'ready' && (
            <div className="block">
              <div className="block__body block__body--empty">
                <div>Run a command — each one becomes a block with its exit code and timing.</div>
                <div className="pane__hints">
                  {/* First, because it is the thing this app does that a terminal
                      does not, and nothing else on screen hints that it can. */}
                  <span>
                    <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>I</kbd> turn into an IDE
                  </span>
                  <span>
                    <kbd>Ctrl</kbd> <kbd>K</kbd> ask Claude for a command
                  </span>
                  <span>
                    <kbd>Ctrl</kbd> <kbd>B</kbd> files
                  </span>
                  <span>
                    <kbd>Ctrl</kbd> <kbd>P</kbd> go to file
                  </span>
                  <span>
                    <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>P</kbd> all commands
                  </span>
                </div>
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

      {/*
        Say why the block UI is missing, so a plain pane reads as a deliberate
        fallback rather than a broken one.
      */}
      {plain && (
        <div className="pane__notice">
          <span>{profileName ?? 'This shell'} has no shell integration — plain terminal mode.</span>
          {pane.exited && <span>· exited {pane.exitCode ?? ''}</span>}
        </div>
      )}
    </div>
  )
}
