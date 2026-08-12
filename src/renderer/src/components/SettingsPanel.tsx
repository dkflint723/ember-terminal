import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { useStore } from '../state/store'

export function SettingsPanel(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const toggle = useStore((s) => s.toggleSettings)
  const profiles = useStore((s) => s.profiles)
  const applySettings = useStore((s) => s.applySettings)
  const [draft, setDraft] = useState<Settings | null>(null)

  useEffect(() => {
    if (open) void window.ember.getSettings().then(setDraft)
  }, [open])

  if (!open || !draft) return null

  const save = async (): Promise<void> => {
    // Panes pick the new font up by re-rendering off the store.
    applySettings(await window.ember.setSettings(draft))
    toggle(false)
  }

  const field = <K extends keyof Settings>(key: K, value: Settings[K]): void =>
    setDraft({ ...draft, [key]: value })

  return (
    <div className="modal-scrim" onMouseDown={() => toggle(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

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
          <button className="btn" onClick={() => toggle(false)}>
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
