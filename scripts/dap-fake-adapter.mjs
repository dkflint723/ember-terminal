// A debug adapter with nothing behind it: speaks real DAP over stdio, stops
// where the breakpoints say, steps one line at a time, and owns two variables.
// It exists so the verification can drive Ember's whole debugging surface —
// client, wiring, margin, panel — without depending on any real debugger being
// installed. Taught to Ember through settings, exactly as a user would teach
// an adapter of their own.
//
// Not run directly; verify-dap.mjs registers it as a debugAdapters entry.

let buffer = Buffer.alloc(0)
let seq = 1000
let program = ''
let currentLine = 1
let breakpointLines = []

const send = (msg) => {
  const body = JSON.stringify({ seq: seq++, ...msg })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}
const respond = (req, body = {}, success = true) =>
  send({ type: 'response', request_seq: req.seq, command: req.command, success, body })
const event = (name, body = {}) => send({ type: 'event', event: name, body })

const stopped = (reason) =>
  event('stopped', { reason, threadId: 1, allThreadsStopped: true })

const finish = () => {
  event('output', { category: 'stdout', output: 'fake-run-done\n' })
  event('terminated', {})
  event('exited', { exitCode: 0 })
  setTimeout(() => process.exit(0), 200)
}

const onRequest = (req) => {
  switch (req.command) {
    case 'initialize':
      respond(req, { supportsConfigurationDoneRequest: true })
      event('initialized', {})
      return
    case 'launch':
      program = req.arguments?.program ?? ''
      respond(req)
      return
    case 'setBreakpoints': {
      const lines = (req.arguments?.breakpoints ?? []).map((b) => b.line)
      breakpointLines = lines
      respond(req, { breakpoints: lines.map((line) => ({ verified: true, line })) })
      return
    }
    case 'configurationDone':
      respond(req)
      // The pretend program runs to its first breakpoint, or clean through.
      setTimeout(() => {
        if (breakpointLines.length > 0) {
          currentLine = breakpointLines[0]
          stopped('breakpoint')
        } else {
          finish()
        }
      }, 150)
      return
    case 'threads':
      respond(req, { threads: [{ id: 1, name: 'main' }] })
      return
    case 'stackTrace':
      respond(req, {
        stackFrames: [
          {
            id: 1,
            name: 'fakeMain',
            line: currentLine,
            column: 1,
            source: { path: program, name: 'program' }
          },
          { id: 2, name: 'fakeCaller', line: 1, column: 1, source: { path: program } }
        ],
        totalFrames: 2
      })
      return
    case 'scopes':
      respond(req, {
        scopes: [{ name: 'Locals', variablesReference: 100, expensive: false }]
      })
      return
    case 'variables':
      if (req.arguments?.variablesReference === 100) {
        respond(req, {
          variables: [
            { name: 'answer', value: '42', type: 'number', variablesReference: 0 },
            { name: 'box', value: 'Object', type: 'object', variablesReference: 101 }
          ]
        })
      } else if (req.arguments?.variablesReference === 101) {
        respond(req, {
          variables: [{ name: 'inner', value: "'nested'", type: 'string', variablesReference: 0 }]
        })
      } else {
        respond(req, { variables: [] })
      }
      return
    case 'next':
    case 'stepIn':
    case 'stepOut':
      respond(req)
      currentLine += 1
      setTimeout(() => stopped('step'), 80)
      return
    case 'continue':
      respond(req, { allThreadsContinued: true })
      setTimeout(finish, 80)
      return
    case 'disconnect':
      respond(req)
      setTimeout(() => process.exit(0), 100)
      return
    default:
      respond(req, {}, true)
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
      if (msg.type === 'request') onRequest(msg)
    } catch {
      // Ignore what does not parse; the framing held.
    }
  }
})
