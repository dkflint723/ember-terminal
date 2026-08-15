import { useEffect, useRef, useState } from 'react'
import type { AiCredential, AiLimit, AiUsage } from '@shared/types'
import {
  AI_EFFORTS,
  AI_MODELS,
  AI_MODES,
  modeChoice,
  modelLabel,
  supportsEffort,
  type AiEffort,
  type AiMode
} from '@shared/models'
import { useStore } from '../state/store'

/** "4 minutes ago", for a reading whose whole meaning depends on how old it is. */
function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  return `${hours} hour${hours === 1 ? '' : 's'} ago`
}

/**
 * 61000 → 61k, because the exact digit is never the thing being read — but only
 * past the point where the full number stops being readable. A limit of 1000 said
 * as "1.0k" is harder to read than saying 1000.
 */
function compact(n: number): string {
  if (n < 10_000) return String(n)
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}m`
}

/** When the window refills, said in minutes rather than as an ISO timestamp. */
function until(reset: string | null): string | null {
  if (!reset) return null
  const at = Date.parse(reset)
  if (Number.isNaN(at)) return null
  const seconds = Math.round((at - Date.now()) / 1000)
  if (seconds <= 0) return 'now'
  if (seconds < 90) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

function Meter({ label, limit }: { label: string; limit: AiLimit }): React.JSX.Element | null {
  if (limit.limit === null && limit.remaining === null) return null
  const share =
    limit.limit && limit.remaining !== null ? Math.max(0, Math.min(1, limit.remaining / limit.limit)) : null
  const refill = until(limit.reset)
  return (
    <div className="usage__row">
      <span className="usage__label">{label}</span>
      {/* The bar is the reading; the numbers are for anyone who wants them. A bar
          with no limit to divide by would be a bar that means nothing, so it is
          left out rather than drawn full. */}
      {share !== null && (
        <span className="usage__bar" aria-hidden="true">
          <span className="usage__fill" style={{ width: `${Math.round(share * 100)}%` }} />
        </span>
      )}
      <span className="usage__count">
        {limit.remaining !== null ? compact(limit.remaining) : '—'}
        {limit.limit !== null && <span className="usage__of"> / {compact(limit.limit)}</span>}
      </span>
      {refill && <span className="usage__reset">{refill}</span>}
    </div>
  )
}

/**
 * What is left, or why there is nothing to show.
 *
 * The API reports rate limits only in the headers of real responses, so this is
 * always a reading from the last one — said as "as of", because a number with no
 * age on it invites being trusted longer than it deserves. A Claude Code
 * subscription reports nothing at all outside a session, and saying so is better
 * than an empty meter that reads as a quota of zero.
 */
function Usage({
  usage,
  credential,
  error
}: {
  usage: AiUsage | null
  credential: AiCredential | null
  error: string | null
}): React.JSX.Element {
  if (error) return <div className="usage__note usage__note--bad">{error}</div>

  if (credential?.source === 'claude-code' && !usage) {
    return (
      <div className="usage__note">
        Signed in through Claude Code. A subscription’s limits are not reported outside a
        session — run <code>claude</code> in the terminal and use <code>/usage</code>.
      </div>
    )
  }

  if (credential?.source === 'none') {
    return <div className="usage__note">No Claude credential yet. Settings has both ways in.</div>
  }

  if (!usage) {
    return (
      <div className="usage__note">
        Nothing asked yet. The API reports what is left alongside an answer, so this fills in
        after the first question — or press check now.
      </div>
    )
  }

  return (
    <div className="usage">
      <Meter label="requests" limit={usage.requests} />
      <Meter label="input" limit={usage.inputTokens} />
      <Meter label="output" limit={usage.outputTokens} />
      {usage.retryAfter !== null && (
        <div className="usage__note usage__note--bad">
          Rate limited. The API asked for {usage.retryAfter}s before the next request.
        </div>
      )}
      <div className="usage__note">As of {ago(usage.at)}.</div>
    </div>
  )
}

/**
 * Which Claude answers, how hard it thinks, and what is left of the limits.
 *
 * The first two lived in the settings dialog — the model as a text box you had to
 * know the id to fill in, and the effort not at all, since it was a constant in
 * main. That is the wrong place for either: the choice is made *while* asking
 * something, and it changes with the question. A slow, careful model is right for
 * "why is this failing" and wrong for the next `git status`.
 *
 * It sits in the status bar, with the rest of the standing state, and says what is
 * in effect without being opened.
 */
export function ClaudeStatus(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const applySettings = useStore((s) => s.applySettings)
  const pickerRequest = useStore((s) => s.aiPickerRequest)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [usage, setUsage] = useState<AiUsage | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [credential, setCredential] = useState<AiCredential | null>(null)
  const [checking, setChecking] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)

  const model = settings.aiModel
  const effort = settings.aiEffort
  const effortAllowed = supportsEffort(model)
  const mode = settings.aiMode
  const modeInfo = modeChoice(mode)

  // The palette's way in, on the same counter pattern the Ask Claude request uses:
  // a number rather than a boolean, so asking twice registers as twice.
  useEffect(() => {
    if (pickerRequest > 0) setOpen(true)
  }, [pickerRequest])

  // Focus lands inside when it opens, so the whole thing is reachable from the
  // keyboard rather than being a menu only a mouse can use.
  useEffect(() => {
    if (open) first.current?.focus()
  }, [open])

  /*
   * The limits are whatever the last answer's headers said, so opening the menu
   * reads them rather than subscribing to anything. Nothing is asked of the API
   * here: a menu that spent quota every time it was opened to report quota would
   * be its own kind of joke.
   */
  useEffect(() => {
    if (!open) return
    setUsageError(null)
    void window.ember.aiUsage().then(setUsage)
    void window.ember.aiCredential().then(setCredential)
  }, [open])

  const check = async (): Promise<void> => {
    setChecking(true)
    setUsageError(null)
    try {
      const res = await window.ember.aiCheckUsage()
      if (res.ok) setUsage(res.usage)
      else setUsageError(res.error)
    } finally {
      setChecking(false)
    }
  }

  useEffect(() => {
    if (!open) return
    const dismiss = (e: Event): void => {
      if (e instanceof KeyboardEvent && e.key !== 'Escape') return
      if (e instanceof MouseEvent && wrap.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('keydown', dismiss, true)
    window.addEventListener('mousedown', dismiss, true)
    return () => {
      window.removeEventListener('keydown', dismiss, true)
      window.removeEventListener('mousedown', dismiss, true)
    }
  }, [open])

  /*
   * Written through to disk immediately rather than gathered into a draft.
   *
   * This is a switch, not a form: the next question should use what was just
   * picked, and a Save button between the two would make the quick change slower
   * than the settings dialog it replaces.
   */
  const choose = async (patch: {
    aiModel?: string
    aiEffort?: AiEffort
    aiMode?: AiMode
  }): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.ember.setSettings(patch)
      applySettings(res.settings)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="claude claude--status" ref={wrap}>
      {/* Carries --info rather than --accent: the accent means focus and one
          primary action now, and a standing readout is neither. */}
      <button
        className={`statusbar__item statusbar__claude ${open ? 'statusbar__claude--open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Claude: ${modelLabel(model)}${effortAllowed ? `, ${effort} effort` : ''}, ${modeInfo.label.toLowerCase()} mode — ${modeInfo.note} Change mode, model, effort, or see limits`}
        title={`Claude mode, model, effort and limits — ${modeInfo.note}`}
        onClick={() => setOpen((o) => !o)}
      >
        ✦ {modelLabel(model)}
        {effortAllowed && <span className="statusbar__sub">· {effort}</span>}
        {/* Always stated, including the careful one. What the agent is allowed to do
            on its own is not the kind of fact that should only appear once it has
            become surprising — and in the one mode that can run something
            irreversible unattended, it is coloured like the risk it is. */}
        <span className={`statusbar__sub ${modeInfo.risky ? 'statusbar__sub--risky' : ''}`}>
          · {modeInfo.label.toLowerCase()}
        </span>
      </button>

      {open && (
        <div className="claude__menu" role="menu" aria-label="Claude model and effort">
          {/*
            First, because it is the one thing here that is read rather than
            chosen — someone opening this to see what is left should not have to
            scroll past two lists of things they did not come for.
          */}
          <div className="claude__heading">
            What is left
            <button
              className="claude__check"
              disabled={checking}
              onClick={() => void check()}
              title="Ask the API what is left, with the smallest request that carries an answer"
            >
              {checking ? 'checking…' : 'check now'}
            </button>
          </div>
          <Usage usage={usage} credential={credential} error={usageError} />

          {/*
            Above the model and the effort because it is the only thing in this
            menu that changes what the app *does* rather than how well it answers —
            and the only one worth finding in a hurry.
          */}
          <div className="claude__heading claude__heading--rule">Mode</div>
          {AI_MODES.map((m) => (
            <button
              key={m.mode}
              className={`claude__item ${m.mode === mode ? 'claude__item--on' : ''} ${
                m.risky ? 'claude__item--risky' : ''
              }`}
              role="menuitemradio"
              aria-checked={m.mode === mode}
              disabled={busy}
              onClick={() => void choose({ aiMode: m.mode })}
            >
              <span className="claude__name">{m.label}</span>
              <span className="claude__note">{m.note}</span>
            </button>
          ))}

          <div className="claude__heading claude__heading--rule">Model</div>
          {AI_MODELS.map((m, i) => (
            <button
              key={m.id}
              ref={i === 0 ? first : undefined}
              className={`claude__item ${m.id === model ? 'claude__item--on' : ''}`}
              role="menuitemradio"
              aria-checked={m.id === model}
              disabled={busy}
              onClick={() => void choose({ aiModel: m.id })}
            >
              <span className="claude__name">{m.label}</span>
              <span className="claude__note">{m.note}</span>
            </button>
          ))}

          <div className="claude__heading">
            Effort
            {!effortAllowed && <span className="claude__note"> — not taken by this model</span>}
          </div>
          {AI_EFFORTS.map((e) => (
            <button
              key={e.level}
              className={`claude__item ${e.level === effort ? 'claude__item--on' : ''}`}
              role="menuitemradio"
              aria-checked={e.level === effort}
              disabled={busy || !effortAllowed}
              onClick={() => void choose({ aiEffort: e.level })}
            >
              <span className="claude__name">{e.level}</span>
              <span className="claude__note">{e.note}</span>
            </button>
          ))}

          {/* A model typed into settings that is not on the list still runs; this is
              where it becomes visible, since the chip can only show its id. */}
          {!AI_MODELS.some((m) => m.id === model) && (
            <div className="claude__heading claude__heading--foot">
              Using {model}, set in Settings.
            </div>
          )}

        </div>
      )}
    </div>
  )
}
