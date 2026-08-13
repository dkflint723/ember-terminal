import { monaco } from './monaco'

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

class IpcTransport {
  readonly state = new Value<ConnectionState>({ state: 'connecting' })
  private listener: ((message: unknown) => void) | undefined
  private unsubscribe: (() => void) | undefined

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
      if (event.type === 'exit') {
        this.state.value = { state: 'closed', error: undefined }
        return
      }
      this.listener?.(event.message)
    })

    this.state.value = { state: 'open' }
    return true
  }

  async send(message: unknown): Promise<void> {
    window.ember.lspSend(this.language, message)
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
 * Monaco language ids that have a server, mapped to the server's id. Several
 * Monaco languages share one server, and some need none: Monaco's bundled
 * TypeScript worker already covers javascript.
 */
const SERVER_FOR: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'typescript',
  typescriptreact: 'typescript',
  javascriptreact: 'typescript',
  python: 'python',
  // Monaco calls this 'shell'; VS Code calls it 'shellscript'. The key is Monaco's.
  shell: 'shell',
  yaml: 'yaml',
  powershell: 'powershell'
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
/** Which server answers for a Monaco language id, if any. */
export function serverFor(language: string): string | null {
  return SERVER_FOR[language] ?? null
}

export function ensureLanguageServer(language: string, root?: string): Promise<boolean> {
  const target = SERVER_FOR[language]
  if (!target) return Promise.resolve(false)

  const existing = started.get(target)
  if (existing) return existing

  const attempt = (async (): Promise<boolean> => {
    const transport = new IpcTransport(target, root)
    if (!(await transport.connect())) return false

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
