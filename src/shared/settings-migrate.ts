/**
 * One-time changes to stored settings, each applied once per install.
 *
 * A default only reaches new installs: every install that has ever saved its
 * settings has every field written down, so changing a default changes nothing for
 * anyone already using the app. When the change is one people should have anyway,
 * it is made here — once, recorded by id in `migrations`, so a choice made after it
 * is never made again for them. Someone moved from Opus 5 to Opus 5.5 who picks
 * Opus 5 back keeps Opus 5.
 *
 * Pure, and run on the raw stored object before it is merged with the defaults:
 * the question is what the file said, not what the merged settings say.
 */

interface Migration {
  id: string
  /** Change the stored object in place; return a sentence if anything changed. */
  apply(stored: Record<string, unknown>): string | null
}

const MIGRATIONS: Migration[] = [
  {
    // Opus 5.5 became the default; Opus 5 had been. An install still on Opus 5 is
    // one that took the old default or chose it — indistinguishable — and it is
    // moved, with a notice that says how to go back.
    id: 'default-model-opus-5-5',
    apply(stored) {
      if (stored.aiModel !== 'claude-opus-5') return null
      stored.aiModel = 'claude-opus-5-5'
      return 'Claude now uses Opus 5.5, the new default. To go back to Opus 5, choose it in Settings or from the Claude chip.'
    }
  }
]

export const MIGRATION_IDS: readonly string[] = MIGRATIONS.map((m) => m.id)

/**
 * Apply every migration this install has not had.
 *
 * Returns the notes to show, and whether anything was recorded — the caller writes
 * the file when it was, so each migration is marked done even when it changed
 * nothing (a fresh install, or one already on another model).
 */
export function migrateStored(stored: Record<string, unknown>): { notes: string[]; recorded: boolean } {
  const done = Array.isArray(stored.migrations)
    ? stored.migrations.filter((m): m is string => typeof m === 'string')
    : []
  const notes: string[] = []
  let recorded = false
  for (const migration of MIGRATIONS) {
    if (done.includes(migration.id)) continue
    const note = migration.apply(stored)
    if (note) notes.push(note)
    done.push(migration.id)
    recorded = true
  }
  stored.migrations = done
  return { notes, recorded }
}
