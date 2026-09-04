import { useEffect, useState } from 'react'
import {
  chooseLaunch,
  debugContinue,
  debugPause,
  debugRestart,
  debugStepIn,
  debugStepOut,
  debugStepOver,
  evaluateRepl,
  fetchVariables,
  refreshLaunchOptions,
  selectFrame,
  selectThread,
  setBreakpointMeta,
  startDebugging,
  stopDebugging,
  toggleBreakpoint,
  toggleExceptionFilter,
  useDebugStore,
  type DebugVariable
} from '../state/debug'
import { useStore, workspaceRoot } from '../state/store'

interface Props {
  onOpenAt: (filePath: string, line: number, column: number) => void
}

/**
 * The debug view: what F5 runs, controls that say what the debugger can do
 * right now, the stack when it is standing still, the variables of the frame
 * being looked at, the breakpoints this window holds with their conditions,
 * the exception filters the adapter offers, a console that evaluates in the
 * stopped frame, and the program's own words at the bottom.
 */
export function DebugPanel({ onOpenAt }: Props): React.JSX.Element {
  const status = useDebugStore((s) => s.status)
  const adapterName = useDebugStore((s) => s.adapterName)
  const reason = useDebugStore((s) => s.stoppedReason)
  const frames = useDebugStore((s) => s.frames)
  const threads = useDebugStore((s) => s.threads)
  const threadId = useDebugStore((s) => s.threadId)
  const activeFrameId = useDebugStore((s) => s.activeFrameId)
  const scopes = useDebugStore((s) => s.scopes)
  const breakpoints = useDebugStore((s) => s.breakpoints)
  const exceptionFilters = useDebugStore((s) => s.exceptionFilters)
  const launchOptions = useDebugStore((s) => s.launchOptions)
  const launchChoice = useDebugStore((s) => s.launchChoice)
  const output = useDebugStore((s) => s.output)
  const repl = useDebugStore((s) => s.repl)
  const treeRoot = useStore(workspaceRoot)

  /** Which breakpoint's condition editor is open, as `${path}:${line}`. */
  const [editing, setEditing] = useState<string | null>(null)
  const [replDraft, setReplDraft] = useState('')

  // What F5 could run changes with the workspace, not with keystrokes.
  useEffect(() => {
    void refreshLaunchOptions()
  }, [treeRoot])

  const stopped = status === 'stopped'
  const live = status === 'running' || status === 'stopped' || status === 'starting'

  return (
    <div className="dbg">
      <div className="field dbg__launch">
        <label>F5 runs</label>
        <select
          aria-label="What F5 runs"
          value={launchChoice}
          disabled={live}
          onChange={(e) => chooseLaunch(e.target.value)}
        >
          {launchOptions.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="dbg__controls" role="toolbar" aria-label="Debug controls">
        <button
          className="btn dbg__ctl"
          title={stopped ? 'Continue (F5)' : 'Start debugging (F5)'}
          disabled={status === 'running' || status === 'starting'}
          onClick={() => void (stopped ? debugContinue() : startDebugging())}
        >
          {stopped ? '▶ continue' : '▶ start'}
        </button>
        <button
          className="btn dbg__ctl"
          title="Pause"
          aria-label="Pause"
          disabled={status !== 'running'}
          onClick={() => void debugPause()}
        >
          ⏸
        </button>
        <button className="btn dbg__ctl" title="Step over (F10)" disabled={!stopped} onClick={debugStepOver}>
          ⤵
        </button>
        <button className="btn dbg__ctl" title="Step in (F11)" disabled={!stopped} onClick={debugStepIn}>
          ↓
        </button>
        <button className="btn dbg__ctl" title="Step out (Shift+F11)" disabled={!stopped} onClick={debugStepOut}>
          ↑
        </button>
        <button
          className="btn dbg__ctl"
          title="Restart (Ctrl+Shift+F5)"
          aria-label="Restart"
          disabled={!live}
          onClick={debugRestart}
        >
          ↻
        </button>
        <button className="btn dbg__ctl" title="Stop (Shift+F5)" aria-label="Stop debugging" disabled={!live} onClick={stopDebugging}>
          ■
        </button>
      </div>

      <div className="dbg__state">
        {status === 'idle' && 'Not debugging. F5 runs the selection above.'}
        {status === 'starting' && `Starting ${adapterName ?? 'the adapter'}…`}
        {status === 'running' && `Running — ${adapterName ?? ''}`}
        {status === 'stopped' && `Paused: ${reason ?? 'stopped'}`}
      </div>

      {stopped && threads.length > 1 && (
        <div className="dbg__threads" role="tablist" aria-label="Threads">
          {threads.map((t) => (
            <button
              key={t.id}
              className={`dbg__thread ${t.id === threadId ? 'dbg__thread--on' : ''}`}
              onClick={() => void selectThread(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}

      {stopped && frames.length > 0 && (
        <div className="dbg__section">
          <div className="dbg__head">Call stack</div>
          {frames.map((frame) => (
            <button
              key={frame.id}
              className={`dbg__frame ${frame.id === activeFrameId ? 'dbg__frame--on' : ''}`}
              onClick={() => {
                void selectFrame(frame.id)
                if (frame.path) onOpenAt(frame.path, frame.line, frame.column)
              }}
            >
              <span className="dbg__frame-name">{frame.name}</span>
              <span className="dbg__frame-where">
                {frame.path ? `${frame.path.split(/[\\/]/).pop()}:${frame.line}` : '(internal)'}
              </span>
            </button>
          ))}
        </div>
      )}

      {stopped && scopes.length > 0 && (
        <div className="dbg__section">
          <div className="dbg__head">Variables</div>
          {scopes.map((scope) => (
            <VariableBranch
              key={scope.variablesReference}
              name={scope.name}
              variablesReference={scope.variablesReference}
              depth={0}
              lazy={scope.expensive}
            />
          ))}
        </div>
      )}

      {exceptionFilters.length > 0 && (
        <div className="dbg__section">
          <div className="dbg__head">Exceptions</div>
          {exceptionFilters.map((filter) => (
            <label key={filter.filter} className="field__check dbg__exc">
              <input
                type="checkbox"
                checked={filter.enabled}
                onChange={() => toggleExceptionFilter(filter.filter)}
              />
              <span>{filter.label}</span>
            </label>
          ))}
        </div>
      )}

      {Object.keys(breakpoints).length > 0 && (
        <div className="dbg__section">
          <div className="dbg__head">Breakpoints</div>
          {Object.values(breakpoints).flatMap((file) =>
            file.lines.map((bp) => {
              const key = `${file.path}:${bp.line}`
              return (
                <div key={key} className="dbg__bp-wrap">
                  <div className="dbg__bp">
                    <span
                      className={`dbg__bp-dot ${bp.verified ? '' : 'dbg__bp-dot--wish'} ${
                        bp.logMessage ? 'dbg__bp-dot--log' : bp.condition ? 'dbg__bp-dot--conditional' : ''
                      }`}
                      aria-hidden="true"
                    />
                    <button
                      className="dbg__bp-name"
                      title={file.path}
                      onClick={() => onOpenAt(file.path, bp.line, 1)}
                    >
                      {file.path.split(/[\\/]/).pop()}:{bp.line}
                    </button>
                    <button
                      className="icon-btn"
                      title="Condition and log message"
                      aria-label={`Edit breakpoint at line ${bp.line}`}
                      onClick={() => setEditing((was) => (was === key ? null : key))}
                    >
                      ✎
                    </button>
                    <button
                      className="icon-btn"
                      title="Remove breakpoint"
                      aria-label={`Remove breakpoint at line ${bp.line}`}
                      onClick={() => toggleBreakpoint(file.path, bp.line)}
                    >
                      ✕
                    </button>
                  </div>
                  {editing === key && (
                    <div className="dbg__bp-meta">
                      <input
                        className="dbg__bp-input"
                        placeholder="Condition — stop only when this is true"
                        aria-label="Breakpoint condition"
                        defaultValue={bp.condition ?? ''}
                        spellCheck={false}
                        onBlur={(e) =>
                          setBreakpointMeta(file.path, bp.line, {
                            condition: e.target.value,
                            logMessage: bp.logMessage
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                      />
                      <input
                        className="dbg__bp-input"
                        placeholder="Log message — print instead of stopping"
                        aria-label="Logpoint message"
                        defaultValue={bp.logMessage ?? ''}
                        spellCheck={false}
                        onBlur={(e) =>
                          setBreakpointMeta(file.path, bp.line, {
                            condition: bp.condition,
                            logMessage: e.target.value
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        }}
                      />
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      )}

      {live && (
        <div className="dbg__section">
          <div className="dbg__head">Console</div>
          {repl.length > 0 && (
            <div className="dbg__repl">
              {repl.map((entry, i) => (
                <div key={i} className="dbg__repl-entry">
                  <span className="dbg__repl-expr">› {entry.expression}</span>
                  <span className={entry.error ? 'dbg__repl-err' : 'dbg__repl-result'}>
                    {entry.result}
                  </span>
                </div>
              ))}
            </div>
          )}
          <input
            className="dbg__console-input"
            placeholder={stopped ? 'Evaluate in the paused frame…' : 'Evaluate…'}
            aria-label="Debug console"
            value={replDraft}
            spellCheck={false}
            onChange={(e) => setReplDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const expression = replDraft.trim()
              if (!expression) return
              setReplDraft('')
              void evaluateRepl(expression)
            }}
          />
        </div>
      )}

      {output.length > 0 && (
        <div className="dbg__section dbg__section--output">
          <div className="dbg__head">Output</div>
          <pre className="dbg__output">
            {output.map((o, i) => (
              <span key={i} className={o.category === 'stderr' ? 'dbg__output-err' : ''}>
                {o.text}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  )
}

/**
 * One expandable node of the variables tree. Children are fetched the first
 * time a node opens and cached in the store until the next stop clears them.
 */
function VariableBranch({
  name,
  value,
  variablesReference,
  depth,
  lazy
}: {
  name: string
  value?: string
  variablesReference: number
  depth: number
  lazy?: boolean
}): React.JSX.Element {
  const children = useDebugStore((s) => s.variables[variablesReference])
  const [open, setOpen] = useState(!lazy && depth === 0)
  const expandable = variablesReference > 0

  return (
    <div className="dbg__var" style={{ marginLeft: depth * 12 }}>
      <button
        className="dbg__var-row"
        onClick={() => {
          if (!expandable) return
          const next = !open
          setOpen(next)
          if (next && children === undefined) void fetchVariables(variablesReference)
        }}
      >
        {expandable && <span className="dbg__var-chevron">{open ? '▾' : '▸'}</span>}
        <span className="dbg__var-name">{name}</span>
        {value !== undefined && <span className="dbg__var-value">{value}</span>}
      </button>
      {open &&
        (children ?? []).map((v: DebugVariable) => (
          <VariableBranch
            key={`${variablesReference}-${v.name}`}
            name={v.name}
            value={v.value}
            variablesReference={v.variablesReference}
            depth={depth + 1}
            lazy
          />
        ))}
    </div>
  )
}
