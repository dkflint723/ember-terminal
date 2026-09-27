import { redactSecrets } from '../shared/secrets.js'
import type { Settings } from '../shared/types.js'

/**
 * What "Copy diagnostics" puts on the clipboard: enough to start on a bug report,
 * and nothing its owner would not paste into one.
 *
 * A report arrived with a description and nothing else, and every one became a hunt
 * for which build, which Windows, which settings. This answers those — but settings
 * hold keys, the commands people saved, the arguments their shells start with and
 * the folders they work in, and a report is posted where anyone can read it. So the
 * rule is the safe one by construction: numbers and switches are copied, a short
 * list of fields known to be names rather than text is copied, keys say only whether
 * one is set, and everything else — including any field added after this was
 * written — is summarised as a count or as "set". The log's last lines follow, run
 * through the redaction again, since a log written by a build before 0.4.2 was not.
 *
 * Kept free of Electron so a table can hold it to that.
 */
export interface Environment {
  version: string
  electron: string
  chrome: string
  node: string
  os: string
  userData: string
}

/** Fields that name a choice from a list, and are copied as they are. */
const NAMES = new Set<string>([
  'fontFamily',
  'defaultProfileId',
  'themeId',
  'aiModel',
  'blockDensity',
  'windowBackdrop',
  'ghostProvider',
  'ghostModel',
  'pendingUpdateVersion'
])

/** Lists of names, not of text: the migrations run, the chords learned. */
const NAME_LISTS = new Set<string>(['migrations', 'learnedChords'])

/** Keys: whether one is set, and nothing else about it. */
const SECRETS = new Set<string>(['anthropicApiKey', 'ghostApiKey'])

export function settingsSummary(settings: Settings): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(settings)) {
    if (SECRETS.has(key)) out[key] = typeof value === 'string' && value.trim() ? 'set' : 'not set'
    else if (value === null || typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string') out[key] = NAMES.has(key) ? value : value ? '(set)' : '(empty)'
    else if (Array.isArray(value))
      out[key] = NAME_LISTS.has(key) ? value.filter((v) => typeof v === 'string') : `${value.length} items`
    // Chord to command id: both are the app's own names, and a clash is a common bug.
    else if (key === 'keybindings') out[key] = value
    else if (key === 'windowBounds') out[key] = value
    else out[key] = '(set)'
  }
  return out
}

export function diagnosticsReport(
  env: Environment,
  settings: Settings,
  logTail: string[]
): string {
  const lines = [
    `Ember ${env.version}`,
    `Electron ${env.electron}, Chromium ${env.chrome}, Node ${env.node}`,
    `OS ${env.os}`,
    `User data ${env.userData}`,
    '',
    'Settings (keys, commands, arguments and folders are left out):',
    JSON.stringify(settingsSummary(settings), null, 2),
    '',
    logTail.length > 0
      ? `ember.log, last ${logTail.length} lines:`
      : 'ember.log: empty — nothing has gone wrong that main noticed.',
    ...logTail.map((l) => redactSecrets(l))
  ]
  return lines.join('\n')
}
