/**
 * Which of the two things a half-typed line is: a command for the shell, or a
 * question for the agent.
 *
 * The composer asks on every keystroke, so this is pure, synchronous, allocates
 * very little, and never throws — a classifier that fails takes the input with
 * it, and being wrong about a line is recoverable in a way that being unable to
 * type is not.
 *
 * The whole difficulty is that English and a shell share a vocabulary. `find`,
 * `make`, `help`, `where`, `select`, `write`, `echo`, `cat` and `ls` are all
 * real commands and all ordinary words, and the same letters mean opposite
 * things in `find . -name x` and `find the file that imports the store`. So the
 * rules are ordered by how certain the evidence is rather than by how cheap it
 * is to check: what the first token names is read first, because it is the
 * strongest signal a command line has, and the words that are both are decided
 * by what surrounds them rather than by the word itself.
 *
 * Where the evidence runs out the answer is shell. The two mistakes do not cost
 * the same: a wrong shell reading is an error message the user can see and fix
 * in a second, while a wrong agent reading spends a model call and several
 * seconds on a line that was only meant to run. Ctrl+K pins the intent for the
 * buffer either way, so the user always has the last word.
 */

export type Intent = 'shell' | 'agent'

/**
 * How much of the buffer any of this looks at.
 *
 * A pasted file is a plausible thing to find in the composer, and nothing below
 * gets more accurate for having scanned 100KB of it: the first token and the
 * shape of the opening line decide everything. The end of the buffer is still
 * read for a trailing question mark, from its own bounded slice.
 */
const HEAD = 2048

/**
 * Commands that no one types as English.
 *
 * Membership here is decisive — a line starting with one of these is a command
 * however long it gets — so anything that doubles as a plain word belongs in
 * AMBIGUOUS_COMMANDS instead, not here.
 */
const SHELL_COMMANDS = new Set([
  // PowerShell aliases and cmd builtins.
  'cd',
  'chdir',
  'sl',
  'pushd',
  'popd',
  'dir',
  'gci',
  'gc',
  'gi',
  'gp',
  'gm',
  'gu',
  'gl',
  'gv',
  'gcm',
  'gps',
  'si',
  'sp',
  'sv',
  'ni',
  'ri',
  'ii',
  'cpi',
  'mi',
  'rni',
  'md',
  'mkdir',
  'rd',
  'rmdir',
  'rm',
  'del',
  'erase',
  'ren',
  'cp',
  'mv',
  'pwd',
  'cls',
  'exit',
  'ps',
  'man',
  'history',
  'iex',
  'icm',
  'iwr',
  'irm',
  'sls',
  'saps',
  'spps',
  'sasv',
  'spsv',
  'gsv',
  'gdr',
  'gmo',
  'ipmo',
  'ipcsv',
  'epcsv',
  'oh',
  'ogv',
  'fl',
  'ft',
  'fw',
  'nal',
  'gal',
  'sal',
  // Windows tools.
  'findstr',
  'tree',
  'fc',
  'comp',
  'attrib',
  'icacls',
  'takeown',
  'robocopy',
  'xcopy',
  'subst',
  'fsutil',
  'chkdsk',
  'sfc',
  'whoami',
  'hostname',
  'ipconfig',
  'ping',
  'tracert',
  'pathping',
  'netstat',
  'nslookup',
  'arp',
  'route',
  'net',
  'reg',
  'wmic',
  'tasklist',
  'taskkill',
  'schtasks',
  'systeminfo',
  'shutdown',
  'winget',
  'choco',
  'scoop',
  'explorer',
  'notepad',
  'powershell',
  'pwsh',
  'cmd',
  'wsl',
  'bash',
  'sh',
  'zsh',
  'fish',
  // Unix tools that people keep on Windows anyway.
  'grep',
  'sed',
  'awk',
  'head',
  'tail',
  'wc',
  'tee',
  'less',
  'du',
  'df',
  'chmod',
  'chown',
  'ln',
  'touch',
  'uname',
  'env',
  'export',
  'tar',
  'zip',
  'unzip',
  'gzip',
  '7z',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'curl',
  'wget',
  'ffmpeg',
  'magick',
  'pandoc',
  'tmux',
  'screen',
  // Development, which is most of what gets typed here.
  'git',
  'gh',
  'glab',
  'hub',
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'bun',
  'bunx',
  'deno',
  'node',
  'nvm',
  'nvs',
  'tsc',
  'tsx',
  'ts-node',
  'vite',
  'webpack',
  'rollup',
  'esbuild',
  'swc',
  'turbo',
  'nx',
  'lerna',
  'eslint',
  'prettier',
  'jest',
  'vitest',
  'mocha',
  'cypress',
  'playwright',
  'electron',
  'python',
  'python3',
  'py',
  'pip',
  'pip3',
  'pipx',
  'conda',
  'poetry',
  'uv',
  'ruff',
  'pytest',
  'tox',
  'ruby',
  'gem',
  'bundle',
  'rails',
  'rake',
  'php',
  'composer',
  'java',
  'javac',
  'mvn',
  'gradle',
  'dotnet',
  'nuget',
  'go',
  'cargo',
  'rustc',
  'rustup',
  'clang',
  'gcc',
  'g++',
  'cmake',
  'ninja',
  'msbuild',
  'docker',
  'docker-compose',
  'podman',
  'kubectl',
  'helm',
  'minikube',
  'terraform',
  'ansible',
  'vagrant',
  'aws',
  'az',
  'gcloud',
  'heroku',
  'vercel',
  'netlify',
  'fly',
  'flyctl',
  'supabase',
  'firebase',
  'prisma',
  'sqlite3',
  'psql',
  'mysql',
  'mongo',
  'mongosh',
  'redis-cli',
  'jq',
  'yq',
  'rg',
  'fd',
  'fzf',
  'bat',
  'eza',
  'delta',
  'code',
  'code-insiders',
  'cursor',
  'vim',
  'nvim',
  'nano',
  'emacs',
  'subl',
  'idea',
  'claude',
  'ollama'
])

/**
 * Words that are a real command and a real English word at once.
 *
 * These are the whole reason this file is longer than a regex. The command
 * reading wins while the line still looks like a command line — `ls`, `ls -la`,
 * `find . -name x`, `select Name` — and the English reading takes over once the
 * line is plainly a sentence, which resolveAmbiguous decides from the words and
 * arguments that follow rather than from this one.
 *
 * Nothing may appear both here and in SHELL_COMMANDS. That set is checked first
 * and answers outright, so a word listed twice would never reach the careful
 * reading it was put here for.
 */
const AMBIGUOUS_COMMANDS = new Set([
  'ls',
  'cat',
  'echo',
  'write',
  'select',
  'where',
  'which',
  'find',
  'make',
  'help',
  'clear',
  'sort',
  'group',
  'measure',
  'compare',
  'foreach',
  'start',
  'stop',
  'set',
  'move',
  'copy',
  'rename',
  'type',
  'more',
  'test',
  'diff',
  'watch',
  'kill'
])

/**
 * Openers that put the rest of the line in the interrogative.
 *
 * These stand on their own: a buffer of nothing but `why` is already a
 * question, because none of them is a command on Windows.
 */
const QUESTION_OPENERS = new Set([
  'what',
  'whats',
  "what's",
  'why',
  'how',
  'when',
  'who',
  'whom',
  'whose',
  'which',
  'is',
  'are',
  'am',
  'was',
  'were',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'shall',
  'would',
  'will',
  'may',
  'might',
  'must',
  'has',
  'have',
  'had',
  'any',
  'anyone',
  'theres',
  "there's"
])

/**
 * Openers that ask a person for something.
 *
 * Unlike the interrogatives these need a second token before they count. A lone
 * `fix` or `build` is far more likely to be a command name halfway through being
 * typed than a request, and the label flicking to `agent` on the first word of
 * every command would make the autodetection feel like it was guessing.
 */
const REQUEST_OPENERS = new Set([
  'explain',
  'describe',
  'summarise',
  'summarize',
  'tell',
  'show',
  'give',
  'list',
  'teach',
  'walk',
  'suggest',
  'recommend',
  'review',
  'check',
  'analyse',
  'analyze',
  'debug',
  'investigate',
  'fix',
  'repair',
  'refactor',
  'rewrite',
  'rename',
  'implement',
  'create',
  'generate',
  'add',
  'remove',
  'delete',
  'drop',
  'convert',
  'translate',
  'turn',
  'change',
  'update',
  'improve',
  'optimise',
  'optimize',
  'simplify',
  'document',
  'comment',
  'build',
  'install',
  'setup',
  'deploy',
  'run',
  'open',
  'close',
  'undo',
  'revert',
  'please',
  'lets',
  "let's",
  'let',
  'i',
  'im',
  "i'm",
  'ive',
  "i've",
  'my',
  'we',
  'our',
  'need',
  'want',
  'help'
])

/**
 * The words that betray a sentence.
 *
 * Determiners, pronouns and auxiliaries only: they are what English puts around
 * a noun and what a command line never contains. Prepositions are deliberately
 * absent — `in`, `to` and `for` are all over real commands (`foreach ($f in
 * $files)`, `move a to b`, `-for 30`) and would drag them into the agent.
 */
const FUNCTION_WORDS = new Set([
  'the',
  'a',
  'an',
  'this',
  'that',
  'these',
  'those',
  'my',
  'our',
  'your',
  'their',
  'its',
  'it',
  'me',
  'us',
  'i',
  'we',
  'you',
  'what',
  'whats',
  "what's",
  'why',
  'how',
  'when',
  'who',
  'which',
  'is',
  'are',
  'am',
  'was',
  'were',
  'be',
  'been',
  'being',
  'do',
  'does',
  'did',
  'doesnt',
  "doesn't",
  'dont',
  "don't",
  'can',
  'cant',
  "can't",
  'could',
  'should',
  'would',
  'will',
  'wont',
  "won't",
  'has',
  'have',
  'had',
  'please',
  'instead',
  'because',
  'whether',
  'about',
  'every',
  'some',
  'any',
  'and',
  'or',
  'not',
  'so',
  'then',
  'than'
])

/**
 * The quantifiers, which are English only while they are quantifying something.
 *
 * These are the words `find all log files` has and `find . -name x` does not,
 * but they are weaker evidence than a determiner because a shell uses several of
 * them as names: `make all` is a rule, `just build all` is a task. So a
 * quantifier counts as a sentence's word only when another token follows it —
 * which is the difference between quantifying a noun and being the noun.
 *
 * `more` is absent on purpose. It is a pager and a page-at-a-time switch, and
 * `type it | more` is nobody's question.
 */
const QUANTIFIERS = new Set([
  'all',
  'each',
  'both',
  'either',
  'neither',
  'no',
  'none',
  'other',
  'another',
  'many'
])

/**
 * Operators that only a shell has a use for.
 *
 * `;` is not in here: it is the one operator that also punctuates English, and
 * the classifier weighs it separately so that "fix this; it has been broken all
 * day" is not read as two commands.
 *
 * The `>` arm has to ignore `->`, `=>` and `>=`, which appear in prose and in
 * code being pasted for the agent to look at, while still catching redirection
 * in every form the shell writes it: `> out.txt`, `2>&1`, `>>log`.
 */
const STRONG_OPERATOR = /\|{1,2}|&&|\$\(|>>|(?:^|[^-=<>!])>(?!=)/

/**
 * A first token that is a file to run rather than a word to read: `./verify`,
 * `.\build.ps1`, `C:\tools\x.exe`, `/usr/bin/env`, `\\server\share\setup.cmd`.
 * Nobody opens a question with one, so either of these ends the matter.
 */
const PATH_LIKE = /^(?:[.~]{1,2}[\\/]|[a-z]:[\\/]|[\\/]|\\\\)/i
const EXECUTABLE_SUFFIX = /\.(?:exe|ps1|psm1|cmd|bat|sh|com|msi)$/i

/**
 * Get-ChildItem, Set-Location, Invoke-RestMethod: the shape is unmistakable and
 * it covers every cmdlet that will ever exist, including ones from modules
 * nothing here has heard of.
 *
 * More than one hyphen is allowed because the tools people install are spelled
 * that way — `create-react-app`, `redis-cli`, `docker-compose` — even though a
 * cmdlet only ever has the one.
 *
 * English hyphenates too, and `re-run the tests` is a request rather than a
 * cmdlet. None of these prefixes is an approved PowerShell verb, so excusing
 * them costs no real command, and the prefix has to be followed immediately by
 * the hyphen — which is why `remove-item` and `redis-cli` are untouched by it.
 */
const VERB_NOUN = /^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)+$/i
const ENGLISH_HYPHEN = /^(?:re|un|non|pre|post|self|co|de|anti|multi|semi|over|under)-/i

/** A switch or a flag, in either the PowerShell or the GNU spelling. */
const FLAG = /^-{1,2}[a-z]/i

/**
 * Arguments rather than words: paths, globs, variables, extensions, drives.
 *
 * This is what keeps a long command line out of the agent when the length rules
 * would otherwise claim it — `select Name, Length, LastWriteTime, Mode,
 * Attributes` is six tokens of commas, not a sentence.
 */
const ARGUMENT_LIKE = /[\\/*]|^[.$@]|^-{1,2}[a-z]|[a-z0-9]:|\.[a-z0-9]{1,5}$|,$/i

export function classifyIntent(buffer: string): Intent {
  // Defensive about its own argument because it is called from an event handler
  // on the typing path, where a throw would break the composer, not just the
  // label.
  if (typeof buffer !== 'string') return 'shell'

  const head = buffer.length > HEAD ? buffer.slice(0, HEAD) : buffer
  const text = head.trim()
  // Nothing typed yet is a shell prompt, which is what the composer opens as.
  if (text.length === 0) return 'shell'

  const tokens = text.split(/\s+/)
  const rest = tokens.slice(1)
  const first = unquote(tokens[0]).toLowerCase()
  const question = endsAsQuestion(buffer, rest.some((t) => FLAG.test(t)))

  // A first token that names something to run settles the line outright: it is
  // the one piece of evidence a command line always has and a sentence almost
  // never does.
  if (looksExecutable(tokens[0])) return 'shell'

  if (SHELL_COMMANDS.has(first)) {
    /*
     * Unless the line has stopped being a command line and become a sentence
     * about one — "git blame is confusing, how do I read it?" is a question that
     * happens to open with a command name.
     *
     * The bar is deliberately high, all three of a question mark, some length
     * and a function word, because this rule is overruling the strongest signal
     * there is. Short lines like `docker ps?` stay shell.
     */
    return question && tokens.length >= 4 && hasEnglishWord(rest) ? 'agent' : 'shell'
  }

  // An interrogative opener closed by a question mark is a question whatever
  // else is in it, so this is asked before the operators below. It is what keeps
  // "how do I pipe git log | head?" from being read as a pipeline: the operator
  // is being asked about rather than used.
  if (question && QUESTION_OPENERS.has(first)) return 'agent'

  /*
   * The operators are read before the overlap rather than after it, because the
   * words a shell shares with English are exactly the ones people write in front
   * of a redirect. `echo "the build is done" > status.txt` and `cat the log |
   * more` are commands with a determiner sitting in the middle of them, and
   * asking resolveAmbiguous first would hand both to the agent on the strength
   * of the word `the`. An operator is what the shell is for; nothing that
   * contains one is a question, bar the interrogative just above.
   */
  if (STRONG_OPERATOR.test(head)) return 'shell'
  // The weak one. A semicolon joins two commands, but it also joins two clauses,
  // and the words around it are the only way to tell which happened.
  if (head.includes(';') && !hasEnglishWord(rest)) return 'shell'

  if (AMBIGUOUS_COMMANDS.has(first)) return resolveAmbiguous(tokens, rest, question)

  if (question) return 'agent'
  if (QUESTION_OPENERS.has(first)) return 'agent'
  if (REQUEST_OPENERS.has(first) && tokens.length > 1) return 'agent'
  // Plenty of sentences open with neither: "the build is broken", "this keeps
  // failing", "it says permission denied". A determiner or pronoun in front of
  // more words is English with nothing else it could be — no command starts with
  // one.
  if (tokens.length > 1 && isEnglishWord(tokens[0], true)) return 'agent'

  /*
   * Nothing here recognises the first token, so the shape of the line has to
   * answer for it.
   *
   * Six tokens is about where an unrecognised command line stops being
   * plausible, and a determiner or pronoun anywhere in it says the same thing
   * sooner. Either way an argument settles it back to shell: paths, flags,
   * globs and variables mean the line resolved itself, whatever this file
   * happens to know. A project's own script or a binary these lists have never
   * heard of is exactly the case that protects.
   */
  const hasArguments = rest.some((t) => ARGUMENT_LIKE.test(t))
  if (tokens.length > 6 && !hasArguments) return 'agent'
  if (tokens.length > 2 && !hasArguments && hasEnglishWord(rest)) return 'agent'

  // Unrecognised and short: almost always a command being typed, and shell is
  // the cheaper thing to be wrong about.
  return 'shell'
}

/**
 * The overlap, decided by everything else on the line.
 *
 * The line is already known to hold no operator — classifyIntent settles those
 * before it gets here — so what is left is words and arguments.
 *
 * The order is the point. A question mark is the end of an argument; a
 * determiner or pronoun means English has a noun phrase in flight and there is
 * no reading of `find the file that imports the store` as a command. Only then
 * does the argument test get a say, so that `find src/store.ts` stays a command
 * while `find the file that imports store.ts` — which has arguments-looking
 * tokens in it too — does not.
 */
/**
 * Commands whose whole job is to take arbitrary prose as their argument.
 * English words after `echo` are not evidence of a question — printing a
 * sentence is exactly what the command does — so only an actual question mark
 * reads these as asking rather than telling.
 */
const ECHOING = new Set(['echo', 'write', 'write-output', 'write-host', 'print', 'printf'])

function resolveAmbiguous(tokens: string[], rest: string[], question: boolean): Intent {
  if (question) return 'agent'
  if (ECHOING.has(unquote(tokens[0]).toLowerCase())) return 'shell'
  if (hasEnglishWord(rest)) return 'agent'
  if (rest.some((t) => ARGUMENT_LIKE.test(t))) return 'shell'
  /*
   * A run of plain words is not evidence of English on its own.
   *
   * `find all log files` reads as a sentence, but it is `all` that says so, and
   * the quantifier is already counted above. Reading three bare words as a phrase
   * without one costs `make clean install test`, `ls src dist build` and
   * `copy src dest backup` — real invocations whose arguments happen to be plain
   * nouns — and it fires on the *absence* of an English word, applied to a line
   * whose first token is a known command. That is the weakest evidence on the
   * page overruling the strongest, and the two mistakes do not cost the same: a
   * command misread as a question spends a model call and several seconds, while
   * a question misread as a command costs an error message.
   */
  if (tokens.length > 6) return 'agent'
  return 'shell'
}

/** Whether the first token names a file, a variable or a cmdlet to invoke. */
function looksExecutable(raw: string): boolean {
  const token = unquote(raw)
  if (token.length === 0) return false
  // The call operator, dot-sourcing, a variable assignment, a comment: all of
  // them are PowerShell that starts before the command name does.
  if (token === '&' || token === '.' || token === '..') return true
  if (token.startsWith('$') || token.startsWith('&') || token.startsWith('#')) return true
  if (token.includes('=')) return true
  if (PATH_LIKE.test(token)) return true
  if (EXECUTABLE_SUFFIX.test(token)) return true
  return VERB_NOUN.test(token) && !ENGLISH_HYPHEN.test(token)
}

/**
 * A trailing question mark that is punctuation rather than a glob.
 *
 * `?` matches a single character in a wildcard and is the alias for
 * Where-Object, so its position is not enough on its own. It only reads as
 * punctuation when the token it ends is a plain word and the line carries no
 * flags — `dir *.?`, `find . -name x?` and `gci | ?` all end in one and none of
 * them is asking anything.
 *
 * Read from the end of the real buffer rather than the truncated head, from a
 * slice long enough for the last token: a pasted page that ends in a question
 * still ends in a question.
 */
function endsAsQuestion(buffer: string, flagged: boolean): boolean {
  const tail = buffer.length > 96 ? buffer.slice(-96) : buffer
  const token = tail.trimEnd().split(/\s+/).pop() ?? ''
  if (!token.endsWith('?') || token === '?') return false
  if (flagged) return false
  const stem = token.replace(/\?+$/, '')
  return !/[*[\]\\/'"]/.test(stem) && !stem.startsWith('-')
}

/**
 * A token compared as a word, with the punctuation English attaches to it.
 *
 * A switch is not a word however it is spelled. `-a`, `--all` and `/i` reduce to
 * `a`, `all` and `i`, every one of which English says constantly, and a line
 * carrying a flag has already declared itself a command — so they reduce to
 * nothing instead.
 */
function wordOf(token: string): string {
  if (FLAG.test(token) || token.startsWith('/')) return ''
  return token.toLowerCase().replace(/[^a-z']/g, '')
}

/**
 * A word only a sentence puts on a line, read in the position it was found in.
 *
 * Determiners and pronouns count wherever they are. A quantifier counts only
 * when something follows it, which is the whole of what separates `all log
 * files` from `make all`.
 */
function isEnglishWord(token: string, followed: boolean): boolean {
  const word = wordOf(token)
  if (FUNCTION_WORDS.has(word)) return true
  return followed && QUANTIFIERS.has(word)
}

/** Whether the tokens after the command name read as a sentence. */
function hasEnglishWord(rest: string[]): boolean {
  return rest.some((token, i) => isEnglishWord(token, i < rest.length - 1))
}

/** Command names get quoted whenever the path has a space in it. */
function unquote(token: string): string {
  return token.replace(/^['"]+/, '').replace(/['"]+$/, '')
}
