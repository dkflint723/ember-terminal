// A shell that redraws its prompt as slowly as bash can, for verify-prompt-redraw.
//
// Bash's readline answers a resize (SIGWINCH) by redrawing its prompt, on its own
// schedule, and a line that reaches it in the middle of that redraw loses characters
// — `type` ran as `ype`, about one run in forty-eight on the runner. Real bash makes
// that a matter of luck. This one makes it certain: it speaks Ember's markers as
// integration.bash does, takes a while to draw each prompt (bash running its
// PROMPT_COMMAND), and for REDRAW_MS after a resize it is redrawing — anything that
// arrives meanwhile is dropped, and said to be.
//
// Each command is answered with `ran:<what arrived>`, so a block shows exactly what
// reached the shell. Run as a profile: node fake-redraw-shell.mjs
import { appendFileSync } from 'node:fs'

const NONCE = process.env.EMBER_NONCE ?? ''
const PROMPT_DELAY_MS = 120
const REDRAW_MS = 250

const out = (s) => process.stdout.write(s)
// Its own account of what happened when, for the suite to read: argv[2], if given.
const LOG = process.argv[2]
const t0 = Date.now()
const log = (what) => {
  if (LOG) appendFileSync(LOG, `${Date.now() - t0} ${what}\n`)
}
const signed = (body) => (NONCE ? `\x1b]633;${body};${NONCE}\x07` : `\x1b]633;${body}\x07`)
const mark = (body) => out(signed(body))
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/;/g, '\\x3b')

let redrawingUntil = 0
let line = ''
let first = true

const prompt = () => {
  log('prompt')
  out('\r\n$ \x1b]133;B\x07')
}

/**
 * The end of a command and the start of the next prompt, written in one piece with
 * whatever came before it — `before` is the command's output start and output. A
 * quick command reaches the terminal that way, start and end in one chunk, and the
 * pane once read such a chunk as a command starting rather than ending (QA).
 */
const promptStart = (code, before = '') => {
  log('end')
  let s = before
  if (!first) s += `\x1b]133;D;${code}\x07`
  s += '\x1b]133;A\x07'
  if (!first) s += signed(`D;${code}`)
  first = false
  s += signed(`P;Cwd=${esc(process.cwd())}`)
  out(s)
  // As bash does: the prompt itself comes a moment later, after PROMPT_COMMAND.
  setTimeout(() => {
    if (Date.now() < redrawingUntil) return // the redraw will draw it
    prompt()
  }, PROMPT_DELAY_MS)
}

const run = (text) => {
  // The integration typed in by the fallback loader is not a command anybody ran.
  if (text.includes('| base64 -d')) {
    prompt()
    return
  }
  let s = signed(`E;${esc(text)}`) + '\x1b]133;C\x07' + signed('C') + `ran:${text}\r\n`
  // A few lines more, as real output has: blocks that take room are what make the
  // next strip a different height, and so what makes each ending a resize.
  for (let i = 1; i <= 4; i++) s += `  output line ${i}\r\n`
  promptStart(text === 'false' ? 1 : 0, s)
}

process.stdout.on('resize', () => {
  log(`resize ${process.stdout.rows}`)
  // Redrawing: input is lost until it is done, and then the prompt is drawn again.
  redrawingUntil = Date.now() + REDRAW_MS
  setTimeout(() => {
    out(`\x1b[2K\r$ ${line}\x1b]133;B\x07`)
  }, REDRAW_MS)
})

if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  for (const ch of data) {
    if (Date.now() < redrawingUntil) {
      process.stderr.write(`dropped ${JSON.stringify(ch)}\n`)
      log(`dropped ${JSON.stringify(ch)}`)
      continue
    }
    if (ch === '\r' || ch === '\n') {
      const text = line
      log(`line ${JSON.stringify(text)}`)
      line = ''
      out('\r\n')
      if (text.length > 0) run(text)
      else prompt()
    } else if (ch === '\x7f') {
      line = line.slice(0, -1)
    } else if (ch === '\x03') {
      line = ''
      prompt()
    } else {
      line += ch
      out(ch)
    }
  }
})

mark('Ready')
promptStart(0)
