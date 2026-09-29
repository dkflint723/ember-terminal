// A language server with nothing behind it: speaks real LSP over stdio,
// answers every hover with the same words, and exists so verification can
// prove Ember's taught-server plumbing — settings row to spawned process to
// Monaco tooltip — without any real language server installed.
//
// Not run directly; verify-lsp-custom.mjs registers it as a languageServers entry.

let buffer = Buffer.alloc(0)

/*
 * --mute-formatting: offer formatting, then never answer it — a server that is busy,
 * wedged, or simply slow, which a save must not wait on. Anything it is told to
 * cancel is appended to the file named by --note, so a suite can see the cancel
 * arrive.
 */
const muteFormatting = process.argv.includes('--mute-formatting')
// --push-edit: once a document opens, ask the editor to change it, unprompted — a
// buggy server — and note what the editor answers.
const pushEdit = process.argv.includes('--push-edit')
// --slow-formatting <ms>: answer, but late, with an edit — so a suite can see whether
// an answer that comes after the save is applied anyway.
const slowAt = process.argv.indexOf('--slow-formatting')
const slowMs = slowAt > 0 ? Number(process.argv[slowAt + 1]) : 0
const noteAt = process.argv.indexOf('--note')
const notePath = noteAt > 0 ? process.argv[noteAt + 1] : null
const note = async (line) => {
  if (!notePath) return
  const fs = await import('node:fs')
  fs.appendFileSync(notePath, `${line}\n`)
}

const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

const onMessage = (msg) => {
  const { id, method } = msg
  // The editor's answer to something this server asked.
  if (method === undefined && id !== undefined) {
    void note(`answered ${id} ${JSON.stringify(msg.result ?? msg.error ?? null)}`)
    return
  }
  if (pushEdit && method === 'textDocument/didOpen') {
    const uri = msg.params?.textDocument?.uri
    setTimeout(() => {
      send({
        id: 'push-1',
        method: 'workspace/applyEdit',
        params: { edit: { changes: { [uri]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '// pushed by the server\n' }] } } }
      })
    }, 1500)
  }
  if (method === '$/cancelRequest') void note(`cancel ${msg.params?.id}`)
  if (method === 'initialize') void note(`initialize ${id} pid ${process.pid}`)
  if (method === 'textDocument/hover') void note(`hover ${id} pid ${process.pid}`)
  if (id === undefined) return // Notifications need no answer.
  if ((muteFormatting || slowMs > 0) && (method === 'textDocument/formatting' || method === 'textDocument/rangeFormatting')) {
    void note(`asked ${method} ${id}`)
    if (slowMs > 0) {
      setTimeout(() => {
        void note(`answered ${id}`)
        send({ id, result: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '# formatted late\n' }] })
      }, slowMs)
    }
    return
  }

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            ...(muteFormatting || slowMs > 0 ? { documentFormattingProvider: true } : {})
          },
          serverInfo: { name: 'fake-lsp' }
        }
      })
      return
    case 'textDocument/hover':
      send({
        id,
        result: { contents: { kind: 'markdown', value: 'taught-server-answer' } }
      })
      return
    case 'shutdown':
      send({ id, result: null })
      return
    default:
      // Every request deserves an answer, even "nothing": a client left
      // waiting is a client that looks hung.
      send({ id, result: null })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('utf8'))
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4)
      continue
    }
    const length = Number(match[1])
    const start = headerEnd + 4
    if (buffer.length < start + length) return
    const body = buffer.subarray(start, start + length).toString('utf8')
    buffer = buffer.subarray(start + length)
    try {
      const msg = JSON.parse(body)
      if (msg.method === 'exit') process.exit(0)
      onMessage(msg)
    } catch {
      // The framing held; a malformed body is ignored.
    }
  }
})
