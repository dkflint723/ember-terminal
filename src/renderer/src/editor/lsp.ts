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

  constructor(private language: string) {}

  async connect(): Promise<boolean> {
    const res = await window.ember.lspStart(this.language)
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
 * Start the client for a language once per session. Called when an editor opens a
 * file of that language rather than at boot, so a terminal-only session never pays
 * for a language server.
 */
export function ensureLanguageServer(language: string): Promise<boolean> {
  // Monaco's TypeScript worker already handles javascript; only ask for a server
  // where one is configured.
  const target = language === 'javascript' ? 'typescript' : language
  if (target !== 'typescript') return Promise.resolve(false)

  const existing = started.get(target)
  if (existing) return existing

  const attempt = (async (): Promise<boolean> => {
    const transport = new IpcTransport(target)
    if (!(await transport.connect())) return false

    const LspClient = (monaco as unknown as { lsp?: { MonacoLspClient?: new (t: unknown) => unknown } })
      .lsp?.MonacoLspClient
    if (!LspClient) return false

    new LspClient(transport)
    return true
  })()

  started.set(target, attempt)
  return attempt
}
