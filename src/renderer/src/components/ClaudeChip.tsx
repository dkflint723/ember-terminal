import { useEffect, useRef, useState } from 'react'
import { AI_EFFORTS, AI_MODELS, modelLabel, supportsEffort, type AiEffort } from '@shared/models'
import { useStore } from '../state/store'

/**
 * Which Claude answers, and how hard it thinks, changed from where it is used.
 *
 * Both lived in the settings dialog — the model as a text box you had to know the
 * id to fill in, and the effort not at all, since it was a constant in main. That
 * is the wrong place for either: the choice is made *while* asking something, and
 * it changes with the question. A slow, careful model is right for "why is this
 * failing" and wrong for the next `git status`.
 *
 * So it sits in the composer's own strip, next to the directory and the branch,
 * and says what is in effect without being opened.
 */
export function ClaudeChip(): React.JSX.Element {
  const settings = useStore((s) => s.settings)
  const applySettings = useStore((s) => s.applySettings)
  const pickerRequest = useStore((s) => s.aiPickerRequest)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLButtonElement>(null)

  const model = settings.aiModel
  const effort = settings.aiEffort
  const effortAllowed = supportsEffort(model)

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
  const choose = async (patch: { aiModel?: string; aiEffort?: AiEffort }): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.ember.setSettings(patch)
      applySettings(res.settings)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="claude" ref={wrap}>
      <button
        className={`chip chip--claude ${open ? 'chip--claude-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Claude model and effort (${modelLabel(model)}${effortAllowed ? `, ${effort} effort` : ''})`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 16 16" className="chip__icon" aria-hidden="true">
          {/* A four-pointed star: the mark this app already uses for the AI prompt. */}
          <path d="M8 1.6 9.5 6.5 14.4 8 9.5 9.5 8 14.4 6.5 9.5 1.6 8 6.5 6.5Z" />
        </svg>
        {modelLabel(model)}
        {effortAllowed && <span className="chip__sub">{effort}</span>}
      </button>

      {open && (
        <div className="claude__menu" role="menu" aria-label="Claude model and effort">
          <div className="claude__heading">Model</div>
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
