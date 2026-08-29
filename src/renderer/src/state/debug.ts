import { create } from 'zustand'
import type { DapEventPayload, DebugAdapter } from '@shared/types'
import { useStore, activeDocument } from './store'

/**
 * Debugging, from the renderer's side of the protocol.
 *
 * Main speaks processes and sockets; everything that understands DAP's shapes —
 * the handshake order, what a stopped event obliges you to ask next, which
 * session in a broker's tree is the one actually running code — lives here,
 * where the UI that shows it lives too. Breakpoints belong to the window: they
 * outlive sessions, and every new session is told about all of them the moment
 * it says `initialized`.
 */

export interface DebugFrame {
  id: number
  name: string
  path: string | null
  line: number
  column: number
}

export interface DebugScope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface DebugVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
}

export interface FileBreakpoints {
  /** The path as the editor knows it, sent to adapters verbatim. */
  path: string
  /** Lines by the user's hand; `verified` is the adapter's answer where one is live. */
  lines: { line: number; verified: boolean }[]
}

interface DebugState {
  status: 'idle' | 'starting' | 'running' | 'stopped'
  adapterName: string | null
  /** Every live session id; the broker and its children all count. */
  sessions: string[]
  /** The session whose stop the UI is showing, and the thread that stopped. */
  stoppedSessionId: string | null
  threadId: number | null
  stoppedReason: string | null
  frames: DebugFrame[]
  activeFrameId: number | null
  scopes: DebugScope[]
  /** Fetched variables, keyed by variablesReference. */
  variables: Record<number, DebugVariable[]>
  breakpoints: Record<string, FileBreakpoints>
  /** The adapter's own words: program output, its stderr, its complaints. */
  output: { category: string; text: string }[]
}

const EMPTY_RUN = {
  stoppedSessionId: null as string | null,
  threadId: null as number | null,
  stoppedReason: null as string | null,
  frames: [] as DebugFrame[],
  activeFrameId: null as number | null,
  scopes: [] as DebugScope[],
  variables: {} as Record<number, DebugVariable[]>
}

export const useDebugStore = create<DebugState>(() => ({
  status: 'idle',
  adapterName: null,
  sessions: [],
  ...EMPTY_RUN,
  breakpoints: {},
  output: []
}))

/** The same canonical key the gutters use: one file, however it was spelled. */
const fileKey = (p: string): string => p.replace(/\\/g, '/').toLowerCase()

const OUTPUT_CAP = 400

function appendOutput(category: string, text: string): void {
  if (!text) return
  useDebugStore.setState((s) => ({
    output: [...s.output.slice(-(OUTPUT_CAP - 1)), { category, text }]
  }))
}

const request = (
  sessionId: string,
  command: string,
  args?: unknown
): Promise<{ ok: boolean; body?: unknown; error?: string }> =>
  window.ember.dapRequest(sessionId, command, args)

/** Tell one session about every breakpoint this window holds. */
async function sendAllBreakpoints(sessionId: string): Promise<void> {
  for (const file of Object.values(useDebugStore.getState().breakpoints)) {
    await sendFileBreakpoints(sessionId, file)
  }
}

async function sendFileBreakpoints(sessionId: string, file: FileBreakpoints): Promise<void> {
  const res = await request(sessionId, 'setBreakpoints', {
    source: { path: file.path },
    breakpoints: file.lines.map((l) => ({ line: l.line })),
    sourceModified: false
  })
  if (!res.ok) return
  const answered = (res.body as { breakpoints?: { verified?: boolean; line?: number }[] })
    ?.breakpoints
  if (!answered) return
  // The adapter's answer is the truth about where the marks actually live.
  useDebugStore.setState((s) => {
    const key = fileKey(file.path)
    const held = s.breakpoints[key]
    if (!held || held.lines.length !== answered.length) return s
    return {
      breakpoints: {
        ...s.breakpoints,
        [key]: {
          path: held.path,
          lines: held.lines.map((l, i) => ({
            line: answered[i]?.line ?? l.line,
            verified: answered[i]?.verified === true
          }))
        }
      }
    }
  })
}

/** A margin click: add the line, or take it away. */
export function toggleBreakpoint(filePath: string, line: number): void {
  const key = fileKey(filePath)
  useDebugStore.setState((s) => {
    const held = s.breakpoints[key] ?? { path: filePath, lines: [] }
    const without = held.lines.filter((l) => l.line !== line)
    const lines =
      without.length === held.lines.length
        ? [...held.lines, { line, verified: false }].sort((a, b) => a.line - b.line)
        : without
    const next = { ...s.breakpoints }
    if (lines.length === 0) delete next[key]
    else next[key] = { path: held.path, lines }
    return { breakpoints: next }
  })
  const file = useDebugStore.getState().breakpoints[key] ?? { path: filePath, lines: [] }
  for (const sessionId of useDebugStore.getState().sessions) {
    void sendFileBreakpoints(sessionId, file)
  }
}

export function breakpointsFor(filePath: string | null): FileBreakpoints | null {
  if (!filePath) return null
  return useDebugStore.getState().breakpoints[fileKey(filePath)] ?? null
}

/**
 * What a stop obliges the client to ask: the stack, then the top frame's
 * scopes, then each cheap scope's variables — and to take the user's eyes to
 * where the program stands.
 */
async function onStopped(sessionId: string, body: { reason?: string; threadId?: number }): Promise<void> {
  const threadId = body.threadId ?? 1
  useDebugStore.setState({
    status: 'stopped',
    stoppedSessionId: sessionId,
    threadId,
    stoppedReason: body.reason ?? 'paused'
  })

  const stack = await request(sessionId, 'stackTrace', { threadId, startFrame: 0, levels: 20 })
  if (!stack.ok) return
  const rawFrames =
    (stack.body as { stackFrames?: { id: number; name: string; line: number; column: number; source?: { path?: string } }[] })
      ?.stackFrames ?? []
  const frames: DebugFrame[] = rawFrames.map((f) => ({
    id: f.id,
    name: f.name,
    path: f.source?.path ?? null,
    line: f.line,
    column: f.column
  }))
  useDebugStore.setState({ frames })
  if (frames.length > 0) await selectFrame(frames[0].id)
}

export async function selectFrame(frameId: number): Promise<void> {
  const s = useDebugStore.getState()
  const sessionId = s.stoppedSessionId
  const frame = s.frames.find((f) => f.id === frameId)
  if (!sessionId || !frame) return
  useDebugStore.setState({ activeFrameId: frameId, scopes: [], variables: {} })

  if (frame.path) {
    window.dispatchEvent(
      new CustomEvent('ember:open-path', {
        detail: { path: frame.path, line: frame.line, column: frame.column }
      })
    )
  }

  const res = await request(sessionId, 'scopes', { frameId })
  if (!res.ok) return
  const scopes =
    (res.body as { scopes?: DebugScope[] })?.scopes?.map((sc) => ({
      name: sc.name,
      variablesReference: sc.variablesReference,
      expensive: sc.expensive === true
    })) ?? []
  useDebugStore.setState({ scopes })
  for (const scope of scopes) {
    if (!scope.expensive) await fetchVariables(scope.variablesReference)
  }
}

export async function fetchVariables(variablesReference: number): Promise<void> {
  const sessionId = useDebugStore.getState().stoppedSessionId
  if (!sessionId || variablesReference === 0) return
  const res = await request(sessionId, 'variables', { variablesReference })
  if (!res.ok) return
  const variables =
    (res.body as { variables?: DebugVariable[] })?.variables?.map((v) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.variablesReference
    })) ?? []
  useDebugStore.setState((s) => ({
    variables: { ...s.variables, [variablesReference]: variables }
  }))
}

function step(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): void {
  const s = useDebugStore.getState()
  if (s.status !== 'stopped' || !s.stoppedSessionId || s.threadId === null) return
  useDebugStore.setState({ status: 'running', ...EMPTY_RUN })
  void request(s.stoppedSessionId, command, { threadId: s.threadId })
}

export const debugContinue = (): void => step('continue')
export const debugStepOver = (): void => step('next')
export const debugStepIn = (): void => step('stepIn')
export const debugStepOut = (): void => step('stepOut')

export function stopDebugging(): void {
  for (const sessionId of useDebugStore.getState().sessions) {
    void window.ember.dapStop(sessionId)
  }
}

/**
 * Start debugging the file in front of the user.
 *
 * The adapter is picked by extension from whatever this machine offers —
 * detected or taught — and handed a launch built the way VS Code would build
 * one for "debug the active file": the program, its directory, output kept in
 * the protocol rather than a spawned console.
 */
export async function startDebugging(): Promise<void> {
  const app = useStore.getState()
  const debug = useDebugStore.getState()
  if (debug.status === 'stopped') {
    debugContinue()
    return
  }
  if (debug.status !== 'idle') return

  const pane = app.panes[app.tabs.find((t) => t.id === app.activeTabId)?.activePaneId ?? '']
  const editorPane =
    pane?.kind === 'editor'
      ? pane
      : Object.values(app.panes).find(
          (p): p is Extract<typeof p, { kind: 'editor' }> => p.kind === 'editor'
        )
  const filePath = editorPane ? activeDocument(editorPane).filePath : null
  if (!filePath) {
    app.setNotice('Open the file to debug first — F5 runs the active file.', 'info')
    return
  }

  const adapters = await window.ember.listDebugAdapters()
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const adapter = adapters.find((a) => a.extensions.includes(ext))
  if (!adapter) {
    app.setNotice(
      adapters.length === 0
        ? 'No debug adapter found — run scripts/fetch-js-debug.mjs, or teach one in settings.'
        : `No debug adapter answers for ${ext} files.`,
      'info'
    )
    return
  }

  const cwd = filePath.slice(0, Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')))
  useDebugStore.setState({
    status: 'starting',
    adapterName: adapter.name,
    sessions: [],
    output: [],
    ...EMPTY_RUN
  })

  const res = await window.ember.dapStart({
    adapterId: adapter.id,
    launch: launchConfigFor(adapter, filePath, cwd)
  })
  if (!res.ok || !res.sessionId) {
    useDebugStore.setState({ status: 'idle', adapterName: null })
    app.setNotice(res.error ?? 'The debugger could not start.', 'error')
    return
  }
  useDebugStore.setState((s) => ({ status: 'running', sessions: [...s.sessions, res.sessionId!] }))
}

function launchConfigFor(
  adapter: DebugAdapter,
  program: string,
  cwd: string
): Record<string, unknown> {
  const base = { type: adapter.id, request: 'launch', name: 'Ember: active file', program, cwd }
  if (adapter.id === 'pwa-node') {
    return { ...base, console: 'internalConsole', outputCapture: 'std' }
  }
  return base
}

/** Wired once at boot; every DAP event lands here. */
export function handleDapEvent(payload: DapEventPayload): void {
  const { sessionId, event, body } = payload
  const s = useDebugStore.getState()

  switch (event) {
    case 'session-started':
      useDebugStore.setState({ sessions: [...s.sessions, sessionId] })
      return
    case 'initialized':
      // Every session — broker or child — is told the window's breakpoints,
      // then released. The order is the protocol's own.
      void sendAllBreakpoints(sessionId).then(() =>
        request(sessionId, 'configurationDone')
      )
      return
    case 'stopped':
      void onStopped(sessionId, (body as { reason?: string; threadId?: number }) ?? {})
      return
    case 'continued':
      if (s.stoppedSessionId === sessionId) {
        useDebugStore.setState({ status: 'running', ...EMPTY_RUN })
      }
      return
    case 'output': {
      const o = body as { category?: string; output?: string }
      appendOutput(o?.category ?? 'console', o?.output ?? '')
      return
    }
    case 'session-ended': {
      const sessions = s.sessions.filter((id) => id !== sessionId)
      if (sessions.length === 0) {
        useDebugStore.setState({ status: 'idle', adapterName: null, sessions, ...EMPTY_RUN })
      } else if (s.stoppedSessionId === sessionId) {
        useDebugStore.setState({ sessions, status: 'running', ...EMPTY_RUN })
      } else {
        useDebugStore.setState({ sessions })
      }
      return
    }
    case 'terminated':
    case 'exited':
      // The session announces its own end; 'session-ended' does the bookkeeping.
      return
    default:
      return
  }
}
