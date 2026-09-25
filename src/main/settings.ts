import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types.js'
import { checkSettings } from '../shared/settings-check.js'
import { withTrust, withoutTrust } from '../shared/trust.js'
import { realFolder } from './files.js'

/**
 * A trusted list with every folder under its real name, folded through the same
 * subsumption rule a single grant goes through — two spellings of one folder
 * become one entry, and a child of a trusted folder is absorbed by it.
 *
 * `ask` says which entries are worth asking the filesystem about. Asking is not
 * free — a folder on a share that has gone away can hold a realpath for seconds —
 * so an entry already written by its real name is not asked about again.
 */
function realTrust(folders: unknown, ask: (folder: string) => boolean = () => true): string[] {
  if (!Array.isArray(folders)) return []
  return folders
    .filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    .map((f) => (ask(f) ? realFolder(f) : f))
    .reduce<string[]>((held, f) => withTrust(held, f), [])
}

/** Marker so we can tell an encrypted key from a plaintext one on read. */
const ENC_PREFIX = 'enc:v1:'

/**
 * Settings live in a single JSON file under userData. The API key is encrypted
 * with the OS keystore (DPAPI on Windows) when available, so it is not sitting
 * in plaintext on disk.
 */
export class SettingsStore {
  private file = join(app.getPath('userData'), 'settings.json')
  private cache: Settings | null = null

  get(): Settings {
    if (this.cache) return this.cache

    let stored: Partial<Settings> = {}
    try {
      stored = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      if (typeof stored !== 'object' || stored === null) throw new Error('not an object')
    } catch (err) {
      /*
       * There is a difference between no settings and unreadable settings.
       *
       * Both used to fall back to defaults in silence, so a file that failed to
       * parse looked like a first run — and the next write replaced it, taking the
       * API key and every preference with it. A file that exists but cannot be read
       * is put aside under .bad instead, which keeps it recoverable and says so.
       */
      if ((err as { code?: string }).code !== 'ENOENT' && existsSync(this.file)) {
        this.loadError = err instanceof Error ? err.message : 'Settings could not be read.'
        try {
          renameSync(this.file, `${this.file}.bad`)
        } catch {
          // Keeping the original is better than losing it; the notice still goes out.
        }
      }
      stored = {}
    }

    /*
     * Settings that were offered once and are not offered now.
     *
     * A spread keeps whatever the file holds, including keys nothing reads any
     * more, and the next save writes them back — so a machine that once chose
     * Bypass would carry that word in its settings file for good, describing a
     * behaviour this app no longer has. They are dropped on the way in.
     */
    for (const gone of ['aiMode', 'aiEffort']) delete (stored as Record<string, unknown>)[gone]

    /*
     * Each field read for what it is supposed to be.
     *
     * The spread used to take whatever the file held, so a hand edit that left a
     * list as a string reached the shell spawner as a string. What cannot be used
     * falls back to its default and is written down, to be said once at startup —
     * a setting that silently stops meaning what it was set to is the other half
     * of the problem.
     */
    const checked = checkSettings(stored as Record<string, unknown>)
    this.loadNotes = checked.notes
    const merged: Settings = { ...DEFAULT_SETTINGS, ...checked.values }
    merged.anthropicApiKey = this.decryptKey(merged.anthropicApiKey)
    // The second key gets the same treatment as the first. A provider key sitting
    // in plaintext beside an encrypted one is the worse kind of half-measure.
    merged.ghostApiKey = this.decryptKey(merged.ghostApiKey)
    // A list written before trust was kept by real name is put right on the way
    // in, so a folder trusted by its short name is still trusted by its long. Only
    // short names are asked about here, at startup, where a stall is felt; an entry
    // spelled through a junction still matches that same spelling, and is written
    // by its real name the next time anything is trusted.
    merged.trustedFolders = realTrust(merged.trustedFolders, (f) => f.includes('~'))
    this.cache = merged
    return merged
  }

  /** Why the stored settings could not be read, if they could not. Read once. */
  private loadError: string | null = null

  /** What was clamped or put back to its default on the way in. Read once. */
  private loadNotes: string[] = []

  takeLoadNotes(): string[] {
    this.get()
    const notes = this.loadNotes
    this.loadNotes = []
    return notes
  }

  takeLoadError(): string | null {
    this.get()
    const error = this.loadError
    this.loadError = null
    return error
  }

  /**
   * Written through a temporary file and renamed into place, so an interrupted
   * write cannot leave a half-file that the next launch treats as corrupt.
   *
   * The outcome is returned rather than swallowed: a failed write meant the API key
   * the user had just typed was kept in memory, reported as saved, and gone on the
   * next launch.
   */
  set(patch: Partial<Settings>): {
    settings: Settings
    persisted: boolean
    error?: string
    notes?: string[]
  } {
    const held = this.get().trustedFolders
    /*
     * Held to the same rules as the file. The dialog clamps what it can, but a
     * suite, a script or an import can send anything, and a value this store
     * accepts is a value every shell and every window then acts on. What was
     * changed on the way in is handed back to be said.
     */
    const { values, notes } = checkSettings(patch as Record<string, unknown>)
    const next: Settings = { ...this.get(), ...values }
    // Whoever sends a whole list — the settings dialog, a suite — is held to the
    // same rule as a single grant: each folder by its real name. A save that sends
    // the list back unchanged asks about nothing.
    if (values.trustedFolders !== undefined) {
      next.trustedFolders = realTrust(values.trustedFolders, (f) => !held.includes(f))
    }
    this.cache = next

    const onDisk: Settings = {
      ...next,
      anthropicApiKey: this.encryptKey(next.anthropicApiKey),
      ghostApiKey: this.encryptKey(next.ghostApiKey)
    }
    const temp = `${this.file}.tmp`
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(temp, JSON.stringify(onDisk, null, 2), 'utf8')
      renameSync(temp, this.file)
      return { settings: next, persisted: true, ...(notes.length > 0 ? { notes } : {}) }
    } catch (err) {
      // The in-memory value stands so the session still works; the caller is told
      // that it will not outlive the window.
      return {
        settings: next,
        persisted: false,
        error: err instanceof Error ? err.message : 'Settings could not be saved.',
        ...(notes.length > 0 ? { notes } : {})
      }
    }
  }

  /** Where the file is, for "Show settings.json". */
  get path(): string {
    return this.file
  }

  /**
   * Record a folder as recently opened, newest first and without duplicates.
   *
   * Compared case-insensitively, because Windows will hand back the same folder
   * with different capitalisation depending on how it was reached, and the same
   * place twice in a recent list is not a recent list.
   */
  noteRecentFolder(folder: string): Settings {
    if (!folder.trim()) return this.get()
    const same = (a: string, b: string): boolean =>
      a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

    const rest = this.get().recentFolders.filter((f) => !same(f, folder))
    // Ten is enough to cover what someone moves between; past that it is a history
    // rather than a shortcut.
    return this.set({ recentFolders: [folder, ...rest].slice(0, 10) }).settings
  }

  /**
   * Record that a composer chord has been pressed, so it stops being advertised.
   *
   * Unioned here rather than in the renderer for the same reason the recent folders
   * are: the settings cache is one object shared by every window, and a renderer
   * that sends the whole array sends the copy it happened to be holding — two
   * windows learning two different chords would each drop the other's.
   */
  noteLearnedChord(chord: string): Settings {
    const known = this.get().learnedChords
    if (!chord.trim() || known.includes(chord)) return this.get()
    return this.set({ learnedChords: [...known, chord] }).settings
  }

  /**
   * Grant or withdraw a folder's permission to run its own code.
   *
   * Unioned here rather than in the renderer for the reason the two above are:
   * the settings cache is one object shared by every window, so a renderer that
   * sent the whole list would send the copy it happened to be holding, and two
   * windows trusting two folders would each drop the other's.
   *
   * The subsumption rules live in shared/trust.ts, where they are tested without
   * a disk: trusting a parent absorbs its children, and revoking a parent takes
   * its children with it.
   */
  noteTrust(folder: string, trusted: boolean): Settings {
    if (!folder.trim()) return this.get()
    const held = this.get().trustedFolders
    /*
     * Written down by the folder's real name rather than by the spelling it was
     * reached through, which is the whole of what makes the answer survive a
     * second spelling: the same folder opened as C:\Users\LONGNA~1\proj, as
     * C:\Users\LongName\proj or through a junction is one entry and one decision.
     * Withdrawn by both, so a revocation cannot miss an entry by spelling either.
     */
    const real = realFolder(folder)
    const next = trusted
      ? withTrust(held, real)
      : withoutTrust(withoutTrust(held, real), folder)
    // Nothing changed — a folder already trusted, or a revocation of one that
    // never was. Writing anyway would push a settings:changed at every window.
    if (next.length === held.length && next.every((f, i) => f === held[i])) return this.get()
    return this.set({ trustedFolders: next }).settings
  }

  /**
   * The key the AI feature should use. An explicit setting wins; otherwise fall
   * back to the ambient environment, which many developers already have set.
   */
  resolveApiKey(): string | null {
    const fromSettings = this.get().anthropicApiKey
    if (fromSettings && fromSettings.trim().length > 0) return fromSettings.trim()
    const fromEnv = process.env.ANTHROPIC_API_KEY
    return fromEnv && fromEnv.trim().length > 0 ? fromEnv.trim() : null
  }

  /** True when the key came from the environment rather than the settings file. */
  keyIsFromEnv(): boolean {
    const fromSettings = this.get().anthropicApiKey
    return (!fromSettings || fromSettings.trim().length === 0) && !!process.env.ANTHROPIC_API_KEY
  }

  /**
   * Whether a key saved now would actually be encrypted.
   *
   * Asked so the dialog can say what is true rather than promising a credential
   * store that may not be there: falling back to plaintext is defensible, telling
   * someone their key is encrypted when it is sitting in a JSON file is not.
   */
  encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  private encryptKey(key: string | null): string | null {
    if (!key) return null
    if (!this.encryptionAvailable()) return key
    try {
      return ENC_PREFIX + safeStorage.encryptString(key).toString('base64')
    } catch {
      return key
    }
  }

  private decryptKey(value: string | null): string | null {
    if (!value) return null
    if (!value.startsWith(ENC_PREFIX)) return value
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), 'base64'))
    } catch {
      // Encrypted with a different OS user or machine; treat as absent so the
      // user is prompted for the key again instead of sending garbage.
      return null
    }
  }
}
