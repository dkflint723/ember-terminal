/**
 * What a settings value is allowed to be, checked one field at a time.
 *
 * Main used to spread whatever settings.json held over the defaults and trust it,
 * so a hand edit that left `customProfiles` as a string, or a `fontSize` of 400,
 * was loaded as it stood — and every shell spawn walked a list that was not a list.
 * The file is a thing people edit, copy between machines and now import, so each
 * field is read for what it is supposed to be, and what is not is said out loud.
 *
 * Two answers for two situations. Reading the file or a save is lenient: a number
 * out of range is clamped, a field of the wrong kind falls back to its default, a
 * list keeps the entries it can use, and every one of those is written down as a
 * note. An import is strict: a file with a string where a list belongs is somebody
 * else's idea of a settings file, and taking part of it would be worse than taking
 * none, so it is refused with the reasons.
 */
import { DEFAULT_SETTINGS, type Settings } from './types.ts'

type Issue = { key: string; message: string; kind: 'clamped' | 'wrong' }

/** Numbers and the ranges the dialog itself offers. */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  fontSize: [8, 32],
  uiZoom: [0.6, 2.5],
  notifyAfterSeconds: [0, 3600],
  autoSaveAfterSeconds: [0, 600],
  ghostDebounceMs: [0, 2000]
}

const ONE_OF: Partial<Record<keyof Settings, readonly string[]>> = {
  blockDensity: ['compact', 'normal', 'comfortable'],
  ghostProvider: ['local', 'openai', 'claude']
}

const isString = (v: unknown): v is string => typeof v === 'string'
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString)
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Why one list entry cannot be used, or null when it can. */
type EntryCheck = (entry: unknown) => string | null

const needs =
  (fields: Record<string, (v: unknown) => boolean>, optional: Record<string, (v: unknown) => boolean> = {}): EntryCheck =>
  (entry) => {
    if (!isRecord(entry)) return 'is not an object'
    for (const [name, ok] of Object.entries(fields)) {
      if (!ok(entry[name])) return `has no usable "${name}"`
    }
    for (const [name, ok] of Object.entries(optional)) {
      if (entry[name] !== undefined && !ok(entry[name])) return `has an unusable "${name}"`
    }
    return null
  }

const nonEmpty = (v: unknown): boolean => isString(v) && v.trim().length > 0

/**
 * The lists whose entries become programs Ember starts, and the others.
 *
 * A program's path is not required to be absolute: `wsl.exe` and `pwsh` are found
 * on PATH exactly as a terminal would find them, and that is what the dialog's own
 * placeholder suggests typing. What is required is that it is a string, that its
 * arguments are a list of strings rather than one string to be split somewhere
 * later, and that the fields the spawner reads are there at all.
 */
const LISTS: Partial<Record<keyof Settings, EntryCheck>> = {
  customProfiles: needs(
    {
      id: nonEmpty,
      name: isString,
      path: nonEmpty,
      args: isStrings,
      integration: (v) => v === 'powershell' || v === 'bash' || v === 'none'
    },
    { cwd: isString }
  ),
  savedCommands: needs({ id: nonEmpty, name: isString, command: isString }),
  languageServers: needs(
    { id: nonEmpty, languageId: nonEmpty, name: isString, command: nonEmpty, args: isStrings },
    { extensions: isStrings }
  ),
  debugAdapters: needs(
    {
      id: nonEmpty,
      name: isString,
      command: nonEmpty,
      args: isStrings,
      transport: (v) => v === 'stdio' || v === 'tcp',
      extensions: isStrings
    },
    { env: (v) => isRecord(v) && Object.values(v).every(isString) }
  ),
  trustedFolders: (e) => (isString(e) ? null : 'is not a folder name'),
  recentFolders: (e) => (isString(e) ? null : 'is not a folder name'),
  learnedChords: (e) => (isString(e) ? null : 'is not a chord'),
  migrations: (e) => (isString(e) ? null : 'is not a migration')
}

const show = (v: unknown): string => {
  const text = JSON.stringify(v) ?? String(v)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** One field, read for what it should be. */
function checkField(key: keyof Settings, value: unknown, issues: Issue[]): unknown {
  const fallback = DEFAULT_SETTINGS[key]
  const wrong = (message: string): undefined => {
    issues.push({ key, message, kind: 'wrong' })
    return undefined
  }

  const range = RANGES[key]
  if (range) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return wrong(`${key} should be a number, and was ${show(value)}`)
    }
    const [min, max] = range
    const clamped = Math.min(Math.max(value, min), max)
    if (clamped !== value) {
      issues.push({ key, message: `${key} of ${value} was brought into range as ${clamped}`, kind: 'clamped' })
    }
    return clamped
  }

  const choices = ONE_OF[key]
  if (choices) {
    return isString(value) && choices.includes(value)
      ? value
      : wrong(`${key} should be one of ${choices.join(', ')}, and was ${show(value)}`)
  }

  const entry = LISTS[key]
  if (entry) {
    if (!Array.isArray(value)) return wrong(`${key} should be a list, and was ${show(value)}`)
    const kept: unknown[] = []
    value.forEach((item, i) => {
      const why = entry(item)
      if (why === null) kept.push(item)
      else issues.push({ key, message: `${key} entry ${i + 1} ${why}, and was left out`, kind: 'wrong' })
    })
    return kept
  }

  if (key === 'keybindings') {
    if (!isRecord(value) || !Object.values(value).every(isString)) {
      return wrong(`keybindings should map commands to chords, and was ${show(value)}`)
    }
    return value
  }

  if (key === 'windowBounds') {
    if (value === null) return null
    const ok =
      isRecord(value) &&
      ['x', 'y', 'width', 'height'].every((k) => typeof value[k] === 'number' && Number.isFinite(value[k]))
    return ok ? value : wrong(`windowBounds should be a rectangle, and was ${show(value)}`)
  }

  if (typeof fallback === 'boolean') {
    return typeof value === 'boolean' ? value : wrong(`${key} should be true or false, and was ${show(value)}`)
  }
  if (typeof fallback === 'string') {
    return isString(value) ? value : wrong(`${key} should be text, and was ${show(value)}`)
  }
  if (fallback === null) {
    // The nullable strings: the two keys, the default shell, a pending update.
    return value === null || isString(value) ? value : wrong(`${key} should be text, and was ${show(value)}`)
  }
  return value
}

export interface Checked {
  /** The fields that can be used, clamped where they had to be. */
  values: Partial<Settings>
  /** Every value that was changed or dropped, and why, in words. */
  notes: string[]
  /** Only the fields that were the wrong kind of thing — what an import refuses on. */
  refusals: string[]
}

/**
 * Read an object that claims to hold settings.
 *
 * Keys this version does not have are left out without a note: a file written by a
 * newer Ember, or one that still carries a setting since retired, is not wrong.
 */
export function checkSettings(raw: Record<string, unknown>): Checked {
  const issues: Issue[] = []
  const values: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (!(name in DEFAULT_SETTINGS)) continue
    const key = name as keyof Settings
    const checked = checkField(key, value, issues)
    if (checked !== undefined) values[key] = checked
  }
  return {
    values: values as Partial<Settings>,
    notes: issues.map((i) => i.message),
    refusals: issues.filter((i) => i.kind === 'wrong').map((i) => i.message)
  }
}

/**
 * What an export leaves out, and what an import will not take.
 *
 * The two credentials, for the obvious reason. The rest describe this machine and
 * this window rather than a preference: where the window was, the folders opened
 * lately, which chords have been learned, an update waiting to install, and which
 * folders are trusted to run their own code — which is a decision about what is on
 * this disk, and carrying it to another machine would be making it for someone.
 */
export const NOT_PORTABLE: readonly (keyof Settings)[] = [
  'anthropicApiKey',
  'ghostApiKey',
  'windowBounds',
  'windowMaximized',
  'recentFolders',
  'learnedChords',
  'pendingUpdateVersion',
  'firstRunDone',
  'trustedFolders',
  'migrations'
]

export function portable(settings: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (!NOT_PORTABLE.includes(key as keyof Settings)) out[key] = value
  }
  return out as Partial<Settings>
}
