// A stand-in for the Claude Code CLI, for test-claude-cli.mjs. Says what it was given
// in the file named by FAKE_RECORD, and answers as FAKE_* ask.
import * as fs from 'node:fs'

const argv = process.argv.slice(2)
if (argv[0] === '--help') {
  if (process.env.FAKE_HELP_FAIL) process.exit(3)
  console.log(
    process.env.FAKE_OLD
      ? '  --disallowed-tools <tools...>\n  --allowed-tools <tools...>\n  --system-prompt <prompt>'
      : process.env.FAKE_HELP_ALT
        ? '  --tools [list]   Use "" to disable all tools\n  --system-prompt-file <file>'
        : '  --tools <tools...>   Use "" to disable all tools\n  via: --system-prompt[-file], --append-system-prompt[-file]'
  )
  process.exit(0)
}

let stdin = ''
process.stdin.on('data', (c) => (stdin += c))
process.stdin.on('end', () => {
  const at = argv.indexOf('--system-prompt-file')
  const record = {
    argv,
    cwd: process.cwd(),
    cwdEntries: fs.readdirSync(process.cwd()),
    stdin,
    systemFromFile: at >= 0 ? fs.readFileSync(argv[at + 1], 'utf8') : null,
    systemFile: at >= 0 ? argv[at + 1] : null
  }
  if (process.env.FAKE_RECORD) fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify(record))
  if (process.env.FAKE_FAIL) {
    process.stderr.write('Error: model not found: nope\nmore detail\n')
    process.exit(1)
  }
  if (process.env.FAKE_SILENT) process.exit(2)
  const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
  const tools = process.env.FAKE_TOOLS ? process.env.FAKE_TOOLS.split(',') : []
  say({ type: 'system', subtype: 'init', tools })
  const text = `heard ${stdin.length} chars`
  say({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } })
  say({ type: 'result', subtype: 'success', is_error: false, result: text })
})
