// What "Copy diagnostics" copies, and what it must not. Run: node scripts/test-diagnostics.mjs
//
// A bug report is posted where anyone can read it, and settings hold keys, saved
// commands, the arguments shells start with and the folders people work in. So every
// place one of those can live is seeded here with a marker, and none may come out.
// The acceptance line from the audit (R21): "Copy diagnostics contains no key and no
// command text". There is no earlier version — the button is new — so EMBER_OLD_RULE=1
// runs the cases against the obvious one: the rule main already uses to hand settings
// to the renderer, keys nulled and everything else as it is, and a log copied as read.
import './ts-resolve.mjs'

const real = await import('../src/main/diagnostics.ts')
const { DEFAULT_SETTINGS } = await import('../src/shared/types.ts')

const obvious = {
  settingsSummary: (s) => ({ ...s, anthropicApiKey: null, ghostApiKey: null }),
  diagnosticsReport: (env, s, tail) =>
    [
      `Ember ${env.version}`,
      `Electron ${env.electron}, Chromium ${env.chrome}, Node ${env.node}`,
      `OS ${env.os}`,
      JSON.stringify(obvious.settingsSummary(s), null, 2),
      tail.length > 0 ? 'ember.log:' : 'ember.log: empty',
      ...tail
    ].join('\n')
}
const { diagnosticsReport, settingsSummary } = process.env.EMBER_OLD_RULE ? obvious : real

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const KEY = 'sk-ant-api03-DiagNotARealKey0123456789abcdef'
const GHOST_KEY = 'sk-proj-DiagGhostNotARealKey0123456789'
const env = {
  version: '0.4.2',
  electron: '38.1.0',
  chrome: '140.0.0.0',
  node: '22.19.0',
  os: 'Windows 10.0.26200 x64',
  userData: 'C:\\Users\\someone\\AppData\\Roaming\\ember'
}
const settings = {
  ...DEFAULT_SETTINGS,
  anthropicApiKey: KEY,
  ghostApiKey: GHOST_KEY,
  ghostBaseUrl: 'https://marker-baseurl.internal.example/v1',
  fontSize: 15,
  themeId: 'ember-dark',
  customProfiles: [
    { id: 'p1', name: 'marker-profile-name', command: 'C:\\marker-shell.exe', args: ['--marker-arg', KEY] }
  ],
  savedCommands: [{ id: 's1', name: 'marker-saved-name', command: 'ssh prod marker-saved-command' }],
  debugAdapters: [{ id: 'd1', name: 'marker-adapter', command: 'marker-adapter.exe', args: [] }],
  languageServers: [
    { id: 'l1', languageId: 'rust', name: 'marker-server', command: 'marker-lsp.exe', args: [], extensions: ['.rs'] }
  ],
  trustedFolders: ['D:\\marker-trusted-folder'],
  recentFolders: ['D:\\marker-recent-folder'],
  migrations: ['m1'],
  // A field added after diagnostics.ts was written, holding text: summarised, not copied.
  someFutureField: 'marker-future-text',
  someFutureObject: { inner: 'marker-future-object' }
}
const log = [
  '[2026-09-20T10:00:00.000Z] update failed: Error: 401 for x-api-key sk-ant-api03-OldLogNotRedacted0123456789',
  '[2026-09-27T10:00:00.000Z] renderer error: Error: boom',
  '    at App (app.js:1:2)'
]
const report = diagnosticsReport(env, settings, log)

// --- what a report needs ---------------------------------------------------------
check('the version', report.includes('Ember 0.4.2'))
check('the runtime', report.includes('Electron 38.1.0') && report.includes('Node 22.19.0'))
check('the OS', report.includes('Windows 10.0.26200 x64'))
check('settings that are numbers or switches, as they are', /"fontSize": 15/.test(report) && /"formatOnSave": (true|false)/.test(report))
check('settings that are names from a list, as they are', /"themeId": "ember-dark"/.test(report))
check('the log lines, in order', report.indexOf('update failed') < report.indexOf('renderer error: Error: boom'))
check('a key is said to be set, and nothing more', /"anthropicApiKey": "set"/.test(report) && /"ghostApiKey": "set"/.test(report))
check('lists of what people typed are counted', /"savedCommands": "1 items"/.test(report) && /"customProfiles": "1 items"/.test(report))

// --- what it must not carry --------------------------------------------------------
const leaked = [KEY, GHOST_KEY, 'OldLogNotRedacted', ...report.match(/marker-[a-z-]+/g) ?? []]
  .filter((s, i, all) => all.indexOf(s) === i)
  .filter((s) => report.includes(s))
check('no key, no saved command, no shell argument, no folder, no taught command', leaked.length === 0, leaked.join(', '))
check('a key in a log line from an older build is redacted here', report.includes('x-api-key [redacted]'))
check('a text field added later is summarised rather than copied', settingsSummary(settings).someFutureField === '(set)')
check('an object field added later is summarised too', settingsSummary(settings).someFutureObject === '(set)')
check('a key that is not set says so', settingsSummary({ ...settings, anthropicApiKey: null }).anthropicApiKey === 'not set')

// --- an empty log says what that means ---------------------------------------------
check('an empty log is said to be empty', diagnosticsReport(env, settings, []).includes('ember.log: empty'))

console.log(`diagnostics: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
