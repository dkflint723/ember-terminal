import { useEffect, useRef, useState } from 'react'
import type { AiCredential, ClaudeAccess, Settings } from '@shared/types'

/**
 * How Claude access reads to the user, in one line.
 *
 * Deliberately says which credential is in effect rather than whether one exists:
 * with a key, an environment variable and a CLI login all possible at once, "it
 * works" is not enough to explain why an answer came back the way it did.
 */
function credentialLabel(credential: AiCredential | null, claude: ClaudeAccess | null): string {
  if (!credential) return 'Checking…'
  switch (credential.source) {
    case 'settings-key':
      return 'Using the API key saved here'
    case 'environment-key':
      return 'Using ANTHROPIC_API_KEY from the environment'
    case 'claude-code':
      return 'Signed in through Claude Code'
    default:
      return claude?.installed ? 'Claude Code is installed, but signed out' : 'Not set up'
  }
}

function credentialTone(credential: AiCredential | null, claude: ClaudeAccess | null): string {
  if (!credential) return 'unknown'
  if (credential.source === 'none') return claude?.installed ? 'warn' : 'off'
  return 'ok'
}

function credentialNote(credential: AiCredential | null, claude: ClaudeAccess | null): string {
  if (credential?.source === 'claude-code') {
    return `Requests go through the Claude Code CLI using the browser sign-in you already have${
      claude?.plan ? `, on your ${claude.plan} plan` : ''
    }. They count against that subscription rather than API credits, and are a little slower than a direct API call.`
  }
  if (credential?.source === 'none' && !claude?.installed) {
    return 'Ask Claude needs either the Claude Code CLI, which you sign into with a browser, or an Anthropic API key below.'
  }
  if (credential?.source === 'none') {
    return claude?.error ?? 'Sign in to Claude Code, or add an API key below.'
  }
  return 'An API key takes precedence over signing in through Claude Code.'
}

/** A quick read on the selected theme without leaving the dialog. */
const SWATCH_TOKENS = ['bg', 'fg', 'accent', 'ok', 'fail', 'info', 'bg-elevated', 'border-strong']

import { useStore } from '../state/store'
import { activateTheme, refreshThemeList } from '../state/theming'
import { ensureSnippets, forgetSnippets } from '../editor/snippets'

/**
 * The Explorer context-menu entry.
 *
 * Read from the registry rather than stored as a setting: the entry lives outside
 * this app and can be removed from outside it, so a remembered "on" would go stale
 * the moment someone tidied their shell extensions. Saved immediately on toggle,
 * not on Save, because it is a system change rather than a preference in a draft.
 */
function ExplorerMenuField(): React.JSX.Element | null {
  const [supported, setSupported] = useState<boolean | null>(null)
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const can = await window.ember.explorerSupported()
      setSupported(can)
      if (can) setOn(await window.ember.explorerStatus())
    })()
  }, [])

  if (supported === null || supported === false) return null

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true)
    setError(null)
    const res = next
      ? await window.ember.explorerRegister()
      : await window.ember.explorerUnregister()
    setBusy(false)
    if (!res.ok) {
      setError(res.error ?? 'Could not change the context menu.')
      return
    }
    // Re-read rather than trusting the write, so the checkbox reflects the
    // registry and not what was asked for.
    setOn(await window.ember.explorerStatus())
  }

  return (
    <div className="field">
      <label>Windows Explorer</label>
      <label className="field__check">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => void toggle(e.target.checked)}
        />
        <span>Show &ldquo;Open in Ember&rdquo; when right-clicking a folder</span>
      </label>
      <div className="field__note">
        {error ?? 'Applies immediately, for this user only, and can be turned off here again.'}
      </div>
    </div>
  )
}

export function SettingsPanel(): React.JSX.Element | null {
  const open = useStore((s) => s.settingsOpen)
  const toggle = useStore((s) => s.toggleSettings)
  const profiles = useStore((s) => s.profiles)
  const themes = useStore((s) => s.themes)
  const applySettings = useStore((s) => s.applySettings)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [themeError, setThemeError] = useState<string | null>(null)
  const [snippetError, setSnippetError] = useState<string | null>(null)
  const [credential, setCredential] = useState<AiCredential | null>(null)
  const [claude, setClaude] = useState<ClaudeAccess | null>(null)
  const [probing, setProbing] = useState(false)

  const refreshAccess = async (): Promise<void> => {
    setProbing(true)
    // The CLI probe first, since the credential answer depends on it.
    setClaude(await window.ember.claudeAccess())
    setCredential(await window.ember.aiCredential())
    setProbing(false)
  }

  useEffect(() => {
    if (!open) return
    void refreshAccess()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /**
   * Sign in by putting the command in a terminal, ready to run.
   *
   * Not run automatically: `claude auth login` opens a browser and takes over the
   * terminal while it waits, and starting that behind a settings dialog without
   * being asked would be a surprise. The user presses Enter.
   */
  const signIn = (): void => {
    const s = useStore.getState()
    const tabId = s.newTab(s.settings.defaultProfileId ?? s.profiles[0]?.id ?? '')
    const tab = useStore.getState().tabs.find((t) => t.id === tabId)
    if (tab) s.setPendingInput(tab.activePaneId, 'claude auth login')
    toggle(false)
  }

  useEffect(() => {
    if (!open) return
    void window.ember.getSettings().then((s) => {
      setDraft(s)
      setSaved(s)
    })
    void refreshThemeList()
  }, [open])

  /*
   * Escape closes the dialog, the same way it dismisses everything else here.
   *
   * On the capture phase and holding the event: the dialog is the thing on top, so
   * it should answer first, and letting Escape carry on afterwards would reach the
   * app's own handler and dismiss something behind the scrim as well.
   *
   * Held in a ref because the handler is registered before `close` is in scope —
   * the dialog renders nothing until its settings have loaded.
   */
  const closeRef = useRef<() => void>(() => toggle(false))
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  if (!open || !draft) return null

  const close = (): void => {
    // Themes preview live, so cancelling has to put the old one back.
    if (saved && saved.themeId !== draft.themeId) void activateTheme(saved.themeId)
    toggle(false)
  }
  closeRef.current = close

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

  const importSnippets = async (): Promise<void> => {
    setSnippetError(null)
    const res = await window.ember.importSnippets()
    // A cancelled picker reports failure with no error to show.
    if (!res.ok) {
      if (res.error) setSnippetError(res.error)
      return
    }
    /*
     * The providers already registered hold the old set, so they are dropped and
     * rebuilt now rather than the next time a document is opened — otherwise the
     * file the user is looking at keeps offering the snippets they just replaced,
     * which reads as the import having failed.
     */
    forgetSnippets()
    const open = new Set(
      Object.values(useStore.getState().panes).flatMap((p) =>
        p.kind === 'editor' ? p.documents.map((d) => d.language) : []
      )
    )
    for (const language of open) void ensureSnippets(language)
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
          <label>Snippets</label>
          <div className="field__note">
            Snippets in the VS Code format, from a folder or a <code>.vsix</code>. A file
            named for its language applies to that language; a <code>.code-snippets</code>{' '}
            file says so per entry. They appear in the completion list with everything the
            language server offers.
          </div>
          <div className="composer__proposal-actions">
            <button className="btn" onClick={() => void importSnippets()}>
              Import snippets…
            </button>
            <button className="btn" onClick={() => window.ember.openSnippetsFolder()}>
              Open snippets folder
            </button>
          </div>
          {snippetError && <div className="composer__error">{snippetError}</div>}
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

        {/* Claude access, shown as what is actually in effect rather than as a field
            to fill in. Signing in through the browser is the common case; the key is
            for people who would rather bring their own. */}
        <div className="field">
          <label>Claude access</label>
          <div className={`access access--${credentialTone(credential, claude)}`}>
            <span className="access__state">{credentialLabel(credential, claude)}</span>
            {credential?.source === 'claude-code' && credential.detail && (
              <span className="access__detail">{credential.detail}</span>
            )}
          </div>
          <div className="field__note">{credentialNote(credential, claude)}</div>
          <div className="composer__proposal-actions">
            {claude?.installed && !claude.signedIn && (
              <button className="btn btn--primary" onClick={() => signIn()}>
                Sign in with your browser
              </button>
            )}
            <button className="btn" onClick={() => void refreshAccess()} disabled={probing}>
              {probing ? 'Checking…' : 'Re-check'}
            </button>
          </div>
        </div>

        <details className="field">
          <summary>Use an API key instead</summary>
          <input
            type="password"
            placeholder="sk-ant-…"
            value={draft.anthropicApiKey ?? ''}
            onChange={(e) => field('anthropicApiKey', e.target.value || null)}
            spellCheck={false}
          />
          <div className="field__note">
            Encrypted at rest with the Windows credential store. A key takes precedence
            over signing in, and buys slightly better results for command generation —
            it can hold the model to a schema, which going through Claude Code cannot.
            Leave blank to use the ANTHROPIC_API_KEY environment variable, or your Claude
            Code sign-in.
          </div>
        </details>

        <div className="field">
          <label>On launch</label>
          <label className="field__check">
            <input
              type="checkbox"
              checked={draft.restoreSession}
              onChange={(e) => field('restoreSession', e.target.checked)}
            />
            <span>Reopen the last window&rsquo;s tabs, splits and files</span>
          </label>
          <div className="field__note">
            Layout and open files, including anything unsaved. Command output is not
            restored — a finished command from last week would only look live.
          </div>
        </div>

        <div className="field">
          <label>Notify after</label>
          <input
            type="number"
            min={0}
            max={3600}
            value={draft.notifyAfterSeconds}
            onChange={(e) => field('notifyAfterSeconds', Math.max(0, Number(e.target.value) || 0))}
          />
          <div className="field__note">
            Seconds. A command running at least this long raises a desktop notification
            when it finishes, but only while Ember is in the background — you do not need
            telling about something you are watching. Zero turns it off.
          </div>
        </div>

        <div className="field">
          <label>Auto save after</label>
          <input
            type="number"
            min={0}
            max={600}
            value={draft.autoSaveAfterSeconds}
            onChange={(e) =>
              field('autoSaveAfterSeconds', Math.max(0, Number(e.target.value) || 0))
            }
          />
          <div className="field__note">
            Seconds. An edited file is written this long after you stop typing. Files that
            have never been saved are left alone, since saving one has to ask where it
            goes. Zero turns it off.
          </div>
        </div>

        <ExplorerMenuField />

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
