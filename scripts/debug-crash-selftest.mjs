// DEBUG ONLY: crash a throwaway Electron on purpose and check its dump is kept.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { newProfile } from './profile.mjs'

const electron = path.join(import.meta.dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
const app = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-crashapp-'))
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'crashapp', main: 'main.js' }))
fs.writeFileSync(
  path.join(app, 'main.js'),
  "const { app, crashReporter } = require('electron');" +
    'crashReporter.start({ uploadToServer: false });' +
    "app.whenReady().then(() => setTimeout(() => process.crash(), 500));"
)
const profile = newProfile('crashtest')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const r = spawnSync(electron, [app, profile.arg], { env, timeout: 60_000 })
console.log(`crash self-test: exit 0x${((r.status ?? 0) >>> 0).toString(16)}`)
const found = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.endsWith('.dmp')) found.push(p)
  }
}
walk(profile.dir)
console.log(`crash self-test: dumps in the profile: ${found.length}`)
profile.cleanup()
const kept = fs.readdirSync(process.env.EMBER_KEEP_LOGS ?? '.').filter((f) => f.endsWith('.dmp'))
console.log(`crash self-test: dumps kept: ${kept.length} ${kept.join(', ')}`)
process.exit(kept.length > 0 ? 0 : 1)
