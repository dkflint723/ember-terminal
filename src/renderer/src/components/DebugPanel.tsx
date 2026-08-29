import { useState } from 'react'
import {
  debugContinue,
  debugStepIn,
  debugStepOut,
  debugStepOver,
  fetchVariables,
  selectFrame,
  startDebugging,
  stopDebugging,
  toggleBreakpoint,
  useDebugStore,
  type DebugVariable
} from '../state/debug'

interface Props {
  onOpenAt: (filePath: string, line: number, column: number) => void
}

/**
 * The debug view: controls that say what the debugger can do right now, the
 * stack when it is standing still, the variables of the frame being looked at,
 * the breakpoints this window holds, and the program's own words at the bottom.
 */
export function DebugPanel({ onOpenAt }: Props): React.JSX.Element {
  const status = useDebugStore((s) => s.status)
  const adapterName = useDebugStore((s) => s.adapterName)
  const reason = useDebugStore((s) => s.stoppedReason)
  const frames = useDebugStore((s) => s.frames)
  const activeFrameId = useDebugStore((s) => s.activeFrameId)
  const scopes = useDebugStore((s) => s.scopes)
  const breakpoints = useDebugStore((s) => s.breakpoints)
  const output = useDebugStore((s) => s.output)

  const stopped = status === 'stopped'
  const live = status === 'running' || status === 'stopped' || status === 'starting'

  return (
    <div className="dbg">
      <div className="dbg__controls" role="toolbar" aria-label="Debug controls">
        <button
          className="btn dbg__ctl"
          title={stopped ? 'Continue (F5)' : 'Start debugging the active file (F5)'}
          disabled={status === 'running' || status === 'starting'}
          onClick={() => void (stopped ? debugContinue() : startDebugging())}
        >
          {stopped ? '▶ continue' : '▶ start'}
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
        <button className="btn dbg__ctl" title="Stop (Shift+F5)" disabled={!live} onClick={stopDebugging}>
          ■
        </button>
      </div>

      <div className="dbg__state">
        {status === 'idle' && 'Not debugging. F5 runs the active file.'}
        {status === 'starting' && `Starting ${adapterName ?? 'the adapter'}…`}
        {status === 'running' && `Running — ${adapterName ?? ''}`}
        {status === 'stopped' && `Paused: ${reason ?? 'stopped'}`}
      </div>

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

      {Object.keys(breakpoints).length > 0 && (
        <div className="dbg__section">
          <div className="dbg__head">Breakpoints</div>
          {Object.values(breakpoints).flatMap((file) =>
            file.lines.map((bp) => (
              <div key={`${file.path}:${bp.line}`} className="dbg__bp">
                <span
                  className={`dbg__bp-dot ${bp.verified ? '' : 'dbg__bp-dot--wish'}`}
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
                  title="Remove breakpoint"
                  aria-label={`Remove breakpoint at line ${bp.line}`}
                  onClick={() => toggleBreakpoint(file.path, bp.line)}
                >
                  ✕
                </button>
              </div>
            ))
          )}
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
