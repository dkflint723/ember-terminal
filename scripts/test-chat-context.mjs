// The context a question carries, whichever door it goes through.
// Run: node scripts/test-chat-context.mjs
//
// A question asked in Ember reaches a model one of two ways: the Anthropic API when
// an API key is set, and the Claude Code CLI when one is not. Each of them used to
// assemble the system prompt for itself, and the two copies drifted — the API path
// grew the attached blocks and the open file, the CLI path never did. So for anyone
// signed in through the CLI rather than with a key, which is the ordinary way to use
// this app, pressing "explain last error" sent the question and threw the error away.
// The model was asked why something failed and shown nothing that had failed.
//
// It survived every check because all of them run against `EMBER_FAKE_AI`, which
// short-circuits before either real path — so the covered path was not the used one,
// and `verify-intent.mjs` proved attachments reached a backend nobody is on.
//
// There is one builder now, so the interesting question is no longer "do both doors
// remember" but "does the builder carry it at all". That is what this asks, and it
// runs here rather than in a window because the answer needs no window: the prompt
// is a pure function of the request.
import { chatSystem } from '../src/shared/prompt.ts'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const FAILED_BLOCK = `$ Get-Item .\\missing.txt (exit 1)
Get-Item: Cannot find path 'D:\\work\\missing.txt' because it does not exist.`

const bare = chatSystem({ shell: 'pwsh', cwd: 'D:\\work' })

// --- the parts that are always there -------------------------------------------
check('the shell is named', bare.includes('pwsh'), bare.slice(0, 120))
check('and the working directory', bare.includes('D:\\work'), bare.slice(0, 160))
check(
  'and the model is told how to propose a file change',
  bare.includes('path=<path>'),
  'no `lang path=<path>` instruction'
)
check(
  'and how to propose a command',
  bare.includes('`run`'),
  'no `run` fence instruction'
)

// --- the part that was being dropped -------------------------------------------
const withBlock = chatSystem({
  shell: 'pwsh',
  cwd: 'D:\\work',
  attached: [FAILED_BLOCK]
})
check(
  'an attached block reaches the model',
  withBlock.includes('Attached terminal output:'),
  'no attachment heading in the prompt'
)
check(
  'carrying the command that failed',
  withBlock.includes('Get-Item .\\missing.txt'),
  'the command is not in the prompt'
)
check(
  'and the error it printed',
  withBlock.includes('because it does not exist'),
  'the error text is not in the prompt'
)
check(
  'and its exit code, which is how the model knows it failed',
  withBlock.includes('(exit 1)'),
  'the exit code is not in the prompt'
)

// --- several of them, because Ctrl+Up attaches more than one --------------------
const two = chatSystem({
  shell: 'pwsh',
  cwd: 'D:\\work',
  attached: [FAILED_BLOCK, '$ npm run build (exit 2)\nTS2345: Argument of type…']
})
check(
  'every attached block arrives, not just the first',
  (two.match(/Attached terminal output:/g) ?? []).length === 2,
  `${(two.match(/Attached terminal output:/g) ?? []).length} of 2`
)
check('the second one intact', two.includes('TS2345'), 'the second block is missing')

/*
 * An empty attachment is not an attachment. The composer builds this list from the
 * recent tail as well as the chips, and a block that ran and printed nothing would
 * otherwise contribute a heading with a blank under it — which reads, to a model,
 * as output that was empty rather than as a block worth nothing.
 */
const blank = chatSystem({ shell: 'pwsh', cwd: 'D:\\work', attached: ['', '   \n'] })
check(
  'an empty attachment is left out rather than announced',
  !blank.includes('Attached terminal output:'),
  'a blank attachment produced a heading'
)

// --- the open file, which was dropped by the same door -------------------------
const withFile = chatSystem({
  shell: 'pwsh',
  cwd: 'D:\\work',
  activeFile: { path: 'D:\\work\\src\\thing.ts', text: 'export const marker = 41\n' }
})
check(
  'the file being edited reaches the model',
  withFile.includes('D:\\work\\src\\thing.ts'),
  'the path is not in the prompt'
)
check(
  'with its buffer, not just its name',
  withFile.includes('export const marker = 41'),
  'the text is not in the prompt'
)

/*
 * And the instructions are not buried. The context is the longest part by far — a
 * screenful of build output — so it goes last; put first, it would push the part
 * telling the model how to answer past whatever a model stops reading carefully.
 */
const both = chatSystem({
  shell: 'pwsh',
  cwd: 'D:\\work',
  activeFile: { path: 'a.ts', text: 'x' },
  attached: [FAILED_BLOCK]
})
check(
  'the instructions come before the context, not after it',
  both.indexOf('path=<path>') < both.indexOf('Attached terminal output:'),
  `instructions at ${both.indexOf('path=<path>')}, context at ${both.indexOf('Attached terminal output:')}`
)

console.log('chat context:', failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
