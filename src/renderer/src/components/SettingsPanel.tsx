import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'

/** A quick read on the selected theme without leaving the dialog. */
const SWATCH_TOKENS = ['bg', 'fg', 'accent', 'ok', 'fail', 'info', 'bg-elevated', 'border-strong']

import { useStore } from '../state/store'
import { activateTheme, refreshThemeList } from '../state/theming'

export function SettingsPanel(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const toggle = useStore((s) => s.toggleSettings)
  const profiles = useStore((s) => s.profiles)
  const themes = useStore((s) => s.themes)
  const applySettings = useStore((s) => s.applySettings)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [themeError, setThemeError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void window.ember.getSettings().then((s) => {
      setDraft(s)
      setSaved(s)
    })
    void refreshThemeList()
  }, [open])

  if (!open || !draft) return null

  const close = (): void => {
    // Themes preview live, so cancelling has to put the old one back.
    if (saved && saved.themeId !== draft.themeId) void activateTheme(saved.themeId)
    toggle(false)
  }

  const save = async (): Promise<void> => {
    // Panes pick the new font up by re-rendering off the store.
    applySettings(await window.ember.setSettings(draft))
    toggle(false)
  }

  const chooseTheme = (themeId: string): void => {
    setDraft({ ...draft, themeId })
    void activateTheme(themeId)
  }

  const importTheme = async (): Promise<void> => {
    setThemeError(null)
    const res = await window.ember.importTheme()
    // A cancelled file picker reports failure with no error to show.
    if (!res.ok) {
      if (res.error) setThemeError(res.error)
      return
    }
    await refreshThemeList()
    if (res.id) chooseTheme(res.id)
  }

  const field = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    setDraft({ ...draft, [key]: value })

  return (
    <div className="modal-scrim" onMouseDown={close}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        <div className="field">
          <label>Theme</label>
          <select value={draft.themeId} onChange={(e) => chooseTheme(e.target.value)}>
            {themes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} · {t.type}
                {t.builtin ? '' : ' · imported'}
              </option>
            ))}
          </select>
          <div className="theme-swatches">
            {SWATCH_TOKENS.map((token) => (
              <span
                key={token}
                className="theme-swatch"
                title={token}
                style={{ background: `var(--${token})` }}
              />
            ))}
          </div>
          <div className="field__note">
            Any VS Code color theme works. Themes change as you pick them; Cancel puts
            the previous one back.
          </div>
          <div className="composer__proposal-actions">
            <button className="btn" onClick={() => void importTheme()}>
              Import .json…
            </button>
            <button className="btn" onClick={() => window.ember.openThemeFolder()}>
              Open themes folder
            </button>
          </div>
          {themeError && <div className="composer__error">{themeError}</div>}
        </div>

        <div className="field">
          <label>Default shell</label>
          <select
            value={draft.defaultProfileId ?? profiles[0]?.id ?? ''}
            onChange={(e) => field('defaultProfileId', e.target.value)}
          >
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Font family</label>
          <input
            value={draft.fontFamily}
            onChange={(e) => field('fontFamily', e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label>Font size</label>
          <input
            type="number"
            min={8}
            max={32}
            value={draft.fontSize}
            onChange={(e) => field('fontSize', Number(e.target.value) || 13)}
          />
        </div>

        <div className="field">
          <label>Claude model</label>
          <input
            value={draft.aiModel}
            onChange={(e) => field('aiModel', e.target.value)}
            spellCheck={false}
          />
        </div>

        <div className="field">
          <label>Anthropic API key</label>
          <input
            type="password"
            placeholder="sk-ant-…"
            value={draft.anthropicApiKey ?? ''}
            onChange={(e) => field('anthropicApiKey', e.target.value || null)}
            spellCheck={false}
          />
          <div className="field__note">
            Encrypted at rest with the Windows credential store. Leave blank to use the
            ANTHROPIC_API_KEY environment variable instead.
          </div>
        </div>

        <div className="modal__actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
