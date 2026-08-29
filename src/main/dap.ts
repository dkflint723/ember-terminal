import { spawn, type ChildProcess } from 'node:child_process'
import { connect, createServer, type Socket } from 'node:net'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DebugAdapter, DebugStartRequest } from '../shared/types.js'

/** A port nothing is listening on right now, found by briefly holding it. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * A Debug Adapter Protocol client, generic on purpose.
 *
 * The adapter is any program that speaks DAP — over its stdio, or over a TCP
 * port it was handed. Ember does not know what a Node debugger is; it knows how
 * to spawn a process, frame messages, match responses to requests, and forward
 * events. Everything language-shaped lives in the adapter, which is the whole
 * point of the protocol.
 *
 * One deliberate piece of cleverness: `startDebugging` reverse requests. Modern
 * js-debug runs as a server whose first session is a broker; launching makes it
 * ask the *client* to open another connection for the real session. Declining
 * that means a debugger that connects and then debugs nothing, so child
 * sessions are opened here and reported upward as their own sessions.
 */

/** How DAP frames a message: a Content-Length header, a blank line, JSON. */
class DapFramer {
  private buffer = Buffer.alloc(0)

  constructor(private onMessage: (msg: Record<string, unknown>) => void) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // A stream that is not speaking DAP; drop the garbage header and resync.
        this.buffer = this.buffer.subarray(headerEnd + 4)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        this.onMessage(JSON.parse(body) as Record<string, unknown>)
      } catch {
        // A malformed body is the adapter's bug; the frame boundary held, carry on.
      }
    }
  }
}

interface PendingRequest {
  resolve: (r: { ok: boolean; body?: unknown; error?: string }) => void
  timer: NodeJS.Timeout
}

/** How long a single request may sit unanswered before the caller is released. */
const REQUEST_TIMEOUT_MS = 15_000

export interface DapSessionEvents {
  onEvent: (sessionId: string, event: string, body: unknown) => void
  onEnd: (sessionId: string) => void
  /** A child session opened on the adapter's own ask; the service must be able to route to it. */
  register: (session: DapSession) => void
}

/**
 * One DAP conversation: a transport, a sequence counter, and the promise that
 * every request gets an answer even when the adapter dies mid-question.
 */
export class DapSession {
  readonly id = randomUUID()
  /** The window that started the root session; children inherit it. */
  ownerWindowId: number

  private seq = 1
  private pending = new Map<number, PendingRequest>()
  private child: ChildProcess | null = null
  private socket: Socket | null = null
  private framer = new DapFramer((msg) => this.onMessage(msg))
  private ended = false
  /** Children opened on the adapter's own ask, torn down with the parent. */
  private children: DapSession[] = []

  constructor(
    private adapter: DebugAdapter,
    private events: DapSessionEvents,
    ownerWindowId: number,
    /** Set for a child session: the socket is a fresh connection to the parent's server. */
    private parent: DapSession | null = null
  ) {
    this.ownerWindowId = ownerWindowId
  }

  /** Spawn (or connect) and run the initialize handshake. */
  async start(): Promise<void> {
    const env = { ...process.env, ...(this.adapter.env ?? {}) }
    if (this.parent) {
      // A child shares its parent's server process; only the socket is new.
      await this.connectWithRetry(this.parent.tcpPort ?? 0)
    } else if (this.adapter.transport === 'tcp') {
      this.tcpPort = await freePort()
      const args = this.adapter.args.map((a) => a.replace('${port}', String(this.tcpPort)))
      this.child = spawn(this.adapter.command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env
      })
      this.wireChild()
      await this.connectWithRetry(this.tcpPort)
    } else {
      this.child = spawn(this.adapter.command, this.adapter.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env
      })
      this.wireChild()
      this.child.stdout?.on('data', (chunk: Buffer) => this.framer.push(chunk))
    }

    const init = await this.request('initialize', {
      clientID: 'ember',
      clientName: 'Ember',
      adapterID: this.adapter.id,
      linesStartAt1: true,
      columnsStartAt1: true,
      pathFormat: 'path',
      locale: 'en',
      supportsVariableType: true,
      supportsProgressReporting: false,
      supportsRunInTerminalRequest: false,
      supportsStartDebuggingRequest: true
    })
    if (!init.ok) throw new Error(init.error ?? 'The adapter refused to initialize.')
  }

  /** For TCP adapters: the port the server was handed. */
  tcpPort: number | null = null

  private wireChild(): void {
    if (!this.child) return
    this.child.on('error', (err) => this.fail(`The adapter could not start: ${err.message}`))
    this.child.on('exit', () => this.end())
    // An adapter's stderr is its diagnostics channel; surface it as output.
    this.child.stderr?.on('data', (chunk: Buffer) =>
      this.events.onEvent(this.id, 'output', {
        category: 'stderr',
        output: chunk.toString('utf8')
      })
    )
  }

  /**
   * A TCP server needs a beat to bind, so failed connects retry rather than
   * probing with a throwaway connection — servers like js-debug treat every
   * accepted connection as a session, and a probe would open a dud one.
   */
  private async connectWithRetry(port: number): Promise<void> {
    const until = Date.now() + 8000
    for (;;) {
      const err = await new Promise<Error | null>((resolve) => {
        const socket = connect({ port, host: '127.0.0.1' }, () => {
          this.socket = socket
          socket.on('data', (chunk) => this.framer.push(chunk))
          socket.on('close', () => this.end())
          resolve(null)
        })
        socket.on('error', (e) => {
          if (this.socket === socket) this.fail(`The adapter connection failed: ${e.message}`)
          else resolve(e)
        })
      })
      if (!err) return
      if (Date.now() > until) throw new Error('The adapter never opened its port.')
      await new Promise((r) => setTimeout(r, 120))
    }
  }

  private write(msg: Record<string, unknown>): void {
    const body = JSON.stringify(msg)
    const frame = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
    if (this.socket) this.socket.write(frame)
    else this.child?.stdin?.write(frame)
  }

  request(command: string, args?: unknown): Promise<{ ok: boolean; body?: unknown; error?: string }> {
    if (this.ended) return Promise.resolve({ ok: false, error: 'The session has ended.' })
    const seq = this.seq++
    this.write({ seq, type: 'request', command, arguments: args ?? {} })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        resolve({ ok: false, error: `The adapter never answered ${command}.` })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(seq, { resolve, timer })
    })
  }

  private onMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'response') {
      const pending = this.pending.get(msg.request_seq as number)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(msg.request_seq as number)
      pending.resolve(
        msg.success === true
          ? { ok: true, body: msg.body }
          : { ok: false, error: (msg.message as string) ?? 'The request failed.' }
      )
      return
    }

    if (msg.type === 'event') {
      this.events.onEvent(this.id, msg.event as string, msg.body)
      if (msg.event === 'terminated' || msg.event === 'exited') {
        // The adapter said it is done; some never close their pipe after.
        setTimeout(() => this.end(), 250)
      }
      return
    }

    if (msg.type === 'request' && msg.command === 'startDebugging') {
      // The broker pattern: answer yes, open the child, launch it with the
      // configuration the adapter itself supplied.
      this.write({
        seq: this.seq++,
        type: 'response',
        request_seq: msg.seq,
        success: true,
        command: 'startDebugging'
      })
      const args = msg.arguments as { configuration?: Record<string, unknown>; request?: string }
      void this.startChild(args?.configuration ?? {}, args?.request === 'attach')
      return
    }

    if (msg.type === 'request') {
      // Anything else the adapter asks of us — runInTerminal was declared
      // unsupported — is declined honestly rather than left hanging.
      this.write({
        seq: this.seq++,
        type: 'response',
        request_seq: msg.seq,
        success: false,
        command: msg.command,
        message: 'Not supported by this client.'
      })
    }
  }

  private async startChild(configuration: Record<string, unknown>, attach: boolean): Promise<void> {
    try {
      const root = this.parent ?? this
      const child = new DapSession(this.adapter, this.events, this.ownerWindowId, root)
      root.children.push(child)
      this.events.register(child)
      this.events.onEvent(child.id, 'session-started', { parent: this.id })
      await child.start()
      const res = await child.request(attach ? 'attach' : 'launch', configuration)
      if (!res.ok) this.events.onEvent(child.id, 'output', { category: 'stderr', output: `${res.error}\n` })
      // The child announces 'initialized' like any session; breakpoint sync and
      // configurationDone are driven from the renderer, which owns breakpoints.
    } catch (err) {
      this.events.onEvent(this.id, 'output', {
        category: 'stderr',
        output: `A child session failed: ${err instanceof Error ? err.message : String(err)}\n`
      })
    }
  }

  private fail(message: string): void {
    this.events.onEvent(this.id, 'output', { category: 'stderr', output: `${message}\n` })
    this.end()
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: 'The session ended.' })
    }
    this.pending.clear()
    for (const child of this.children) child.end()
    this.children = []
    try {
      this.socket?.destroy()
    } catch {
      // Already gone.
    }
    try {
      this.child?.kill()
    } catch {
      // Already gone.
    }
    this.events.onEnd(this.id)
  }
}

/** Every live session, and the way a window's worth of them dies together. */
export class DapService {
  private sessions = new Map<string, DapSession>()

  constructor(
    private forward: (ownerWindowId: number, sessionId: string, event: string, body: unknown) => void
  ) {}

  private events(ownerWindowId: number): DapSessionEvents {
    return {
      onEvent: (sessionId, event, body) => this.forward(ownerWindowId, sessionId, event, body),
      onEnd: (sessionId) => {
        if (!this.sessions.delete(sessionId)) return
        this.forward(ownerWindowId, sessionId, 'session-ended', {})
      },
      register: (session) => this.sessions.set(session.id, session)
    }
  }

  async start(
    req: DebugStartRequest,
    adapter: DebugAdapter,
    ownerWindowId: number
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const session = new DapSession(adapter, this.events(ownerWindowId), ownerWindowId)
    this.sessions.set(session.id, session)
    try {
      await session.start()
      // Launch is not awaited to completion here: many adapters only answer it
      // after configurationDone, which the renderer sends once breakpoints are
      // down. Waiting would deadlock the handshake.
      void session.request(req.launch.request === 'attach' ? 'attach' : 'launch', req.launch)
      return { ok: true, sessionId: session.id }
    } catch (err) {
      session.end()
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  request(
    sessionId: string,
    command: string,
    args?: unknown
  ): Promise<{ ok: boolean; body?: unknown; error?: string }> {
    const session = this.sessions.get(sessionId)
    if (!session) return Promise.resolve({ ok: false, error: 'No such session.' })
    return session.request(command, args)
  }

  stop(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // Ask politely first; end() runs regardless when the adapter goes quiet.
    void session.request('disconnect', { terminateDebuggee: true })
    setTimeout(() => session.end(), 1200)
  }

  stopOwnedBy(windowId: number): void {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerWindowId === windowId) session.end()
    }
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) session.end()
    this.sessions.clear()
  }
}

/**
 * The adapters this app carries with it.
 *
 * js-debug — the Node debugger VS Code itself uses — ships in Ember's
 * resources, fetched at build time by scripts/fetch-js-debug.mjs (it is a
 * GitHub release artifact, not an npm package, so it cannot be a dependency).
 * Probed rather than assumed: a development checkout that has not run the
 * fetch simply offers no Node adapter, instead of offering one that cannot
 * start.
 */
export function detectAdapters(resourcesBase: string): DebugAdapter[] {
  const found: DebugAdapter[] = []
  const script = join(resourcesBase, 'js-debug', 'src', 'dapDebugServer.js')
  if (existsSync(script)) {
    found.push({
      id: 'pwa-node',
      name: 'Node.js (js-debug)',
      // Ember's own runtime runs the server: with ELECTRON_RUN_AS_NODE the
      // Electron binary is a plain node, so the adapter works on machines
      // where node itself is not on PATH. The program being debugged still
      // runs on whatever `node` the launch configuration resolves.
      command: process.execPath,
      args: [script, '${port}', '127.0.0.1'],
      transport: 'tcp',
      env: { ELECTRON_RUN_AS_NODE: '1' },
      extensions: ['.js', '.mjs', '.cjs']
    })
  }
  return found
}
