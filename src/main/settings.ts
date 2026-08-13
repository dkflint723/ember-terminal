import { app, safeStorage } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '../shared/types.js'

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
    } catch {
      // No settings yet, or the file is unreadable/corrupt: fall back to
      // defaults rather than failing to launch.
    }

    const merged: Settings = { ...DEFAULT_SETTINGS, ...stored }
    merged.anthropicApiKey = this.decryptKey(merged.anthropicApiKey)
    this.cache = merged
    return merged
  }

  set(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.get(), ...patch }
    this.cache = next

    const onDisk: Settings = { ...next, anthropicApiKey: this.encryptKey(next.anthropicApiKey) }
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(onDisk, null, 2), 'utf8')
    } catch {
      // Keep the in-memory value so the session still works even if the disk
      // write fails; the user just loses persistence.
    }
    return next
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
    return this.set({ recentFolders: [folder, ...rest].slice(0, 10) })
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
