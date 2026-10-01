import { loadMarker, loaderLine, looksLikePrompt, payloadLines, REMOTE_TOKEN } from '../shared/remote-integration.js'
import { isTerminalReply } from '../shared/ssh-remote.js'

/**
 * The ssh side of shell integration (audit R31, phase 2): when to type Ember's bash
 * script into a remote shell, and only ever for a host the person said yes to.
 *
 * Main does this, not the window: the yes is enforced where the shell is written
 * to, and the window only ever learns that a host wants an answer. What to type is
 * in shared/remote-integration.ts; this is the timing, and it is narrow on purpose.
 *
 * One moment per connection: the first time the session sits quiet at what looks
 * like a prompt, with nothing typed into it since it started. Then, for a host said
 * yes to, the visible line goes; the script follows only once that line has said,
 * with this session's nonce, that echo is off and it is reading. A host with no
 * answer yet is asked at that moment, and a yes given while the pane is still at
 * that untouched first prompt acts on it; any other yes is kept for the next
 * connection. After the person has typed anything at all, or the moment has passed,
 * nothing is typed into that connection — QA found the alternatives typing into a
 * Python REPL after a late yes, into another host reached with `ssh db` from a pane
 * that was never answered, and onto the end of a half-typed `rm -rf build #`, which
 * its Enter would have run.
 */
export type RemoteEvent = { paneId: string; host: string; state: 'ask' | 'loaded' | 'unsupported' | 'slow' }

/** What the watcher writes to, reads and tells: main's pty, settings and window. */
export interface RemoteDeps {
  write: (paneId: string, data: string) => void
  choice: (host: string) => 'on' | 'off' | undefined
  setChoice: (host: string, choice: 'on' | 'off') => void
  notify: (event: RemoteEvent) => void
  script: () => string | null
}

interface Watch {
  host: string
  nonce: string
  /** The end of the screen, raw, for the prompt test. */
  tail: string
  /**
   * watching: not at a prompt yet. asked: at the first prompt, waiting for an answer.
   * loading: the visible line went, waiting for it to say it is listening.
   */
  phase: 'watching' | 'asked' | 'loading'
  quiet: NodeJS.Timeout | null
  giveUp: NodeJS.Timeout | null
  /** Output since the visible line went: for its marker, and for a prompt instead of one. */
  seen: string
  /** Anything on the screen since the person was asked: the first prompt is no longer what it was. */
  changed: boolean
}

/** Quiet this long at a prompt before anything is typed. */
const SETTLE_MS = 500
/** How long the visible line has to say it is listening. */
const LOAD_WAIT_MS = 8_000
/** A login that has not reached its first prompt, or an answer not given, by now is left alone. */
const WATCH_MS = 180_000

/**
 * A host's answer, if it has one of its own. Read as an own property: a host called
 * `constructor` or `__proto__` otherwise found the object's inherited ones, and
 * anything but `'off'` was taken for a yes (QA).
 */
export function choiceFor(map: Record<string, unknown> | undefined, host: string): 'on' | 'off' | undefined {
  if (!map || !Object.hasOwn(map, host)) return undefined
  const value = map[host]
  return value === 'on' || value === 'off' ? value : undefined
}

export class RemoteIntegration {
  private watches = new Map<string, Watch>()
  /**
   * Panes asked about their host this connection, and which host: an answer is kept
   * for the host even once the watch is over — typing ends it — but only from the
   * pane that was asked, and only once.
   */
  private asked = new Map<string, string>()

  // A field, not a constructor parameter property, so the unit tables can load this
  // file with node's own type stripping (test-remote-shell.mjs).
  private deps: RemoteDeps

  constructor(deps: RemoteDeps) {
    this.deps = deps
  }

  /** A remote session has started: watch for its first prompt, unless the host was told no. */
  started(paneId: string, host: string, nonce: string): void {
    this.closed(paneId)
    if (this.deps.choice(host) === 'off') return
    const watch: Watch = { host, nonce, tail: '', phase: 'watching', quiet: null, giveUp: null, seen: '', changed: false }
    // Every phase but loading ends here: an answer left for three minutes is kept for
    // the next connection, not acted on whenever the pane happens to look like a prompt.
    watch.giveUp = setTimeout(() => {
      if (this.watches.get(paneId) === watch && watch.phase !== 'loading') this.ended(paneId)
    }, WATCH_MS)
    this.watches.set(paneId, watch)
  }

  /** Output from a session; cheap when it is not being watched. */
  data(paneId: string, data: string): void {
    const watch = this.watches.get(paneId)
    if (!watch) return
    if (watch.phase === 'loading') {
      watch.seen = (watch.seen + data).slice(-2048)
      if (watch.seen.includes(loadMarker(watch.nonce))) this.sendScript(paneId, watch)
      return
    }
    watch.tail = (watch.tail + data).slice(-2048)
    if (watch.phase === 'asked') {
      watch.changed = true
      return
    }
    if (watch.quiet) clearTimeout(watch.quiet)
    watch.quiet = setTimeout(() => this.settled(paneId), SETTLE_MS)
  }

  /**
   * Something the window sent to the session. Anything a person sent — not the
   * terminal answering a query or reporting focus — ends this connection's chance:
   * typing after them could finish their line for them.
   */
  input(paneId: string, data: string): void {
    const watch = this.watches.get(paneId)
    if (!watch || watch.phase === 'loading' || data.length === 0 || isTerminalReply(data)) return
    this.ended(paneId)
  }

  /** The session is gone: its watch, and any question it was asked. */
  closed(paneId: string): void {
    this.ended(paneId)
    this.asked.delete(paneId)
  }

  ended(paneId: string): void {
    const watch = this.watches.get(paneId)
    if (!watch) return
    if (watch.quiet) clearTimeout(watch.quiet)
    if (watch.giveUp) clearTimeout(watch.giveUp)
    this.watches.delete(paneId)
  }

  /**
   * The person's answer, from the pane that asked. Kept for the host either way. A
   * yes acts now only if this pane is still at the untouched first prompt it was
   * asked at — nothing typed (that ends the watch) and nothing new on the screen.
   */
  answer(paneId: string, yes: boolean): void {
    const host = this.asked.get(paneId)
    if (host === undefined) return
    this.asked.delete(paneId)
    this.deps.setChoice(host, yes ? 'on' : 'off')
    const watch = this.watches.get(paneId)
    if (!watch) return
    if (yes && watch.phase === 'asked' && !watch.changed && looksLikePrompt(watch.tail)) this.load(paneId, watch)
    else this.ended(paneId)
  }

  /** The first quiet at a prompt: the one moment this connection gets. */
  private settled(paneId: string): void {
    const watch = this.watches.get(paneId)
    if (!watch || watch.phase !== 'watching') return
    watch.quiet = null
    if (!looksLikePrompt(watch.tail)) return
    const choice = this.deps.choice(watch.host)
    if (choice === 'on') {
      this.load(paneId, watch)
      return
    }
    if (choice === 'off') {
      this.ended(paneId)
      return
    }
    watch.phase = 'asked'
    this.asked.set(paneId, watch.host)
    this.deps.notify({ paneId, host: watch.host, state: 'ask' })
  }

  private load(paneId: string, watch: Watch): void {
    watch.phase = 'loading'
    watch.seen = ''
    // Ctrl-U first, as a backstop: the line should be empty — nothing has been typed —
    // and if it is not, it is cleared rather than finished.
    this.deps.write(paneId, `\x15${loaderLine(watch.nonce)}`)
    if (watch.giveUp) clearTimeout(watch.giveUp)
    watch.giveUp = setTimeout(() => {
      if (this.watches.get(paneId) !== watch || watch.phase !== 'loading') return
      this.ended(paneId)
      /*
       * Back at a prompt with no word from the line: the shell ran it and it did
       * nothing, so it is not bash, and the host is not tried again. Silence is not
       * that — a slow link, a busy host — and the yes stands for the next connection.
       */
      // Only once the shell has echoed the line itself: typed-ahead that something
      // else ate (a banner's "press Enter") proves nothing about the shell (QA).
      const echoed = watch.seen.indexOf(REMOTE_TOKEN)
      const after = echoed < 0 ? '' : watch.seen.slice(echoed).replace(/^[^\n]*\n/, '')
      if (echoed >= 0 && looksLikePrompt(after)) {
        this.deps.setChoice(watch.host, 'off')
        this.deps.notify({ paneId, host: watch.host, state: 'unsupported' })
      } else {
        this.deps.notify({ paneId, host: watch.host, state: 'slow' })
      }
    }, LOAD_WAIT_MS)
  }

  private sendScript(paneId: string, watch: Watch): void {
    const script = this.deps.script()
    this.ended(paneId)
    if (!script) return
    // A line at a time, each ended as Enter ends one: the visible line reads them.
    this.deps.write(paneId, payloadLines(script, watch.nonce).map((l) => `${l}\r`).join(''))
    this.deps.notify({ paneId, host: watch.host, state: 'loaded' })
  }
}
