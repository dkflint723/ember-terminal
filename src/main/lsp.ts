import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

type Send = (payload: unknown) => void

/** One `client/registerCapability` request, offered to the client a part at a time. */
interface RegistrationBatch {
  language: string
  serverId: unknown
  remaining: number
  ids: number[]
  timer: NodeJS.Timeout
  answered?: boolean
}

/**
 * Every message between the renderer's LSP client and a server passes through
 * post() and onData(), so this is the one place the whole conversation is visible.
 * Off unless EMBER_LSP_LOG names a file, because the traffic is large and dominated
 * by didChange on every keystroke.
 */
const LOG_PATH = process.env.EMBER_LSP_LOG
function trace(direction: '-->' | '<--', language: string, message: unknown): void {
  if (!LOG_PATH) return
  try {
    appendFileSync(LOG_PATH, `${direction} [${language}] ${JSON.stringify(message)}\n`, 'utf8')
  } catch {
    // Tracing must never take the transport down with it.
  }
}

/**
 * One spelling for a `file://` URI, applied to everything crossing this transport in
 * either direction.
 *
 * Three parties spell the same Windows path three ways, and Monaco's client matches
 * documents by plain string equality, so any disagreement silently drops the message:
 *
 *   client didOpen   file:///c:/users/…/sample.ts   (lowercased by the client)
 *   client requests  file:///c:/Users/…/sample.ts   (the URI's original case)
 *   tsserver replies file:///c%3A/users/…/sample.ts (drive colon percent-encoded)
 *
 * The consequences were invisible rather than loud. Outbound, a server that
 * canonicalises paths (pyright, tsserver) shrugged off the case difference while one
 * that does not (bash-language-server) answered null to every request about a file it
 * had in memory. Inbound, `%3A` meant published diagnostics matched no open document
 * and were discarded — which is why TypeScript's squiggles and hovers were really
 * Monaco's bundled worker all along, with the language server contributing nothing
 * the user could see.
 *
 * Lowercase with a literal colon is the canonical form because it is the one the
 * client already uses for its own reverse lookups. Confined to Windows: elsewhere the
 * case of a path is load-bearing and rewriting it would name a file that does not exist.
 */
function canonicalFileUri(uri: string): string {
  return uri.toLowerCase().replace(/^file:\/\/\/([a-z])%3a/, 'file:///$1:')
}

function normalizeUris<T>(message: T): T {
  if (process.platform !== 'win32') return message

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (typeof value !== 'object' || value === null) return value

    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const isFileUri =
        (key === 'uri' || key === 'rootUri') &&
        typeof item === 'string' &&
        item.startsWith('file://')
      out[key] = isFileUri ? canonicalFileUri(item as string) : walk(item)
    }
    return out
  }

  return walk(message) as T
}

/**
 * The shorthand most servers use: a Node program shipped in node_modules, run by
 * Electron's own binary in Node mode.
 */
function nodeServer(
  entry: string[],
  args: string[]
): (base: string) => { exe: string; args: string[] } | null {
  return (base) => {
    const path = join(base, ...entry)
    return existsSync(path) ? { exe: process.execPath, args: [path, ...args] } : null
  }
}

/**
 * PowerShell Editor Services, which is not a Node program and so does not fit the
 * shorthand above — it is a PowerShell module started by a script, and needs
 * `pwsh` to run it.
 *
 * Looked for in `resources/lsp` first, so it can be shipped with the app, and then
 * in an installed VS Code PowerShell extension, which is where most Windows
 * machines that care about PowerShell already have a copy. Nothing is downloaded
 * and nothing is assumed: when neither is present the language simply has no
 * server, exactly as if no entry existed.
 */
function powerShellEditorServices(base: string): { exe: string; args: string[] } | null {
  const candidates = [join(base, 'resources', 'lsp', 'PowerShellEditorServices')]

  // The extension folder is version-stamped, so the newest match wins.
  try {
    const extensions = join(homedir(), '.vscode', 'extensions')
    const installed = readdirSync(extensions)
      .filter((name) => name.startsWith('ms-vscode.powershell-'))
      .sort()
      .reverse()
    for (const name of installed) {
      candidates.push(join(extensions, name, 'modules', 'PowerShellEditorServices'))
    }
  } catch {
    // No VS Code on this machine; the bundled path is still worth trying.
  }

  const modules = candidates.find((path) => existsSync(join(path, 'Start-EditorServices.ps1')))
  if (!modules) return null

  const exe = powerShellExecutable()
  if (!exe) return null

  // PSES insists on somewhere to write its log and session details even over
  // stdio, so it gets a corner of userData rather than the workspace.
  const scratch = join(app.getPath('userData'), 'pses')
  try {
    mkdirSync(scratch, { recursive: true })
  } catch {
    return null
  }

  const script = join(modules, 'Start-EditorServices.ps1')
  return {
    exe,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-HostName',
      'Ember',
      '-HostProfileId',
      'dev.dkflint.ember',
      '-HostVersion',
      app.getVersion(),
      '-BundledModulesPath',
      dirname(modules),
      '-LogPath',
      join(scratch, 'pses.log'),
      '-SessionDetailsPath',
      join(scratch, 'session.json'),
      '-LogLevel',
      'Warning',
      '-Stdio'
    ]
  }
}

/** pwsh if it is installed, else the Windows PowerShell that always is. */
function powerShellExecutable(): string | null {
  if (process.platform !== 'win32') return 'pwsh'
  const candidates = [
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe'
    )
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

/**
 * Runs language servers and shuttles JSON-RPC between them and the renderer.
 *
 * The renderer owns the LSP client, because Monaco ships one. That client is written
 * against the servers VS Code's own extensions use, and is thinner than it looks:
 * it answers only three of the requests a server may make of a client, and it is
 * inconsistent about how it spells a document's URI. Neither gap can be closed from
 * the renderer without replacing the client outright, and both are cheap to close
 * here, because every message already passes through this one seam. So this side is
 * not purely a pipe: it frames the stream, canonicalises URIs in both directions,
 * enriches the handshake, and replies on the client's behalf where the client would
 * otherwise reject a server's request. See `normalizeUris` and `answerClientRequest`.
 *
 * The framing itself is the ordinary part: servers speak `Content-Length`-delimited
 * JSON over stdio, which has to be reassembled because a pipe read can split or
 * coalesce messages arbitrarily.
 */
export class LspService {
  private servers = new Map<string, ChildProcessWithoutNullStreams>()
  private buffers = new Map<string, Buffer>()
  /** Workspace root per language, injected into the handshake. See post(). */
  private roots = new Map<string, string>()

  constructor(private send: Send) {}

  /**
   * Where each language's server lives, relative to the app root, and how it is told
   * to speak stdio. Adding a language is one entry here plus the same id in the
   * renderer's supported set.
   *
   * The stdio flag is per-server rather than assumed: `--stdio` is the common
   * spelling but not a universal one, and bash-language-server takes a `start`
   * subcommand instead. `initialization` supplies the server's own settings, which
   * ride along in the handshake; it receives the app root because the only setting
   * needed so far is a path into it.
   */
  private static readonly SERVERS: Record<
    string,
    {
      /** Resolves the command, or null when this machine cannot run this server. */
      command: (base: string) => { exe: string; args: string[] } | null
      initialization?: (base: string) => Record<string, unknown>
    }
  > = {
    typescript: {
      command: nodeServer(['node_modules', 'typescript-language-server', 'lib', 'cli.mjs'], [
        '--stdio'
      ]),
      // Left to itself the server hunts for `node_modules/typescript/lib/tsserver.js`
      // by walking up from its working directory. That happens to succeed when the
      // app runs from its own source tree and finds nothing once it is packaged, so
      // the path is handed over rather than discovered.
      initialization: (base) => ({
        tsserver: { path: join(base, 'node_modules', 'typescript', 'lib', 'tsserver.js') }
      })
    },
    python: {
      command: nodeServer(['node_modules', 'pyright', 'langserver.index.js'], ['--stdio'])
    },
    shell: {
      command: nodeServer(['node_modules', 'bash-language-server', 'out', 'cli.js'], ['start'])
    },
    yaml: {
      command: nodeServer(
        ['node_modules', 'yaml-language-server', 'out', 'server', 'src', 'server.js'],
        ['--stdio']
      )
    },
    powershell: { command: powerShellEditorServices }
  }

  /**
   * A packaged app has no `node` on the path, but Electron's own binary runs as
   * Node when ELECTRON_RUN_AS_NODE is set — the standard way to host a Node child
   * process from Electron. Every server here happens to be a Node program; a native
   * one would need its own branch.
   *
   * Packaged, `app.getAppPath()` names the asar archive, and the servers are unpacked
   * beside it. The main process could read either spelling — Electron patches `fs` to
   * see through the archive — but the child cannot: it is Electron running as plain
   * Node, and that mode does not carry the archive support with it. So the path is
   * rewritten to the unpacked sibling, which is a real directory both ends agree on.
   *
   * The servers have to be unpacked rather than left in the archive regardless,
   * because they read data files of their own from disk: pyright its typeshed stubs,
   * bash-language-server its tree-sitter grammar.
   */
  private appBase(): string {
    return app.getAppPath().replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked')
  }

  private serverCommand(language: string): { exe: string; args: string[]; cwd: string } | null {
    const server = LspService.SERVERS[language]
    if (!server) return null

    const base = this.appBase()
    const command = server.command(base)
    if (!command) {
      trace('-->', language, `no server available for ${language}`)
      return null
    }
    return { ...command, cwd: base }
  }

  start(language: string, root?: string): { ok: boolean; error?: string } {
    if (root) this.roots.set(language, root)
    if (this.servers.has(language)) return { ok: true }

    const command = this.serverCommand(language)
    if (!command) return { ok: false, error: `No language server configured for ${language}.` }

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(command.exe, command.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Anchored to the app rather than inherited: a server that resolves anything
        // by walking up from its working directory would otherwise get a different
        // answer depending on where the user launched the app from.
        cwd: command.cwd,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not start server.' }
    }

    this.servers.set(language, child)
    this.buffers.set(language, Buffer.alloc(0))

    child.stdout.on('data', (chunk: Buffer) => this.onData(language, chunk))
    // A server that rejects the handshake often explains itself here and nowhere else.
    if (LOG_PATH) child.stderr.on('data', (c: Buffer) => trace('<--', language, `stderr: ${c}`))
    else child.stderr.resume()
    child.on('exit', (code, signal) => {
      trace('<--', language, `exit: code=${code} signal=${signal}`)
      this.servers.delete(language)
      this.buffers.delete(language)
      this.send({ type: 'exit', language, code })
    })
    child.on('error', () => {
      this.servers.delete(language)
      this.buffers.delete(language)
    })

    return { ok: true }
  }

  /** Reassemble framed messages, which may arrive split or several at a time. */
  private onData(language: string, chunk: Buffer): void {
    let buffer = Buffer.concat([this.buffers.get(language) ?? Buffer.alloc(0), chunk])

    for (;;) {
      const separator = buffer.indexOf('\r\n\r\n')
      if (separator === -1) break

      const header = buffer.subarray(0, separator).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Unparseable header: drop it rather than stall the stream forever.
        buffer = buffer.subarray(separator + 4)
        continue
      }

      const length = Number.parseInt(match[1], 10)
      const start = separator + 4
      if (buffer.length < start + length) break

      const body = buffer.subarray(start, start + length).toString('utf8')
      buffer = buffer.subarray(start + length)

      try {
        const parsed = normalizeUris(JSON.parse(body))
        trace('<--', language, parsed)
        if (
          !this.settleDirect(parsed) &&
          !this.splitRegistrations(language, parsed) &&
          !this.answerClientRequest(language, parsed)
        ) {
          this.send({ type: 'message', language, message: parsed })
        }
      } catch {
        // A malformed body loses one message; the stream stays aligned.
      }
    }

    this.buffers.set(language, buffer)
  }

  /**
   * Forward a message to the server, enriching the `initialize` handshake.
   *
   * Monaco's bundled LSP client builds `initialize` itself and offers no way to set
   * a workspace root. Servers that analyse per-file (typescript-language-server) do
   * not care; servers that index a project (pyright) return nothing at all without
   * one. Since this transport already sits between client and server, the root is
   * injected here rather than reimplementing the client to gain one parameter.
   *
   * The same request also carries the server's own settings, which the client has no
   * concept of at all — `initializationOptions` is where a server is told things like
   * where its backing toolchain lives.
   *
   * Only absent fields are filled in, so anything the client does send still wins.
   */
  post(language: string, message: unknown): void {
    if (!this.servers.has(language)) return
    // Answers to the parts of a split registration batch stop here: the server sent
    // one request and must see exactly one response to it, not one per part.
    if (this.settleRegistration(message)) return

    let outgoing = message
    if (this.isInitialize(message)) {
      const params = (message.params ?? {}) as Record<string, unknown>
      const root = this.roots.get(language)
      const workspace = root
        ? (() => {
            const uri = pathToFileURL(root).href
            return {
              rootUri: params.rootUri ?? uri,
              // Deprecated in the spec but still what some servers actually read.
              rootPath: params.rootPath ?? root,
              workspaceFolders: params.workspaceFolders ?? [{ uri, name: basename(root) }]
            }
          })()
        : {}

      const settings = LspService.SERVERS[language]?.initialization?.(this.appBase())
      outgoing = {
        ...message,
        params: {
          ...params,
          processId: params.processId ?? process.pid,
          ...workspace,
          ...(settings ? { initializationOptions: params.initializationOptions ?? settings } : {})
        }
      }
    }

    this.write(language, normalizeUris(outgoing))
  }

  /**
   * Move every running server to a new workspace root.
   *
   * A server is started once per language and told its root in the handshake, so
   * opening a different folder afterwards left them all indexing the previous one:
   * imports resolved against the old project and diagnostics described a tree the
   * user had moved away from. Nothing looked broken, which is what made it worth
   * finding — the answers were simply about the wrong code.
   *
   * Told rather than restarted. `workspace/didChangeWorkspaceFolders` is the
   * protocol's own answer to this, and restarting would mean disposing a client
   * whose providers are already registered with Monaco — the way to end up with
   * two of everything answering each request.
   */
  setRoot(root: string): void {
    for (const language of this.servers.keys()) {
      const previous = this.roots.get(language)
      if (previous === root) continue
      this.roots.set(language, root)

      const folder = (path: string): { uri: string; name: string } => ({
        uri: pathToFileURL(path).href,
        name: basename(path)
      })
      this.write(
        language,
        normalizeUris({
          jsonrpc: '2.0',
          method: 'workspace/didChangeWorkspaceFolders',
          params: {
            event: {
              added: [folder(root)],
              removed: previous ? [folder(previous)] : []
            }
          }
        })
      )
    }
  }

  /**
   * Ask a server something directly, outside Monaco's client.
   *
   * Some things the UI wants — a document outline, say — are answered by the
   * server but not exposed by the client, which registers providers with Monaco
   * and offers no way to invoke them. Rather than reimplement the client, this
   * borrows its connection.
   *
   * Sharing a connection means sharing an id space, so these are numbered from a
   * reserved range far above anything the client will reach, and their responses
   * are resolved here instead of being forwarded — a reply the client never asked
   * for would otherwise arrive as an answer to a request it does not have.
   */
  private static readonly DIRECT_ID_BASE = 1_000_000
  private nextDirectId = LspService.DIRECT_ID_BASE
  private pendingDirect = new Map<number, (result: unknown) => void>()

  request(language: string, method: string, params: unknown): Promise<unknown> {
    if (!this.servers.has(language)) return Promise.resolve(null)
    const id = ++this.nextDirectId

    return new Promise((resolve) => {
      // Never left hanging: a server that goes away mid-request would otherwise
      // strand whatever is waiting on it.
      const timer = setTimeout(() => {
        this.pendingDirect.delete(id)
        resolve(null)
      }, 10_000)

      this.pendingDirect.set(id, (result) => {
        clearTimeout(timer)
        resolve(result)
      })
      this.write(language, normalizeUris({ jsonrpc: '2.0', id, method, params }))
    })
  }

  /** True when this was an answer to one of our own direct requests. */
  private settleDirect(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false
    const reply = message as { id?: unknown; method?: unknown; result?: unknown }
    if (typeof reply.id !== 'number' || reply.method !== undefined) return false
    if (reply.id < LspService.DIRECT_ID_BASE) return false

    const resolve = this.pendingDirect.get(reply.id)
    if (!resolve) return false
    this.pendingDirect.delete(reply.id)
    resolve(reply.result ?? null)
    return true
  }

  /**
   * Offer a batch of dynamic registrations to the client one at a time.
   *
   * The client looks each registration's method up in its capability table and
   * throws on the first one it does not recognise, with no guard around the loop.
   * A single unusable entry therefore rejects the whole batch and silently drops
   * every registration behind it. PowerShell Editor Services registers document
   * synchronisation — `textDocument/didOpen` and its siblings — dynamically and in
   * the same batch as its real providers; those are notifications rather than
   * capabilities, so the batch died on them and the language was left with almost
   * none of the features the server actually offers.
   *
   * Split up, an unusable registration costs only itself. The server asked one
   * question and gets one answer, once every part has been offered.
   */
  private static readonly CLIENT_ID_BASE = 2_000_000
  private nextClientId = LspService.CLIENT_ID_BASE
  private pendingRegistrations = new Map<number, RegistrationBatch>()

  private splitRegistrations(language: string, message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false
    const request = message as { id?: unknown; method?: unknown; params?: unknown }
    if (request.method !== 'client/registerCapability' || request.id === undefined) return false

    const params = request.params as { registrations?: unknown[] } | undefined
    const registrations = params?.registrations
    // A single registration is already isolated; forwarding it untouched keeps the
    // common case on the client's own path.
    if (!Array.isArray(registrations) || registrations.length < 2) return false

    const batch: RegistrationBatch = {
      language,
      serverId: request.id,
      remaining: registrations.length,
      ids: [],
      // A client that never answers would otherwise leave the server waiting on an
      // acknowledgement forever, which is how a handshake stalls.
      timer: setTimeout(() => this.finishRegistrations(batch), 10_000)
    }

    for (const registration of registrations) {
      const id = ++this.nextClientId
      batch.ids.push(id)
      this.pendingRegistrations.set(id, batch)
      this.send({
        type: 'message',
        language,
        message: {
          jsonrpc: '2.0',
          id,
          method: 'client/registerCapability',
          params: { registrations: [registration] }
        }
      })
    }
    return true
  }

  /** True when this was the client's answer to one part of a split batch. */
  private settleRegistration(message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false
    const reply = message as { id?: unknown; method?: unknown }
    if (typeof reply.id !== 'number' || reply.method !== undefined) return false
    if (reply.id < LspService.CLIENT_ID_BASE) return false

    const batch = this.pendingRegistrations.get(reply.id)
    if (!batch) return false
    this.pendingRegistrations.delete(reply.id)
    // A registration the client could not use is not the server's problem: the
    // consequence is that it will never be asked for that feature.
    batch.remaining -= 1
    if (batch.remaining <= 0) this.finishRegistrations(batch)
    return true
  }

  private finishRegistrations(batch: RegistrationBatch): void {
    clearTimeout(batch.timer)
    for (const id of batch.ids) this.pendingRegistrations.delete(id)
    if (batch.answered) return
    batch.answered = true
    this.write(batch.language, { jsonrpc: '2.0', id: batch.serverId, result: null })
  }

  /** Frame one message onto a server's stdin. */
  private write(language: string, message: unknown): void {
    const child = this.servers.get(language)
    if (!child) return

    trace('-->', language, message)

    const body = Buffer.from(JSON.stringify(message), 'utf8')
    try {
      // Escapes, not real line breaks: the header must be CRLF-delimited, and a
      // literal break here would emit LF on an LF checkout and be rejected.
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
      child.stdin.write(body)
    } catch {
      // The server died between the check and the write; its exit handler cleans up.
    }
  }

  /**
   * Answer the requests a server makes *of* the client.
   *
   * Monaco's client declares all of these in its protocol contract but registers
   * handlers for only three — `client/registerCapability`, its `unregister` twin, and
   * `workspace/inlayHint/refresh`. Every other one falls through to a JSON-RPC
   * "method not found" error. Most servers shrug that off, but a server that treats a
   * rejection of its own request as fatal will exit: pyright sends
   * `workspace/diagnostic/refresh` as soon as it finishes its first analysis, gets an
   * error back, and dies with code 1 about a second after the handshake. Everything
   * after that is sent into a closed pipe, which is exactly what "the server starts,
   * exchanges messages, then answers nothing" looked like from outside.
   *
   * Answering here rather than in the renderer keeps the client's own handlers
   * authoritative: anything it implements is not in this table and is forwarded
   * untouched. Returns true when the message was consumed.
   */
  private answerClientRequest(language: string, message: unknown): boolean {
    if (typeof message !== 'object' || message === null) return false
    const request = message as { id?: unknown; method?: unknown; params?: unknown }
    // A notification has no id and needs no reply; a response has no method.
    if (typeof request.method !== 'string' || request.id === undefined) return false

    const result = this.clientResult(language, request.method, request.params)
    if (result === undefined) return false

    this.write(language, { jsonrpc: '2.0', id: request.id, result })
    return true
  }

  /**
   * The client's answer to a server-initiated request, or undefined to let Monaco's
   * client handle it. The refreshes are acknowledged rather than acted on — Monaco
   * re-pulls diagnostics and tokens on document change anyway, so the cost is
   * staleness until the next edit, not absence. The capabilities that would let a
   * server ask for more than this are not advertised, so declining is consistent
   * rather than merely convenient.
   */
  private clientResult(language: string, method: string, params: unknown): unknown {
    switch (method) {
      case 'workspace/diagnostic/refresh':
      case 'workspace/semanticTokens/refresh':
      case 'workspace/codeLens/refresh':
      case 'workspace/inlineValue/refresh':
      case 'workspace/foldingRange/refresh':
      case 'window/workDoneProgress/create':
      case 'window/showMessageRequest':
        return null

      // One entry per requested section, in order, or the server cannot match them
      // up. Null means "unset", which every server reads as "use your defaults".
      case 'workspace/configuration': {
        const items = (params as { items?: unknown[] } | undefined)?.items
        return Array.isArray(items) ? items.map(() => null) : []
      }

      case 'workspace/workspaceFolders': {
        const root = this.roots.get(language)
        if (!root) return null
        return [{ uri: pathToFileURL(root).href, name: basename(root) }]
      }

      // Declined rather than acknowledged: claiming success for an edit or a
      // navigation that never happened would leave the server's model of the
      // document ahead of the editor's.
      case 'workspace/applyEdit':
        return { applied: false }
      case 'window/showDocument':
        return { success: false }

      default:
        return undefined
    }
  }

  private isInitialize(message: unknown): message is { params?: unknown; method: string } {
    return (
      typeof message === 'object' &&
      message !== null &&
      (message as { method?: unknown }).method === 'initialize'
    )
  }

  dispose(): void {
    for (const child of this.servers.values()) {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    this.servers.clear()
    this.buffers.clear()
    this.roots.clear()
  }
}
