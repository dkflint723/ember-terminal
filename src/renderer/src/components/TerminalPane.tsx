import { Fragment, useEffect, useLayoutEffect, useRef } from 'react'
import { useStore, type Block, type TerminalPaneState } from '../state/store'
import { getController } from '../terminal/controller'
import { AgentBlock } from './AgentBlock'
import { BlockView } from './BlockView'
import { InputEditor } from './InputEditor'
import { OverviewRuler, useBlockGeometry } from './OverviewRuler'
import { FindBar } from './FindBar'

interface Props {
  pane: TerminalPaneState
  active: boolean
  onFocus: () => void
}

/**
 * When the restored run happened, in the form a person would say it.
 *
 * The last restored block rather than the first: the mark sits above them all and
 * what someone wants to know is when they were last here, not when that stretch of
 * work began. Both kinds of block carry `restored` and `startedAt`, so the mark
 * reads the same whether the session ended on a command or on a question.
 */
function whenRan(blocks: Block[]): string {
  const last = [...blocks].reverse().find((b) => b.restored)
  if (!last) return 'earlier'
  const at = new Date(last.startedAt)
  const day = at.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return `${day} at ${at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

export function TerminalPane({ pane, active, onFocus }: Props): React.JSX.Element {
  const termHost = useRef<HTMLDivElement>(null)
  const liveWrap = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const toggleBlock = useStore((s) => s.toggleBlock)
  const patchConversation = useStore((s) => s.patchConversation)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const fontSize = useStore((s) => s.settings.fontSize)
  const palette = useStore((s) => s.theme.terminal)
  const mode = useStore((s) => s.mode)
  const profileName = useStore((s) => s.profiles.find((p) => p.id === pane.profileId)?.name)

  // The controller is created once per pane; later font and theme changes go
  // through setFont/setPalette rather than recreating the terminal.
  const controller = getController(pane.id, fontFamily, fontSize, palette)

  // Two separate reasons to hand the whole pane to the terminal: a full-screen
  // program has taken over, or this shell never reports command boundaries and so
  // has no blocks to show. Both present as an ordinary terminal.
  const plain = pane.integration === 'absent'
  const raw = pane.mode === 'raw' || plain

  /*
   * Blocks when the terminal is the app; one continuous stream when it is a panel.
   *
   * The two want opposite things from the same session. With the whole window, a
   * command is worth separating from the one before it — that is what the app is
   * for. Dropped into the bottom third of an IDE it is not: every hairline and
   * status glyph is height taken from the four lines actually being read, and the
   * panel is where people expect a terminal to behave like a terminal.
   *
   * The stream is drawn from the same captured blocks rather than by handing the
   * pane to the live terminal, because the live terminal is a window onto conpty's
   * console buffer and not a record: conpty repaints a small screen instead of
   * scrolling it, so a pane rendered that way holds exactly one screenful and
   * scrolls back to nothing. The captures are where this app's history actually
   * lives, so the stream is those, with the furniture taken off.
   */
  const stream = mode === 'ide' && !raw

  /*
   * Only a command can be running.
   *
   * This drives the strip of live terminal and the scroll-to-bottom, so it has to
   * mean "a program has the pty", not "the list ends in something recent". A
   * conversation block is the other kind now — nothing is attached to it — and it
   * has no status to read at all.
   */
  const last = pane.blocks.at(-1)
  const running = !plain && last?.kind === 'command' && last.status === 'running'

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

  /*
   * Follow the newest output, unless the reader has gone looking at something else.
   *
   * Two things were wrong with pinning this to the block count alone. A command's
   * output is rendered into its block when the command *finishes*, so the tall part
   * arrives without the count changing and nothing moved the view — which is the
   * whole of "I have to drag it down myself". And scrolling unconditionally is its
   * own bug in the other direction: someone reading back through a build log does
   * not want the next line of output to yank them to the end.
   *
   * So it follows only while it is already at the end. The slack is for a wheel
   * notch that lands a pixel short, which is still someone watching the end.
   */
  const stuck = useRef(true)
  const noteScroll = (): void => {
    const el = scroller.current
    if (el) stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
  }

  // The size of what the newest block is holding, which is what changes when output
  // lands in a block that already existed. `last` is read further up the component.
  const lastSize = last ? (last.kind === 'command' ? last.output.length : last.answer.length) : 0

  useEffect(() => {
    const el = scroller.current
    if (el && stuck.current) el.scrollTop = el.scrollHeight
  }, [pane.blocks.length, running, lastSize, mode])

  const rerun = (command: string): void => {
    if (command.trim().length > 0) controller.runCommand(command)
  }

  // Where the blocks sit, for the ruler down the right edge and for knowing which
  // head is pinned. Measured from the DOM, so it follows wrapping and collapsing
  // without either of them having to report anything.
  const findOpen = useStore((s) => s.findPaneId === pane.id)
  const setFind = useStore((s) => s.setFind)

  const geometry = useBlockGeometry(scroller, pane.blocks)

  return (
    <div
      className={`pane ${active ? 'pane--active' : ''}`}
      onMouseDown={onFocus}
      // Reflects shell-integration state for styling and for the verify harness,
      // which must not have to infer readiness from UI label text.
      data-integration={pane.integration}
    >
      {!raw && findOpen && (
        <FindBar
          scroller={scroller}
          // The bar re-reads the pane when a command finishes under it, so output
          // that lands while it is open is searchable without retyping.
          revision={pane.blocks.length + lastSize}
          onClose={() => setFind(null)}
        />
      )}
      {!raw && (
        <div className="pane__body">
        <div
          className={`pane__scroll ${stream ? 'pane__scroll--stream' : ''}`}
          ref={scroller}
          onScroll={noteScroll}
        >
          {/*
            An aside, not a block. These borrowed a block's chrome, which stopped
            being free once blocks became a hairline list: an empty pane drew a
            separator and a status rule under a command that never ran.
          */}
          {pane.blocks.length === 0 && pane.integration === 'pending' && (
            <div className="pane__note">
              Starting shell… command blocks appear once shell integration loads.
            </div>
          )}
          {/* Once the shell is up and nothing has been run, the pane was simply
              blank — which says nothing about what this app does differently, or
              that there is an editor and a workspace a keystroke away. */}
          {pane.blocks.length === 0 && pane.integration === 'ready' && (
            <div className="pane__note">
              <div>
                <div>Run a command — each one becomes a block with its exit code and timing.</div>
                <div className="pane__hints">
                  {/* First, because it is the thing this app does that a terminal
                      does not. It said "turn into an IDE" in both modes, which is
                      the wrong half of the sentence to read while already in one. */}
                  <span>
                    <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>I</kbd>{' '}
                    {mode === 'ide' ? 'back to the terminal' : 'turn into an IDE'}
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
          {pane.blocks.map((b, i) => (
            <Fragment key={b.id}>
              {/*
                Where the last session ended.

                Restored blocks are real records — the command ran, the exit code is
                its own — but they are not this session, and a pane that opens
                already holding output owes the reader that sentence. Drawn once, at
                the boundary, rather than as a mark on every block.
              */}
              {b.restored && i === 0 && (
                <div className="blocks__mark">
                  Previous session from {whenRan(pane.blocks)}
                </div>
              )}
              {!b.restored && pane.blocks[i - 1]?.restored && (
                <div className="blocks__mark blocks__mark--now">This session</div>
              )}
              {b.kind === 'conversation' ? (
                <AgentBlock
                  block={b}
                  stuck={b.id === geometry.stuckId}
                  onToggle={() => toggleBlock(pane.id, b.id)}
                  onRun={(command) => {
                    patchConversation(pane.id, b.id, {
                      proposal: b.proposal ? { ...b.proposal, state: 'run' } : null
                    })
                    rerun(command)
                  }}
                  onDismiss={() =>
                    patchConversation(pane.id, b.id, {
                      proposal: b.proposal ? { ...b.proposal, state: 'dismissed' } : null
                    })
                  }
                />
              ) : (
                <BlockView
                  block={b}
                  stuck={b.id === geometry.stuckId}
                  onToggle={() => toggleBlock(pane.id, b.id)}
                  onRerun={rerun}
                />
              )}
            </Fragment>
          ))}
        </div>
        <OverviewRuler geometry={geometry} scroller={scroller} />
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
