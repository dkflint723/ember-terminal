// Says whether this process is elevated, by the same test Ember uses, and whether
// it can write where the suites write. Exits non-zero when --expect names the other
// answer, or when a directory the suites need is not writable.
//
// Run: node .github/elevation.mjs --expect unelevated
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const config = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'config')
let elevated
try {
  fs.readdirSync(config)
  elevated = true
  console.log(`listed ${config}: elevated`)
} catch (e) {
  elevated = false
  console.log(`could not list ${config} (${e.code}): not elevated`)
}

let ok = true
const places = [
  process.cwd(),
  os.tmpdir(),
  path.join(os.homedir(), '.claude', 'ide'),
  process.env.EMBER_KEEP_LOGS
].filter(Boolean)
for (const dir of places) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, `.elevation-probe-${process.pid}`)
    fs.writeFileSync(f, 'x')
    fs.rmSync(f)
    console.log(`writable: ${dir}`)
  } catch (e) {
    ok = false
    console.log(`NOT writable: ${dir} (${e.code})`)
  }
}

const i = process.argv.indexOf('--expect')
const expect = i === -1 ? null : process.argv[i + 1]
if (expect === 'unelevated' && elevated) ok = false
if (expect === 'elevated' && !elevated) ok = false
process.exit(ok ? 0 : 1)
