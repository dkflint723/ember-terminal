// A language server with nothing behind it: speaks real LSP over stdio,
// answers every hover with the same words, and exists so verification can
// prove Ember's taught-server plumbing — settings row to spawned process to
// Monaco tooltip — without any real language server installed.
//
// Not run directly; verify-lsp-custom.mjs registers it as a languageServers entry.

let buffer = Buffer.alloc(0)

const send = (msg) => {
  const body = JSON.stringify({ jsonrpc: '2.0', ...msg })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

const onMessage = (msg) => {
  const { id, method } = msg
  if (id === undefined) return // Notifications need no answer.

  switch (method) {
    case 'initialize':
      send({
        id,
        result: {
          capabilities: { textDocumentSync: 1, hoverProvider: true },
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
