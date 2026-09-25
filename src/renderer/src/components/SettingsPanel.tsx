import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  AiCredential,
  ClaudeAccess,
  CustomLanguageServer,
  CustomProfile,
  GhostModel,
  Settings
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { NOT_PORTABLE } from '@shared/settings-check'
import { chordOf, COMMANDS, resolveBindings } from '../keys'
import { AI_MODELS, modelChoice } from '@shared/models'
import { leadFamily, monospaceFamilies, stackFor } from '../state/fonts'

/**
 * How Claude access reads to the user, in one line.
 *
 * Deliberately says which credential is in effect rather than whether one exists:
 * with a key, an environment variable and a CLI login all possible at once, "it
 * works" is not enough to explain why an answer came back the way it did.
 */
/**
 * Every field that holds a secret, so the rule about them is written once.
 *
 * Main redacts these on the way out, which means the dialog's copy of one is null
 * whether or not a key is stored — so anything sending the draft back has to drop
 * them first. Listing them here is the difference between adding a third secret
 * and remembering three separate places to teach about it.
 */
const SECRETS = ['anthropicApiKey', 'ghostApiKey'] as const

/**
 * The option that hands the field back. Not a model name anybody could have, and
 * not the empty string, which already means "the endpoint's own default".
 */
const TYPE_A_NAME = '\u0000type'

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
  { id: 'suggestions', label: 'Suggestions' },
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
    <div className="field" role="group" aria-labelledby="settings-explorer">
      <span className="field__label" id="settings-explorer">Windows Explorer</span>
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

/** A pressed key as it should be read back: Tab, Space, Enter, ← rather than ArrowLeft. */
function labelOfKey(key: string): string {
  if (key === ' ') return 'Space'
  if (key.startsWith('Arrow')) return key.slice(5)
  return key
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
  /** What the configured local server says it holds, and whether we are asking. */
  const [localModels, setLocalModels] = useState<GhostModel[]>([])
  const [findingModels, setFindingModels] = useState(false)
  /** Set when somebody asked for the field back, so the list does not take it again. */
  const [typedModel, setTypedModel] = useState(false)
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
  /** Whether a suggestion-provider key is stored. Its value never comes over. */
  const [hasGhostKey, setHasGhostKey] = useState(false)
  /** What the last press of Test found, if it has been pressed. */
  const [ghostTest, setGhostTest] = useState<{ good: boolean; text: string } | null>(null)
  const [ghostTesting, setGhostTesting] = useState(false)
  /** Asking whether to throw away edits, after Escape or a click outside. */
  const [askDiscard, setAskDiscard] = useState(false)
  const askDiscardRef = useRef(false)
  askDiscardRef.current = askDiscard
  /** The second press each of these needs, since neither can be taken back. */
  const [confirmRemoveKey, setConfirmRemoveKey] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  /** Narrows every field in the dialog by what it says; empty shows them all. */
  const [query, setQuery] = useState('')
  /** What the last import, export or reset did, said under the buttons that did it. */
  const [portNote, setPortNote] = useState<{ good: boolean; text: string } | null>(null)

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
        // A download that has started supersedes whatever was staged before it,
        // and installing the older file would cancel the one now arriving.
        if (status.stage === 'ready') setUpdateReady(true)
        else setUpdateReady(false)
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

  /**
   * What the configured server holds.
   *
   * Asked when settings open and whenever the address changes, because that is
   * exactly when the answer is different — and asked again on request, since a
   * server started after this dialog opened has models the dialog has not heard of.
   */
  const loadLocalModels = useCallback(async (baseUrl: string): Promise<void> => {
    setFindingModels(true)
    try {
      // The address on screen, not the one on disk: this dialog edits a draft and
      // writes nothing until Save, so asking about the stored address answered
      // every question about the server the user was in the middle of leaving.
      setLocalModels(await window.ember.ghostModels(baseUrl))
    } catch {
      setLocalModels([])
    } finally {
      setFindingModels(false)
    }
  }, [])

  /*
   * After the address stops moving, not on every keystroke of it.
   *
   * Typing a URL is twenty-odd renders, and without this each one sent a request
   * to whatever the half-typed address happened to name — including, briefly, an
   * address belonging to a provider the user was switching away from.
   */
  useEffect(() => {
    if (!open || draft?.ghostProvider !== 'local') return
    const address = draft.ghostBaseUrl
    const timer = window.setTimeout(() => void loadLocalModels(address), 400)
    return () => window.clearTimeout(timer)
  }, [open, draft?.ghostProvider, draft?.ghostBaseUrl, loadLocalModels])

  useEffect(() => {
    if (!open) return
    /*
     * A fresh dialog asks again and offers the picker again. Both of these are
     * about the window rather than about the settings, so without this one press
     * of "Type a name…" — even one that was escaped out of without saving — left
     * the field a bare text box for as long as the app was running, with four
     * models installed and discovery working perfectly.
     */
    setTypedModel(false)
    setLocalModels([])
    setAskDiscard(false)
    setConfirmRemoveKey(false)
    setConfirmReset(false)
    setQuery('')
    setPortNote(null)
    void window.ember.getSettings().then((s) => {
      setDraft(s)
      setSaved(s)
      setHasApiKey(s.hasApiKey)
      setHasGhostKey(s.hasGhostKey)
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

  const [refused, setRefused] = useState<{ id: string; key: string } | null>(null)
  const closeRef = useRef<() => void>(() => toggle(false))
  /*
   * Whether a chord is being captured, where the window listener can see it.
   *
   * That listener runs in the capture phase, so it answered Escape before the
   * chord button ever saw the key — and Escape there closes the dialog and throws
   * the draft away. The note under the list says "Esc changes nothing", and for
   * anyone who pressed it to back out of a capture it changed everything: every
   * other edit in Settings went with it.
   */
  const capturingRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      if (capturingRef.current) {
        setCapturing(null)
        capturingRef.current = null
        return
      }
      // Escape answers the question it raised: keep editing.
      if (askDiscardRef.current) {
        setAskDiscard(false)
        return
      }
      closeRef.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  /*
   * Search across every setting, not only the shortcuts.
   *
   * By what each field says — its label, its choices, its explanation — so a
   * search for "PATH" finds the shells and "Ctrl" finds the chords, without a
   * keyword list to keep in step with the dialog. Written onto the rendered fields
   * after each render rather than threaded through forty JSX blocks: nothing in
   * React owns their display, and a field that is hidden is still mounted, so its
   * draft value is untouched.
   */
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!open || !body) return
    const q = query.trim().toLowerCase()
    let shown = 0
    for (const section of Array.from(body.querySelectorAll<HTMLElement>('[data-section]'))) {
      const title = section.querySelector('.settings__section-title')?.textContent?.toLowerCase() ?? ''
      let inSection = 0
      for (const field of Array.from(section.querySelectorAll<HTMLElement>(':scope > .field'))) {
        const hit = !q || title.includes(q) || (field.textContent ?? '').toLowerCase().includes(q)
        field.style.display = hit ? '' : 'none'
        if (hit) inSection += 1
      }
      section.style.display = inSection > 0 ? '' : 'none'
      shown += inSection
    }
    body.dataset.empty = shown === 0 ? 'yes' : 'no'
  })

  if (!open || !draft) return null

  /** The keys the draft has changed, compared the way save compares them. */
  const changed = (Object.keys(draft) as (keyof Settings)[]).filter(
    (key) => !saved || !Object.is(draft[key], saved[key])
  )

  /** Show what a set of values looks like, for the three that apply as they change. */
  const preview = (from: Settings, to: Settings): void => {
    if (from.themeId !== to.themeId) void activateTheme(to.themeId)
    if (from.uiZoom !== to.uiZoom) window.ember.setZoom(to.uiZoom || 1)
    if (from.blockDensity !== to.blockDensity) {
      document.documentElement.dataset.density = to.blockDensity ?? 'normal'
    }
  }

  /*
   * Cancel puts back everything that was previewed, not only the theme.
   *
   * Zoom and density apply as they change, so they can be judged by looking — and
   * Cancel reverted the theme alone, leaving the window at 150% after "cancelling"
   * a change to 150%. All three go back to what is saved.
   */
  const discard = (): void => {
    if (saved) preview(draft, saved)
    setAskDiscard(false)
    toggle(false)
  }

  /*
   * Escape and a click outside ask first when there is something to lose.
   *
   * Either one used to throw the draft away at once, and a click that lands a few
   * pixels outside the dialog is the easiest mistake in the app to make. Cancel is
   * a decision and does not ask; these two are often not.
   */
  const close = (): void => {
    if (askDiscard) return
    if (changed.length > 0) setAskDiscard(true)
    else discard()
  }
  closeRef.current = close

  const save = async (): Promise<void> => {
    // Panes pick the new font up by re-rendering off the store.
    /*
     * An untouched key field means "leave it alone", not "clear it".
     *
     * No stored key ever comes back from main, so the draft's copy is null
     * whether or not one exists — sending it would wipe a saved key every time
     * anybody changed a font size. Every secret, not the first one: the
     * suggestion provider's key was added later and this line was not, so a save
     * of any kind quietly emptied it and suggestions stopped for a reason the
     * dialog reported as the endpoint refusing the key.
     */
    /*
     * What changed in this dialog, not everything it is showing.
     *
     * Saving sent the whole snapshot taken when the dialog opened, so anything
     * main wrote in the meantime was overwritten by the stale copy on screen — the
     * recent-folders list is written every time a tree root is opened, and a
     * dialog left open across that lost it. Unedited values keep the references
     * they were loaded with, so comparing per key is enough to tell.
     */
    const patch: Partial<Settings> = {}
    for (const key of Object.keys(draft) as (keyof Settings)[]) {
      if (!saved || !Object.is(draft[key], saved[key])) {
        patch[key] = draft[key] as never
      }
    }
    for (const secret of SECRETS) if (patch[secret] == null) delete patch[secret]
    const res = await window.ember.setSettings(patch)
    applySettings(res.settings)
    // What main had to change to accept it — a size brought into range, a row it
    // could not use — said rather than left to be noticed later.
    if (res.notes && res.notes.length > 0) {
      useStore.getState().setNotice(`Saved, with changes: ${res.notes.join('; ')}.`, 'error')
    }
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

  /** Settings from outside the dialog, put in the draft to be looked at and saved. */
  const takeIn = (values: Partial<Settings>): void => {
    const next = { ...draft, ...values }
    preview(draft, next)
    setDraft(next)
  }

  const importFile = async (): Promise<void> => {
    setPortNote(null)
    const res = await window.ember.importSettings()
    if (!res.ok || !res.values) {
      if (res.error) setPortNote({ good: false, text: res.error })
      return
    }
    takeIn(res.values)
    const count = Object.keys(res.values).length
    const adjusted = res.notes && res.notes.length > 0 ? ` Adjusted: ${res.notes.join('; ')}.` : ''
    setPortNote({
      good: true,
      text: `${count} settings read into this dialog — nothing is kept until you press Save.${adjusted}`
    })
  }

  const exportFile = async (): Promise<void> => {
    setPortNote(null)
    const res = await window.ember.exportSettings()
    if (res.ok && res.path) {
      setPortNote({
        good: true,
        text: `Saved settings written to ${res.path}${changed.length > 0 ? ' — without the edits in this dialog, which are not saved yet' : ''}.`
      })
    } else if (res.error) {
      setPortNote({ good: false, text: res.error })
    }
  }

  /*
   * Every preference back to its default, into the draft.
   *
   * Not what describes this machine — the keys, the window, the trusted folders,
   * what has been learned — which is the same line an export draws, for the same
   * reason: those are not preferences. And into the draft rather than straight to
   * disk, so it can be looked at and cancelled like any other edit.
   */
  const resetAll = (): void => {
    const kept: Partial<Settings> = {}
    for (const key of NOT_PORTABLE) (kept as Record<string, unknown>)[key] = draft[key]
    takeIn({ ...DEFAULT_SETTINGS, ...kept })
    setConfirmReset(false)
    setPortNote({ good: true, text: 'Every preference is back to its default in this dialog — nothing is kept until you press Save.' })
  }

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
            <input
              className="settings__search"
              type="search"
              placeholder="Search settings…"
              aria-label="Search settings"
              value={query}
              spellCheck={false}
              onChange={(e) => setQuery(e.target.value)}
            />
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
            {query.trim() && (
              <div className="settings__nomatch field__note">
                No setting mentions &ldquo;{query.trim()}&rdquo;.
              </div>
            )}
            <section className="settings__section" data-section="appearance">
              <h3 className="settings__section-title">Appearance</h3>

              <div className="field">
                <label htmlFor="settings-theme">Theme</label>
                <select id="settings-theme" value={draft.themeId} onChange={(e) => chooseTheme(e.target.value)}>
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
                <label htmlFor="settings-font">Font family</label>
                {(() => {
                  const current = leadFamily(draft.fontFamily)
                  const options = fontChoices.includes(current)
                    ? fontChoices
                    : [current, ...fontChoices]
                  return (
                    <select
                      id="settings-font"
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
                <label htmlFor="settings-font-size">Font size</label>
                <div className="field__unit">
                  <input
                    id="settings-font-size"
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
                <label htmlFor="settings-zoom">Interface size</label>
                <div className="field__unit">
                  <input
                    id="settings-zoom"
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

              {/* Applied as it changes, like the zoom above it: how much room a
                  block should take is a thing to judge by looking, not by reading. */}
              <div className="field">
                <label htmlFor="settings-density">Block density</label>
                <select
                  id="settings-density"
                  className="settings__density"
                  value={draft.blockDensity ?? 'normal'}
                  onChange={(e) => {
                    const next = e.target.value as Settings['blockDensity']
                    field('blockDensity', next)
                    document.documentElement.dataset.density = next
                  }}
                >
                  <option value="compact">Compact</option>
                  <option value="normal">Normal</option>
                  <option value="comfortable">Comfortable</option>
                </select>
                <div className="field__note">
                  How much air a command block gets in the terminal. Blocks stay flat and
                  separated by a rule at every setting; this is the spacing inside them.
                  Compact fits about half again as many commands on a screen as Comfortable.
                </div>
              </div>

              <div className="field" role="group" aria-labelledby="settings-sr">
                <span className="field__label" id="settings-sr">Screen reader</span>
                <label className="field__check">
                  <input
                    type="checkbox"
                    checked={draft.screenReaderMode}
                    onChange={(e) => field('screenReaderMode', e.target.checked)}
                  />
                  <span>Optimize terminals and editors for a screen reader</span>
                </label>
                <div className="field__note">
                  Terminals keep their rows where NVDA or Narrator can read them, and the
                  editor reads the line under the caret. It slows drawing a little while
                  output is streaming, so it is off unless you turn it on. Finished
                  commands and Claude&rsquo;s answers are announced either way.
                </div>
              </div>
            </section>

            <section className="settings__section" data-section="terminal">
              <h3 className="settings__section-title">Terminal</h3>

              <div className="field">
                <label htmlFor="settings-shell">Default shell</label>
                <select
                  id="settings-shell"
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

              <div className="field" role="group" aria-labelledby="settings-saved">
                <span className="field__label" id="settings-saved">Saved commands</span>
                {draft.savedCommands.map((saved, i) => (
                  <div key={saved.id} className="savedrow">
                    <input
                      className="savedrow__name"
                      aria-label={`Saved command ${i + 1}: name`}
                      placeholder="Name"
                      value={saved.name}
                      spellCheck={false}
                      onChange={(e) =>
                        field(
                          'savedCommands',
                          draft.savedCommands.map((c, at) =>
                            at === i ? { ...c, name: e.target.value } : c
                          )
                        )
                      }
                    />
                    <input
                      className="savedrow__command"
                      aria-label={`Saved command ${i + 1}: command line`}
                      placeholder="docker compose up {{service}}"
                      value={saved.command}
                      spellCheck={false}
                      onChange={(e) =>
                        field(
                          'savedCommands',
                          draft.savedCommands.map((c, at) =>
                            at === i ? { ...c, command: e.target.value } : c
                          )
                        )
                      }
                    />
                    <button
                      className="icon-btn"
                      aria-label={`Remove ${saved.name || 'command'}`}
                      title="Remove"
                      onClick={() =>
                        field(
                          'savedCommands',
                          draft.savedCommands.filter((_, at) => at !== i)
                        )
                      }
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <div className="composer__proposal-actions">
                  <button
                    className="btn"
                    onClick={() =>
                      field('savedCommands', [
                        ...draft.savedCommands,
                        { id: `saved-${crypto.randomUUID()}`, name: '', command: '' }
                      ])
                    }
                  >
                    Add command…
                  </button>
                </div>
                <div className="field__note">
                  Listed in the Scripts view beside whatever the open project declares,
                  and one press from running. Anything in double braces —{' '}
                  <code>deploy {'{{env}}'}</code> — is asked for first, so one saved
                  command covers every environment rather than one each.
                </div>
              </div>

              <div className="field" role="group" aria-labelledby="settings-shells">
                <span className="field__label" id="settings-shells">Custom shells</span>
                {draft.customProfiles.map((shell, i) => (
                  <div key={shell.id} className="shellrow">
                    <input
                      className="shellrow__name"
                      aria-label={`Custom shell ${i + 1}: name`}
                      placeholder="Name"
                      value={shell.name}
                      spellCheck={false}
                      onChange={(e) => patchCustom(i, { name: e.target.value })}
                    />
                    <input
                      className="shellrow__path"
                      aria-label={`Custom shell ${i + 1}: program`}
                      placeholder="wsl.exe"
                      value={shell.path}
                      spellCheck={false}
                      onChange={(e) => patchCustom(i, { path: e.target.value })}
                    />
                    <input
                      className="shellrow__args"
                      aria-label={`Custom shell ${i + 1}: arguments`}
                      placeholder="-d Ubuntu"
                      value={joinArgs(shell.args)}
                      spellCheck={false}
                      onChange={(e) => patchCustom(i, { args: parseArgs(e.target.value) })}
                    />
                    <select
                      className="shellrow__dialect"
                      aria-label={`Custom shell ${i + 1}: integration`}
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
                      aria-label={`Custom shell ${i + 1}: start in`}
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
                {/* Said where the rows are, because these rows start programs and
                    nothing about a name, a path and some arguments says so. */}
                <div className="field__note field__note--warn">
                  Ember runs this program with your permissions whenever a session opens
                  with this shell.
                </div>
              </div>

              <div className="field">
                <label htmlFor="settings-notify">Notify after</label>
                <div className="field__unit">
                  <input
                    id="settings-notify"
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

              <div className="field" role="group" aria-labelledby="settings-format">
                <span className="field__label" id="settings-format">Formatting</span>
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

              <div className="field" role="group" aria-labelledby="settings-lsp">
                <span className="field__label" id="settings-lsp">Language servers</span>
                {draft.languageServers.map((server, i) => (
                  <div key={server.id} className="langrow">
                    <input
                      className="langrow__language"
                      aria-label={`Language server ${i + 1}: language`}
                      placeholder="rust"
                      title="The Monaco language id this server answers for"
                      value={server.languageId}
                      spellCheck={false}
                      onChange={(e) => patchLang(i, { languageId: e.target.value })}
                    />
                    <input
                      className="langrow__command"
                      aria-label={`Language server ${i + 1}: program`}
                      placeholder="rust-analyzer"
                      value={server.command}
                      spellCheck={false}
                      onChange={(e) => patchLang(i, { command: e.target.value })}
                    />
                    <input
                      className="langrow__args"
                      aria-label={`Language server ${i + 1}: arguments`}
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
                      aria-label={`Language server ${i + 1}: file extensions`}
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
                <div className="field__note field__note--warn">
                  Ember runs this program with your permissions whenever a matching file
                  opens.
                </div>
              </div>

              <div className="field">
                <label htmlFor="settings-autosave">Auto save after</label>
                <div className="field__unit">
                  <input
                    id="settings-autosave"
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

              <div className="field" role="group" aria-labelledby="settings-snippets">
                <span className="field__label" id="settings-snippets">Snippets</span>
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

            <section className="settings__section" data-section="suggestions">
              <h3 className="settings__section-title">Suggestions</h3>

              <div className="field" role="group" aria-labelledby="settings-ghost">
                <span className="field__label" id="settings-ghost">Inline suggestions</span>
                <label className="field__check">
                  <input
                    type="checkbox"
                    checked={draft.ghostEnabled}
                    onChange={(e) => field('ghostEnabled', e.target.checked)}
                  />
                  <span>Suggest the next few lines ahead of the cursor</span>
                </label>
                <div className="field__note">
                  Off unless you turn it on, because every way of answering costs
                  something: a paid endpoint is billed per pause in your typing, a
                  subscription is drawn down the same way, and a local model runs your
                  GPU while you type. They appear in the editor and on the command
                  line. Tab takes one in the editor; on the command line it is Right
                  or End, because Tab there belongs to shell completion.
                </div>
              </div>

              {draft.ghostEnabled && (
                <>
                  <div className="field">
                    <label htmlFor="settings-ghost-provider">Answered by</label>
                    <select
                      id="settings-ghost-provider"
                      className="settings__ghost-provider"
                      value={draft.ghostProvider}
                      onChange={(e) =>
                        field('ghostProvider', e.target.value as Settings['ghostProvider'])
                      }
                    >
                      <option value="local">A model on this machine</option>
                      <option value="openai">An OpenAI-compatible endpoint</option>
                      <option value="claude">Claude</option>
                    </select>
                    <div className="field__note">
                      {draft.ghostProvider === 'local'
                        ? 'Anything speaking the OpenAI API on this machine — Ollama, llama.cpp, LM Studio. A model trained to fill in the middle is asked in that form, which is both quicker and more accurate than asking in prose. Nothing leaves the machine and nothing is billed.'
                        : draft.ghostProvider === 'openai'
                          ? 'Any endpoint speaking the OpenAI API — OpenAI itself, or anyone else who implements it. Needs a key, kept encrypted here and never sent to this window.'
                          : 'Through the Claude credential this app already has, so it needs no second key. It is a chat model rather than one trained to complete code, so it is slower here than a local model would be.'}
                    </div>
                  </div>

                  {draft.ghostProvider !== 'claude' && (
                    <div className="field">
                      <label htmlFor="settings-ghost-address">Address</label>
                      <input
                        id="settings-ghost-address"
                        className="settings__ghost-url"
                        value={draft.ghostBaseUrl}
                        spellCheck={false}
                        placeholder="http://localhost:11434/v1"
                        onChange={(e) => field('ghostBaseUrl', e.target.value)}
                      />
                      <div className="field__note">
                        Ollama serves this on port 11434; llama.cpp&rsquo;s own server uses
                        8080.
                      </div>
                    </div>
                  )}

                  <div className="field">
                    <label htmlFor="settings-ghost-model">Model</label>
                    {/*
                      Chosen, where the server will say what it has.
                      A model name is exact and unforgiving — a missing tag, a colon
                      where a slash belongs — and getting it wrong produces "model
                      not found" for something the user can plainly see installed.
                      The list is whatever the address actually holds, so it is
                      right by construction rather than by being kept up to date.

                      The field is still a field, though. A server that lists
                      nothing may answer perfectly well, a name can be newer than
                      the list, and the endpoint's own default is a valid choice —
                      so "Type a name" is always the last option rather than a
                      fallback for when discovery breaks.
                    */}
                    {draft.ghostProvider === 'local' && localModels.length > 0 && !typedModel ? (
                      <div className="settings__modelrow">
                        <select
                          id="settings-ghost-model"
                          className="settings__ghost-model"
                          value={draft.ghostModel}
                          onChange={(e) => {
                            if (e.target.value === TYPE_A_NAME) {
                              setTypedModel(true)
                              return
                            }
                            field('ghostModel', e.target.value)
                          }}
                        >
                          <option value="">The endpoint&rsquo;s own default</option>
                          {/* A name already saved that the server no longer lists
                              stays selectable, so opening settings cannot silently
                              change which model is in use. */}
                          {!localModels.some((m) => m.name === draft.ghostModel) &&
                            draft.ghostModel && (
                              <option value={draft.ghostModel}>
                                {draft.ghostModel} (not installed)
                              </option>
                            )}
                          {/*
                            Marked where the server says a model cannot fill in the
                            middle, which is the whole of what a suggestion is. Those
                            models answer nothing and raise nothing, so choosing one
                            looks exactly like the feature being broken — and the
                            names give no clue, because the agent-shaped coder models
                            dropped the ability and kept the word "coder".

                            Marked rather than hidden: it is still the user's server
                            and their choice, and a list that quietly omits something
                            they can plainly see installed is the same unexplained
                            silence one layer further back.
                          */}
                          {localModels.map((m) => (
                            <option key={m.name} value={m.name}>
                              {m.name}
                              {m.fim === false ? ' — cannot suggest' : ''}
                            </option>
                          ))}
                          <option value={TYPE_A_NAME}>Type a name…</option>
                        </select>
                        <button
                          type="button"
                          className="btn btn--quiet"
                          onClick={() => void loadLocalModels(draft.ghostBaseUrl)}
                          disabled={findingModels}
                        >
                          {findingModels ? 'Looking…' : 'Refresh'}
                        </button>
                      </div>
                    ) : (
                      <div className="settings__modelrow">
                        <input
                          className="settings__ghost-model"
                          id="settings-ghost-model"
                          value={draft.ghostModel}
                          spellCheck={false}
                          placeholder={
                            draft.ghostProvider === 'claude'
                              ? 'claude-haiku-4-5-20251001'
                              : 'qwen2.5-coder:1.5b'
                          }
                          onChange={(e) => {
                            // Someone typing a name is someone who wants the field.
                            // Without this, a slow server's answer arriving mid-word
                            // replaced the box they were typing in with a dropdown
                            // and dropped the rest of the name on the floor.
                            setTypedModel(true)
                            field('ghostModel', e.target.value)
                          }}
                        />
                        {draft.ghostProvider === 'local' && (
                          <button
                            type="button"
                            className="btn btn--quiet"
                            onClick={() => {
                              setTypedModel(false)
                              void loadLocalModels(draft.ghostBaseUrl)
                            }}
                            disabled={findingModels}
                          >
                            {findingModels ? 'Looking…' : 'Installed…'}
                          </button>
                        )}
                      </div>
                    )}
                    <div className="field__note">
                      As the endpoint names it; left empty, the endpoint&rsquo;s own default
                      answers. Pick one trained to fill in the middle rather than to chat.
                      Measured on this codebase by taking 150 real lines out and putting them
                      back: <code>qwen3-coder:30b</code> restored 49% of them exactly,{' '}
                      <code>qwen2.5-coder:14b</code> 45%, <code>:7b</code> 41%,{' '}
                      <code>:1.5b</code> 31%.
                    </div>
                    <div className="field__note">
                      Bigger usually means slower, and the 30B is the exception worth knowing
                      about: only about three billion of its parameters run per token, so it
                      answered in 166 ms against the 14B&rsquo;s 275 — more accurate and
                      faster at once. It wants roughly 21 GB of video memory, which is the
                      catch. Below that the 7B is the sensible one, and on a machine doing
                      something else the 1.5B stays quick when the others do not.
                    </div>
                  </div>

                  {draft.ghostProvider === 'openai' && (
                    <div className="field">
                      <label htmlFor="settings-ghost-key">Key</label>
                      <input
                        id="settings-ghost-key"
                        className="settings__ghost-key"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder={hasGhostKey ? 'A key is saved — type to replace it' : 'sk-…'}
                        value={draft.ghostApiKey ?? ''}
                        onChange={(e) => field('ghostApiKey', e.target.value)}
                      />
                      <div className="field__note">
                        Encrypted at rest, and never handed back to this window — the same
                        treatment the Anthropic key gets.
                      </div>
                    </div>
                  )}

                  {/*
                      Suggestions fail quietly by design — nothing appears, which is
                      also what happens when the model has nothing to say — so there
                      is no way to tell a wrong address from a quiet moment by
                      watching. This is how you tell.
                    */}
                  <div className="field" role="group" aria-labelledby="settings-ghost-check">
                    <span className="field__label" id="settings-ghost-check">Check it works</span>
                    <div className="composer__proposal-actions">
                      <button
                        className="btn"
                        type="button"
                        disabled={ghostTesting}
                        onClick={() => {
                          setGhostTesting(true)
                          setGhostTest(null)
                          void (async () => {
                            // Saved first: the test asks main, which reads the
                            // stored settings rather than what is on screen.
                            const probe: Partial<Settings> = {
                              ghostEnabled: draft.ghostEnabled,
                              ghostProvider: draft.ghostProvider,
                              ghostBaseUrl: draft.ghostBaseUrl,
                              ghostModel: draft.ghostModel,
                              ghostApiKey: draft.ghostApiKey
                            }
                            // Same rule as saving: an untouched field is not an
                            // instruction to clear the key. Sending it deleted the
                            // stored key and then reported the keyless probe it had
                            // just caused as the endpoint refusing the key.
                            if (probe.ghostApiKey == null) delete probe.ghostApiKey
                            await window.ember.setSettings(probe)
                            const res = await window.ember.ghostTest()
                            setGhostTest(
                              res.ok
                                ? {
                                    good: true,
                                    text: `Answered in ${res.ms} ms${res.shape ? ` through ${res.shape}` : ''} — ${res.sample}`
                                  }
                                : { good: false, text: res.error }
                            )
                            setGhostTesting(false)
                          })()
                        }}
                      >
                        {ghostTesting ? 'Asking…' : 'Save and test'}
                      </button>
                    </div>
                    {ghostTest && (
                      <div
                        className={`field__note ${ghostTest.good ? '' : 'field__note--bad'}`}
                      >
                        {ghostTest.text}
                      </div>
                    )}
                  </div>

                  <div className="field">
                    <label htmlFor="settings-ghost-wait">Wait before asking</label>
                    <div className="field__unit">
                      <input
                        id="settings-ghost-wait"
                        type="number"
                        min={0}
                        max={2000}
                        step={50}
                        value={draft.ghostDebounceMs}
                        onChange={(e) =>
                          field('ghostDebounceMs', Math.min(Math.max(Number(e.target.value) || 0, 0), 2000))
                        }
                      />
                      <span className="field__unit-label">ms</span>
                    </div>
                    <div className="field__note">
                      How long the cursor rests before anything is asked. A model on this
                      machine can be asked almost at once; a paid endpoint should wait until
                      you have actually stopped, because each pause is billed.
                    </div>
                  </div>
                </>
              )}
            </section>

            <section className="settings__section" data-section="claude">
              <h3 className="settings__section-title">Claude</h3>

              <div className="field">
                <label htmlFor="settings-claude-model">Claude model</label>
                {(() => {
                  const known = AI_MODELS.some((m) => m.id === draft.aiModel)
                  const showCustom = modelCustom || !known
                  return (
                    <>
                      <select
                        id="settings-claude-model"
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
                        {/* Names only. The notes used to ride along inside each
                            option and there is no width at which that reads: a
                            select clips its own text, so every model was
                            introduced by a sentence cut off mid-word. They say
                            more below, where prose can wrap. */}
                        {AI_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                        <option value="custom">Another model id…</option>
                      </select>
                      {showCustom && (
                        <input
                          className="settings__model-custom"
                          aria-label="Claude model name"
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
                {modelChoice(draft.aiModel) && (
                  <div className="field__note field__note--lead">
                    {modelChoice(draft.aiModel)?.note}
                  </div>
                )}
                <div className="field__note">
                  The ✦ chip beside the prompt switches between these — and sets how
                  hard Claude thinks — without coming here. &ldquo;Another model
                  id&rdquo; takes anything, including models newer than this build.
                </div>
              </div>

              {/* Claude access, shown as what is actually in effect rather than as a field
                  to fill in. Signing in through the browser is the common case; the key is
                  for people who would rather bring their own. */}
              <div className="field" role="group" aria-labelledby="settings-claude-access">
                <span className="field__label" id="settings-claude-access">Claude access</span>
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
                  aria-label="Anthropic API key"
                  placeholder={hasApiKey ? 'A key is saved — type to replace it' : 'sk-ant-…'}
                  value={draft.anthropicApiKey ?? ''}
                  onChange={(e) => field('anthropicApiKey', e.target.value || null)}
                  spellCheck={false}
                />
                {/* Two presses: this one acts at once rather than at Save, and a
                    removed key is gone — there is no copy of it to put back. */}
                {hasApiKey && (
                  <div className="composer__proposal-actions">
                    {confirmRemoveKey ? (
                      <>
                        <span className="field__note">Remove the saved key now? It cannot be recovered.</span>
                        <button
                          className="btn"
                          data-confirm="remove-key"
                          onClick={() => {
                            void (async () => {
                              const res = await window.ember.setSettings({ anthropicApiKey: null })
                              applySettings(res.settings)
                              setHasApiKey(false)
                              setConfirmRemoveKey(false)
                            })()
                          }}
                        >
                          Remove it
                        </button>
                        <button className="btn" onClick={() => setConfirmRemoveKey(false)}>
                          Keep it
                        </button>
                      </>
                    ) : (
                      <button className="btn" onClick={() => setConfirmRemoveKey(true)}>
                        Remove saved key…
                      </button>
                    )}
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

              <div className="field" role="group" aria-labelledby="settings-keys">
                <span className="field__label" id="settings-keys">Shortcuts</span>
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
                        aria-label={`${command.label}: ${capturing === command.id ? 'press the new keys' : chord}. Press to change`}
                        onClick={() => {
                          setCapturing(command.id)
                          capturingRef.current = command.id
                          setRefused(null)
                        }}
                        onBlur={() => {
                          setCapturing((c) => (c === command.id ? null : c))
                          if (capturingRef.current === command.id) capturingRef.current = null
                        }}
                        onKeyDown={(e) => {
                          if (capturing !== command.id) return
                          // The press is the answer, not a keystroke for the app.
                          e.preventDefault()
                          e.stopPropagation()
                          if (e.key === 'Escape') {
                            setCapturing(null)
                            capturingRef.current = null
                            setRefused(null)
                            return
                          }
                          if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
                          /*
                           * A binding has to need Ctrl or Alt, unless it is a
                           * function key.
                           *
                           * Anything else is a key the window already needs for
                           * something: Tab moves between controls, Enter presses
                           * them, Space scrolls, the arrows move a caret. Binding
                           * one took it away everywhere, because the app-wide
                           * handler calls preventDefault — a keyboard user who
                           * pressed Enter on a chord and then Tab to move on
                           * bound Tab to Terminal↔IDE and lost Tab for good at
                           * the next Save. Shift alone does not count: Shift+Tab
                           * is still Tab.
                           */
                          const functionKey = /^F([1-9]|1[0-2])$/.test(e.key)
                          if (!e.ctrlKey && !e.altKey && !functionKey) {
                            setRefused({ id: command.id, key: e.key })
                            return
                          }
                          setRefused(null)
                          capturingRef.current = null
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
                      {refused?.id === command.id && (
                        <span className="keyrow__refused" role="status">
                          {labelOfKey(refused.key)} needs Ctrl or Alt
                        </span>
                      )}
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
                  Click a chord and press the new keys; Esc leaves it as it was. A
                  binding needs Ctrl or Alt, or a function key — Tab, Enter, Space and
                  the arrows belong to the window and cannot be taken. These are the
                  window&rsquo;s own shortcuts: what the editor and the shell claim for
                  themselves stays theirs.
                </div>
              </div>
            </section>

            <section className="settings__section" data-section="system">
              <h3 className="settings__section-title">System</h3>

              <div className="field" role="group" aria-labelledby="settings-launch">
                <span className="field__label" id="settings-launch">On launch</span>
                <label className="field__check">
                  <input
                    type="checkbox"
                    checked={draft.restoreSession}
                    onChange={(e) => field('restoreSession', e.target.checked)}
                  />
                  <span>Reopen the last window&rsquo;s tabs, splits and files</span>
                </label>
                <div className="field__note">
                  Layout and open files, including anything unsaved, and the blocks each
                  pane had run — with a line drawn where the last session ended, so a
                  command from last week does not read as one from this morning. A pane
                  keeps its last 120 blocks; anything cleared stays cleared.
                </div>
              </div>

              <div className="field" role="group" aria-labelledby="settings-version">
                <span className="field__label" id="settings-version">Version</span>
                {/* Nowhere in the window said which build this was, so the first
                    question anyone asks about a bug — which version? — had no answer
                    short of the installer's filename. */}
                <div className="field__note">
                  Ember {window.ember.version}
                </div>
              </div>

              <div className="field" role="group" aria-labelledby="settings-updates">
                <span className="field__label" id="settings-updates">Updates</span>
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
                </div>
                {/* Its own line. Wedged in beside the buttons as a flex item it
                    was squeezed into a tall ragged column whenever it had more
                    than a few words to say — which is most of the time. */}
                {updateNote && <div className="field__note">{updateNote}</div>}
              </div>

              <div className="field" role="group" aria-labelledby="settings-file">
                <span className="field__label" id="settings-file">This file</span>
                <div className="composer__proposal-actions">
                  <button className="btn" onClick={() => void importFile()}>
                    Import…
                  </button>
                  <button className="btn" onClick={() => void exportFile()}>
                    Export…
                  </button>
                  <button className="btn" onClick={() => void window.ember.revealSettings()}>
                    Show settings.json
                  </button>
                  {confirmReset ? (
                    <>
                      <button className="btn" data-confirm="reset-all" onClick={resetAll}>
                        Reset every preference
                      </button>
                      <button className="btn" onClick={() => setConfirmReset(false)}>
                        Keep them
                      </button>
                    </>
                  ) : (
                    <button className="btn" onClick={() => setConfirmReset(true)}>
                      Reset all…
                    </button>
                  )}
                </div>
                {portNote && (
                  <div
                    className={`field__note ${portNote.good ? '' : 'field__note--bad'}`}
                    role="status"
                  >
                    {portNote.text}
                  </div>
                )}
                <div className="field__note">
                  An export carries preferences only: never a key, and nothing about this
                  machine — its window, its recent and trusted folders. An import is
                  checked field by field and refused whole if any of it is the wrong
                  kind of value; what it holds lands in this dialog for you to look at
                  before Save. settings.json itself is read when Ember starts, so an
                  edit made to it while Ember is running is replaced at the next save.
                </div>
              </div>

              <ExplorerMenuField />
            </section>
          </div>
        </div>

        {saveError && <div className="composer__error settings__error">{saveError}</div>}

        {askDiscard && (
          <div className="settings__discard" role="alertdialog" aria-label="Discard changes?">
            <span>
              Discard {changed.length === 1 ? 'your change' : `${changed.length} changes`}?
            </span>
            <button className="btn" autoFocus onClick={() => setAskDiscard(false)}>
              Keep editing
            </button>
            <button className="btn" data-confirm="discard" onClick={discard}>
              Discard
            </button>
          </div>
        )}

        <div className="modal__actions">
          <button className="btn" onClick={discard}>
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
