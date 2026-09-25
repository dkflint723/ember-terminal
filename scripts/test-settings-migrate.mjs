// One-time changes to stored settings. Run: node scripts/test-settings-migrate.mjs
//
// A new default reaches only new installs, because every install that has saved its
// settings has every field written down. Opus 5.5 replacing Opus 5 as the default is
// a change existing installs should have too, so it is made once per install and
// recorded — and a choice made after it is left alone.
import { migrateStored, MIGRATION_IDS } from '../src/shared/settings-migrate.ts'
import { checkSettings, NOT_PORTABLE } from '../src/shared/settings-check.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
const ID = 'default-model-opus-5-5'
const show = (x) => JSON.stringify(x)

{
  const stored = { aiModel: 'claude-opus-5', fontSize: 14 }
  const r = migrateStored(stored)
  check('an install on Opus 5 is moved to Opus 5.5', stored.aiModel === 'claude-opus-5-5', show(stored))
  check('and told, with the way back', r.notes.length === 1 && /Opus 5\.5/.test(r.notes[0]) && /Opus 5\b/.test(r.notes[0]), show(r.notes))
  check('and it is recorded', r.recorded && stored.migrations.includes(ID), show(stored))
  check('nothing else is touched', stored.fontSize === 14)
}
{
  // The same install, next launch, after choosing Opus 5 again on purpose.
  const stored = { aiModel: 'claude-opus-5', migrations: [ID] }
  const r = migrateStored(stored)
  check('a choice of Opus 5 made afterwards is kept', stored.aiModel === 'claude-opus-5', show(stored))
  check('without a word, and nothing to write', r.notes.length === 0 && !r.recorded, show(r))
}
{
  const stored = { aiModel: 'claude-sonnet-5' }
  const r = migrateStored(stored)
  check('an install on another model keeps it', stored.aiModel === 'claude-sonnet-5')
  check('says nothing', r.notes.length === 0)
  check('but is recorded, so a later choice of Opus 5 is not moved either', r.recorded && stored.migrations.includes(ID))
}
{
  const stored = {}
  const r = migrateStored(stored)
  check('a new install gains no model it did not have', !('aiModel' in stored), show(stored))
  check('and is recorded as done', r.recorded && stored.migrations.includes(ID), show(stored))
}
{
  const stored = { aiModel: 'claude-opus-5', migrations: 'garbage' }
  migrateStored(stored)
  check('a damaged record is treated as none', stored.aiModel === 'claude-opus-5-5' && Array.isArray(stored.migrations))
}
{
  const stored = { aiModel: 'claude-opus-5', migrations: ['something-older'] }
  migrateStored(stored)
  check('records of other migrations are kept', stored.migrations.includes('something-older') && stored.migrations.includes(ID), show(stored))
}

// The record is a setting like any other, and stays on this machine.
check('every migration has a unique id', new Set(MIGRATION_IDS).size === MIGRATION_IDS.length)
check('the record passes the settings check', checkSettings({ migrations: [ID] }).notes.length === 0)
check('a record that is not a list is refused on import', checkSettings({ migrations: ID }).refusals.length === 1)
check('and it is not exported, since it describes this install', NOT_PORTABLE.includes('migrations'))

console.log(`settings migrations: ${cases} cases`, failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
