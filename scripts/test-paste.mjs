// What a paste may carry into a terminal. Run: node scripts/test-paste.mjs
//
// A newline in the clipboard is an Enter, and an escape character is an
// instruction rather than text — including the marker that ends a bracketed
// paste, which is how pasted text talks its way out of being treated as text. The
// cases below are the shapes that matter, each paired with the ordinary text
// nearest to it that must come through untouched.
import { cleanPaste, needsAsking, pasteQuestion, runQuestion } from '../src/shared/paste.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const DEL = String.fromCharCode(127)
const NUL = String.fromCharCode(0)

// --- ordinary text comes through exactly as it was ------------------------------------
cases += 4
const plain = cleanPaste('git status')
check('a single line is unchanged', plain.text === 'git status', JSON.stringify(plain))
check('and nothing was taken out of it', plain.removed === 0, JSON.stringify(plain))
check('and it is not one line that runs on arrival', !plain.runsOnArrival, JSON.stringify(plain))
check('so nothing is asked', !needsAsking(plain), JSON.stringify(plain))

cases += 2
const tabbed = cleanPaste('name\tvalue')
check('a tab survives, being text', tabbed.text === 'name\tvalue', JSON.stringify(tabbed))
const accented = cleanPaste('echo "café ☕"')
check('and so does anything above ASCII', accented.text === 'echo "café ☕"', JSON.stringify(accented))

// --- escapes and other control characters do not -----------------------------------------
cases += 3
const escaped = cleanPaste(`echo hi${ESC}]0;pwned${BEL}`)
check('an escape character is removed', !escaped.text.includes(ESC), JSON.stringify(escaped.text))
check('and so is the bell that ends the sequence', !escaped.text.includes(BEL), JSON.stringify(escaped.text))
check('and the count says how many went', escaped.removed === 2, JSON.stringify(escaped))

cases += 2
// The end-of-paste marker: left in, it closes the bracket early and everything
// after it arrives as ordinary typing, which is the protection undone.
const breakout = cleanPaste(`ls${ESC}[201~\nrm -rf /`)
check('the end-of-paste marker cannot survive', !breakout.text.includes(ESC), JSON.stringify(breakout.text))
check('though what it was hiding is still counted', breakout.lines === 2, JSON.stringify(breakout))

cases += 2
const nulled = cleanPaste(`a${NUL}b${DEL}c`)
check('a NUL and a DEL are removed', nulled.text === 'abc', JSON.stringify(nulled))
check('and counted', nulled.removed === 2, JSON.stringify(nulled))

// --- line endings, which are the other half of the danger -----------------------------------
cases += 4
const windows = cleanPaste('one\r\ntwo\r\n')
check('CRLF becomes one newline each', windows.text === 'one\ntwo\n', JSON.stringify(windows.text))
check('with nothing counted as removed', windows.removed === 0, JSON.stringify(windows))
const lone = cleanPaste('one\rtwo')
check('a lone carriage return is a newline too', lone.text === 'one\ntwo', JSON.stringify(lone.text))
check('and it counts as two lines', lone.lines === 2, JSON.stringify(lone))

cases += 3
const blanks = cleanPaste('one\n\n\ntwo\n')
check('empty lines are not counted as lines that run', blanks.lines === 2, JSON.stringify(blanks))
const trailing = cleanPaste('deploy.sh\n')
check('one line with a newline after it still runs on arrival', trailing.runsOnArrival, JSON.stringify(trailing))
check('but there is only one of it, so nothing is asked', !needsAsking(trailing), JSON.stringify(trailing))

// --- what the shell is holding decides whether to ask ------------------------------------------
cases += 4
const many = 'git pull\nnpm install\nnpm run build\n'
const unheld = cleanPaste(many, false)
check('multiple lines run on arrival when nothing holds them', unheld.runsOnArrival, JSON.stringify(unheld))
check('and that is worth asking about', needsAsking(unheld), JSON.stringify(unheld))
const held = cleanPaste(many, true)
check('bracketed paste means the shell holds it until Enter', !held.runsOnArrival, JSON.stringify(held))
check('so it is not asked about', !needsAsking(held), JSON.stringify(held))

// --- and the question itself says what is happening ---------------------------------------------
cases += 4
const question = pasteQuestion(unheld)
check('the question counts the lines', question.includes('3 lines'), question)
check('and shows the one it would start with', question.includes('git pull'), question)
check('and says it will run rather than wait', /as soon as it arrives/.test(question), question)
const withStripped = pasteQuestion(cleanPaste(`ls${ESC}x\nrm -rf build`))
check('and mentions anything taken out of it', /1 control character will be removed/.test(withStripped), withStripped)

// --- and the other question, for lines already on screen ------------------------------------
cases += 3
const running = runQuestion(cleanPaste('git pull\nnpm ci\nnpm test'))
check('the run question counts the lines', running.includes('3 lines'), running)
check('and shows the one it starts with', running.includes('git pull'), running)
check(
  'and asks about running them rather than about pasting',
  /Run them\?/.test(running) && !/arrives/.test(running),
  running
)

console.log(
  failures === 0 ? `paste: ${cases} cases PASS` : `paste: ${failures} checks FAILED of ${cases} cases`
)
process.exit(failures === 0 ? 0 : 1)
