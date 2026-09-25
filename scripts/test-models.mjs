// Which Claude models do what with a request. Run: node scripts/test-models.mjs
//
// The newer models think before they answer whether or not they are asked, count
// that thinking against max_tokens, reject `effort` on the older small ones, and
// can decline a request outright. Ember shapes each request from these three rules,
// read from the model id — so a model typed into Settings by hand gets the same
// treatment as one picked from the menu. This is that table, held still.
import {
  AI_MODELS,
  hasServerFallback,
  modelChoice,
  takesEffort,
  thinksByDefault
} from '../src/shared/models.ts'
import { DEFAULT_SETTINGS } from '../src/shared/types.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

// id → [thinks by default, takes effort, server fallback]
const TABLE = {
  'claude-opus-5-5': [true, true, true],
  'claude-opus-5': [true, true, true],
  'claude-fable-5-1': [true, true, true],
  'claude-fable-5': [true, true, false],
  'claude-mythos-5-1': [true, true, false],
  'claude-sonnet-5': [true, true, false],
  'claude-opus-4-8': [false, true, false],
  'claude-opus-4-7': [false, true, false],
  'claude-opus-4-6': [false, true, false],
  'claude-opus-4-5': [false, true, false],
  'claude-sonnet-4-6': [false, true, false],
  'claude-sonnet-4-5': [false, false, false],
  'claude-haiku-4-5': [false, false, false],
  'claude-haiku-4-5-20251001': [false, false, false]
}
for (const [id, [thinks, effort, fallback]] of Object.entries(TABLE)) {
  check(`${id} ${thinks ? 'thinks' : 'does not think'} unasked`, thinksByDefault(id) === thinks)
  check(`${id} ${effort ? 'takes' : 'rejects'} effort`, takesEffort(id) === effort)
  check(`${id} ${fallback ? 'has' : 'has no'} server fallback`, hasServerFallback(id) === fallback)
}

// Near misses: an id that only starts like a listed one is not that model.
check('opus-5-5 with a suffix is not given the fallback', !hasServerFallback('claude-opus-5-5-preview'))
check('a model from elsewhere is none of these', !thinksByDefault('gpt-5') && !takesEffort('gpt-5') && !hasServerFallback('gpt-5'))

// The menu.
check('the default is listed first', AI_MODELS[0]?.id === DEFAULT_SETTINGS.aiModel, AI_MODELS[0]?.id)
check('and the default is Opus 5.5', DEFAULT_SETTINGS.aiModel === 'claude-opus-5-5', DEFAULT_SETTINGS.aiModel)
check('the newest Opus is offered', modelChoice('claude-opus-5-5')?.label === 'Opus 5.5')
check('every listed id is unique', new Set(AI_MODELS.map((m) => m.id)).size === AI_MODELS.length)
check('every listed model has a note', AI_MODELS.every((m) => m.note.trim().length > 0))

console.log(`claude models: ${cases} cases`, failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
