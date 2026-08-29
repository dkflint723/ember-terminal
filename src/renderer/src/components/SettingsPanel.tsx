import { useEffect, useRef, useState } from 'react'
import type {
  AiCredential,
  ClaudeAccess,
  CustomLanguageServer,
  CustomProfile,
  Settings
} from '@shared/types'
import { chordOf, COMMANDS, resolveBindings } from '../keys'
import { AI_MODELS } from '@shared/models'
import { leadFamily, monospaceFamilies, stackFor } from '../state/fonts'

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

/*
 * The dialog grew past one screen long before it grew past one topic, and a
 * single scroll made the most-touched settings the hardest to reach — fonts
 * lived below twenty-six keybinding rows. Grouped by what a person came to
 * change, with a rail that jumps; everything stays on one scroll so nothing is
 * hidden behind a tab that has to be guessed.
 */
const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'editor', label: 'Editor' },
  { id: 'claude', label: 'Claude' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'system', label: 'System' }
] as const

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

/** `-d Ubuntu` ⇄ ['-d','Ubuntu'], double quotes keeping spaces together. */
function parseArgs(text: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|(\S+)/g
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2])
  return out
}

function joinArgs(args: string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
}

export function SettingsPanel(): React.JSX.Element | null {
  /** What the last hand-run update check said, shown beside the button. */
  const [updateNote, setUpdateNote] = useState('')
  /** Whether an update is staged and installable — carried, never inferred. */
  const [updateReady, setUpdateReady] = useState(false)
  /*
   * The jump-to-section helper, reachable from an effect that is created long
   * before it is: the dialog renders nothing until its settings have loaded,
   * so the function itself does not exist when the listener is registered.
   */
  const jumpToRef = useRef<(id: string) => void>(() => {})
  /** Which command is listening for its new chord, if any. */
  const [capturing, setCapturing] = useState<string | null>(null)
  /** Which section the rail lights up — follows the scroll, and jumps on click. */
  const [section, setSection] = useState<string>('appearance')
  /** Narrows the shortcut list by label or chord; empty shows everything. */
  const [keyQuery, setKeyQuery] = useState('')
  /** The machine's monospace families, fetched when the dialog opens. */
  const [fontChoices, setFontChoices] = useState<string[]>([])
  /** Whether the model field is in hand-typed mode, for ids the list lacks. */
  const [modelCustom, setModelCustom] = useState(false)
  const open = useStore((s) => s.settingsOpen)
  const toggle = useStore((s) => s.toggleSettings)
  const profiles = useStore((s) => s.profiles)
  const themes = useStore((s) => s.themes)
  const applySettings = useStore((s) => s.applySettings)
  const setProfiles = useStore((s) => s.setProfiles)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [saved, setSaved] = useState<Settings | null>(null)
  const [themeError, setThemeError] = useState<string | null>(null)
  const [snippetError, setSnippetError] = useState<string | null>(null)
  const [credential, setCredential] = useState<AiCredential | null>(null)
  const [claude, setClaude] = useState<ClaudeAccess | null>(null)
  const [probing, setProbing] = useState(false)
  /** Null until asked; false means a saved key would sit in plain text. */
  const [encrypted, setEncrypted] = useState<boolean | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  /** Whether main is holding a key. Its value never comes over. */
  const [hasApiKey, setHasApiKey] = useState(false)

  const refreshAccess = async (): Promise<void> => {
    setProbing(true)
    // The CLI probe first, since the credential answer depends on it.
    setClaude(await window.ember.claudeAccess())
    setCredential(await window.ember.aiCredential())
    setEncrypted(await window.ember.keyEncryptionAvailable())
    setProbing(false)
  }

  // The updater talks while it works; the note follows it rather than staying
  // on whatever the check said a minute ago.
  useEffect(
    () =>
      window.ember.onUpdateStatus((status) => {
        setUpdateNote(status.text)
        if (status.stage === 'ready') setUpdateReady(true)
        else if (status.stage === 'error') setUpdateReady(false)
      }),
    []
  )

  // Opened from the update notification: land on the section it is about.
  useEffect(
    () =>
      window.ember.onOpenSettings(() => {
        useStore.getState().toggleSettings(true)
        setSection('system')
        window.setTimeout(() => jumpToRef.current('system'), 120)
      }),
    []
  )

  useEffect(() => {
    if (!open) return
    void refreshAccess()
    setModelCustom(false)
    void monospaceFamilies().then(setFontChoices)
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
    // newTab hands back the pane id, not the tab id. Looking a tab up by it found
    // nothing, the guard swallowed that, and the button opened an empty terminal and
    // did nothing else — the whole point of the feature, inert and silent.
    const paneId = s.newTab(s.settings.defaultProfileId ?? s.profiles[0]?.id ?? '')
    s.setPendingInput(paneId, 'claude auth login')
    toggle(false)
  }

  useEffect(() => {
    if (!open) return
    void window.ember.getSettings().then((s) => {
      setDraft(s)
      setSaved(s)
      setHasApiKey(s.hasApiKey)
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
  /*
   * The dialog has to take focus when it opens.
   *
   * Without this, focus stays wherever it was — which is the terminal composer —
   * so opening Settings and starting to type sent the keystrokes to the shell
   * behind the scrim, and Enter ran them as a command. Every check here drove the
   * fields by setting their values directly, which is exactly the thing that never
   * notices a focus bug.
   *
   * The dialog itself takes focus rather than the first field: landing on a text
   * input would let a stray keystroke edit a setting before the user has even
   * looked at it.
   */
  const modalRef = useRef<HTMLDivElement>(null)
  /** The scrolling column of sections, for the rail's jumps and its highlight. */
  const bodyRef = useRef<HTMLDivElement>(null)
  const ready = open && draft !== null
  useEffect(() => {
    if (!ready) return
    const frame = window.requestAnimationFrame(() => modalRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [ready])

  /** Keep Tab inside the dialog, so it cannot walk out into the app behind it. */
  const trapTab = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Tab' || !modalRef.current) return
    const focusable = Array.from(
      modalRef.current.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null)
    if (focusable.length === 0) return

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === modalRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

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
    /*
     * An untouched key field means "leave it alone", not "clear it".
     *
     * The stored key never comes back from main, so the draft's copy is null
     * whether or not one exists — sending it would wipe a saved key every time
     * anybody changed a font size.
     */
    const patch: Partial<Settings> = { ...draft }
    if (patch.anthropicApiKey == null) delete patch.anthropicApiKey
    const res = await window.ember.setSettings(patch)
    applySettings(res.settings)
    /*
     * A write that did not happen keeps the dialog open.
     *
     * The failure used to be swallowed in main and unreportable by construction, so
     * a key typed into a settings file that could not be written was accepted,
     * applied, and gone by the next launch — with the dialog closing as if it had
     * worked.
     */
    if (!res.persisted) {
      setSaveError(res.error ?? 'Settings could not be saved, and will be lost on restart.')
      return
    }
    // Custom shells changed the list main serves; the + menu and the default
    // picker should know without a relaunch.
    setProfiles(await window.ember.listProfiles())
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

  const patchCustom = (i: number, part: Partial<CustomProfile>): void =>
    field(
      'customProfiles',
      draft.customProfiles.map((c, at) => (at === i ? { ...c, ...part } : c))
    )

  const patchLang = (i: number, part: Partial<CustomLanguageServer>): void =>
    field(
      'languageServers',
      draft.languageServers.map((c, at) => (at === i ? { ...c, ...part } : c))
    )

  const jumpTo = (id: string): void => {
    bodyRef.current
      ?.querySelector<HTMLElement>(`[data-section="${id}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    setSection(id)
  }
  // Handed to the listener above, which was created before this existed.
  jumpToRef.current = jumpTo

  /**
   * The rail follows the scroll: the lit entry is the last section whose top has
   * passed under the header, with the bottom clamped so the final section can be
   * reached even when it is too short to climb that high.
   */
  const onBodyScroll = (): void => {
    const body = bodyRef.current
    if (!body) return
    const parts = Array.from(body.querySelectorAll<HTMLElement>('[data-section]'))
    let current = parts[0]?.dataset.section ?? 'appearance'
    for (const el of parts) {
      if (el.offsetTop <= body.scrollTop + 60) current = el.dataset.section ?? current
    }
    if (body.scrollTop + body.clientHeight >= body.scrollHeight - 8) {
      current = parts[parts.length - 1]?.dataset.section ?? current
    }
    setSection((was) => (was === current ? was : current))
  }

  const resolved = resolveBindings(draft.keybindings ?? {})
  const keyQ = keyQuery.trim().toLowerCase()
  const shownCommands = COMMANDS.filter((command) => {
    if (!keyQ) return true
    const chord = resolved.byId.get(command.id) ?? command.chord
    return (
      command.label.toLowerCase().includes(keyQ) || chord.toLowerCase().includes(keyQ)
    )
  })

  return (
    <div className="modal-scrim" onMouseDown={close}>
      <div
        className="modal modal--settings"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={trapTab}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Settings</h2>

        <div className="settings__layout">
          <nav className="settings__nav" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`settings__nav-item ${section === s.id ? 'settings__nav-item--on' : ''}`}
                onClick={() => jumpTo(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings__body" ref={bodyRef} onScroll={onBodyScroll}>
            <section className="settings__section" data-section="appearance">
              <h3 className="settings__section-title">Appearance</h3>

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
                <label>Font family</label>
                {(() => {
                  const current = leadFamily(draft.fontFamily)
                  const options = fontChoices.includes(current)
                    ? fontChoices
                    : [current, ...fontChoices]
                  return (
                    <select
                      className="settings__font"
                      value={current}
                      onChange={(e) => field('fontFamily', stackFor(e.target.value))}
                    >
                      {options.map((family) => (
                        <option
                          key={family}
                          value={family}
                          style={{ fontFamily: `"${family}", monospace` }}
                        >
                          {family}
                        </option>
                      ))}
                    </select>
                  )
                })()}
                <div className="field__note">
                  The monospace faces this machine has, each shown as itself. The pick
                  gets Consolas and monospace behind it as fallbacks.
                </div>
              </div>

              <div className="field">
                <label>Font size</label>
                <div className="field__unit">
                  <input
                    type="number"
                    min={8}
                    max={32}
                    value={draft.fontSize}
                    onChange={(e) => field('fontSize', Number(e.target.value) || 13)}
                  />
                  <span className="field__unit-label">px</span>
                </div>
              </div>

              <div className="field">
                <label>Interface size</label>
                <div className="field__unit">
                  <input
                    type="number"
                    min={60}
                    max={250}
                    step={10}
                    value={Math.round((draft.uiZoom || 1) * 100)}
                    onChange={(e) => {
                      const percent = Math.min(Math.max(Number(e.target.value) || 100, 60), 250)
                      field('uiZoom', percent / 100)
                      // Applied as it changes, so the number can be judged by looking.
                      window.ember.setZoom(percent / 100)
                    }}
                  />
                  <span className="field__unit-label">%</span>
                </div>
                <div className="field__note">
                  Scales the whole interface, terminal included — the editor font setting
                  only covers text inside editors. Ctrl+= and Ctrl+- do the same, and
                  Ctrl+0 returns to 100.
                </div>
              </div>
            </section>

            <section className="settings__section" data-section="terminal">
              <h3 className="settings__section-title">Terminal</h3>

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
                <label>Custom shells</label>
                {draft.customProfiles.map((shell, i) => (
                  <div key={shell.id} className="shellrow">
                    <input
                      className="shellrow__name"
                      placeholder="Name"
                      value={shell.name}
                      spellCheck={false}
                      onChange={(e) => patchCustom(i, { name: e.target.value })}
                    />
                    <input
                      className="shellrow__path"
                      placeholder="wsl.exe"
                      value={shell.path}
                      spellCheck={false}
                      onChange={(e) => patchCustom(i, { path: e.target.value })}
                    />
                    <input
                      className="shellrow__args"
                      placeholder="-d Ubuntu"
                      value={joinArgs(shell.args)}
                      spellCheck={false}
                      onChange={(e) => patchCustom(i, { args: parseArgs(e.target.value) })}
                    />
                    <select
                      className="shellrow__dialect"
                      value={shell.integration}
                      title="Which shell-integration dialect to inject, for blocks and prompts"
                      onChange={(e) =>
                        patchCustom(i, {
                          integration: e.target.value as CustomProfile['integration']
                        })
                      }
                    >
                      <option value="none">plain</option>
                      <option value="powershell">powershell</option>
                      <option value="bash">bash</option>
                    </select>
                    <button
                      className="icon-btn"
                      aria-label={`Remove ${shell.name || 'shell'}`}
                      title="Remove"
                      onClick={() =>
                        field(
                          'customProfiles',
                          draft.customProfiles.filter((_, at) => at !== i)
                        )
                      }
                    >
                      ✕
                    </button>
                    <input
                      className="shellrow__cwd"
                      placeholder="Start in — optional, e.g. D:\code (new sessions only)"
                      value={shell.cwd ?? ''}
                      spellCheck={false}
                      onChange={(e) => patchCustom(i, { cwd: e.target.value })}
                    />
                  </div>
                ))}
                <div className="composer__proposal-actions">
                  <button
                    className="btn"
                    onClick={() =>
                      field('customProfiles', [
                        ...draft.customProfiles,
                        {
                          id: `custom-${crypto.randomUUID()}`,
                          name: '',
                          path: '',
                          args: [],
                          integration: 'none' as const
                        }
                      ])
                    }
                  >
                    Add shell…
                  </button>
                </div>
                <div className="field__note">
                  Anything spawnable: a WSL distro (<code>wsl.exe -d Ubuntu</code>), a Developer
                  PowerShell, nushell, ssh somewhere. Pick the dialect the shell actually speaks
                  and it gets blocks and prompt detection; plain runs it as a bare terminal.
                </div>
              </div>

              <div className="field">
                <label>Notify after</label>
                <div className="field__unit">
                  <input
                    type="number"
                    min={0}
                    max={3600}
                    value={draft.notifyAfterSeconds}
                    onChange={(e) =>
                      field('notifyAfterSeconds', Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                  <span className="field__unit-label">s</span>
                </div>
                <div className="field__note">
                  A command running at least this long raises a desktop notification when it
                  finishes, but only while Ember is in the background — you do not need
                  telling about something you are watching. Zero turns it off.
                </div>
              </div>
            </section>

            <section className="settings__section" data-section="editor">
              <h3 className="settings__section-title">Editor</h3>

              <div className="field">
                <label>Formatting</label>
                <label className="field__check">
                  <input
                    type="checkbox"
                    checked={draft.formatOnSave}
                    onChange={(e) => field('formatOnSave', e.target.checked)}
                  />
                  <span>Format on save</span>
                </label>
                <div className="field__note">
                  Explicit saves only — auto-save never reflows a buffer mid-thought.
                  A workspace with its own prettier gets prettier, its config and all;
                  otherwise the language&rsquo;s formatter. Alt+Shift+F formats by hand
                  either way.
                </div>
              </div>

              <div className="field">
                <label>Language servers</label>
                {draft.languageServers.map((server, i) => (
                  <div key={server.id} className="langrow">
                    <input
                      className="langrow__language"
                      placeholder="rust"
                      title="The Monaco language id this server answers for"
                      value={server.languageId}
                      spellCheck={false}
                      onChange={(e) => patchLang(i, { languageId: e.target.value })}
                    />
                    <input
                      className="langrow__command"
                      placeholder="rust-analyzer"
                      value={server.command}
                      spellCheck={false}
                      onChange={(e) => patchLang(i, { command: e.target.value })}
                    />
                    <input
                      className="langrow__args"
                      placeholder="arguments"
                      value={joinArgs(server.args)}
                      spellCheck={false}
                      onChange={(e) => patchLang(i, { args: parseArgs(e.target.value) })}
                    />
                    <button
                      className="icon-btn"
                      aria-label={`Remove ${server.languageId || 'server'}`}
                      title="Remove"
                      onClick={() =>
                        field(
                          'languageServers',
                          draft.languageServers.filter((_, at) => at !== i)
                        )
                      }
                    >
                      ✕
                    </button>
                    <input
                      className="langrow__extensions"
                      placeholder="Extensions — optional, e.g. .rs (most languages need none)"
                      value={(server.extensions ?? []).join(' ')}
                      spellCheck={false}
                      onChange={(e) =>
                        patchLang(i, {
                          extensions: e.target.value.split(/\s+/).filter(Boolean)
                        })
                      }
                    />
                  </div>
                ))}
                <div className="composer__proposal-actions">
                  <button
                    className="btn"
                    onClick={() =>
                      field('languageServers', [
                        ...draft.languageServers,
                        {
                          id: `lang-${crypto.randomUUID()}`,
                          languageId: '',
                          name: '',
                          command: '',
                          args: []
                        }
                      ])
                    }
                  >
                    Add server…
                  </button>
                </div>
                <div className="field__note">
                  Anything that speaks LSP over stdio: rust-analyzer, gopls, clangd. The
                  language id must be one the editor knows — most are built in — and the
                  server starts the first time a file of that language opens.
                </div>
              </div>

              <div className="field">
                <label>Auto save after</label>
                <div className="field__unit">
                  <input
                    type="number"
                    min={0}
                    max={600}
                    value={draft.autoSaveAfterSeconds}
                    onChange={(e) =>
                      field('autoSaveAfterSeconds', Math.max(0, Number(e.target.value) || 0))
                    }
                  />
                  <span className="field__unit-label">s</span>
                </div>
                <div className="field__note">
                  An edited file is written this long after you stop typing. Files that have
                  never been saved are left alone, since saving one has to ask where it goes.
                  Zero turns it off.
                </div>
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
            </section>

            <section className="settings__section" data-section="claude">
              <h3 className="settings__section-title">Claude</h3>

              <div className="field">
                <label>Claude model</label>
                {(() => {
                  const known = AI_MODELS.some((m) => m.id === draft.aiModel)
                  const showCustom = modelCustom || !known
                  return (
                    <>
                      <select
                        className="settings__model"
                        value={showCustom ? 'custom' : draft.aiModel}
                        onChange={(e) => {
                          if (e.target.value === 'custom') {
                            setModelCustom(true)
                          } else {
                            setModelCustom(false)
                            field('aiModel', e.target.value)
                          }
                        }}
                      >
                        {AI_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label} — {m.note}
                          </option>
                        ))}
                        <option value="custom">Another model id…</option>
                      </select>
                      {showCustom && (
                        <input
                          className="settings__model-custom"
                          placeholder="claude-…"
                          value={draft.aiModel}
                          spellCheck={false}
                          onChange={(e) => field('aiModel', e.target.value)}
                        />
                      )}
                    </>
                  )
                })()}
                {/* The escape hatch stays because the field takes any id, including
                    one newer than this build knows about. */}
                <div className="field__note">
                  The ✦ chip beside the prompt switches between these — and sets how
                  hard Claude thinks — without coming here. &ldquo;Another model
                  id&rdquo; takes anything, including models newer than this build.
                </div>
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
                {/* Empty even when a key is stored: the value stays in main and never
                    comes back here, so an empty box means "leave it as it is" rather than
                    "clear it". Removing one is a separate, deliberate action. */}
                <input
                  type="password"
                  placeholder={hasApiKey ? 'A key is saved — type to replace it' : 'sk-ant-…'}
                  value={draft.anthropicApiKey ?? ''}
                  onChange={(e) => field('anthropicApiKey', e.target.value || null)}
                  spellCheck={false}
                />
                {hasApiKey && (
                  <div className="composer__proposal-actions">
                    <button
                      className="btn"
                      onClick={() => {
                        void (async () => {
                          const res = await window.ember.setSettings({ anthropicApiKey: null })
                          applySettings(res.settings)
                          setHasApiKey(false)
                        })()
                      }}
                    >
                      Remove saved key
                    </button>
                  </div>
                )}
                <div className="field__note">
                  {encrypted === false
                    ? 'Windows is not offering a credential store, so this would be saved as plain text in your settings file. Consider the ANTHROPIC_API_KEY environment variable instead.'
                    : 'Encrypted at rest with the Windows credential store.'}{' '}
                  A key takes precedence over signing in, and buys slightly better results for
                  command generation — it can hold the model to a schema, which going through
                  Claude Code cannot. Leave blank to use the ANTHROPIC_API_KEY environment
                  variable, or your Claude Code sign-in.
                </div>
              </details>
            </section>

            <section className="settings__section" data-section="keyboard">
              <h3 className="settings__section-title">Keyboard</h3>

              <div className="field">
                <label>Shortcuts</label>
                <input
                  className="settings__keyfilter"
                  placeholder="Filter shortcuts…"
                  aria-label="Filter keyboard shortcuts"
                  value={keyQuery}
                  spellCheck={false}
                  onChange={(e) => setKeyQuery(e.target.value)}
                />
                {shownCommands.map((command) => {
                  const chord = resolved.byId.get(command.id) ?? command.chord
                  const overridden = (draft.keybindings ?? {})[command.id] !== undefined
                  return (
                    <div key={command.id} className="keyrow">
                      <span className="keyrow__label">{command.label}</span>
                      <button
                        type="button"
                        className={`keyrow__chord ${capturing === command.id ? 'keyrow__chord--live' : ''}`}
                        aria-label={`Change the binding for ${command.label}`}
                        onClick={() => setCapturing(command.id)}
                        onBlur={() => setCapturing((c) => (c === command.id ? null : c))}
                        onKeyDown={(e) => {
                          if (capturing !== command.id) return
                          // The press is the answer, not a keystroke for the app.
                          e.preventDefault()
                          e.stopPropagation()
                          if (e.key === 'Escape') {
                            setCapturing(null)
                            return
                          }
                          if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
                          const next = { ...(draft.keybindings ?? {}) }
                          const pressed = chordOf(e.nativeEvent)
                          if (pressed === command.chord) delete next[command.id]
                          else next[command.id] = pressed
                          field('keybindings', next)
                          setCapturing(null)
                        }}
                      >
                        {capturing === command.id ? 'press keys…' : chord}
                      </button>
                      {overridden && (
                        <button
                          className="icon-btn"
                          title="Back to the default"
                          aria-label={`Reset ${command.label} to ${command.chord}`}
                          onClick={() => {
                            const next = { ...(draft.keybindings ?? {}) }
                            delete next[command.id]
                            field('keybindings', next)
                          }}
                        >
                          ↺
                        </button>
                      )}
                    </div>
                  )
                })}
                {shownCommands.length === 0 && (
                  <div className="field__note">Nothing matches.</div>
                )}
                {resolved.conflicts.map((c) => (
                  <div key={c.chord} className="composer__error">
                    {c.chord} is claimed twice — {c.labels.join(' and ')}. The first one wins.
                  </div>
                ))}
                <div className="field__note">
                  Click a chord and press the new keys; Esc changes nothing. These are the
                  window&rsquo;s own shortcuts — what the editor and the shell claim for
                  themselves stays theirs.
                </div>
              </div>
            </section>

            <section className="settings__section" data-section="system">
              <h3 className="settings__section-title">System</h3>

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
                <label>Updates</label>
                <label className="field__check">
                  <input
                    type="checkbox"
                    checked={draft.autoUpdate}
                    onChange={(e) => field('autoUpdate', e.target.checked)}
                  />
                  <span>Check for a new version</span>
                </label>
                <div className="field__note">
                  Off unless asked for: an update check is Ember reaching out to a server on
                  its own and then replacing itself, which is a thing to be chosen rather
                  than inherited. A new version downloads in the background and then waits:
                  nothing is replaced underneath a running shell, and nothing is installed
                  without being asked for. &ldquo;Install now&rdquo; runs the installer where
                  you can see it, and Ember reopens itself when it finishes.
                </div>
                <div className="composer__proposal-actions">
                  <button
                    className="btn"
                    disabled={updateNote === 'Checking…'}
                    onClick={() => {
                      setUpdateNote('Checking…')
                      void window.ember.checkForUpdates().then(setUpdateNote)
                    }}
                  >
                    Check now
                  </button>
                  {/* Only once something is actually staged: a quit that never
                      comes, or an installer that quietly declined to run, should
                      not leave the update sitting on disk with no way to apply it. */}
                  {updateReady && (
                    <button className="btn btn--primary" onClick={() => window.ember.installUpdateNow()}>
                      Install now
                    </button>
                  )}
                  {updateNote && <span className="field__note">{updateNote}</span>}
                </div>
              </div>

              <ExplorerMenuField />
            </section>
          </div>
        </div>

        {saveError && <div className="composer__error settings__error">{saveError}</div>}

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
