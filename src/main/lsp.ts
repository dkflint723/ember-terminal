import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

type Send = (payload: unknown) => void

/**
 * Runs language servers and shuttles JSON-RPC between them and the renderer.
 *
 * The renderer owns the LSP client (Monaco ships one), so this side deliberately
 * knows nothing about the protocol's semantics — only its framing. Servers speak
 * `Content-Length`-delimited JSON over stdio, which has to be reassembled because
 * a pipe read can split or coalesce messages arbitrarily.
 */
export class LspService {
  private servers = new Map<string, ChildProcessWithoutNullStreams>()
  private buffers = new Map<string, Buffer>()
  /** Workspace root per language, injected into the handshake. See post(). */
  private roots = new Map<string, string>()

  constructor(private send: Send) {}

  /**
   * Where each language's server lives, relative to the app root. Adding a
   * language is one entry here plus the same id in the renderer's supported set.
   */
  private static readonly SERVERS: Record<string, string[]> = {
    typescript: ['node_modules', 'typescript-language-server', 'lib', 'cli.mjs']
  }

  /**
   * A packaged app has no `node` on the path, but Electron's own binary runs as
   * Node when ELECTRON_RUN_AS_NODE is set — the standard way to host a Node child
   * process from Electron. Both servers happen to be Node programs; a native
   * server would need its own branch here.
   */
  private serverCommand(language: string): { exe: string; args: string[] } | null {
    const parts = LspService.SERVERS[language]
    if (!parts) return null

    const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
    const entry = join(base, ...parts)
    if (!existsSync(entry)) return null
    return { exe: process.execPath, args: [entry, '--stdio'] }
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
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      })
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Could not start server.' }
    }

    this.servers.set(language, child)
    this.buffers.set(language, Buffer.alloc(0))

    child.stdout.on('data', (chunk: Buffer) => this.onData(language, chunk))
    child.stderr.resume()
    child.on('exit', (code) => {
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
        this.send({ type: 'message', language, message: JSON.parse(body) })
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
   * Only absent fields are filled in, so anything the client does send still wins.
   */
  post(language: string, message: unknown): void {
    const child = this.servers.get(language)
    if (!child) return

    let outgoing = message
    const root = this.roots.get(language)
    if (root && this.isInitialize(message)) {
      const params = (message.params ?? {}) as Record<string, unknown>
      const uri = pathToFileURL(root).href
      outgoing = {
        ...message,
        params: {
          ...params,
          processId: params.processId ?? process.pid,
          rootUri: params.rootUri ?? uri,
          // Deprecated in the spec but still what some servers actually read.
          rootPath: params.rootPath ?? root,
          workspaceFolders: params.workspaceFolders ?? [{ uri, name: basename(root) }]
        }
      }
    }

    const body = Buffer.from(JSON.stringify(outgoing), 'utf8')
    try {
      // Escapes, not real line breaks: the header must be CRLF-delimited, and a
      // literal break here would emit LF on an LF checkout and be rejected.
      child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
      child.stdin.write(body)
    } catch {
      // The server died between the check and the write; its exit handler cleans up.
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
