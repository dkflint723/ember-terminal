/**
 * What a command could do that cannot be taken back, said before it runs (audit R29).
 *
 * Commands are typed on the user's behalf from a handful of places — Claude's Run, a
 * block's Run again, a paste — and nothing said which of them deleted files for good,
 * ran a script fetched from the internet, asked for administrator rights or rewrote
 * git history. The only label was the one a model chose to put on its own proposal.
 *
 * This is a local rule set, PowerShell first and bash second, and it only warns: a
 * label is never a permission, some ordinary commands will be labelled, and a
 * command written to avoid the rules will not be. What it is for is the command a
 * person runs without reading closely.
 */

export type RiskClass = 'irreversible' | 'network-executes' | 'elevation' | 'history-rewriting'

export interface Risk {
  class: RiskClass
  /** What it does, in a phrase that finishes "This command …". */
  why: string
}

/** How many labels to show: every class, only what cannot be undone, or none. */
export type RiskSensitivity = 'all' | 'irreversible' | 'off'

export const RISK_TITLES: Record<RiskClass, string> = {
  irreversible: 'cannot be undone',
  'network-executes': 'runs code from the internet',
  elevation: 'asks for administrator rights',
  'history-rewriting': 'rewrites git history'
}

/** PowerShell's aliases for the commands the rules name, by what they stand for. */
const ALIASES: Record<string, string> = {
  rm: 'remove-item',
  del: 'remove-item',
  erase: 'remove-item',
  ri: 'remove-item',
  rd: 'remove-item',
  rmdir: 'remove-item',
  iwr: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  iex: 'invoke-expression',
  saps: 'start-process',
  start: 'start-process',
  clc: 'clear-content'
}

/** The command a segment runs: its first word, without a path, quotes, `&` or `.exe`. */
function verbOf(segment: string): { verb: string; rest: string } {
  const text = segment.trim().replace(/^[&.]\s+/, '')
  const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))\s*([\s\S]*)$/.exec(text)
  if (!m) return { verb: '', rest: '' }
  const word = (m[1] ?? m[2] ?? m[3] ?? '').split(/[\\/]/).pop() ?? ''
  const bare = word.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
  return { verb: ALIASES[bare] ?? bare, rest: m[4] ?? '' }
}

/**
 * A command line's segments — what runs one after another or side by side, and what
 * runs inside a script block or parentheses: `ForEach-Object { Remove-Item $_ }`
 * deletes as surely as `Remove-Item` does. Quoted text is not split, so a commit
 * message holding `; rm -rf` is a message.
 */
function segmentsOf(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: string | null = null
  const text = command.replace(/\r\n?/g, '\n')
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quote) {
      current += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    const two = text.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      out.push(current)
      current = ''
      i += 1
      continue
    }
    if ('\n;|{}()'.includes(c)) {
      out.push(current)
      current = ''
      continue
    }
    current += c
  }
  out.push(current)
  return out.map((s) => s.trim().replace(/^[$@]$/, '')).filter((s) => s.length > 0)
}

const has = (rest: string, flag: RegExp): boolean => flag.test(` ${rest} `)

/** The rules for one segment: what its command is, and what its arguments make of it. */
function segmentRisks(segment: string): Risk[] {
  const { verb, rest } = verbOf(segment)
  const out: Risk[] = []
  const add = (cls: RiskClass, why: string): void => {
    out.push({ class: cls, why })
  }

  switch (verb) {
    case 'remove-item':
      add('irreversible', 'deletes files outright, past the Recycle Bin')
      break
    case 'clear-content':
      add('irreversible', 'empties the contents of files')
      break
    case 'clear-recyclebin':
      add('irreversible', 'empties the Recycle Bin for good')
      break
    case 'format-volume':
    case 'format':
    case 'clear-disk':
    case 'initialize-disk':
    case 'remove-partition':
    case 'diskpart':
      add('irreversible', 'erases a disk or a partition')
      break
    case 'shred':
    case 'wipe':
      add('irreversible', 'overwrites files so they cannot be recovered')
      break
    case 'dd':
      if (has(rest, /\sof=/)) add('irreversible', 'writes raw bytes over a file or a device')
      break
    case 'stop-computer':
    case 'restart-computer':
    case 'shutdown':
    case 'reboot':
    case 'poweroff':
    case 'halt':
      add('irreversible', 'shuts down or restarts the machine, ending every program on it')
      break
    case 'reg':
      if (has(rest, /^\s*delete\s/i)) add('irreversible', 'deletes registry keys')
      break
    case 'remove-itemproperty':
      add('irreversible', 'deletes registry values or file properties')
      break
    case 'terraform':
      if (has(rest, /^\s*destroy\b/i)) add('irreversible', 'destroys the infrastructure it manages')
      break
    case 'kubectl':
      if (has(rest, /^\s*delete\b/i)) add('irreversible', 'deletes cluster resources')
      break
    case 'docker':
    case 'podman':
      if (
        has(rest, /^\s*(system|volume|image|container|builder|network)\s+prune\b/i) ||
        has(rest, /^\s*volume\s+rm\b/i) ||
        has(rest, /^\s*rm\b.*\s(-f|--force)\b/i) ||
        has(rest, /^\s*rmi\b/i) ||
        has(rest, /^\s*compose\b.*\sdown\b.*\s(-v|--volumes)\b/i)
      ) {
        add('irreversible', 'deletes containers, images or volumes')
      }
      break
    case 'npm':
      if (has(rest, /^\s*unpublish\b/i)) add('irreversible', 'removes a published package')
      // Only when it fetches without asking: npm asks before it downloads otherwise.
      if (has(rest, /^\s*exec\b/i) && has(rest, /\s(-y|--yes)\b/i)) add('network-executes', 'fetches a package and runs it')
      break
    case 'npx':
      // `npx tsc` runs the project's own; it fetches without asking only when told
      // to, or when named with a version.
      if (has(rest, /\s(-y|--yes|-p|--package)\b/i) || /^\s*(@?[\w.-]+\/)?[\w.-]+@[\w.^~-]+/.test(rest)) {
        add('network-executes', 'fetches a package and runs it')
      }
      break
    case 'bunx':
    case 'uvx':
      add('network-executes', 'fetches a package and runs it')
      break
    case 'find':
      if (has(rest, /\s-delete\b/) || has(rest, /\s-exec(dir)?\s+rm\b/)) add('irreversible', 'deletes the files it finds')
      break
    case 'xargs': {
      // What it runs, judged as itself.
      const inner = rest.replace(/^(\s*-\S+(\s+\S+)?)*/, '')
      out.push(...segmentRisks(inner))
      break
    }
    case 'aws':
      if (has(rest, /^\s*s3\s+(rm|rb)\b/i)) add('irreversible', 'deletes objects or buckets')
      break
    case 'gh':
      if (has(rest, /^\s*(repo|release)\s+delete\b/i)) add('irreversible', 'deletes a repository or release on GitHub')
      break
    case 'vssadmin':
      if (has(rest, /^\s*delete\s+shadows\b/i)) add('irreversible', 'deletes the shadow copies Windows restores from')
      break
    case 'cipher':
      if (has(rest, /\s\/w\b/i)) add('irreversible', 'overwrites free space, so deleted files cannot be recovered')
      break
    case 'sqlcmd':
    case 'psql':
    case 'mysql':
    case 'sqlite3':
    case 'invoke-sqlcmd':
      if (/\b(drop\s+(table|database|schema)|truncate\s+table)\b/i.test(rest)) add('irreversible', 'drops database tables or their rows')
      break
    case 'pnpm':
    case 'yarn':
      if (has(rest, /^\s*dlx\b/i)) add('network-executes', 'fetches a package and runs it')
      break
    case 'pipx':
      if (has(rest, /^\s*run\b/i)) add('network-executes', 'fetches a package and runs it')
      break
    case 'winget':
    case 'choco':
    case 'scoop':
      if (has(rest, /^\s*(install|upgrade|update)\b/i)) add('network-executes', 'downloads software and runs its installer')
      break
    case 'msiexec':
      if (has(rest, /https?:\/\//i)) add('network-executes', 'runs an installer straight from the internet')
      break
    /*
     * A command handed to another shell, to a remote one, or to Invoke-Expression as
     * a string is that command, and is judged as itself: `powershell -c "Remove-Item
     * x"` deletes, and so does `cmd /c rd /s /q build` and `ssh host "rm -rf /var"`.
     */
    case 'powershell':
    case 'pwsh': {
      const m = /(?:^|\s)-(?:c|command)\s+([\s\S]+)$/i.exec(rest)
      const inner = m ? m[1] : rest.replace(/^(\s*-\S+)*/, '')
      if (/(?:^|\s)-(?:e|ec|enc|encodedcommand)\s/i.test(` ${rest}`)) {
        add('network-executes', 'runs an encoded command, which cannot be read before it runs')
      } else if (inner.trim()) out.push(...innerRisks(inner))
      break
    }
    case 'cmd': {
      const m = /(?:^|\s)\/[ck]\s+([\s\S]+)$/i.exec(rest)
      if (m) out.push(...innerRisks(m[1]))
      break
    }
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash':
    case 'ksh': {
      const m = /(?:^|\s)-[a-z]*c\s+([\s\S]+)$/.exec(rest)
      if (m) out.push(...innerRisks(m[1]))
      break
    }
    case 'wsl': {
      if (has(rest, /\s--unregister\b/i)) add('irreversible', 'deletes a Linux distribution and everything in it')
      const m = /(?:^|\s)(?:-e|--exec|--)\s+([\s\S]+)$/i.exec(rest)
      const inner = m ? m[1] : /^\s*-/.test(rest) ? '' : rest
      if (inner.trim()) out.push(...innerRisks(inner))
      break
    }
    case 'ssh': {
      // Past the options (and their values) and the host, to what runs there.
      const words = rest.trim().split(/\s+/)
      let i = 0
      while (i < words.length && words[i].startsWith('-')) i += /^-[bcDEeFIiJLlmOoPpQRSWw]$/.test(words[i]) ? 2 : 1
      const inner = words.slice(i + 1).join(' ')
      if (inner.trim()) out.push(...innerRisks(inner))
      break
    }
    case 'invoke-expression':
      if (/^\s*["']/.test(rest)) out.push(...innerRisks(rest))
      break
    case 'start-process': {
      if (has(rest, /\s-verb\s+['"]?runas\b/i)) add('elevation', 'starts a program as administrator')
      const list = /\s-(?:argumentlist|args)\s+([\s\S]+)$/i.exec(` ${rest}`)
      if (list && /^\s*['"]?(powershell|pwsh|cmd)(\.exe)?\b/i.test(rest)) out.push(...innerRisks(list[1]))
      break
    }
    case 'sudo':
    case 'gsudo':
    case 'doas': {
      add('elevation', 'runs a command as administrator')
      // And what it runs is judged as itself: `sudo rm -rf` still deletes.
      const words = rest.trim().split(/\s+/)
      let i = 0
      while (i < words.length && words[i].startsWith('-')) i += /^-[ugCp]$/.test(words[i]) ? 2 : 1
      const inner = words.slice(i).join(' ')
      if (inner) out.push(...segmentRisks(inner))
      break
    }
    case 'runas':
      add('elevation', 'runs a command as another user')
      break
    case 'set-executionpolicy':
      add('elevation', 'changes which scripts PowerShell will run')
      break
    case 'add-mppreference':
    case 'set-mppreference':
      add('elevation', 'changes Microsoft Defender’s protection')
      break
    case 'bcdedit':
      add('elevation', 'changes how Windows starts')
      break
    case 'takeown':
      add('elevation', 'takes ownership of files from their owner')
      break
    case 'netsh':
      if (has(rest, /\b(advfirewall|firewall)\b/i)) add('elevation', 'changes the firewall')
      break
    case 'new-netfirewallrule':
    case 'set-netfirewallprofile':
      add('elevation', 'changes the firewall')
      break
    case 'git':
      return out.concat(gitRisks(rest))
  }
  return out
}

/** A command passed as text to something that runs it: its quotes off, judged as a line. */
let innerDepth = 0
function innerRisks(text: string): Risk[] {
  if (innerDepth > 4) return []
  const unquoted = text.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
  innerDepth += 1
  try {
    return classifyCommand(unquoted)
  } finally {
    innerDepth -= 1
  }
}

/** git's own: which subcommands, with which flags, lose work or rewrite what was shared. */
function gitRisks(rest: string): Risk[] {
  const out: Risk[] = []
  // Past git's own options (-C dir, -c key=value) to the subcommand.
  const words = rest.trim().split(/\s+/)
  let i = 0
  while (i < words.length && words[i].startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1
  const sub = (words[i] ?? '').toLowerCase()
  // Quotes off: `git push origin "+main"` forces as surely as without them.
  const args = ` ${words.slice(i + 1).join(' ').replace(/["']/g, '')} `
  const flag = (re: RegExp): boolean => re.test(args)
  switch (sub) {
    case 'clean':
      if (flag(/\s-[a-z]*f|\s--force\b/)) out.push({ class: 'irreversible', why: 'deletes untracked files' })
      break
    case 'reset':
      if (flag(/\s--hard\b/)) out.push({ class: 'irreversible', why: 'throws away uncommitted changes' })
      if (!flag(/\s--soft\b/) && /\s(HEAD[~^]|[0-9a-f]{7,}|origin\/)/.test(args)) {
        out.push({ class: 'history-rewriting', why: 'moves the branch to another commit' })
      }
      break
    case 'checkout':
      if (flag(/\s--\s|\s\.\s|\s(-f|--force)\b/)) out.push({ class: 'irreversible', why: 'throws away changes to files' })
      break
    case 'switch':
      if (flag(/\s(-f|--force|--discard-changes)\b/)) out.push({ class: 'irreversible', why: 'throws away changes to files' })
      break
    case 'restore':
      if (!flag(/\s--staged\b|\s-S\b/) || flag(/\s--worktree\b|\s-W\b/)) out.push({ class: 'irreversible', why: 'throws away changes to files' })
      break
    case 'stash':
      if (flag(/^\s*(drop|clear)\b/)) out.push({ class: 'irreversible', why: 'deletes stashed work' })
      break
    case 'branch':
      if (flag(/\s-D\b|\s--delete\s+--force\b|\s-d\s+--force\b|\s--force\s+(-d|--delete)\b/)) out.push({ class: 'irreversible', why: 'deletes a branch, merged or not' })
      break
    case 'push':
      if (flag(/\s(-f|--force|--force-with-lease)\b|\s\+\S/)) {
        out.push({ class: 'history-rewriting', why: 'replaces history others may already have' })
        out.push({ class: 'irreversible', why: 'overwrites commits on the remote' })
      }
      if (flag(/\s(--delete|-d)\b|\s:\S/)) out.push({ class: 'irreversible', why: 'deletes a branch or tag on the remote' })
      break
    case 'rebase':
      out.push({ class: 'history-rewriting', why: 'rewrites commits' })
      break
    case 'commit':
      if (flag(/\s--amend\b/)) out.push({ class: 'history-rewriting', why: 'replaces the last commit' })
      break
    case 'filter-branch':
    case 'filter-repo':
      out.push({ class: 'history-rewriting', why: 'rewrites the whole history' })
      break
    case 'reflog':
      if (flag(/^\s*(expire|delete)\b/)) out.push({ class: 'irreversible', why: 'forgets where commits were, so they can be lost' })
      break
    case 'gc':
      if (flag(/\s--prune(=now)?\b/)) out.push({ class: 'irreversible', why: 'deletes commits nothing points to' })
      break
  }
  return out
}

/** Patterns that only show across segments: something downloaded, then run. */
const WHOLE: { test: RegExp; risk: Risk }[] = [
  {
    test: /\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|downloadstring)\b[^;\n]*\|\s*(iex|invoke-expression)\b/i,
    risk: { class: 'network-executes', why: 'downloads a script and runs it' }
  },
  {
    test: /\b(iex|invoke-expression)\b[\s(&]*\(?\s*(iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget|\(?\s*new-object\s+(system\.)?net\.webclient)/i,
    risk: { class: 'network-executes', why: 'downloads a script and runs it' }
  },
  {
    test: /\b(curl|wget)\b[^;\n]*\|\s*(sudo\s+)?(ba|z|da|k)?sh\b|\b(curl|wget)\b[^;\n]*\|\s*(sudo\s+)?(python3?|node|pwsh|powershell|perl|ruby)\b/i,
    risk: { class: 'network-executes', why: 'downloads a script and runs it' }
  },
  {
    test: /\b(ba|z)?sh\s+(-c\s+["']?\$\(|<\()\s*(curl|wget)\b/i,
    risk: { class: 'network-executes', why: 'downloads a script and runs it' }
  },
  {
    test: /\[scriptblock\]::create\s*\(.*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|curl|wget)\b/i,
    risk: { class: 'network-executes', why: 'downloads a script and runs it' }
  }
]

/**
 * Every risk a command carries, one per class, the first reason for each kept.
 * In the order of RISK_TITLES, so labels always come out the same way.
 */
export function classifyCommand(full: string): Risk[] {
  /*
   * The first 32 KB: these rules run on the window's own thread for every proposal
   * and multi-line paste, and one long line naming curl over and over took seconds
   * (QA measured 2.2 s at 100 KB). A command is not that long; a paste of minified
   * text is, and what it would run starts at its top.
   */
  const command = full.length > 32_768 ? full.slice(0, 32_768) : full
  const found: Risk[] = []
  for (const segment of segmentsOf(command)) found.push(...segmentRisks(segment))
  for (const rule of WHOLE) if (rule.test.test(command)) found.push(rule.risk)
  // What runs inside a double-quoted string: `$(…)`, and bash's backticks.
  for (const quoted of command.match(/"[^"]*"/g) ?? []) {
    for (const m of quoted.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) found.push(...innerRisks(m[1] ?? m[2] ?? ''))
  }
  const order = Object.keys(RISK_TITLES) as RiskClass[]
  return order.flatMap((cls) => {
    const first = found.find((r) => r.class === cls)
    return first ? [first] : []
  })
}

/** A sentence for a question already being asked, such as a paste's; '' for none. */
export function riskSentence(risks: Risk[]): string {
  if (risks.length === 0) return ''
  return `Among them is something that ${risks.map((r) => `${r.why} (${RISK_TITLES[r.class]})`).join(', and something that ')}.`
}

/** The risks worth showing at this sensitivity. */
export function visibleRisks(risks: Risk[], sensitivity: RiskSensitivity): Risk[] {
  if (sensitivity === 'off') return []
  return sensitivity === 'irreversible' ? risks.filter((r) => r.class === 'irreversible') : risks
}

/**
 * Whether running it takes a second click: anything that cannot be undone, and in the
 * administrator's window anything labelled at all — there, every one of them reaches
 * further.
 */
export function needsSecondClick(risks: Risk[], admin: boolean): boolean {
  return admin ? risks.length > 0 : risks.some((r) => r.class === 'irreversible')
}

/** PowerShell cmdlets that honour -WhatIf, by their full names. */
const SHOULD_PROCESS = new Set([
  'remove-item', 'move-item', 'copy-item', 'rename-item', 'new-item', 'set-item', 'clear-item',
  'set-content', 'add-content', 'clear-content', 'stop-process', 'stop-service', 'start-service',
  'restart-service', 'set-service', 'remove-itemproperty', 'set-itemproperty', 'new-itemproperty',
  'clear-recyclebin', 'remove-partition', 'format-volume', 'clear-disk', 'set-executionpolicy',
  'stop-computer', 'restart-computer'
])

/** Cmdlets that only read, and so may stand before the one being previewed. */
const READERS = /^(get-[a-z]+|select-object|sort-object|where-object|measure-object|test-path|resolve-path|split-path|join-path|gci|gi|ls|dir)$/

/** A cmdlet's name as PowerShell writes it: Remove-Item, not remove-item. */
const properName = (verb: string): string => verb.replace(/(^|-)([a-z])/g, (_m, dash: string, c: string) => dash + c.toUpperCase())

/**
 * The same command with -WhatIf, when that is certain to change nothing — an
 * allowlist, not a list of what to refuse (QA found four ordinary-looking lines that
 * slipped past one). Allowed: a pipeline of PowerShell readers ending in one cmdlet
 * that honours -WhatIf, each stage starting with a bare cmdlet name — no path, no
 * extension, so no script that merely shares a cmdlet's name — and arguments made of
 * plain words, paths, quoted strings without a `|` in them, and `$env:NAME`. Nothing
 * that runs code while being read as an argument: no parentheses or brackets, no
 * variable but an environment one, no comment, no script block, no line break, no
 * redirection, no second statement.
 *
 * The cmdlet is written out by its full name, so the line cannot mean anything to cmd
 * or bash — `del x -WhatIf` in cmd deletes x — and -WhatIf goes at the very end,
 * where only that cmdlet can take it. Null for anything else: no preview rather than
 * a misleading one.
 */
export function whatIfPreview(command: string): string | null {
  const text = command.trim()
  if (!text || /[\r\n;`{}()[\]#@<>&]/.test(text)) return null
  if (/\s-(whatif|confirm|wh|wi|wha|whati|conf|confi|confir|cf)\b/i.test(text)) return null
  // A `$` only as `$env:NAME`.
  if (text.replace(/\$env:[A-Za-z_][A-Za-z0-9_]*/g, '').includes('$')) return null
  // Quotes balanced, and no `|` inside one, which would split the pipeline wrongly.
  let quote: string | null = null
  for (const c of text) {
    if (quote) {
      if (c === quote) quote = null
      else if (c === '|') return null
    } else if (c === '"' || c === "'") {
      quote = c
    }
  }
  if (quote) return null
  const parts = text.split('|').map((s) => s.trim())
  const firstWord = (part: string): string => /^\S+/.exec(part)?.[0] ?? ''
  if (!parts.every((p) => /^[A-Za-z][A-Za-z-]*$/.test(firstWord(p)))) return null
  const lastPart = parts[parts.length - 1]
  const last = verbOf(lastPart).verb
  if (!SHOULD_PROCESS.has(last)) return null
  if (!parts.slice(0, -1).every((p) => READERS.test(firstWord(p).toLowerCase()) || READERS.test(verbOf(p).verb))) return null
  // No argument may end ready to take the next word: `-Exclude:` would take -WhatIf as
  // its value, and a trailing comma would make it one more path.
  if (parts.some((p) => p.split(/\s+/).some((token) => /[:,]$/.test(token) && !/^[A-Za-z]:$/.test(token)))) return null
  // -WhatIf straight after the cmdlet's name, where it can only be the cmdlet's.
  const named = `${properName(last)} -WhatIf${lastPart.slice(firstWord(lastPart).length)}`
  return [...parts.slice(0, -1), named].join(' | ')
}
