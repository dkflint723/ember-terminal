// Fetch Microsoft's js-debug DAP server into resources/js-debug.
//
// It is the Node debugger VS Code itself uses, published only as a GitHub
// release tarball — not on npm — so it cannot be a dependency. It is not
// committed either: ~50MB of someone else's build products do not belong in
// this repository. This script puts it where the build's extraResources rule
// already ships everything, and detection prefers this copy at runtime.
//
// Run: node scripts/fetch-js-debug.mjs   (once, and after wanting an update)
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = path.resolve(import.meta.dirname, '..')
const target = path.join(APP_DIR, 'resources', 'js-debug')
const marker = path.join(target, 'src', 'dapDebugServer.js')

if (fs.existsSync(marker) && process.argv[2] !== '--force') {
  console.log(`already here: ${marker}`)
  process.exit(0)
}

const api = 'https://api.github.com/repos/microsoft/vscode-js-debug/releases/latest'
const release = await (await fetch(api, { headers: { 'user-agent': 'ember-terminal' } })).json()
const asset = (release.assets ?? []).find(
  (a) => /^js-debug-dap-.*\.tar\.gz$/.test(a.name)
)
if (!asset) {
  console.error('No js-debug-dap asset in the latest release:', release.tag_name)
  process.exit(1)
}

console.log(`fetching ${asset.name} (${Math.round(asset.size / 1024 / 1024)}MB)…`)
const body = Buffer.from(await (await fetch(asset.browser_download_url)).arrayBuffer())
const tarball = path.join(APP_DIR, 'resources', asset.name)
fs.mkdirSync(path.dirname(tarball), { recursive: true })
fs.writeFileSync(tarball, body)

fs.rmSync(target, { recursive: true, force: true })
// The tarball's root directory is js-debug/, so extracting into resources/
// lands it exactly where detection looks. Relative paths, because GNU tar
// reads a Windows drive letter as a remote host name.
execFileSync('tar', ['-xzf', asset.name], {
  cwd: path.join(APP_DIR, 'resources'),
  stdio: 'inherit'
})
fs.rmSync(tarball, { force: true })

if (!fs.existsSync(marker)) {
  console.error('Extraction finished but the server script is missing.')
  process.exit(1)
}
console.log(`ready: ${marker} (${release.tag_name})`)
