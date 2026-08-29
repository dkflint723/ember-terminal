// A debug adapter with nothing behind it: speaks real DAP over stdio, stops
// where the breakpoints say, steps one line at a time, owns two variables and
// two threads, declares an exception filter, asks for a terminal when the
// launch wants one, and answers the console. It exists so the verification can
// drive Ember's whole debugging surface without depending on any real debugger
// being installed. Taught to Ember through settings, exactly as a user would
// teach an adapter of their own.
//
// The pretend program is the launch's `program` file; its CONTENT sets the
// scenario: 'hang-forever' runs until paused, 'throws-late' raises at line 4
// when the uncaught filter is on. Everything the adapter is told, it echoes as
// output events, so the verification can read what actually crossed the wire.
//
// Not run directly; verify-dap.mjs registers it as a debugAdapters entry.
import * as fs from 'node:fs'
import * as path from 'node:path'

let buffer = Buffer.alloc(0)
let seq = 1000
let program = ''
let programText = ''
let launchConsole = ''
let currentLine = 1
let exceptionFilters = []
const bpByPath = new Map()
/** The runInTerminal ask parked on the client, and what follows its answer. */
let pendingTerminal = null

const send = (msg) => {
  const body = JSON.stringify({ seq: seq++, ...msg })
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}
const respond = (req, body = {}, success = true) =>
  send({ type: 'response', request_seq: req.seq, command: req.command, success, body })
const event = (name, body = {}) => send({ type: 'event', event: name, body })
const say = (text) => event('output', { category: 'stdout', output: `${text}\n` })

const stopped = (reason) =>
  event('stopped', { reason, threadId: 1, allThreadsStopped: true })

const finish = () => {
  say('fake-run-done')
  event('terminated', {})
  event('exited', { exitCode: 0 })
  setTimeout(() => process.exit(0), 200)
}

const programBreakpoints = () => bpByPath.get(program.replace(/\\/g, '/').toLowerCase()) ?? []

/** What the pretend program does once released. */
const beginRun = () => {
  const bps = programBreakpoints()
  if (bps.length > 0) {
    currentLine = bps[0].line
    stopped('breakpoint')
    return
  }
  if (programText.includes('throws-late') && exceptionFilters.includes('uncaught')) {
    currentLine = 4
    stopped('exception')
    return
  }
  if (programText.includes('hang-forever')) return
  finish()
}

const beginLaunch = (req, kind) => {
  program = String(req.arguments?.program ?? '')
  launchConsole = String(req.arguments?.console ?? '')
  try {
    programText = fs.readFileSync(program, 'utf8')
  } catch {
    programText = ''
  }
  say(
    `launch-args:${JSON.stringify({
      request: kind,
      magic: req.arguments?.magic ?? null,
      console: launchConsole || null
    })}`
  )
  if (kind === 'attach') say('attached-ok')
  respond(req)
}

const onRequest = (req) => {
  switch (req.command) {
    case 'initialize':
      respond(req, {
        supportsConfigurationDoneRequest: true,
        exceptionBreakpointFilters: [
          { filter: 'uncaught', label: 'Uncaught exceptions', default: false }
        ]
      })
      event('initialized', {})
      return
    case 'launch':
      beginLaunch(req, 'launch')
      return
    case 'attach':
      beginLaunch(req, 'attach')
      return
    case 'setBreakpoints': {
      const source = String(req.arguments?.source?.path ?? '')
      const asked = (req.arguments?.breakpoints ?? []).map((b) => ({
        line: b.line,
        condition: b.condition ?? null,
        logMessage: b.logMessage ?? null
      }))
      bpByPath.set(source.replace(/\\/g, '/').toLowerCase(), asked)
      say(`bp-sent:${path.basename(source)}:${JSON.stringify(asked)}`)
      respond(req, { breakpoints: asked.map((b) => ({ verified: true, line: b.line })) })
      return
    }
    case 'setExceptionBreakpoints':
      exceptionFilters = req.arguments?.filters ?? []
      say(`exception-filters:${JSON.stringify(exceptionFilters)}`)
      respond(req)
      return
    case 'configurationDone':
      respond(req)
      setTimeout(() => {
        if (launchConsole === 'integratedTerminal') {
          // The program "runs in a terminal": ask the client to stand it up,
          // and only proceed once the client says it is standing.
          pendingTerminal = seq
          send({
            seq: pendingTerminal,
            type: 'request',
            command: 'runInTerminal',
            arguments: {
              kind: 'integrated',
              title: 'fake program',
              cwd: path.dirname(program || '.'),
              args: ['cmd', '/c', 'echo dap-terminal-proof'],
              env: { FAKE_DEBUG: '1' }
            }
          })
          seq++
          return
        }
        beginRun()
      }, 150)
      return
    case 'threads':
      respond(req, {
        threads: [
          { id: 1, name: 'main' },
          { id: 2, name: 'worker' }
        ]
      })
      return
    case 'stackTrace': {
      const worker = req.arguments?.threadId === 2
      respond(req, {
        stackFrames: [
          {
            id: worker ? 21 : 1,
            name: worker ? 'workerFrame' : 'fakeMain',
            line: currentLine,
            column: 1,
            source: { path: program, name: 'program' }
          },
          { id: worker ? 22 : 2, name: 'fakeCaller', line: 1, column: 1, source: { path: program } }
        ],
        totalFrames: 2
      })
      return
    }
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
    case 'evaluate': {
      const expression = String(req.arguments?.expression ?? '')
      if (expression === 'answer*2') respond(req, { result: '84', variablesReference: 0 })
      else respond(req, { result: `echo:${expression}`, variablesReference: 0 })
      return
    }
    case 'pause':
      respond(req)
      currentLine = 1
      setTimeout(() => stopped('pause'), 60)
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

const onResponse = (msg) => {
  if (pendingTerminal !== null && msg.request_seq === pendingTerminal) {
    pendingTerminal = null
    say(`terminal-standing:${msg.success === true}`)
    beginRun()
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
      else if (msg.type === 'response') onResponse(msg)
    } catch {
      // Ignore what does not parse; the framing held.
    }
  }
})
