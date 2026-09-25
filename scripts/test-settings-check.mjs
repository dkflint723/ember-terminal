// What a settings value may be. Run: node scripts/test-settings-check.mjs
//
// Main used to spread settings.json over the defaults and trust whatever it held,
// so a list that was not a list reached the shell spawner, and a font size of 400
// reached the terminal. These are the rules the file, a save and an import are all
// read through: lenient for the first two — clamp, fall back, keep what can be
// used, and say so — and strict for an import, which refuses on anything that is
// the wrong kind of thing.
import { checkSettings, portable, NOT_PORTABLE } from '../src/shared/settings-check.ts'
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
const show = (r) => JSON.stringify({ values: r.values, notes: r.notes, refusals: r.refusals })

const shell = { id: 's1', name: 'Ubuntu', path: 'wsl.exe', args: ['-d', 'Ubuntu'], integration: 'bash' }

// --- what is already right says nothing -------------------------------------
{
  const r = checkSettings(DEFAULT_SETTINGS)
  check('the defaults pass untouched', r.notes.length === 0, show(r))
  check('and every one of them is kept', Object.keys(r.values).length === Object.keys(DEFAULT_SETTINGS).length)
}
{
  const r = checkSettings({ customProfiles: [shell], fontSize: 14, windowBounds: null, anthropicApiKey: null })
  check('good values pass as they are', r.notes.length === 0 && r.values.fontSize === 14, show(r))
  check('a good shell is kept whole', r.values.customProfiles?.[0]?.path === 'wsl.exe', show(r))
}
{
  const r = checkSettings({ someSettingFromANewerEmber: true, aiMode: 'bypass' })
  check('keys this version does not have are dropped quietly', r.notes.length === 0 && Object.keys(r.values).length === 0, show(r))
}

// --- numbers are brought into range, and that is not a refusal --------------
{
  const r = checkSettings({ fontSize: 400 })
  check('a font size of 400 becomes 32', r.values.fontSize === 32, show(r))
  check('and says so', r.notes.some((n) => n.includes('fontSize') && n.includes('32')), show(r))
  check('but an import is not refused for it', r.refusals.length === 0, show(r))
}
check('a zoom of 0 becomes 60%', checkSettings({ uiZoom: 0 }).values.uiZoom === 0.6)
check('a negative wait becomes none', checkSettings({ notifyAfterSeconds: -5 }).values.notifyAfterSeconds === 0)

// --- the wrong kind of thing is dropped, and is a refusal --------------------
for (const [label, raw, key] of [
  ['a font size in quotes', { fontSize: '12' }, 'fontSize'],
  ['a font size that is not a number at all', { fontSize: Number.NaN }, 'fontSize'],
  ['shells as one string', { customProfiles: 'wsl.exe' }, 'customProfiles'],
  ['a density nobody offers', { blockDensity: 'huge' }, 'blockDensity'],
  ['a boolean as a word', { restoreSession: 'yes' }, 'restoreSession'],
  ['a chord that is a number', { keybindings: { 'palette.commands': 1 } }, 'keybindings'],
  ['a key that is a number', { anthropicApiKey: 5 }, 'anthropicApiKey'],
  ['half a rectangle', { windowBounds: { x: 1 } }, 'windowBounds'],
  ['a theme that is not a name', { themeId: ['tidewater'] }, 'themeId']
]) {
  const r = checkSettings(raw)
  check(`${label} is left out`, !(key in r.values), show(r))
  check(`${label} is refused on import`, r.refusals.length === 1 && r.refusals[0].includes(key), show(r))
}

// --- a list keeps the entries it can use -------------------------------------
{
  const r = checkSettings({
    customProfiles: [
      shell,
      { ...shell, id: 's2', args: '-d Ubuntu' },
      { ...shell, id: 's3', path: '' },
      { ...shell, id: 's4', integration: 'zsh' },
      'pwsh'
    ]
  })
  check('the one usable shell survives', r.values.customProfiles?.length === 1, show(r))
  check('arguments as one string are left out', r.notes.some((n) => n.includes('entry 2') && n.includes('args')), show(r))
  check('a shell with no program is left out', r.notes.some((n) => n.includes('entry 3') && n.includes('path')), show(r))
  check('an integration nobody offers is left out', r.notes.some((n) => n.includes('entry 4')), show(r))
  check('a bare string is left out', r.notes.some((n) => n.includes('entry 5') && n.includes('not an object')), show(r))
}
{
  const r = checkSettings({
    languageServers: [
      { id: 'l1', languageId: 'rust', name: 'rust', command: 'rust-analyzer', args: [] },
      { id: 'l2', languageId: 'go', name: 'go', command: 'gopls', args: [], extensions: '.go' }
    ]
  })
  check('a language server with extensions as a string is left out', r.values.languageServers?.length === 1, show(r))
}
{
  const r = checkSettings({
    debugAdapters: [
      { id: 'd1', name: 'x', command: 'node', args: [], transport: 'pipe', extensions: [] }
    ]
  })
  check('a debug adapter with a transport nobody offers is left out', r.values.debugAdapters?.length === 0, show(r))
}
check(
  'a folder list keeps its strings',
  checkSettings({ recentFolders: ['C:\\a', 7, 'C:\\b'] }).values.recentFolders?.length === 2
)

// --- what an export carries ---------------------------------------------------
{
  const out = portable({ ...DEFAULT_SETTINGS, anthropicApiKey: 'sk-ant-secret', ghostApiKey: 'sk-other' })
  check('an export carries no key', !('anthropicApiKey' in out) && !('ghostApiKey' in out), JSON.stringify(out).slice(0, 120))
  check('nor which folders this machine trusts', !('trustedFolders' in out))
  check('nor where this window was', !('windowBounds' in out))
  check('but does carry the preferences', out.fontSize === DEFAULT_SETTINGS.fontSize && 'keybindings' in out)
  check(
    'and reads back through the import check without a word',
    checkSettings(out).refusals.length === 0 && checkSettings(out).notes.length === 0
  )
  check('every key held back is a real setting', NOT_PORTABLE.every((k) => k in DEFAULT_SETTINGS))
}

console.log(`settings check: ${cases} cases`, failures === 0 ? 'PASS' : 'FAIL')
process.exit(failures === 0 ? 0 : 1)
