import { monaco, languageForPath } from './monaco'
import { useStore, workspaceRoot } from '../state/store'
import { SERVER_FOR, serverFor, taughtServerFor } from './servers'
import { afterRename, applyWorkspaceEdit, ensureModels, fileUrisIn, NAMES_FILES } from './broker'

export { serverFor }

/**
 * Connects Monaco's bundled LSP client to a language server running in the main
 * process.
 *
 * Monaco 0.56 ships `MonacoLspClient`, which registers every LSP-backed feature
 * (hover, completion, diagnostics, definitions) as soon as it is constructed with a
 * transport. So the only work here is being that transport: the server's stdio is
 * framed in main, and this carries decoded JSON-RPC messages across IPC.
 *
 * The transport interface is structural and not exported from Monaco, so it is
 * implemented to shape.
 */

interface Listener<T> {
  (value: T): void
}

interface Disposable {
  dispose(): void
}

type ConnectionState =
  | { state: 'connecting' }
  | { state: 'open' }
  | { state: 'closed'; error: Error | undefined }

/** Monaco's IValueWithChangeEvent, which the client reads to know we are live. */
class Value<T> {
  private listeners = new Set<Listener<T>>()

  constructor(private current: T) {}

  get value(): T {
    return this.current
  }

  set value(next: T) {
    this.current = next
    for (const listener of [...this.listeners]) listener(next)
  }

  get onChange(): (listener: Listener<T>) => Disposable {
    return (listener) => {
      this.listeners.add(listener)
      return { dispose: () => this.listeners.delete(listener) }
    }
  }
}

/*
 * One document, however its URI was spelled. Monaco's client writes a request's
 * URI its own way — `file:///c:/…` where the model says `file:///c%3A/…` — so a
 * give-up that compared the strings found nothing to give up on. Both are parsed,
 * and a Windows file path is compared as Windows compares paths, without case;
 * anything else is compared exactly, since only there is case not meaningful.
 */
function sameUri(a: string, b: string): boolean {
  const canon = (u: string): string => {
    const parsed = monaco.Uri.parse(u)
    if (parsed.scheme === 'file' && /^[a-z]:[\\/]/i.test(parsed.fsPath)) return parsed.fsPath.toLowerCase()
    return parsed.toString()
  }
  return canon(a) === canon(b)
}

class IpcTransport {
  readonly state = new Value<ConnectionState>({ state: 'connecting' })
  private listener: ((message: unknown) => void) | undefined
  private unsubscribe: (() => void) | undefined
  /** Document URI to the language it was opened as. See `serves`. */
  private openedAs = new Map<string, string>()
  /**
   * Requests sent and not yet answered, by id: what was asked, and about which
   * document. Nothing on this channel had a deadline — Monaco's client waits on a
   * reply for as long as it takes, and a server that never answers kept whatever
   * awaited it waiting too. What is here can be given up on (`abandon`), and is all
   * failed at once when the server goes.
   */
  private inFlight = new Map<number | string, { method: string; uri: string | undefined; explicit?: boolean }>()
  /** Given up on: the server's late reply, if one comes, is dropped. */
  private abandoned = new Set<number | string>()

  constructor(
    private language: string,
    private root: string | undefined
  ) {}

  async connect(): Promise<boolean> {
    const res = await window.ember.lspStart(this.language, this.root)
    if (!res.ok) {
      this.state.value = { state: 'closed', error: new Error(res.error ?? 'no server') }
      return false
    }

    this.unsubscribe = window.ember.onLspMessage((event) => {
      if (event.language !== this.language) return
      if (event.type === 'restarted') {
        /*
         * Main brought the server back and replayed the handshake; the client
         * never noticed. What the fresh process is missing is the documents,
         * and the models here are their living truth — every one this server
         * answers for is re-opened with its current text. The synchronizer's
         * own version counters continue from where they were, which servers
         * take as the monotonic sequence the protocol asks for.
         */
        for (const model of monaco.editor.getModels()) {
          if (serverFor(model.getLanguageId()) !== this.language) continue
          window.ember.lspSend(this.language, {
            jsonrpc: '2.0',
            method: 'textDocument/didOpen',
            params: {
              textDocument: {
                uri: model.uri.toString(),
                languageId: model.getLanguageId(),
                version: model.getVersionId(),
                text: model.getValue()
              }
            }
          })
        }
        useStore.getState().setNotice(`The ${this.language} language server was restarted.`, 'info')
        // Open again, if it had been given up on and has now been asked back.
        if (this.state.value.state === 'closed') {
          this.state.value = { state: 'open' }
          if (this.language === 'typescript') standDownBundledTypeScript()
        }
        /*
         * Nothing in flight is given up here. Main holds what was sent while the
         * server was down and delivers it to the new process before it says so, so
         * those requests are about to be answered; failing them at this point
         * failed exactly the ones that were going to work.
         */
        return
      }
      if (event.type === 'exit') {
        // Carrying the reason: a transport that closed because the server could not
        // be started should say so rather than look like a clean shutdown.
        this.state.value = {
          state: 'closed',
          error: event.error ? new Error(event.error) : undefined
        }
        if (event.error) {
          useStore
            .getState()
            .setNotice(`The ${event.language} language server could not start: ${event.error}`, 'error')
        } else {
          useStore
            .getState()
            .setNotice(`The ${event.language} language server stopped and could not be revived.`, 'error')
        }
        // TypeScript stood its bundled worker down when the server arrived;
        // with the server gone for good, the worker is the intelligence left.
        if (this.language === 'typescript') standUpBundledTypeScript()
        // Nothing still asked of it will be answered now; said, so nothing waits on it.
        this.answerInFlightWithNothing()
        /*
         * And what it said about the files is taken down. Its squiggles stayed on
         * screen with nothing behind them — and the bundled TypeScript worker, stood
         * back up just above, drew its own beside them, every mistake twice.
         */
        for (const model of monaco.editor.getModels()) {
          if (serverFor(model.getLanguageId()) === this.language) monaco.editor.setModelMarkers(model, 'lsp', [])
        }
        return
      }
      // Only protocol messages go to the reader. A server's stderr travels on the
      // same channel, for the Output panel, and is not JSON-RPC: handed on, it
      // reached Monaco's client as a message with no method and threw in the page.
      if (event.type !== 'message') return
      // The server asking the editor to make an edit: applied here, and answered.
      const request = event.message as { id?: number | string; method?: unknown; params?: { edit?: unknown } } | undefined
      if (request && request.id !== undefined && request.method === 'workspace/applyEdit') {
        const id = request.id
        /*
         * Only when asked. A server's edit is taken while a command someone ran is
         * under way, or in the moments after it; any other edit a server sends —
         * a buggy one, unprompted — is declined and changes nothing.
         */
        if (!serverEditExpected()) {
          window.ember.lspSend(this.language, {
            jsonrpc: '2.0',
            id,
            result: { applied: false, failureReason: 'Ember applies edits from a language server only when a command you ran asks for them.' }
          })
          return
        }
        void applyWorkspaceEdit(request.params?.edit)
          .catch((err: unknown) => ({ applied: false, failureReason: String(err) }))
          .then((result) => window.ember.lspSend(this.language, { jsonrpc: '2.0', id, result }))
        return
      }
      const reply = event.message as { id?: number | string; method?: unknown; result?: unknown } | undefined
      if (reply && reply.id !== undefined && reply.method === undefined) {
        const asked = this.inFlight.get(reply.id)
        this.inFlight.delete(reply.id)
        // Already answered, with nothing, when it was given up on.
        if (this.abandoned.delete(reply.id)) return
        if (asked?.method === 'initialize') registerServerCommands(this.language, reply.result)
        /*
         * A query the editor makes by itself, failed by the server, is nothing to
         * show — not an error in the page. Monaco rethrows a provider's error on a
         * timer, which ember.log records as a fault, so a server's own bug became
         * one of Ember's: TypeScript 5.9 throws computing refactorings for a
         * lightbulb over the constant an extract has just made.
         */
        const failed = reply as { error?: unknown }
        if (asked && failed.error !== undefined && QUIET_ON_FAILURE.has(asked.method) && !asked.explicit) {
          this.listener?.({ jsonrpc: '2.0', id: reply.id, result: null })
          return
        }
        /*
         * An answer that names other files waits until each one has a model: the
         * editor can show and edit only what it holds a model for. See broker.ts.
         */
        if (asked && NAMES_FILES.has(asked.method)) {
          const uris = fileUrisIn(reply.result)
          if (uris.length > 0) {
            void ensureModels(uris)
              .catch(() => [] as string[])
              .then(() => {
                this.listener?.(event.message)
                if (asked.method === 'textDocument/rename') afterRename(reply.result)
              })
            return
          }
        }
      }
      this.listener?.(event.message)
    })

    this.state.value = { state: 'open' }
    return true
  }

  async send(message: unknown): Promise<void> {
    if (!this.serves(message)) return
    const rpc = message as { id?: number | string; method?: unknown; params?: { textDocument?: { uri?: unknown } } }
    const isRequest = !!rpc && rpc.id !== undefined && typeof rpc.method === 'string'
    /*
     * A server given up on is not asked anything. Monaco's client keeps its
     * providers registered and goes on asking — a hover, a highlight — and main
     * drops each one, so each was a promise that never settled. Answered here, at
     * once, with nothing.
     */
    if (this.state.value.state === 'closed') {
      if (isRequest) queueMicrotask(() => this.listener?.({ jsonrpc: '2.0', id: rpc.id, result: null }))
      return
    }
    if (isRequest) {
      const uri = rpc.params?.textDocument?.uri
      // A code action asked for by hand (Ctrl+.) is kept apart from the lightbulb's.
      const trigger = (rpc.params as { context?: { triggerKind?: unknown } } | undefined)?.context?.triggerKind
      this.inFlight.set(rpc.id as number | string, {
        method: rpc.method as string,
        uri: typeof uri === 'string' ? uri : undefined,
        explicit: rpc.method === 'textDocument/codeAction' && trigger === 1
      })
    }
    window.ember.lspSend(this.language, message)
  }

  /*
   * With nothing, not with an error. Monaco turns an error reply into an exception,
   * and for hover, highlights, the outline and the rest it rethrows that on a timer
   * — an uncaught error in the page, which ember.log now records as a fault. Nothing
   * is what a server that has gone has to say.
   */
  private answerInFlightWithNothing(): void {
    for (const [id, asked] of [...this.inFlight.entries()]) {
      /*
       * Except the handshake. Answered with nothing, the client reads the server's
       * capabilities out of null and throws — an unhandled rejection in the page,
       * which ember.log records as a fault. Left waiting, it throws nothing.
       */
      if (asked.method === 'initialize') continue
      this.inFlight.delete(id)
      this.listener?.({ jsonrpc: '2.0', id, result: null })
    }
  }

  /**
   * Give up on every request of this kind about this document: the server is told
   * to stop ($/cancelRequest), the client waiting on it is answered with nothing at
   * once, and the server's own answer, should it come after all, is dropped rather
   * than applied to a document that has moved on. Returns how many there were.
   */
  abandon(methods: string[], uri: string): number {
    let count = 0
    for (const [id, asked] of [...this.inFlight.entries()]) {
      if (!methods.includes(asked.method) || !asked.uri || sameUri(asked.uri, uri) === false) continue
      this.inFlight.delete(id)
      this.abandoned.add(id)
      window.ember.lspSend(this.language, { jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
      this.listener?.({ jsonrpc: '2.0', id, result: null })
      count += 1
    }
    return count
  }

  /**
   * True when this message is about a document this server actually handles.
   *
   * Monaco's client offers every open document to every running server, so the
   * TypeScript server was being told to open markdown, and then asked for
   * highlights in it. It refuses — "Cannot open document" — and every request
   * against that file afterwards fails, which surfaced as an unhandled rejection.
   * Nothing was broken for the user, but a keystroke in a markdown file was
   * sending a didChange to a server with no use for it, and the failures were
   * indistinguishable from a server that had genuinely gone wrong.
   *
   * A request that is dropped is answered here rather than left hanging: the
   * client is waiting on a promise, and silence would leak it.
   */
  private serves(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return true
    const rpc = message as {
      id?: unknown
      method?: unknown
      params?: { textDocument?: { uri?: unknown; languageId?: unknown } }
    }
    if (typeof rpc.method !== 'string' || !rpc.method.startsWith('textDocument/')) return true

    const uri = rpc.params?.textDocument?.uri
    if (typeof uri !== 'string') return true

    /*
     * didOpen states the language outright, and what it said is remembered for the
     * rest of the document's life. Asking the model each time would be wrong at the
     * one moment it matters: didClose is sent while the model is being disposed, and
     * a document that answered "typescript" on the way in must not answer "plaintext"
     * on the way out — that would drop the close and leave the server holding a file
     * it thinks is still open.
     */
    const declared = rpc.params?.textDocument?.languageId
    if (typeof declared === 'string') this.openedAs.set(uri, declared)
    const language =
      this.openedAs.get(uri) ??
      monaco.editor.getModel(monaco.Uri.parse(uri))?.getLanguageId() ??
      languageForPath(fileUriToPath(uri))
    if (rpc.method === 'textDocument/didClose') this.openedAs.delete(uri)

    if (serverFor(language) === this.language) return true
    if (rpc.id !== undefined) {
      queueMicrotask(() => this.listener?.({ jsonrpc: '2.0', id: rpc.id, result: null }))
    }
    return false
  }

  setListener(listener: ((message: unknown) => void) | undefined): void {
    this.listener = listener
  }

  toString(): string {
    return `ipc-lsp(${this.language})`
  }

  dispose(): void {
    this.unsubscribe?.()
    this.state.value = { state: 'closed', error: undefined }
  }
}

const started = new Map<string, Promise<boolean>>()

/**
 * The commands a server says it can carry out, made into commands the editor can run.
 *
 * A code action can come back as a command rather than an edit — the TypeScript
 * server's refactorings all do (`_typescript.applyRefactoring`) — and Monaco runs it
 * by looking the name up among its own commands. Nothing had registered any, so
 * choosing extract to constant ran nothing, and the server was never asked. Each is
 * registered here to ask the server (`workspace/executeCommand`); the server then
 * sends back the edit it made (`workspace/applyEdit`), which broker.ts applies.
 */
const registeredCommands = new Set<string>()
/** Server commands running now, and when the last one ended. See serverEditExpected. */
let commandsRunning = 0
let lastCommandEnded = 0
const EDIT_AFTER_COMMAND_MS = 5_000
function serverEditExpected(): boolean {
  return commandsRunning > 0 || Date.now() - lastCommandEnded < EDIT_AFTER_COMMAND_MS
}
/** Names that are the editor's own; a server's command must not replace one of them. */
const EDITOR_OWN = /^(editor|actions|workbench|vs|monaco)\./

/** Requests the editor makes on its own, on a timer or as the caret moves. */
const QUIET_ON_FAILURE = new Set([
  'textDocument/codeAction',
  'textDocument/codeLens',
  'textDocument/documentHighlight',
  'textDocument/documentSymbol',
  'textDocument/documentLink',
  'textDocument/documentColor',
  'textDocument/foldingRange',
  'textDocument/inlayHint',
  'textDocument/semanticTokens/full',
  'textDocument/semanticTokens/full/delta',
  'textDocument/semanticTokens/range'
])
function registerServerCommands(language: string, result: unknown): void {
  const commands = (result as { capabilities?: { executeCommandProvider?: { commands?: unknown } } } | null)
    ?.capabilities?.executeCommandProvider?.commands
  if (!Array.isArray(commands)) return
  for (const command of commands) {
    if (typeof command !== 'string' || registeredCommands.has(command)) continue
    // Monaco's command registry is global and the last registration wins: a server
    // naming one of the editor's own commands would have taken it over.
    if (EDITOR_OWN.test(command) || monaco.editor.getEditors().some((e) => e.getAction(command))) continue
    registeredCommands.add(command)
    monaco.editor.registerCommand(command, async (_accessor, ...args: unknown[]) => {
      commandsRunning += 1
      try {
        return await window.ember.lspRequest(language, 'workspace/executeCommand', { command, arguments: args })
      } finally {
        commandsRunning -= 1
        lastCommandEnded = Date.now()
      }
    })
  }
}
/** The transport for each running server, for giving up on what was asked of it. */
const transports = new Map<string, IpcTransport>()

/**
 * Give up on a document's outstanding requests of these kinds, whichever server is
 * answering for its language. Used by a save that will not wait on a formatter.
 */
export function abandonRequests(model: monaco.editor.ITextModel, methods: string[]): number {
  const server = serverFor(model.getLanguageId())
  if (!server) return 0
  return transports.get(server)?.abandon(methods, model.uri.toString()) ?? 0
}


/**
 * Silence the bundled TypeScript worker's providers once the language server is up.
 *
 * Monaco ships its own TypeScript service and registers hover, completion and the
 * rest for typescript and javascript. With a language server also answering, every
 * hover renders twice and completions arrive doubled. The server is the better of
 * the two — it reads tsconfig.json and resolves across the real project, where the
 * worker sees one file — so the worker stands down rather than the other way round.
 *
 * Deliberately called only after the client is constructed: if no server starts, the
 * worker stays on and TypeScript keeps the intelligence it had before.
 */
/** The reverse, for when the server is gone for good: the worker returns. */
function standUpBundledTypeScript(): void {
  const ts = (monaco as unknown as { typescript?: Record<string, TsDefaults | undefined> })
    .typescript
  const restored = {
    completionItems: true,
    hovers: true,
    documentSymbols: true,
    definitions: true,
    references: true,
    documentHighlights: true,
    rename: true,
    diagnostics: true,
    signatureHelp: true
  }
  ts?.typescriptDefaults?.setModeConfiguration(restored)
  ts?.javascriptDefaults?.setModeConfiguration(restored)
}

function standDownBundledTypeScript(): void {
  const ts = (monaco as unknown as { typescript?: Record<string, TsDefaults | undefined> })
    .typescript
  const superseded = {
    completionItems: false,
    hovers: false,
    documentSymbols: false,
    definitions: false,
    references: false,
    documentHighlights: false,
    rename: false,
    diagnostics: false,
    signatureHelp: false
  }
  ts?.typescriptDefaults?.setModeConfiguration(superseded)
  ts?.javascriptDefaults?.setModeConfiguration(superseded)
}

interface TsDefaults {
  setModeConfiguration(config: Record<string, boolean>): void
}

/**
 * Start the client for a language once per session. Called when an editor opens a
 * file of that language rather than at boot, so a terminal-only session never pays
 * for a language server.
 */
/**
 * Restart the server for the file in front of you: the focused editor's, or else
 * the active editor pane's. Shared by the palette and the rebindable command.
 */
export async function restartActiveLanguageServer(): Promise<void> {
  /*
   * The file in front of you: the focused editor, or else an editor on screen —
   * from a terminal pane beside one, the palette offers this and the editor is what
   * it means. The model's own language, not the one its name suggests: a file can
   * be set to a language by hand, or belong to a taught one.
   */
  const editors = monaco.editor.getEditors()
  const model = (editors.find((e) => e.hasTextFocus()) ?? editors.find((e) => e.getModel()))?.getModel()
  const languageId = model?.getLanguageId()
  if (!languageId) {
    useStore.getState().setNotice('Open a file to restart the language server for it.', 'info')
    return
  }
  await restartLanguageServer(languageId)
}

/** Restart the server answering for this editor language, by hand. */
export async function restartLanguageServer(languageId: string): Promise<void> {
  const server = serverFor(languageId)
  const store = useStore.getState()
  if (!server) {
    store.setNotice(`No language server answers for ${languageId} files.`, 'info')
    return
  }
  const res = await window.ember.lspRestart(server)
  if (res.ok) return
  if (res.error === 'not-started') {
    /*
     * It never got as far as a handshake — it could not be started at all — and
     * the first attempt was remembered, so nothing would try again short of
     * reloading the window. Tried afresh: a toolchain installed since is found.
     */
    started.delete(server)
    store.setNotice(`Starting the ${server} language server again.`, 'info')
    const ok = await ensureLanguageServer(languageId, workspaceRoot(useStore.getState()) ?? undefined)
    if (!ok) store.setNotice(`The ${server} language server still could not be started.`, 'error')
    return
  }
  store.setNotice(res.error ?? `The ${server} language server could not be restarted.`, 'error')
}

/** Which server answers for a Monaco language id, if any. */
/** One place a definition, declaration or implementation can be. */
export interface DefinitionTarget {
  filePath: string
  line: number
  column: number
}

/**
 * Where a symbol is defined, asked of the server directly.
 *
 * Monaco's bundled client answers this itself, but only for files it is already
 * managing: it keeps a map of the models it has opened and throws "no text model"
 * for anything else. So Go to Definition worked only when the target file happened
 * to be open already, which is the opposite of what the feature is for.
 *
 * The direct request channel exists for exactly this — the outline uses it for the
 * same reason — and going through it means the answer arrives as data that can be
 * used to open the file, rather than as an exception inside the client.
 */
export async function findDefinition(
  language: string,
  filePath: string,
  line: number,
  column: number
): Promise<DefinitionTarget | null> {
  const server = serverFor(language)
  if (!server) return null

  const { modelUri } = await import('./monaco')
  const result = await window.ember.lspRequest(server, 'textDocument/definition', {
    textDocument: { uri: modelUri(filePath).toString() },
    position: { line: line - 1, character: column - 1 }
  })

  // Servers may answer with a Location, a list of them, or LocationLinks — all
  // three are allowed, and which one arrives varies by server and by capability.
  const first = Array.isArray(result) ? result[0] : result
  if (!first || typeof first !== 'object') return null

  const link = first as {
    uri?: string
    targetUri?: string
    range?: { start?: { line?: number; character?: number } }
    targetSelectionRange?: { start?: { line?: number; character?: number } }
    targetRange?: { start?: { line?: number; character?: number } }
  }
  const uri = link.uri ?? link.targetUri
  const start = (link.targetSelectionRange ?? link.targetRange ?? link.range)?.start
  if (!uri || !start) return null

  return {
    filePath: fileUriToPath(uri),
    line: (start.line ?? 0) + 1,
    column: start.character ?? 0
  }
}

/** `file:///c:/a/b.ts` back to a path the rest of the app can open. */
function fileUriToPath(uri: string): string {
  const withoutScheme = decodeURIComponent(uri.replace(/^file:\/\//, ''))
  // Windows paths come back as `/c:/…`; the leading slash is not part of them.
  return /^\/[a-zA-Z]:/.test(withoutScheme) ? withoutScheme.slice(1) : withoutScheme
}


/**
 * Make Monaco recognise the taught languages' files. An id Monaco already
 * knows keeps its tokenizer; extra extensions are contributed alongside. An id
 * it has never heard of is registered plain — no colours, but a working
 * server. Registration is additive and idempotent-enough: an extension already
 * resolving to the id is left alone.
 */
export function registerTaughtLanguages(
  servers: { languageId: string; extensions?: string[] }[]
): void {
  const known = monaco.languages.getLanguages()
  for (const server of servers) {
    const existing = known.filter((l) => l.id === server.languageId)
    if (existing.length === 0) {
      monaco.languages.register({ id: server.languageId, extensions: server.extensions })
      continue
    }
    const missing = (server.extensions ?? []).filter(
      (ext) => !existing.some((l) => l.extensions?.includes(ext))
    )
    if (missing.length > 0) {
      monaco.languages.register({ id: server.languageId, extensions: missing })
    }
  }
}

export function ensureLanguageServer(language: string, root?: string): Promise<boolean> {
  const target = SERVER_FOR[language] ?? taughtServerFor(language) ?? undefined
  if (!target) return Promise.resolve(false)

  const existing = started.get(target)
  if (existing) return existing

  const attempt = (async (): Promise<boolean> => {
    const transport = new IpcTransport(target, root)
    if (!(await transport.connect())) return false
    transports.set(target, transport)

    const LspClient = (
      monaco as unknown as { lsp?: { MonacoLspClient?: new (t: unknown) => unknown } }
    ).lsp?.MonacoLspClient
    if (!LspClient) return false

    new LspClient(transport)
    if (target === 'typescript') standDownBundledTypeScript()
    return true
  })()

  started.set(target, attempt)
  return attempt
}
