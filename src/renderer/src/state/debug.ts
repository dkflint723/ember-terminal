import { create } from 'zustand'
import type { DapEventPayload, DebugAdapter, DebugStartRequest } from '@shared/types'
import { debuggeeLabel, debuggeeLine, MOST_LINE, taskLabel, taskLine } from '@shared/debuggee'
import { resolveLaunchVariables, type LaunchContext } from '@shared/launch-vars'
import { forWindows, resolveTask, type ResolvedTask } from '@shared/launch-tasks'
import { existingController } from '../terminal/controller'
import { readinessOf } from '../terminal/typing'
import { monacoIfLoaded } from '../editor/loaded'
import { activeDocument, paneIdsOf, useStore, workspaceRoot, type CommandBlock } from './store'
import { mayRunIn } from '@shared/trust'
import { explainRestricted, learnRealName } from './trust'

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
  /** Stop only on a hit count the adapter understands — `5`, `>= 3`, `% 2`. */
  hitCondition?: string
}

/**
 * What the adapter said it can do. The panel shows a control only where the
 * adapter will honour it; before any adapter has said, it shows them all.
 */
export interface DebugCapabilities {
  conditions: boolean
  logPoints: boolean
  hitConditions: boolean
  terminate: boolean
}

export interface WatchResult {
  value: string
  error: boolean
  variablesReference: number
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
  kind: 'active-file' | 'config' | 'attach' | 'unsupported'
  config?: Record<string, unknown>
  /** For an entry Ember cannot run: why, said when it is chosen. */
  why?: string
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
  /** The last adapter's capabilities; null until one has said. */
  capabilities: DebugCapabilities | null
  /** The Watch panel's expressions, kept across runs and in the session file. */
  watches: string[]
  /** Their values in the frame being looked at, by expression. */
  watchResults: Record<string, WatchResult>
}

const EMPTY_RUN = {
  stoppedSessionId: null as string | null,
  threadId: null as number | null,
  threads: [] as { id: number; name: string }[],
  stoppedReason: null as string | null,
  frames: [] as DebugFrame[],
  activeFrameId: null as number | null,
  scopes: [] as DebugScope[],
  variables: {} as Record<number, DebugVariable[]>,
  watchResults: {} as Record<string, WatchResult>
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
  repl: [],
  capabilities: null,
  watches: []
}))

/** Each session's capabilities: configurationDone is only sent where it is understood. */
const sessionCapabilities = new Map<string, Record<string, unknown>>()

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

/*
 * Collected, and added once a frame. Each output event copied the whole buffer and
 * re-rendered the panel, so a program printing in a loop kept the window busy doing
 * little else. A timer rather than an animation frame: a window in the background
 * gets no frames, and its output would wait until it was looked at.
 */
let pendingOutput: { category: string; text: string }[] = []
let outputFlush: ReturnType<typeof setTimeout> | null = null

function appendOutput(category: string, text: string): void {
  if (!text) return
  pendingOutput.push({ category, text })
  if (outputFlush !== null) return
  outputFlush = setTimeout(() => {
    const batch = pendingOutput
    pendingOutput = []
    outputFlush = null
    useDebugStore.setState((s) => ({ output: [...s.output, ...batch].slice(-OUTPUT_CAP) }))
  }, 16)
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
  /*
   * Paths, not the breakpoint lists themselves.
   *
   * This loop awaits a full round trip per file, and a list taken before the first
   * of them is a statement about a file the user may have clicked in since — a
   * debugger takes a moment to come up, and the margin is right there.
   */
  const paths = Object.values(useDebugStore.getState().breakpoints).map((f) => f.path)
  for (const path of paths) await sendFileBreakpoints(sessionId, path)
  await sendExceptionFilters(sessionId)
}

/**
 * Every mutation of a file's breakpoints bumps its version, and a reply is
 * only merged back when nothing moved during the round trip. A stale reply is
 * simply dropped — the mutation that made it stale has already scheduled a
 * resend of its own, which will bring fresh verification.
 */
const breakpointVersions = new Map<string, number>()
/** `${sessionId}:${id}` → the file and line an adapter's breakpoint id stands for. */
const breakpointIds = new Map<string, { key: string; line: number }>()
const bumpVersion = (key: string): void => {
  breakpointVersions.set(key, (breakpointVersions.get(key) ?? 0) + 1)
}

async function sendFileBreakpoints(sessionId: string, filePath: string): Promise<void> {
  const key = fileKey(filePath)
  /*
   * The lines and the version they belong to are read together, in one turn.
   *
   * The guard below drops a reply if the version moved during the round trip, and
   * that is only sound if the version was sampled at the same instant as the lines
   * it vouches for. They used to come from different places: the caller captured
   * the list, the callee read the version afterwards. A breakpoint added while an
   * earlier file was still in flight therefore bumped the version BEFORE this line
   * ran — so the guard compared a number with itself, passed, and the merge below,
   * which is a full replacement, wrote the list from before the click back over the
   * store. The line vanished from the store, from the gutter that repaints off it,
   * and from the adapter. The merge does not bump the version and the click's own
   * debounce had already fired, so nothing ever resent it. It was gone for good.
   */
  const held = useDebugStore.getState().breakpoints[key]
  const sent = held?.lines ?? []
  const path = held?.path ?? filePath
  const versionAtSend = breakpointVersions.get(key) ?? 0
  const res = await request(sessionId, 'setBreakpoints', {
    source: { path },
    breakpoints: sent.map((l) => ({
      line: l.line,
      ...(l.condition ? { condition: l.condition } : {}),
      ...(l.logMessage ? { logMessage: l.logMessage } : {}),
      ...(l.hitCondition ? { hitCondition: l.hitCondition } : {})
    })),
    sourceModified: false
  })
  if (!res.ok) return
  if ((breakpointVersions.get(key) ?? 0) !== versionAtSend) return
  const answered = (res.body as { breakpoints?: { id?: number; verified?: boolean; line?: number }[] })
    ?.breakpoints
  if (!answered) return
  // The adapter's ids, so a later `breakpoint` event can say which one it means.
  for (const [k, where] of breakpointIds) if (where.key === key && k.startsWith(`${sessionId}:`)) breakpointIds.delete(k)
  answered.forEach((reply, i) => {
    if (typeof reply?.id === 'number') {
      breakpointIds.set(`${sessionId}:${reply.id}`, { key, line: reply.line ?? sent[i]?.line ?? 0 })
    }
  })
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
          logMessage: asked.logMessage,
          hitCondition: asked.hitCondition
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
      for (const sessionId of useDebugStore.getState().sessions) {
        void sendFileBreakpoints(sessionId, filePath)
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
  meta: { condition?: string; logMessage?: string; hitCondition?: string }
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
                  logMessage: meta.logMessage?.trim() ? meta.logMessage.trim() : undefined,
                  hitCondition: meta.hitCondition?.trim() ? meta.hitCondition.trim() : undefined
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
        ...(l.logMessage ? { logMessage: l.logMessage } : {}),
        ...(l.hitCondition ? { hitCondition: l.hitCondition } : {})
      }))
    })),
    exceptionFilters: exceptionChoice,
    launchChoice: s.launchChoice,
    watches: s.watches
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
        condition: typeof l.condition === 'string' ? l.condition : undefined,
        logMessage: typeof l.logMessage === 'string' ? l.logMessage : undefined,
        hitCondition: typeof l.hitCondition === 'string' ? l.hitCondition : undefined
      }))
    if (lines.length > 0) breakpoints[fileKey(file.path)] = { path: file.path, lines }
  }
  exceptionChoice =
    typeof saved.exceptionFilters === 'object' && saved.exceptionFilters !== null
      ? saved.exceptionFilters
      : {}
  const watches = Array.isArray(saved.watches)
    ? saved.watches.filter((w): w is string => typeof w === 'string' && w.trim().length > 0).slice(0, 50)
    : []
  useDebugStore.setState({
    breakpoints,
    watches,
    ...(typeof saved.launchChoice === 'string' ? { launchChoice: saved.launchChoice } : {})
  })
}

/* ---------- breakpoints that move with their files ---------- */

const inside = (parent: string, p: string): boolean => {
  const a = fileKey(parent).replace(/\/+$/, '')
  const b = fileKey(p)
  return b === a || b.startsWith(`${a}/`)
}

/**
 * A file or folder renamed in the explorer: its breakpoints go with it.
 *
 * They were keyed by path and stayed on the old one — hollow dots on a file that no
 * longer existed, and none on the file the code was now in. The adapter is told
 * both halves: the old path has none, the new one has them.
 */
export function moveBreakpoints(from: string, to: string): void {
  const moved: string[] = []
  useDebugStore.setState((s) => {
    const next = { ...s.breakpoints }
    for (const [key, file] of Object.entries(s.breakpoints)) {
      if (!inside(from, file.path)) continue
      // By the normalised prefix: `inside` matched it without case or a trailing slash.
      const path = to.replace(/[\\/]+$/, '') + file.path.slice(from.replace(/[\\/]+$/, '').length)
      delete next[key]
      next[fileKey(path)] = { path, lines: file.lines.map((l) => ({ ...l, verified: false })) }
      moved.push(file.path, path)
    }
    return moved.length > 0 ? { breakpoints: next } : s
  })
  for (const path of moved) {
    bumpVersion(fileKey(path))
    scheduleResend(path)
  }
}

/** A file or folder deleted in the explorer: its breakpoints go too, and the adapter is told. */
export function dropBreakpoints(target: string): void {
  const dropped: string[] = []
  useDebugStore.setState((s) => {
    const next = { ...s.breakpoints }
    for (const [key, file] of Object.entries(s.breakpoints)) {
      if (!inside(target, file.path)) continue
      delete next[key]
      dropped.push(file.path)
    }
    return dropped.length > 0 ? { breakpoints: next } : s
  })
  for (const path of dropped) {
    bumpVersion(fileKey(path))
    scheduleResend(path)
  }
}

/**
 * The adapter changed its mind about a breakpoint — verified it once the script
 * loaded, or moved it to the line code is really on. There was no handler, so a
 * breakpoint an adapter verifies late (js-debug does, for any file not yet loaded)
 * stayed a hollow dot while it worked.
 */
function onBreakpointEvent(sessionId: string, body: unknown): void {
  const b = body as { reason?: string; breakpoint?: { id?: number; verified?: boolean; line?: number; source?: { path?: string } } }
  const bp = b?.breakpoint
  if (!bp) return
  const known = typeof bp.id === 'number' ? breakpointIds.get(`${sessionId}:${bp.id}`) : undefined
  const key = known?.key ?? (bp.source?.path ? fileKey(bp.source.path) : null)
  const was = known?.line ?? bp.line
  if (!key || was === undefined) return
  useDebugStore.setState((s) => {
    const file = s.breakpoints[key]
    if (!file) return s
    const index = file.lines.findIndex((l) => l.line === was)
    if (index < 0) return s
    const line = typeof bp.line === 'number' && bp.line > 0 ? bp.line : was
    // Moved onto a line that already has one: the two are one breakpoint now.
    if (line !== was && file.lines.some((l) => l.line === line)) return s
    const verified = b.reason === 'removed' ? false : bp.verified === true
    const lines = file.lines.map((l, i) => (i === index ? { ...l, line, verified } : l)).sort((x, y) => x.line - y.line)
    if (known && typeof bp.id === 'number') breakpointIds.set(`${sessionId}:${bp.id}`, { key, line })
    return { breakpoints: { ...s.breakpoints, [key]: { path: file.path, lines } } }
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
  // js-debug debugs browsers too, and its server answers for them under the same roof.
  chrome: 'pwa-node',
  'pwa-chrome': 'pwa-node',
  msedge: 'pwa-node',
  'pwa-msedge': 'pwa-node',
  python: 'debugpy'
}
/** VS Code's names for js-debug's configurations, and the names js-debug itself uses. */
const JS_DEBUG_TYPE: Record<string, string> = {
  node: 'pwa-node',
  chrome: 'pwa-chrome',
  msedge: 'pwa-msedge'
}
/**
 * Types VS Code runs through machinery of its own rather than an adapter, and what
 * to write instead. Listed, so that choosing one says so rather than the entry
 * being missing from the list with no word as to why.
 */
const NOT_ADAPTERS: Record<string, string> = {
  'node-terminal':
    'A node-terminal configuration opens a VS Code terminal with the debugger attached, which Ember has no way to do. Use "type": "node" with "console": "integratedTerminal".'
}
/**
 * Fields VS Code acts on that Ember does not, and what that means for the run. Said
 * in the Debug view's output when a configuration has them, rather than dropped.
 */
const IGNORED_FIELDS: Record<string, string> = {
  postDebugTask: 'no task runs when the debugging ends',
  serverReadyAction: 'no browser is opened when the server says it is ready'
}
const adapterIdFor = (type: string, adapters: DebugAdapter[]): string | null => {
  const mapped = TYPE_MAP[type] ?? type
  return adapters.some((a) => a.id === mapped) ? mapped : null
}

const dirnameOf = (p: string): string =>
  p.slice(0, Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/')))

/**
 * What F5 runs from: the open folder, the file in front of you, its caret and
 * selection, and your home folder — everything a launch.json variable can name that
 * the window knows.
 */
function launchContext(workspace: string, file: string | null): LaunchContext {
  const editors = monacoIfLoaded()?.monaco.editor.getEditors() ?? []
  const editor = editors.find((e) => e.hasTextFocus()) ?? editors.find((e) => e.getModel() && file && fileKey(e.getModel()!.uri.fsPath) === fileKey(file))
  const position = editor?.getPosition()
  const selection = editor?.getSelection()
  const model = editor?.getModel()
  return {
    workspace,
    file,
    ...(position ? { line: position.lineNumber } : {}),
    ...(selection && model && !selection.isEmpty() ? { selection: model.getValueInRange(selection) } : {}),
    home: window.ember.homeDir
  }
}

/**
 * What the F5 picker offers: the active file always, every launch.json entry,
 * and an attach for Node when Node is here. An entry Ember cannot run is still
 * listed, and choosing it says why — it used to be left out without a word.
 */
export async function refreshLaunchOptions(): Promise<void> {
  const options: LaunchOption[] = [{ id: 'active-file', label: 'Active file', kind: 'active-file' }]
  const adapters = await window.ember.listDebugAdapters()
  const root = workspaceRoot(useStore.getState())

  if (root) {
    const read = await window.ember.readFile(`${root}\\.vscode\\launch.json`)
    if (read.ok) {
      try {
        const parsed = parseJsonc(read.content) as {
          configurations?: Record<string, unknown>[]
          compounds?: Record<string, unknown>[]
        }
        for (const config of parsed?.configurations ?? []) {
          const name = typeof config?.name === 'string' ? config.name : null
          const type = typeof config?.type === 'string' ? config.type : null
          if (!name || !type) continue
          if (NOT_ADAPTERS[type]) {
            options.push({ id: `config:${name}`, label: `${name} (not supported)`, kind: 'unsupported', why: NOT_ADAPTERS[type] })
          } else if (!adapterIdFor(type, adapters)) {
            options.push({
              id: `config:${name}`,
              label: `${name} (no adapter)`,
              kind: 'unsupported',
              why: `No debug adapter answers for type ‘${type}’. Teach one in settings, under debugAdapters.`
            })
          } else {
            options.push({ id: `config:${name}`, label: name, kind: 'config', config })
          }
        }
        for (const compound of parsed?.compounds ?? []) {
          const name = typeof compound?.name === 'string' ? compound.name : null
          if (!name) continue
          options.push({
            id: `compound:${name}`,
            label: `${name} (compound, not supported)`,
            kind: 'unsupported',
            why: 'A compound starts several configurations together, and Ember debugs one at a time. Start its configurations one by one.'
          })
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
  await evaluateWatches()
  for (const scope of scopes) {
    if (!scope.expensive) await fetchVariables(scope.variablesReference)
  }
}

/* ---------- the Watch panel ---------- */

/**
 * Each watch expression, evaluated in the frame being looked at. After the scopes
 * are known and before the variables are fetched: a watch is the thing someone
 * chose to look at, and should not wait behind a large scope.
 */
async function evaluateWatches(): Promise<void> {
  const s = useDebugStore.getState()
  const sessionId = s.stoppedSessionId
  const frameId = s.activeFrameId
  if (!sessionId || frameId === null || s.watches.length === 0) return
  const generation = stopGeneration
  const results: Record<string, WatchResult> = {}
  await Promise.all(
    s.watches.map(async (expression) => {
      const res = await request(sessionId, 'evaluate', { expression, frameId, context: 'watch' })
      const answer = res.body as { result?: unknown; variablesReference?: number } | undefined
      results[expression] = res.ok
        ? { value: String(answer?.result ?? ''), error: false, variablesReference: answer?.variablesReference ?? 0 }
        : { value: res.error ?? 'Not available', error: true, variablesReference: 0 }
    })
  )
  // Answers for a stop that has moved on, or a frame no longer being looked at, are not these.
  const now = useDebugStore.getState()
  if (generation !== stopGeneration || now.activeFrameId !== frameId) return
  useDebugStore.setState({ watchResults: results })
}

export function addWatch(expression: string): void {
  const text = expression.trim()
  if (!text || useDebugStore.getState().watches.includes(text)) return
  useDebugStore.setState((s) => ({ watches: [...s.watches, text].slice(-50) }))
  void evaluateWatches()
}

export function removeWatch(expression: string): void {
  useDebugStore.setState((s) => {
    const { [expression]: _gone, ...rest } = s.watchResults
    void _gone
    return { watches: s.watches.filter((w) => w !== expression), watchResults: rest }
  })
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
  /*
   * A prompt, not merely a shell. `integration === 'ready'` says the handshake
   * happened once; it says nothing about what has the keyboard now. The line
   * handed over is written straight into the pty (controller.runCommand ->
   * send(`${line}\r`)), so a pane with a program in it takes it as that
   * program's stdin: F5 with `npm run dev` (or vim, or a python REPL) in the
   * tab's shell typed `$env:NODE_OPTIONS=…; cd …; & 'node' 'app.js'` into the
   * dev server, reported success to the adapter, and the session died 15s
   * later on dap.ts's REQUEST_TIMEOUT_MS with 'The adapter never answered
   * launch.' — after a line of PowerShell had been injected into whatever the
   * user had open. The pane already knows: the alternate screen (mode 'raw'),
   * a command still running, and a masked secret prompt. With no pane at a
   * prompt the callers fall back to console 'internalConsole', which is honest
   * about where the output goes.
   *
   * The rule was first written here, and now lives in terminal/typing.ts, where
   * every other button that types into a terminal uses it too.
   */
  return terminals.find((p) => readinessOf(p.id).ok)?.id ?? null
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
  /*
   * The window a stop can land in opens on the line above, so it starts empty
   * here rather than in startWith, which is several awaits too late to be the
   * beginning of anything. Reaching this line means the status was 'idle', and
   * a stop only raises the flag while it is 'starting' — so anything still
   * raised belongs to a start that is already over.
   */
  cancelRequested = false
  const idleAgain = (): void => {
    // Going idle with a stop still pending would carry it into the next F5.
    cancelRequested = false
    useDebugStore.setState({ status: 'idle', adapterName: null })
  }

  /*
   * Whatever goes wrong on the way, the debugger comes back to idle and says what.
   * A throw anywhere past the claim above — a taught adapter whose entry had no
   * extensions was one — left the panel reading "Starting…" until the window was
   * reloaded, and F5 did nothing at all in the meantime (DA-06).
   */
  try {
    await prepareStart(app, idleAgain)
  } catch (err) {
    idleAgain()
    app.setNotice(`The debugger could not start: ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/** Say why a configuration's variables could not all be filled in. */
function unsupportedVariables(list: string[]): string {
  const reasons: string[] = []
  if (list.some((v) => v.startsWith('${command:'))) reasons.push('${command:…} runs a command from a VS Code extension')
  if (list.some((v) => v.startsWith('${input:'))) reasons.push('${input:…} asks a question Ember has no way to put')
  const said = reasons.length > 0 ? ` — ${reasons.join(', and ')}` : ''
  return `The launch configuration uses ${list.join(', ')}, which Ember cannot fill in${said}. The debugger did not start.`
}

async function prepareStart(app: ReturnType<typeof useStore.getState>, idleAgain: () => void): Promise<void> {
  // The options may never have been built — F5 works without the panel open,
  // and a restored launch choice must mean what it says.
  await refreshLaunchOptions()
  const adapters = await window.ember.listDebugAdapters()
  const fresh = useDebugStore.getState()
  const choice = fresh.launchOptions.find((o) => o.id === fresh.launchChoice) ?? fresh.launchOptions[0]
  if (choice.kind === 'unsupported') {
    app.setNotice(choice.why ?? 'Ember cannot run this configuration.', 'info')
    idleAgain()
    return
  }
  const workspace = workspaceRoot(app) ?? ''
  const file = activeEditorFile()

  /*
   * A launch configuration is somebody else's command line: .vscode/launch.json
   * arrives with the repository, and F5 without one runs the file in front of
   * you. Neither reads as "run this repository", so a folder nobody has trusted
   * does not get to.
   *
   * Gated here rather than at each branch below, which is where a fourth kind of
   * launch would quietly have missed it.
   */
  const asked = workspace || file
  const real = asked ? await learnRealName(asked) : null
  if (!mayRunIn(asked, app.settings, real).trusted) {
    explainRestricted('The debugger did not start.')
    idleAgain()
    return
  }

  let adapterId: string | null = null
  let launch: Record<string, unknown> | null = null
  let task: ResolvedTask | null = null
  const notes: string[] = []

  if (choice.kind === 'config' && choice.config) {
    // What VS Code does on Windows: the configuration's `windows` block laid over it.
    const config = forWindows(choice.config)
    const type = String(config.type ?? '')
    adapterId = adapterIdFor(type, adapters)
    if (!adapterId) {
      app.setNotice(`No debug adapter answers for type '${type}'.`, 'info')
      idleAgain()
      return
    }
    /*
     * Every variable VS Code knows, filled in — or the launch refused, naming the
     * ones that cannot be. Five were substituted and the rest went through as text,
     * so `${userHome}/app.js` was a program path, and the launch failed saying only
     * that the file did not exist (DA-05). `${env:…}` is left for main.
     */
    const context = launchContext(workspace, file)
    const resolved = resolveLaunchVariables(config, context)
    if (!resolved.ok) {
      app.setNotice(unsupportedVariables(resolved.unsupported), 'error')
      idleAgain()
      return
    }
    launch = resolved.value as Record<string, unknown>
    if (typeof launch.request !== 'string') launch.request = 'launch'
    for (const [field, meaning] of Object.entries(IGNORED_FIELDS)) {
      if (launch[field] !== undefined) notes.push(`Ember does not act on ${field} in this configuration: ${meaning}.\n`)
    }
    /*
     * The task a configuration asks for before it starts: a TypeScript project's
     * build, above all. It was ignored, and the program launched was the JavaScript
     * from whenever the last build happened to be.
     */
    if (typeof launch.preLaunchTask === 'string' && launch.preLaunchTask.trim()) {
      const read = workspace ? await window.ember.readFile(`${workspace}\\.vscode\\tasks.json`) : null
      let tasksJson: unknown = null
      if (read?.ok) {
        try {
          tasksJson = parseJsonc(read.content)
        } catch {
          app.setNotice('.vscode/tasks.json could not be read, so its preLaunchTask cannot run. The debugger did not start.', 'error')
          idleAgain()
          return
        }
      }
      const found = resolveTask(launch.preLaunchTask, tasksJson, { ...context, workspace: workspace || (file ? dirnameOf(file) : '') })
      if (!found.ok) {
        app.setNotice(`${found.reason} The debugger did not start.`, 'error')
        idleAgain()
        return
      }
      task = found.task
    }
    /*
     * In the name js-debug answers to. A launch.json written for VS Code says
     * "type": "node" — VS Code translates that for js-debug itself — and js-debug's
     * own server knows only `pwa-node`: every such configuration failed with
     * "Unknown config", said only in the Debug view.
     */
    // Only for js-debug: a taught adapter answering to `chrome` itself knows no other name.
    if (adapterId === 'pwa-node' && typeof launch.type === 'string' && JS_DEBUG_TYPE[launch.type]) {
      launch.type = JS_DEBUG_TYPE[launch.type]
    }
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
  lastTask = task
  await runTaskThenStart({ adapterId, launch }, task, notes, adapters)
}

/* ---------- the task before the launch ---------- */

/** The preLaunchTask of the last start, run again by a restart as VS Code does. */
let lastTask: ResolvedTask | null = null

/**
 * The task first, when there is one, and the launch only if it succeeded.
 *
 * Idle, with a notice, when it did not: a build that failed has left nothing new to
 * debug, and launching the old output anyway is exactly what running the task is for
 * preventing.
 */
async function runTaskThenStart(
  req: DebugStartRequest,
  task: ResolvedTask | null,
  notes: string[],
  adapters?: DebugAdapter[]
): Promise<void> {
  if (task && !(await runPreLaunchTask(task))) {
    cancelRequested = false
    useDebugStore.setState({ status: 'idle', adapterName: null })
    return
  }
  await startWith(req, adapters, notes)
}

/**
 * How a block ended: its exit code, or why it will not say. An end is trusted once
 * it has stood for a moment — a line whose start marker arrives late is marked
 * finished and then reopened, under the same id (controller.ts, reopenUnstarted).
 */
function blockOutcome(paneId: string, blockId: string): Promise<{ exitCode: number | null } | 'cancelled' | 'gone'> {
  return new Promise((resolve) => {
    let endedAt = 0
    const tick = (): void => {
      if (cancelRequested) return resolve('cancelled')
      const pane = useStore.getState().terminalPane(paneId)
      const block = pane?.blocks.find((b): b is CommandBlock => b.kind === 'command' && b.id === blockId)
      if (!pane || !block) return resolve('gone')
      if (block.status === 'running') {
        if (pane.exited) return resolve('gone')
        endedAt = 0
      } else if (endedAt === 0) {
        endedAt = Date.now()
      } else if (Date.now() - endedAt >= 400) {
        return resolve({ exitCode: block.exitCode })
      }
      window.setTimeout(tick, 150)
    }
    tick()
  })
}

/**
 * Run the task where the debuggee would run: a PowerShell pane at its prompt in this
 * tab, in a child of that shell (shared/debuggee.ts), so a build that changes folder
 * or sets a variable leaves the pane's shell as it was. It is a block like any other
 * command — its output is there to read when it fails — named for the task.
 */
/**
 * A PowerShell pane at its prompt, waited for a moment when there is none yet. A
 * restart comes here the instant the old session ends, while the program it ran in
 * the terminal is still being taken down and the pane's prompt has not come back;
 * without the wait a restart with a preLaunchTask, or a program in the terminal, was
 * refused for want of a pane that was about to be there. A stop asked for ends it.
 */
async function debuggeePane(ms = 8_000): Promise<string | null> {
  for (const until = Date.now() + ms; ; ) {
    const id = terminalPaneForDebuggee()
    if (id || cancelRequested || Date.now() >= until) return id
    await new Promise((r) => window.setTimeout(r, 150))
  }
}

async function runPreLaunchTask(task: ResolvedTask): Promise<boolean> {
  const app = useStore.getState()
  useDebugStore.setState({ status: 'starting', adapterName: `the task ‘${task.label}’` })
  const paneId = await debuggeePane()
  if (cancelRequested) return false
  const controller = paneId ? existingController(paneId) : undefined
  if (!paneId || !controller) {
    app.setNotice(
      `The preLaunchTask ‘${task.label}’ runs in a PowerShell terminal, and this tab has none at its prompt. The debugger did not start.`,
      'error'
    )
    return false
  }
  // Measured with room for the file's name, before a file is written for a line that
  // would be refused: one that is never read holds its values until the next sweep.
  if (taskLine({ script: task.script, cwd: task.cwd, envFile: task.env ? 'x'.repeat(260) : undefined }).length > MOST_LINE) {
    app.setNotice(`The preLaunchTask ‘${task.label}’ is too long a command for Windows to start. The debugger did not start.`, 'error')
    return false
  }
  const envFile = task.env ? ((await window.ember.dapEnvFile(task.env)) ?? undefined) : undefined
  const line = taskLine({ script: task.script, cwd: task.cwd, envFile })
  const blockId = cancelRequested ? null : controller.runCommand(line, { label: taskLabel(task.label) })
  if (!blockId) {
    if (envFile) void window.ember.dapDropEnvFile(envFile)
    if (cancelRequested) return false
    app.setNotice(`The preLaunchTask ‘${task.label}’ could not be run in the terminal. The debugger did not start.`, 'error')
    return false
  }
  const outcome = await blockOutcome(paneId, blockId)
  if (outcome === 'cancelled') {
    app.setNotice(`The debugger did not start. The task ‘${task.label}’ goes on in its terminal until it ends or you stop it there.`, 'info')
    return false
  }
  if (outcome === 'gone') {
    app.setNotice(`The preLaunchTask ‘${task.label}’ did not finish in its terminal. The debugger did not start.`, 'error')
    return false
  }
  if (outcome.exitCode !== 0) {
    app.setNotice(
      `The preLaunchTask ‘${task.label}’ failed${outcome.exitCode !== null ? ` (exit code ${outcome.exitCode})` : ''}. The debugger did not start; its output is in the terminal.`,
      'error'
    )
    return false
  }
  return true
}

async function startWith(req: DebugStartRequest, adapters?: DebugAdapter[], notes: string[] = []): Promise<void> {
  const app = useStore.getState()
  const list = adapters ?? (await window.ember.listDebugAdapters())
  const adapter = list.find((a) => a.id === req.adapterId)

  /*
   * A stop asked for during the handshake, honoured before anything is spawned.
   * This line used to clear the flag instead, which threw away every stop asked
   * for between startDebugging's synchronous 'starting' claim and here: two
   * listDebugAdapters round trips and a disk read of .vscode/launch.json, which
   * on a network path is long enough to read 'Starting…', realise it is the
   * wrong launch choice, and press Shift+F5. Only a stop landing later, during
   * dapStart, survived. The panel's Stop button is enabled for the whole of
   * that window (DebugPanel.tsx: disabled={!live}, and 'starting' is live), so
   * the click it advertises was discarded too.
   */
  if (cancelRequested) {
    cancelRequested = false
    useDebugStore.setState({ status: 'idle', adapterName: null })
    return
  }

  lastStart = req
  restartPending = false
  endedEarly.clear()
  // The last run's output still on its way belongs to the last run.
  pendingOutput = []
  useDebugStore.setState({
    status: 'starting',
    adapterName: adapter?.name ?? req.adapterId,
    sessions: [],
    output: [],
    repl: [],
    // Filters belong to the adapter that declared them; a new session's
    // capabilities repopulate this before its 'initialized' is answered.
    exceptionFilters: [],
    // Until this adapter says what it honours: the last one's word is not its.
    capabilities: null,
    ...EMPTY_RUN
  })
  // After the clearing above, which would take them with it.
  for (const note of notes) appendOutput('console', note)

  const res = await window.ember.dapStart(req)
  if (!res.ok || !res.sessionId) {
    // A stop asked for during a start that failed anyway dies with it, rather
    // than outliving it to cancel the next one.
    cancelRequested = false
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

/**
 * The adapter asked for its program to run in a real terminal. It runs as an
 * ordinary command in the active tab's shell, where it becomes a block and its
 * stdin belongs to the user — but in a child of that shell, which is given the
 * adapter's environment and directory. See shared/debuggee.ts for why the pane's own
 * shell is no longer where they are set. The reply tells the adapter the command is
 * standing.
 */
function runDebuggeeInTerminal(body: {
  requestSeq?: number
  args?: string[]
  cwd?: string
  env?: Record<string, string | null>
  envFile?: string
}, paneId: string | null): boolean {
  const controller = paneId ? existingController(paneId) : undefined
  const request = { args: (body.args ?? []).map(String), cwd: body.cwd, envFile: body.envFile, env: body.env }
  const line = debuggeeLine(request)
  if (!controller || line === null) return false
  if (line.length > MOST_LINE) {
    useStore
      .getState()
      .setNotice('The debugger asked to run a program with a command line too long for Windows to start.', 'error')
    return false
  }
  // Named for what it runs; what was typed carries paths and stays out of history.
  controller.runCommand(line, { label: debuggeeLabel(request) })
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
      const caps = (body ?? {}) as Record<string, unknown>
      sessionCapabilities.set(sessionId, caps)
      /*
       * The panel's controls follow the adapter. Condition and log-message boxes
       * showed for every adapter, and an adapter that ignores them stopped on
       * every hit of a breakpoint the user believed was conditional.
       */
      useDebugStore.setState({
        capabilities: {
          conditions: caps.supportsConditionalBreakpoints === true,
          logPoints: caps.supportsLogPoints === true,
          hitConditions: caps.supportsHitConditionalBreakpoints === true,
          terminate: caps.supportsTerminateRequest === true
        }
      })
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
      void sendAllBreakpoints(sessionId).then(() => {
        // Only to an adapter that said it understands it; the protocol says the
        // client must not send it otherwise.
        if (sessionCapabilities.get(sessionId)?.supportsConfigurationDoneRequest === true) {
          void request(sessionId, 'configurationDone')
        }
      })
      return
    case 'breakpoint':
      onBreakpointEvent(sessionId, body)
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
      void debuggeePane().then((paneId) => {
        const ok = runDebuggeeInTerminal(args, paneId)
        if (typeof args?.requestSeq === 'number') {
          window.ember.dapReverseReply(sessionId, args.requestSeq, ok)
        }
      })
      return
    }
    case 'launch-failed': {
      // Said where it will be seen: the Debug view may not be open.
      const message = (body as { message?: string } | undefined)?.message ?? 'The launch failed.'
      useStore.getState().setNotice(`The debugger could not start the program: ${message}`, 'error')
      return
    }
    case 'session-ended': {
      if (!s.sessions.includes(sessionId)) {
        // Goodbye before hello: the start reply has not landed yet. Remember
        // it so the reply does not resurrect a session that already died.
        endedEarly.add(sessionId)
        return
      }
      sessionCapabilities.delete(sessionId)
      for (const k of breakpointIds.keys()) if (k.startsWith(`${sessionId}:`)) breakpointIds.delete(k)
      const sessions = s.sessions.filter((id) => id !== sessionId)
      if (sessions.length === 0) {
        stopGeneration++
        useDebugStore.setState({ status: 'idle', adapterName: null, sessions, ...EMPTY_RUN })
        if (restartPending && lastStart) {
          restartPending = false
          // The task again too: a restart after an edit wants the edit built.
          void runTaskThenStart(lastStart, lastTask, [])
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
