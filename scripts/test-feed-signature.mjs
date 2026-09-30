// The update feed's signature. Run: node scripts/test-feed-signature.mjs
//
// Whoever held the GitHub account held the feed (audit R24, SE-06). A release now
// carries a signature made offline over what its feed says; this holds the canonical
// form, the check, and where the signature is looked for — and runs the signing
// script against a feed on disk, the way a release is signed.
import './ts-resolve.mjs'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
const { canonicalFeed, signatureUrl } = await import('../src/shared/feed-signature.ts')
const { checkFeedSignature } = await import('../src/main/feed-check.ts')

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const feedText = `version: 0.4.4
files:
  - url: Ember-Setup-0.4.4.exe
    sha512: AAAA+real/hash==
    size: 104857600
path: Ember-Setup-0.4.4.exe
sha512: AAAA+real/hash==
releaseDate: '2026-09-30T00:00:00.000Z'
`
const parsed = yaml.load(feedText)
const info = { version: parsed.version, files: parsed.files }
check('the canonical form from the file is the form from what the updater parsed', canonicalFeed(parsed) === canonicalFeed(info))
check('and it names the version and each file', canonicalFeed(info) === 'ember-update-feed 1\nversion 0.4.4\nfile Ember-Setup-0.4.4.exe AAAA+real/hash== 104857600\n', JSON.stringify(canonicalFeed(info)))
check('files in any order sign the same', canonicalFeed({ version: '1', files: [{ url: 'b', sha512: '2' }, { url: 'a', sha512: '1' }] }) === canonicalFeed({ version: '1', files: [{ url: 'a', sha512: '1' }, { url: 'b', sha512: '2' }] }))

check('on GitHub, the signature is among the release’s assets', signatureUrl('owner: dkflint723\nrepo: ember-terminal\nprovider: github\n', '0.4.4') === 'https://github.com/dkflint723/ember-terminal/releases/download/v0.4.4/latest.yml.sig')
check('on a generic feed, beside latest.yml', signatureUrl('provider: generic\nurl: http://127.0.0.1:5000/\n', '9') === 'http://127.0.0.1:5000/latest.yml.sig')
check('anything else has no place for one', signatureUrl('provider: s3\n', '1') === null)

// --- the check, against a key of the test's own --------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
process.env.EMBER_UPDATE_PUBKEY = publicKey.export({ type: 'spki', format: 'pem' })
const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-feedsig-'))
fs.writeFileSync(path.join(resources, 'app-update.yml'), 'provider: generic\nurl: http://feed.test/\n')
const served = (sig) => async (url) => (url === 'http://feed.test/latest.yml.sig' && sig !== null ? { ok: true, status: 200, text: sig } : { ok: false, status: 404, text: '' })
const good = sign(null, Buffer.from(canonicalFeed(info)), privateKey).toString('base64')

check('a feed signed by the key is accepted', (await checkFeedSignature(info, served(good), resources)).ok)
const tampered = { ...info, files: [{ ...info.files[0], sha512: 'BBBB+attacker==' }] }
const t = await checkFeedSignature(tampered, served(good), resources)
check('a feed whose installer hash was changed is not', !t.ok && /does not match/.test(t.reason), JSON.stringify(t))
const bumped = await checkFeedSignature({ ...info, version: '0.4.5' }, served(good), resources)
check('nor one whose version was', !bumped.ok)
const other = generateKeyPairSync('ed25519').privateKey
check('nor one signed by another key', !(await checkFeedSignature(info, served(sign(null, Buffer.from(canonicalFeed(info)), other).toString('base64')), resources)).ok)
const missing = await checkFeedSignature(info, served(null), resources)
check('a release with no signature says so', !missing.ok && /no signature is published/.test(missing.reason), JSON.stringify(missing))
check('and a signature that is not one', !(await checkFeedSignature(info, served('not base64 at all!'), resources)).ok)

// --- the signing script, on a feed on disk ---------------------------------------------------------
const keyFile = path.join(resources, 'k.pem')
fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
const feedFile = path.join(resources, 'latest.yml')
fs.writeFileSync(feedFile, feedText)
let refused = ''
try {
  execFileSync(process.execPath, ['--no-warnings', path.join(import.meta.dirname, 'sign-release.mjs'), '--file', feedFile], { env: { ...process.env, EMBER_UPDATE_KEY: keyFile }, encoding: 'utf8', stdio: 'pipe' })
} catch (err) {
  refused = String(err.stderr ?? '')
}
check('the script refuses a key that is not the one Ember is built with', /not the one in src\/shared\/feed-signature\.ts/.test(refused), refused.slice(0, 160))
check('and writes nothing', !fs.existsSync(`${feedFile}.sig`))

fs.rmSync(resources, { recursive: true, force: true })
console.log(`feed signature: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
