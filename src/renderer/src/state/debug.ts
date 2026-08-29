import { create } from 'zustand'
import type { DapEventPayload, DebugAdapter, DebugStartRequest } from '@shared/types'
import { existingController } from '../terminal/controller'
import { useStore, activeDocument, paneIdsOf } from './store'

/**
 * Debugging, from the renderer's side of the protocol.
 *
 * Main speaks processes and sockets; everything that understands DAP's shapes —
 * the handshake order, what a stopped event obliges you to ask next, which
 * session in a broker's tree is the one actually running code — lives here,
 * where the UI that shows it lives too. Breakpoints belong to the window: they
 * outlive sessions, they are written into the session file, and every new
 * session is told about all of them the moment it says `initialized`.
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

export interface BreakpointLine {
  line: number
  verified: boolean
  /** Only stop when this expression is true — the adapter evaluates it. */
  condition?: string
  /** Print instead of stopping: a logpoint, where the adapter supports them. */
  logMessage?: string
}

export interface FileBreakpoints {
  /** The path as the editor knows it, sent to adapters verbatim. */
  path: string
  lines: BreakpointLine[]
}

export interface ExceptionFilter {
  filter: string
  label: string
  enabled: boolean
}

export interface LaunchOption {
  id: string
  label: string
  kind: 'active-file' | 'config' | 'attach'
  config?: Record<string, unknown>
}

interface DebugState {
  status: 'idle' | 'starting' | 'running' | 'stopped'
  adapterName: string | null
  /** Every live session id; the broker and its children all count. */
  sessions: string[]
  /** The session whose stop the UI is showing, and the thread that stopped. */
  stoppedSessionId: string | null
  threadId: number | null
  threads: { id: number; name: string }[]
  stoppedReason: string | null
  frames: DebugFrame[]
  activeFrameId: number | null
  scopes: DebugScope[]
  /** Fetched variables, keyed by variablesReference. */
  variables: Record<number, DebugVariable[]>
  breakpoints: Record<string, FileBreakpoints>
  /** The adapter's exception filters, as checkboxes; empty until it declares them. */
  exceptionFilters: ExceptionFilter[]
  /** What F5 runs: the active file, a launch.json entry, or an attach. */
  launchOptions: LaunchOption[]
  launchChoice: string
  /** The adapter's own words: program output, its stderr, its complaints. */
  output: { category: string; text: string }[]
  /** The console's exchanges, newest last. */
  repl: { expression: string; result: string; error: boolean }[]
}

const EMPTY_RUN = {
  stoppedSessionId: null as string | null,
  threadId: null as number | null,
  threads: [] as { id: number; name: string }[],
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
  exceptionFilters: [],
  launchOptions: [{ id: 'active-file', label: 'Active file', kind: 'active-file' }],
  launchChoice: 'active-file',
  output: [],
  repl: []
}))

/**
 * Exception choices made before (or between) sessions, applied whenever an
 * adapter declares its filters — and restored from the session file, where the
 * filters themselves are not yet known.
 */
let exceptionChoice: Record<string, boolean> = {}
/** The last thing F5 started, for restart's stop-and-start-again fallback. */
let lastStart: DebugStartRequest | null = null
let restartPending = false
/** A stop asked for while the adapter was still standing up; honoured on arrival. */
let cancelRequested = false
/**
 * Which stop the async chain belongs to. A stackTrace answered after the user
 * already stepped on, or a scopes fetch racing a faster frame click, must not
 * write yesterday's stop into today's — every continuation checks it is still
 * telling the current story before touching the store.
 */
let stopGeneration = 0
/**
 * Sessions that ended before the start call even reported them. The events
 * channel and the invoke reply race; a taught adapter that dies right after
 * its handshake can say goodbye before the renderer has said hello.
 */
const endedEarly = new Set<string>()

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

/* ---------- breakpoints ---------- */

/** Tell one session about every breakpoint and exception choice this window holds. */
async function sendAllBreakpoints(sessionId: string): Promise<void> {
  for (const file of Object.values(useDebugStore.getState().breakpoints)) {
    await sendFileBreakpoints(sessionId, file)
  }
  await sendExceptionFilters(sessionId)
}

/**
 * Every mutation of a file's breakpoints bumps its version, and a reply is
 * only merged back when nothing moved during the round trip. A stale reply is
 * simply dropped — the mutation that made it stale has already scheduled a
 * resend of its own, which will bring fresh verification.
 */
const breakpointVersions = new Map<string, number>()
const bumpVersion = (key: string): void => {
  breakpointVersions.set(key, (breakpointVersions.get(key) ?? 0) + 1)
}

async function sendFileBreakpoints(sessionId: string, file: FileBreakpoints): Promise<void> {
  const key = fileKey(file.path)
  const versionAtSend = breakpointVersions.get(key) ?? 0
  const sent = file.lines
  const res = await request(sessionId, 'setBreakpoints', {
    source: { path: file.path },
    breakpoints: sent.map((l) => ({
      line: l.line,
      ...(l.condition ? { condition: l.condition } : {}),
      ...(l.logMessage ? { logMessage: l.logMessage } : {})
    })),
    sourceModified: false
  })
  if (!res.ok) return
  if ((breakpointVersions.get(key) ?? 0) !== versionAtSend) return
  const answered = (res.body as { breakpoints?: { verified?: boolean; line?: number }[] })
    ?.breakpoints
  if (!answered) return
  /*
   * The adapter's answer is the truth about where the marks actually live.
   * Answers come back positionally; when the adapter moves two onto the same
   * line they are collapsed to one rather than shown as twins — the first
   * keeps its condition, since it was the earlier ask.
   */
  useDebugStore.setState((s) => {
    const held = s.breakpoints[key]
    if (!held) return s
    const merged = new Map<number, BreakpointLine>()
    sent.forEach((asked, i) => {
      const reply = answered[i]
      const line = reply?.line ?? asked.line
      if (!merged.has(line)) {
        merged.set(line, {
          line,
          verified: reply?.verified === true,
          condition: asked.condition,
          logMessage: asked.logMessage
        })
      }
    })
    return {
      breakpoints: {
        ...s.breakpoints,
        [key]: { path: held.path, lines: [...merged.values()].sort((a, b) => a.line - b.line) }
      }
    }
  })
}

const resendTimers = new Map<string, number>()

/** Push one file's breakpoints to every live session, on a short debounce. */
function scheduleResend(filePath: string): void {
  const key = fileKey(filePath)
  window.clearTimeout(resendTimers.get(key))
  resendTimers.set(
    key,
    window.setTimeout(() => {
      resendTimers.delete(key)
      const file = useDebugStore.getState().breakpoints[key] ?? { path: filePath, lines: [] }
      for (const sessionId of useDebugStore.getState().sessions) {
        void sendFileBreakpoints(sessionId, file)
      }
    }, 250)
  )
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
  bumpVersion(key)
  scheduleResend(filePath)
}

/** Give one breakpoint a condition or a log message; empty strings clear them. */
export function setBreakpointMeta(
  filePath: string,
  line: number,
  meta: { condition?: string; logMessage?: string }
): void {
  const key = fileKey(filePath)
  useDebugStore.setState((s) => {
    const held = s.breakpoints[key]
    if (!held) return s
    return {
      breakpoints: {
        ...s.breakpoints,
        [key]: {
          path: held.path,
          lines: held.lines.map((l) =>
            l.line === line
              ? {
                  ...l,
                  condition: meta.condition?.trim() ? meta.condition.trim() : undefined,
                  logMessage: meta.logMessage?.trim() ? meta.logMessage.trim() : undefined
                }
              : l
          )
        }
      }
    }
  })
  bumpVersion(key)
  scheduleResend(filePath)
}

/**
 * The buffer moved under the marks. The editor reports where its decorations
 * now stand; the store follows, so the dots and the lines the adapter is told
 * about are the lines the code is actually on. Duplicates collapse — deleting
 * the lines between two breakpoints leaves one, not twins.
 */
export function syncBreakpointLines(filePath: string, currentLines: number[]): void {
  const key = fileKey(filePath)
  const held = useDebugStore.getState().breakpoints[key]
  if (!held) return
  if (
    held.lines.length === currentLines.length &&
    held.lines.every((l, i) => l.line === currentLines[i])
  ) {
    return
  }
  useDebugStore.setState((s) => {
    const file = s.breakpoints[key]
    if (!file) return s
    const merged = new Map<number, BreakpointLine>()
    file.lines.forEach((l, i) => {
      const line = currentLines[i] ?? l.line
      if (!merged.has(line)) merged.set(line, { ...l, line })
    })
    return {
      breakpoints: {
        ...s.breakpoints,
        [key]: { path: file.path, lines: [...merged.values()].sort((a, b) => a.line - b.line) }
      }
    }
  })
  bumpVersion(key)
  scheduleResend(filePath)
}

export function breakpointsFor(filePath: string | null): FileBreakpoints | null {
  if (!filePath) return null
  return useDebugStore.getState().breakpoints[fileKey(filePath)] ?? null
}

/* ---------- exception filters ---------- */

async function sendExceptionFilters(sessionId: string): Promise<void> {
  const filters = useDebugStore.getState().exceptionFilters
  if (filters.length === 0) return
  await request(sessionId, 'setExceptionBreakpoints', {
    filters: filters.filter((f) => f.enabled).map((f) => f.filter)
  })
}

export function toggleExceptionFilter(filter: string): void {
  useDebugStore.setState((s) => ({
    exceptionFilters: s.exceptionFilters.map((f) =>
      f.filter === filter ? { ...f, enabled: !f.enabled } : f
    )
  }))
  // Merged, not replaced: choices remembered for other adapters' filters must
  // survive a toggle made while debugging this one.
  exceptionChoice = {
    ...exceptionChoice,
    ...Object.fromEntries(
      useDebugStore.getState().exceptionFilters.map((f) => [f.filter, f.enabled])
    )
  }
  for (const sessionId of useDebugStore.getState().sessions) {
    void sendExceptionFilters(sessionId)
  }
}

/* ---------- persistence: the window's debugging posture ---------- */

export function serializeDebug(): NonNullable<
  import('@shared/types').SessionSnapshot['debug']
> {
  const s = useDebugStore.getState()
  return {
    breakpoints: Object.values(s.breakpoints).map((f) => ({
      path: f.path,
      lines: f.lines.map((l) => ({
        line: l.line,
        ...(l.condition ? { condition: l.condition } : {}),
        ...(l.logMessage ? { logMessage: l.logMessage } : {})
      }))
    })),
    exceptionFilters: exceptionChoice,
    launchChoice: s.launchChoice
  }
}

export function seedDebug(
  saved: import('@shared/types').SessionSnapshot['debug'] | undefined
): void {
  if (!saved) return
  const breakpoints: Record<string, FileBreakpoints> = {}
  const savedFiles = Array.isArray(saved.breakpoints) ? saved.breakpoints : []
  for (const file of savedFiles) {
    if (typeof file?.path !== 'string' || !Array.isArray(file.lines)) continue
    const lines = file.lines
      .filter((l) => Number.isFinite(l?.line) && l.line > 0)
      .map((l) => ({
        line: l.line,
        verified: false,
        condition: l.condition,
        logMessage: l.logMessage
      }))
    if (lines.length > 0) breakpoints[fileKey(file.path)] = { path: file.path, lines }
  }
  exceptionChoice =
    typeof saved.exceptionFilters === 'object' && saved.exceptionFilters !== null
      ? saved.exceptionFilters
      : {}
  useDebugStore.setState({
    breakpoints,
    ...(typeof saved.launchChoice === 'string' ? { launchChoice: saved.launchChoice } : {})
  })
}

/* ---------- what F5 runs ---------- */

/**
 * launch.json is JSON-with-commentary; strings survive, comments and trailing
 * commas do not. Small and honest — anything it cannot read is no launch.json.
 */
function parseJsonc(text: string): unknown {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  /*
   * Trailing commas: legal in launch.json, fatal to JSON.parse. Removed with
   * the same string-awareness as the comment pass — a regex over the whole
   * text would also eat a comma that lives inside a string value.
   */
  let cleaned = ''
  let inStr = false
  for (let i = 0; i < out.length; i++) {
    const c = out[i]
    if (inStr) {
      cleaned += c
      if (c === '\\') {
        cleaned += out[i + 1] ?? ''
        i++
      } else if (c === '"') {
        inStr = false
      }
      continue
    }
    if (c === '"') {
      inStr = true
      cleaned += c
      continue
    }
    if (c === ',') {
      let j = i + 1
      while (j < out.length && /\s/.test(out[j])) j++
      if (out[j] === '}' || out[j] === ']') continue
    }
    cleaned += c
  }
  return JSON.parse(cleaned)
}

/** The types launch.json speaks, mapped to the adapters Ember serves. */
const TYPE_MAP: Record<string, string> = {
  node: 'pwa-node',
  'pwa-node': 'pwa-node',
  python: 'debugpy'
}
const adapterIdFor = (type: string, adapters: DebugAdapter[]): string | null => {
  const mapped = TYPE_MAP[type] ?? type
  return adapters.some((a) => a.id === mapped) ? mapped : null
}

/** ${workspaceFolder} and friends, resolved against this window. */
function substitute(value: unknown, workspace: string, file: string | null, depth = 0): unknown {
  // A launch.json nested past all reason is a stack overflow waiting inside
  // an F5 press; past this depth values pass through untouched.
  if (depth > 32) return value
  if (typeof value === 'string') {
    return value
      .replace(/\$\{workspaceFolder\}/g, workspace)
      .replace(/\$\{workspaceFolderBasename\}/g, workspace.split(/[\\/]/).pop() ?? '')
      .replace(/\$\{file\}/g, file ?? '')
      .replace(/\$\{fileBasename\}/g, file?.split(/[\\/]/).pop() ?? '')
      .replace(/\$\{fileDirname\}/g, file ? dirnameOf(file) : '')
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, workspace, file, depth + 1))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitute(v, workspace, file, depth + 1)])
    )
  }
  return value
}

const dirnameOf = (p: string): string =>
  p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))

/**
 * What the F5 picker offers: the active file always, every launch.json entry
 * an available adapter answers for, and an attach for Node when Node is here.
 */
export async function refreshLaunchOptions(): Promise<void> {
  const options: LaunchOption[] = [{ id: 'active-file', label: 'Active file', kind: 'active-file' }]
  const adapters = await window.ember.listDebugAdapters()
  const root = useStore.getState().treeRoot

  if (root) {
    const read = await window.ember.readFile(`${root}\\.vscode\\launch.json`)
    if (read.ok) {
      try {
        const parsed = parseJsonc(read.content) as { configurations?: Record<string, unknown>[] }
        for (const config of parsed?.configurations ?? []) {
          const name = typeof config?.name === 'string' ? config.name : null
          const type = typeof config?.type === 'string' ? config.type : null
          if (!name || !type || !adapterIdFor(type, adapters)) continue
          options.push({ id: `config:${name}`, label: name, kind: 'config', config })
        }
      } catch {
        // A launch.json that does not parse offers nothing, quietly.
      }
    }
  }

  if (adapters.some((a) => a.id === 'pwa-node')) {
    options.push({ id: 'attach-node', label: 'Attach to Node (port 9229)', kind: 'attach' })
  }

  useDebugStore.setState((s) => ({
    launchOptions: options,
    launchChoice: options.some((o) => o.id === s.launchChoice) ? s.launchChoice : 'active-file'
  }))
}

export function chooseLaunch(id: string): void {
  useDebugStore.setState({ launchChoice: id })
}

/* ---------- the stop, and what it obliges ---------- */

async function onStopped(sessionId: string, body: { reason?: string; threadId?: number }): Promise<void> {
  const generation = ++stopGeneration
  const threadId = body.threadId ?? 1
  useDebugStore.setState({
    status: 'stopped',
    stoppedSessionId: sessionId,
    threadId,
    stoppedReason: body.reason ?? 'paused'
  })

  // Which threads exist, for adapters with more than one story to tell.
  const threadsRes = await request(sessionId, 'threads')
  if (generation !== stopGeneration) return
  if (threadsRes.ok) {
    const threads =
      (threadsRes.body as { threads?: { id: number; name: string }[] })?.threads ?? []
    useDebugStore.setState({ threads })
  }

  await loadStack(sessionId, threadId, generation)
}

async function loadStack(sessionId: string, threadId: number, generation: number): Promise<void> {
  const stack = await request(sessionId, 'stackTrace', { threadId, startFrame: 0, levels: 20 })
  if (generation !== stopGeneration || !stack.ok) return
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

/** Look at another thread of the same stop. */
export async function selectThread(threadId: number): Promise<void> {
  const s = useDebugStore.getState()
  if (s.status !== 'stopped' || !s.stoppedSessionId) return
  useDebugStore.setState({ threadId, frames: [], activeFrameId: null, scopes: [], variables: {} })
  await loadStack(s.stoppedSessionId, threadId, stopGeneration)
}

export async function selectFrame(frameId: number): Promise<void> {
  const s = useDebugStore.getState()
  const sessionId = s.stoppedSessionId
  const frame = s.frames.find((f) => f.id === frameId)
  if (!sessionId || !frame) return
  const generation = stopGeneration
  useDebugStore.setState({ activeFrameId: frameId, scopes: [], variables: {} })

  if (frame.path) {
    window.dispatchEvent(
      new CustomEvent('ember:open-path', {
        detail: { path: frame.path, line: frame.line, column: frame.column }
      })
    )
  }

  const res = await request(sessionId, 'scopes', { frameId })
  // The stop moved on, or the user clicked a different frame while this one
  // was still answering — either way this answer describes the wrong moment.
  if (generation !== stopGeneration || useDebugStore.getState().activeFrameId !== frameId) return
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
  const generation = stopGeneration
  const res = await request(sessionId, 'variables', { variablesReference })
  if (generation !== stopGeneration || !res.ok) return
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

/* ---------- driving ---------- */

function step(command: 'continue' | 'next' | 'stepIn' | 'stepOut'): void {
  const s = useDebugStore.getState()
  if (s.status !== 'stopped' || !s.stoppedSessionId || s.threadId === null) return
  stopGeneration++
  useDebugStore.setState({ status: 'running', ...EMPTY_RUN })
  void request(s.stoppedSessionId, command, { threadId: s.threadId })
}

export const debugContinue = (): void => step('continue')
export const debugStepOver = (): void => step('next')
export const debugStepIn = (): void => step('stepIn')
export const debugStepOut = (): void => step('stepOut')

/**
 * Interrupt a run. The broker's children come after it in the list, and the
 * newest session is the one actually running code — so the ask goes there,
 * addressed to whichever thread it names first.
 */
export async function debugPause(): Promise<void> {
  const s = useDebugStore.getState()
  if (s.status !== 'running' || s.sessions.length === 0) return
  // Every session that answers for threads gets the ask: with a broker tree
  // there is no reliable way to know which child holds the loop the user is
  // watching, and pausing a paused thread is a no-op everywhere.
  for (const sessionId of s.sessions) {
    void request(sessionId, 'threads').then((threadsRes) => {
      const threads =
        (threadsRes.body as { threads?: { id: number }[] })?.threads ?? [{ id: 1 }]
      if (threads.length > 0) void request(sessionId, 'pause', { threadId: threads[0].id })
    })
  }
}

export function stopDebugging(): void {
  restartPending = false
  const s = useDebugStore.getState()
  if (s.status === 'starting') {
    // Nothing to stop yet; the start honours this the moment it lands.
    cancelRequested = true
    return
  }
  for (const sessionId of s.sessions) {
    void window.ember.dapStop(sessionId)
  }
}

/**
 * Stop, then start the same thing again. Deliberately not the protocol's own
 * restart request: adapters disagree about who restarts what in a session
 * tree, and stop-plus-start behaves identically everywhere — breakpoints
 * included, since a fresh session is told about all of them at initialized.
 */
export function debugRestart(): void {
  const s = useDebugStore.getState()
  // Not while starting: there is nothing to stop yet, and a pending flag set
  // now would fire a surprise relaunch when this run someday ends on its own.
  if (s.status === 'idle' || s.status === 'starting' || !lastStart) return
  if (s.sessions.length === 0) return
  restartPending = true
  for (const sessionId of s.sessions) void window.ember.dapStop(sessionId)
}

/* ---------- starting ---------- */

function activeEditorFile(): string | null {
  const app = useStore.getState()
  const pane = app.panes[app.tabs.find((t) => t.id === app.activeTabId)?.activePaneId ?? '']
  const editorPane =
    pane?.kind === 'editor'
      ? pane
      : Object.values(app.panes).find(
          (p): p is Extract<typeof p, { kind: 'editor' }> => p.kind === 'editor'
        )
  return editorPane ? activeDocument(editorPane).filePath : null
}

/** Whether the active tab has a PowerShell pane a debuggee could run in. */
function terminalPaneForDebuggee(): string | null {
  const app = useStore.getState()
  const tab = app.tabs.find((t) => t.id === app.activeTabId)
  if (!tab) return null
  // Only shells that actually speak PowerShell: the line handed over is
  // PowerShell, and typing it into bash or cmd would run something else
  // entirely while telling the adapter everything went fine.
  const speaksPs = new Set(
    app.profiles.filter((p) => p.integration === 'powershell').map((p) => p.id)
  )
  const terminals = paneIdsOf(tab)
    .map((id) => app.panes[id])
    .filter(
      (p): p is Extract<typeof p, { kind: 'terminal' }> =>
        p?.kind === 'terminal' && speaksPs.has(p.profileId)
    )
  return terminals.find((p) => p.integration === 'ready' && !p.exited)?.id ?? null
}

export async function startDebugging(): Promise<void> {
  const app = useStore.getState()
  const debug = useDebugStore.getState()
  if (debug.status === 'stopped') {
    debugContinue()
    return
  }
  if (debug.status !== 'idle') return
  // Claimed synchronously, before the first await: a held-down F5 auto-repeats
  // faster than any IPC answers, and two launches of the same program is not a
  // thing anyone has ever wanted.
  useDebugStore.setState({ status: 'starting' })
  const idleAgain = (): void => useDebugStore.setState({ status: 'idle' })

  // The options may never have been built — F5 works without the panel open,
  // and a restored launch choice must mean what it says.
  await refreshLaunchOptions()
  const adapters = await window.ember.listDebugAdapters()
  const fresh = useDebugStore.getState()
  const choice = fresh.launchOptions.find((o) => o.id === fresh.launchChoice) ?? fresh.launchOptions[0]
  const workspace = app.treeRoot ?? ''
  const file = activeEditorFile()

  let adapterId: string | null = null
  let launch: Record<string, unknown> | null = null

  if (choice.kind === 'config' && choice.config) {
    const type = String(choice.config.type ?? '')
    adapterId = adapterIdFor(type, adapters)
    if (!adapterId) {
      app.setNotice(`No debug adapter answers for type '${type}'.`, 'info')
      idleAgain()
      return
    }
    try {
      launch = substitute(choice.config, workspace, file) as Record<string, unknown>
    } catch {
      app.setNotice('The launch configuration could not be resolved.', 'error')
      idleAgain()
      return
    }
    if (typeof launch.request !== 'string') launch.request = 'launch'
    // The debuggee runs in a real pane when the config asks for a terminal;
    // with no pane to give it, the protocol console keeps things honest.
    if (launch.console === 'integratedTerminal' && !terminalPaneForDebuggee()) {
      launch.console = 'internalConsole'
    }
  } else if (choice.kind === 'attach') {
    adapterId = 'pwa-node'
    launch = {
      type: 'pwa-node',
      request: 'attach',
      name: 'Ember: attach',
      port: 9229,
      address: 'localhost',
      cwd: workspace || undefined
    }
  } else {
    if (!file) {
      app.setNotice('Open the file to debug first — F5 runs the active file.', 'info')
      idleAgain()
      return
    }
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase()
    const adapter = adapters.find((a) => a.extensions.includes(ext))
    if (!adapter) {
      app.setNotice(
        adapters.length === 0
          ? 'No debug adapter found — run scripts/fetch-js-debug.mjs, or teach one in settings.'
          : `No debug adapter answers for ${ext} files.`,
        'info'
      )
      idleAgain()
      return
    }
    adapterId = adapter.id
    launch = { type: adapter.id, request: 'launch', name: 'Ember: active file', program: file, cwd: dirnameOf(file) }
    if (adapter.id === 'pwa-node') {
      // A real pane when one is standing — stdin works there — else the protocol.
      launch.console = terminalPaneForDebuggee() ? 'integratedTerminal' : 'internalConsole'
      launch.outputCapture = 'std'
    }
  }

  if (!adapterId || !launch) {
    idleAgain()
    return
  }
  await startWith({ adapterId, launch }, adapters)
}

async function startWith(req: DebugStartRequest, adapters?: DebugAdapter[]): Promise<void> {
  const app = useStore.getState()
  const list = adapters ?? (await window.ember.listDebugAdapters())
  const adapter = list.find((a) => a.id === req.adapterId)

  lastStart = req
  restartPending = false
  cancelRequested = false
  endedEarly.clear()
  useDebugStore.setState({
    status: 'starting',
    adapterName: adapter?.name ?? req.adapterId,
    sessions: [],
    output: [],
    repl: [],
    // Filters belong to the adapter that declared them; a new session's
    // capabilities repopulate this before its 'initialized' is answered.
    exceptionFilters: [],
    ...EMPTY_RUN
  })

  const res = await window.ember.dapStart(req)
  if (!res.ok || !res.sessionId) {
    useDebugStore.setState({ status: 'idle', adapterName: null })
    app.setNotice(res.error ?? 'The debugger could not start.', 'error')
    return
  }
  if (cancelRequested) {
    // Shift+F5 landed while the adapter was standing up; keep the promise.
    cancelRequested = false
    void window.ember.dapStop(res.sessionId)
    useDebugStore.setState({ status: 'idle', adapterName: null })
    return
  }
  if (endedEarly.has(res.sessionId)) {
    // The session said goodbye before this reply arrived — a crash right
    // after the handshake. Idle is the truth.
    endedEarly.delete(res.sessionId)
    useDebugStore.setState({ status: 'idle', adapterName: null })
    return
  }
  useDebugStore.setState((s) => ({ status: 'running', sessions: [...s.sessions, res.sessionId!] }))
}

/* ---------- the console ---------- */

export async function evaluateRepl(expression: string): Promise<void> {
  const s = useDebugStore.getState()
  const sessionId = s.stoppedSessionId ?? s.sessions[s.sessions.length - 1]
  if (!expression.trim() || !sessionId) return
  const res = await request(sessionId, 'evaluate', {
    expression,
    context: 'repl',
    ...(s.status === 'stopped' && s.activeFrameId !== null ? { frameId: s.activeFrameId } : {})
  })
  const result = res.ok
    ? String((res.body as { result?: unknown })?.result ?? '')
    : (res.error ?? 'The evaluation failed.')
  useDebugStore.setState((prev) => ({
    repl: [...prev.repl.slice(-99), { expression, result, error: !res.ok }]
  }))
}

/* ---------- the debuggee's terminal ---------- */

/** One value, said in PowerShell without being interpreted by it. Newlines
    become spaces: the line is typed into a pty, and a linebreak inside a value
    would end the command early no matter how well it is quoted. */
const psQuote = (v: string): string =>
  `'${v.replace(/[\r\n]/g, ' ').replace(/'/g, "''")}'`

/**
 * The adapter asked for its program to run in a real terminal. Build the line
 * — environment, directory, program — and run it as an ordinary command in the
 * active tab's shell, where it becomes a block and its stdin belongs to the
 * user. The reply tells the adapter the command is standing.
 */
function runDebuggeeInTerminal(body: {
  requestSeq?: number
  args?: string[]
  cwd?: string
  env?: Record<string, string | null>
}): boolean {
  const paneId = terminalPaneForDebuggee()
  const controller = paneId ? existingController(paneId) : undefined
  const args = (body.args ?? []).map(String)
  if (!controller || args.length === 0) return false

  const parts: string[] = []
  const setKeys: string[] = []
  for (const [key, value] of Object.entries(body.env ?? {})) {
    if (value === null) continue
    // The key is interpolated into the command line and cannot be quoted the
    // way a value can — anything but a plain identifier is refused outright,
    // because "creative" keys from a cloned repo's launch.json would otherwise
    // be raw PowerShell running in the user's shell.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    setKeys.push(key)
    parts.push(`$env:${key}=${psQuote(String(value))}`)
  }
  if (body.cwd) parts.push(`cd ${psQuote(String(body.cwd))}`)
  parts.push(`& ${args.map(psQuote).join(' ')}`)
  if (setKeys.length > 0) {
    // The debug environment is for the debuggee, not for the user's shell: a
    // NODE_OPTIONS bootloader left behind would quietly attach a debugger to
    // every node the user runs afterwards. Cleared once the program is done.
    parts.push(
      `Remove-Item ${setKeys.map((k) => `Env:${k}`).join(', ')} -ErrorAction SilentlyContinue`
    )
  }
  controller.runCommand(parts.join('; '))
  return true
}

/* ---------- events ---------- */

/** Wired once at boot; every DAP event lands here. */
export function handleDapEvent(payload: DapEventPayload): void {
  const { sessionId, event, body } = payload
  const s = useDebugStore.getState()

  switch (event) {
    case 'session-started':
      useDebugStore.setState({ sessions: [...s.sessions, sessionId] })
      return
    case 'capabilities-known': {
      const raw = (body as { exceptionBreakpointFilters?: { filter: string; label: string; default?: boolean }[] })
        ?.exceptionBreakpointFilters
      if (!raw || raw.length === 0) return
      useDebugStore.setState({
        exceptionFilters: raw.map((f) => ({
          filter: f.filter,
          label: f.label,
          enabled: exceptionChoice[f.filter] ?? f.default === true
        }))
      })
      return
    }
    case 'initialized':
      // Every session — broker or child — is told the window's breakpoints and
      // exception choices, then released. The order is the protocol's own.
      void sendAllBreakpoints(sessionId).then(() =>
        request(sessionId, 'configurationDone')
      )
      return
    case 'stopped':
      void onStopped(sessionId, (body as { reason?: string; threadId?: number }) ?? {})
      return
    case 'continued':
      if (s.stoppedSessionId === sessionId) {
        stopGeneration++
        useDebugStore.setState({ status: 'running', ...EMPTY_RUN })
      }
      return
    case 'output': {
      const o = body as { category?: string; output?: string }
      appendOutput(o?.category ?? 'console', o?.output ?? '')
      return
    }
    case 'run-in-terminal': {
      const args = body as {
        requestSeq?: number
        args?: string[]
        cwd?: string
        env?: Record<string, string | null>
      }
      const ok = runDebuggeeInTerminal(args)
      if (typeof args?.requestSeq === 'number') {
        window.ember.dapReverseReply(sessionId, args.requestSeq, ok)
      }
      return
    }
    case 'session-ended': {
      if (!s.sessions.includes(sessionId)) {
        // Goodbye before hello: the start reply has not landed yet. Remember
        // it so the reply does not resurrect a session that already died.
        endedEarly.add(sessionId)
        return
      }
      const sessions = s.sessions.filter((id) => id !== sessionId)
      if (sessions.length === 0) {
        stopGeneration++
        useDebugStore.setState({ status: 'idle', adapterName: null, sessions, ...EMPTY_RUN })
        if (restartPending && lastStart) {
          restartPending = false
          void startWith(lastStart)
        }
      } else if (s.stoppedSessionId === sessionId) {
        stopGeneration++
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
