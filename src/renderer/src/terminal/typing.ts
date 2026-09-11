import { useStore } from '../state/store'
import { existingController } from './controller'
import { argumentFor, fillBlanks, shellKindOf, type ShellKind } from '@shared/quote'

/**
 * Typing a command into a terminal on the person's behalf — one rule for all of it.
 *
 * Five buttons type a command into a shell: Claude's Run, a block's Run again, a
 * script, a history row's `git show`, and the directory picker's move. Each sent
 * its text straight to the pty whatever had the keyboard at the time. With
 * `ssh prod` open in the pane, Run on Claude's `rm -rf node_modules && npm ci` ran
 * it on the server; with python open it went into the REPL; at a password prompt it
 * was sent as the password. The debugger's launcher already knew better, and its
 * rule is lifted to here: a command is typed only at a prompt, and every refusal
 * says why and what can be done instead.
 */

export type Refusal = 'gone' | 'exited' | 'starting' | 'plain' | 'raw' | 'secret' | 'running'

export type Readiness = { ok: true } | { ok: false; reason: Refusal; program?: string }

type State = ReturnType<typeof useStore.getState>

/**
 * Whether a terminal is at its prompt, which is the one state in which text typed
 * into it is a command to its shell.
 *
 * `integration === 'ready'` says the shell reported a prompt once; it says nothing
 * about what has the keyboard now. The pane knows the rest: a command still
 * running, the alternate screen of a full-screen program, and a masked secret
 * prompt. A shell that never reports prompts at all — cmd, or one whose profile
 * displaced the integration — cannot be vouched for either way.
 */
export function readinessIn(s: State, paneId: string | null | undefined): Readiness {
  const pane = paneId ? s.terminalPane(paneId) : null
  if (!pane) return { ok: false, reason: 'gone' }
  if (pane.exited) return { ok: false, reason: 'exited' }
  const last = pane.blocks.at(-1)
  const program = last?.kind === 'command' && last.status === 'running' ? last.command : undefined
  // In this order: a password prompt and a full-screen program are recognised from
  // the output, so they are known even in a shell that reports nothing else.
  if (pane.awaitingSecret) return { ok: false, reason: 'secret', program }
  if (pane.mode === 'raw') return { ok: false, reason: 'raw', program }
  if (pane.integration === 'pending') return { ok: false, reason: 'starting' }
  if (pane.integration === 'absent') return { ok: false, reason: 'plain' }
  if (program !== undefined) return { ok: false, reason: 'running', program }
  return { ok: true }
}

export function readinessOf(paneId: string | null | undefined): Readiness {
  return readinessIn(useStore.getState(), paneId)
}

/** The same, kept current for a component: re-renders only when the answer changes. */
export function useReadiness(paneId: string | null | undefined): Readiness {
  const reason = useStore((s) => {
    const r = readinessIn(s, paneId)
    return r.ok ? null : r.reason
  })
  const program = useStore((s) => {
    const r = readinessIn(s, paneId)
    return r.ok ? undefined : r.program
  })
  return reason === null ? { ok: true } : { ok: false, reason, program }
}

/**
 * The refusals a person may override. Text sent into a running program on purpose
 * — a line for a REPL — is a real thing to want, and so is typing into a shell that
 * cannot say where its prompt is; both become a second, deliberate click. A password
 * prompt, a full-screen program, and a shell that has gone are never typed into.
 */
function overridable(reason: Refusal): boolean {
  return reason === 'running' || reason === 'plain'
}

/**
 * Type a command into a terminal, if it is at its prompt. Nothing is sent otherwise,
 * and the answer says why; `anyway` is the second click on an overridable refusal.
 */
export function typeIntoTerminal(
  paneId: string,
  text: string,
  opts: { anyway?: boolean } = {}
): Readiness {
  const ready = readinessOf(paneId)
  if (!ready.ok && !(opts.anyway && overridable(ready.reason))) return ready
  const controller = existingController(paneId)
  if (!controller) return { ok: false, reason: 'gone' }
  if (ready.ok) controller.runCommand(text)
  // Into a running program on purpose, it is that program's input — a line, as the
  // composer sends one while a program runs — not a command of the shell's. Through
  // runCommand it opened a block of its own, which no prompt would ever close.
  else controller.send(`${text.trim()}\r`)
  return { ok: true }
}

/** A command, short enough to name in a sentence. */
function named(text: string): string {
  const line = text.trim().split(/\r?\n/)[0]
  return `“${line.length > 48 ? `${line.slice(0, 47)}…` : line}”`
}

/** The program a running command is — its first word — for a button's label. */
export function programOf(command: string | undefined): string {
  const word = command?.trim().split(/\s+/)[0]
  return word ? `“${word}”` : 'it'
}

/** Why nothing was typed, as the end of a sentence. */
export function whyNot(r: { reason: Refusal; program?: string }): string {
  switch (r.reason) {
    case 'running':
      return `${r.program ? named(r.program) : 'a program'} is still running in that terminal`
    case 'raw':
      return `${r.program ? named(r.program) : 'a full-screen program'} has the whole terminal`
    case 'secret':
      return 'that terminal is waiting for a password'
    case 'plain':
      return 'that shell does not say when it is at a prompt, so Ember cannot tell what would receive it'
    case 'exited':
      return 'that terminal’s shell has exited'
    case 'starting':
      return 'that terminal’s shell has not shown its first prompt yet'
    case 'gone':
      return 'there is no terminal to send it to'
  }
}

/**
 * Type it, or say plainly that it was not typed and offer the ways forward:
 * another terminal next to this one, the deliberate second click where there is
 * one, or waiting for a shell that is still starting. Returns whether it was sent.
 */
export function sendOrExplain(paneId: string | null | undefined, text: string): boolean {
  const r: Readiness = paneId ? typeIntoTerminal(paneId, text) : { ok: false, reason: 'gone' }
  if (r.ok) return true
  const actions: { label: string; run: () => void }[] = []
  if (paneId && r.reason !== 'gone' && r.reason !== 'starting' && r.reason !== 'plain') {
    actions.push({ label: 'Run in a new terminal', run: () => runInNewTerminal(paneId, text) })
  }
  if (paneId && r.reason === 'running') {
    actions.push({
      label: `Send to ${programOf(r.program)} anyway`,
      run: () => void typeIntoTerminal(paneId, text, { anyway: true })
    })
  }
  if (paneId && r.reason === 'plain') {
    actions.push({ label: 'Send anyway', run: () => void typeIntoTerminal(paneId, text, { anyway: true }) })
  }
  if (paneId && r.reason === 'starting') {
    actions.push({ label: 'Send when it is ready', run: () => runWhenReady(paneId, text, false) })
  }
  useStore.getState().setNotice(`${named(text)} was not sent: ${whyNot(r)}.`, 'error', actions)
  return false
}

/**
 * A new terminal beside this one — the same shell, in the same directory — with
 * the command typed into it once it reaches its prompt.
 */
export function runInNewTerminal(fromPaneId: string, text: string): void {
  const s = useStore.getState()
  const tabId = s.tabIdForPane(fromPaneId)
  const created = tabId ? s.splitPane(tabId, fromPaneId, 'row') : null
  if (!created) {
    s.setNotice(`${named(text)} was not sent: there was no terminal to open another beside.`, 'error')
    return
  }
  runWhenReady(created, text, true)
}

/**
 * Type a command the moment a terminal reaches its prompt, and not otherwise.
 *
 * A terminal that was just opened is fresh: nothing has run in it yet, so even a
 * shell that never reports its prompt is known to be sitting at one once it has
 * settled. Anything else happening first — the shell exits, a program starts —
 * abandons the command and says so, and so does a prompt that never comes.
 */
function runWhenReady(paneId: string, text: string, fresh: boolean): void {
  let done = false
  let stop = (): void => {}
  let timer = 0
  const finish = (): void => {
    done = true
    stop()
    window.clearTimeout(timer)
  }
  const attempt = (): void => {
    if (done) return
    const r = readinessOf(paneId)
    if (!r.ok && r.reason === 'starting') return
    // Settled before typing: the command opening a block is itself a change of state,
    // and it would arrive back here as a program running in the way.
    finish()
    if (r.ok || (fresh && r.reason === 'plain')) {
      typeIntoTerminal(paneId, text, { anyway: true })
      return
    }
    useStore.getState().setNotice(`${named(text)} was not sent: ${whyNot(r)}.`, 'error')
  }
  stop = useStore.subscribe(attempt)
  timer = window.setTimeout(() => {
    if (done) return
    finish()
    useStore
      .getState()
      .setNotice(`${named(text)} was not sent: the terminal never reached a prompt.`, 'error')
  }, 30_000)
  attempt()
}

/** The shell a terminal speaks, for quoting what is typed into it; null when unknown. */
export function shellOf(paneId: string | null | undefined): ShellKind | null {
  const s = useStore.getState()
  const pane = paneId ? s.terminalPane(paneId) : null
  return shellKindOf(s.profiles.find((p) => p.id === pane?.profileId))
}

/** A word that means the same bare to every shell Ember knows, quoted or not. */
const BARE_EVERYWHERE = /^[A-Za-z_][A-Za-z0-9_./:=+-]*$/

/**
 * One value as one argument for the shell in that terminal, or null where it
 * cannot be said: a shell Ember does not know, with a value that would need
 * quoting, or a value the Command Prompt has no way to quote.
 */
export function argumentIn(paneId: string | null | undefined, value: string): string | null {
  const shell = shellOf(paneId)
  if (!shell) return BARE_EVERYWHERE.test(value) ? value : null
  try {
    return argumentFor(shell, value)
  } catch {
    return null
  }
}

/**
 * A saved command with its blanks filled for the shell in that terminal, or the
 * name of the blank that could not be filled there. In a shell Ember does not
 * know, only values that need no quoting anywhere go in.
 */
export function fillBlanksIn(
  paneId: string | null | undefined,
  command: string,
  values: Record<string, string>
): { command: string } | { refused: string } {
  const shell = shellOf(paneId)
  if (shell) return fillBlanks(shell, command, values)
  const odd = Object.entries(values).find(([, v]) => !BARE_EVERYWHERE.test(v))
  if (odd) return { refused: odd[0] }
  return { command: command.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, name: string) => values[name] ?? whole) }
}
