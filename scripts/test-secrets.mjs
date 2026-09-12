// What counts as a credential, and — just as important — what does not.
// Run: node scripts/test-secrets.mjs
//
// Two failures matter here and they pull in opposite directions. Missing a key
// writes it to a database that outlives the session, or hands it to a model. Seeing
// one where there is none makes the terminal useless: history drops ordinary
// commands, output comes back full of [redacted], and the suggestion in the editor
// stops appearing for reasons nobody can see. So every pattern below is paired with
// the ordinary text nearest to it that must survive untouched.
import {
  containsInlineSecret,
  containsKeyShape,
  hasSecret,
  inventsRedaction,
  redactSecrets
} from '../src/shared/secrets.ts'

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
let cases = 0

/** Text that must come back with the value gone and the label kept. */
const redacts = (text, mustNotContain, mustContain) => {
  cases += 1
  const out = redactSecrets(text)
  check(`redacted: ${text.slice(0, 52)}`, !out.includes(mustNotContain), JSON.stringify(out))
  if (mustContain !== undefined) {
    check(`label kept: ${text.slice(0, 52)}`, out.includes(mustContain), JSON.stringify(out))
  }
}
/** Text that must come back exactly as it went in. */
const untouched = (text) => {
  cases += 1
  const out = redactSecrets(text)
  check(`left alone: ${text.slice(0, 60)}`, out === text, JSON.stringify(out))
}
const dropped = (command) => {
  cases += 1
  check(`dropped from history: ${command.slice(0, 56)}`, containsInlineSecret(command))
}
const kept = (command) => {
  cases += 1
  check(`kept in history: ${command.slice(0, 56)}`, !containsInlineSecret(command))
}

// --- vendor key shapes, which need no label ---------------------------------------------
redacts('ANTHROPIC_API_KEY=sk-ant-api03-AbCdEf0123456789', 'sk-ant-api03')
redacts('curl -H "x-api-key: sk-proj-AbCdEf0123456789xyz"', 'sk-proj-AbCdEf')
redacts('key sk-svcacct-0123456789abcdefghij done', 'sk-svcacct-')
redacts('OPENAI_API_KEY=sk-0123456789abcdefghijABCDEFGHIJ', 'sk-0123456789')
redacts('token ghp_0123456789abcdefghij', 'ghp_0123456789')
redacts('using github_pat_11ABCDEFG0123456789_abcdefghij now', 'github_pat_11ABCDEFG')
redacts('GITLAB=glpat-0123456789abcdefghij', 'glpat-0123456789')
redacts('slack xoxb-0123456789-abcdefghij', 'xoxb-0123456789')
redacts('key AIzaSyA0123456789abcdefghijklmnopqrstu', 'AIzaSyA0123456789')
redacts('aws_access_key_id = AKIAIOSFODNN7EXAMPLE', 'AKIAIOSFODNN7EXAMPLE')
redacts('session ASIAIOSFODNN7EXAMPLE expires', 'ASIAIOSFODNN7EXAMPLE')
redacts('hf_abcdefghijklmnopqrstuvwxyz0123456789', 'hf_abcdefghij')
redacts('stripe sk_live_0123456789abcdefghij charged', 'sk_live_0123456789')
redacts('npm_0123456789abcdefghijklmnopqrstuvwxyz', 'npm_0123456789')
redacts(
  'Bearer eyJhbGciOiJIUzI1NiIs.eyJzdWIiOiIxMjM0NTY3.SflKxwRJSMeKKF2QT4f',
  'eyJhbGciOiJIUzI1NiIs'
)
redacts(
  'x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----\ny',
  'MIIEowIBAAKCAQEA'
)

// --- labelled credentials: the value goes, the label stays -------------------------------
redacts('docker login --password hunter2 --username me', 'hunter2', '--password [redacted]')
redacts('deploy --api-key=abc123def456', 'abc123def456', '--api-key=[redacted]')
redacts('PASSWORD=letmein ./deploy.sh', 'letmein', 'PASSWORD=[redacted]')
redacts('$env:ANTHROPIC_API_KEY = "abcdefghijkl"', 'abcdefghijkl', 'ANTHROPIC_API_KEY = [redacted]')
redacts('export API_KEY=abcdefghijkl', 'abcdefghijkl', 'API_KEY=[redacted]')
redacts('setx AZURE_CLIENT_SECRET abcdefghijkl', 'abcdefghijkl', '[redacted]')
redacts('curl -H "x-api-key: abcdefghijkl"', 'abcdefghijkl', 'x-api-key: [redacted]')
redacts('Authorization: Bearer abcdefghijkl', 'abcdefghijkl', 'Authorization: Bearer [redacted]')
redacts(
  'DefaultEndpointsProtocol=https;AccountName=me;AccountKey=abcdefghijkl==;',
  'abcdefghijkl',
  'AccountKey=[redacted]'
)
redacts('Server=db;Password=hunter2;Trusted=no', 'hunter2', 'Password=[redacted]')
redacts('psql postgres://user:secretpw@localhost:5432/db', 'secretpw', 'postgres://user:[redacted]@')
redacts('mysql -u root -pSuperSecret123', 'SuperSecret123', '-p[redacted]')

// --- and what must survive it -------------------------------------------------------------
untouched('git push origin main')
untouched('npm run build')
untouched('kubectl get secret my-secret -o yaml')
untouched('docker login --username me --password-stdin')
untouched('echo $env:PASSWORD')
untouched('git commit -m "add password reset flow"')
untouched('npm_config_registry=https://registry.npmjs.org/')
untouched('npm_lifecycle_event=build')
untouched('git log --pretty=format:%h -n 5')
untouched('sha256: 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08')
untouched('commit 6b00954bebaedc357b3100fd2ab9c0e3d4f5a6b7')
untouched('SELECT * FROM users WHERE password IS NOT NULL')
untouched('ls -la ~/.ssh')
untouched('grep -rn "token" src/')
untouched('AKIA is the prefix AWS uses for a long-lived key')

// --- the storage verdict ------------------------------------------------------------------
dropped('mysql -u root -pSuperSecret123')
dropped('curl -H "Authorization: Bearer sk-ant-api03-abc123def456" https://api.example.com')
dropped('docker login --password hunter2 --username me')
dropped('gh auth login --token ghp_abcdefghijklmnop')
dropped('export API_KEY=sk-live-1234567890')
dropped('PASSWORD=letmein ./deploy.sh')
dropped('psql postgres://user:secretpw@localhost:5432/db')
dropped('$env:ANTHROPIC_API_KEY = "sk-ant-api03-abcdefgh"')
dropped('setx GITHUB_TOKEN ghp_0123456789abcdefghij')
// No label at all: the key is simply an argument, which is how a deploy script
// takes one. Nothing in the old rules looked at this, so it was stored verbatim.
dropped('./deploy.sh sk-ant-api03-AbCdEf0123456789')
dropped('curl -H "x-api-key: abcdefghijklmnop" https://api.example.com')

kept('git push origin main')
kept('npm run build')
kept('docker login --username me --password-stdin')
kept('echo $env:PASSWORD')
kept('kubectl get pods -n prod')
kept('kubectl get secret my-secret -o yaml')
kept('ls -la')
kept('ssh user@host')
kept('grep -rn "token" src/')
kept('git commit -m "add password reset flow"')
kept('code --diff a.txt b.txt')
kept('tar -xzf archive.tar.gz')
kept('npm run deploy -- --dry-run')

// --- the two questions the round-trip paths ask ---------------------------------------------
cases += 2
check('a buffer holding a key is withheld', hasSecret('const key = "sk-ant-api03-abcdefgh"'))
check('an ordinary buffer is not', !hasSecret('export function add(a, b) {\n  return a + b\n}\n'))
cases += 2
check('a key shape is a key shape', containsKeyShape('sk-ant-api03-AbCdEf0123456789'))
check('a label alone is not', !containsKeyShape('--password hunter2'))

// A global regular expression remembers where it stopped. Asked twice, a stateful
// one answers only every other time — which would leak one key in two.
cases += 2
check('asked twice, the same answer', containsKeyShape('ghp_0123456789abcdefghij'))
check('and again', containsKeyShape('ghp_0123456789abcdefghij'))
cases += 2
const twice = 'TOKEN=abcdefghijkl and TOKEN=mnopqrstuvwx'
check('every occurrence goes, not the first', !redactSecrets(twice).includes('mnopqrstuvwx'), redactSecrets(twice))
check('the first one too', !redactSecrets(twice).includes('abcdefghijkl'), redactSecrets(twice))

// --- and what a proposal is allowed to write back ------------------------------------------
cases += 4
check(
  'a proposal that invented a redaction is refused',
  inventsRedaction('KEY=[redacted]\n', 'KEY=sk-ant-api03-abcdefgh\n')
)
check(
  'one that changed nothing else about it is still refused',
  inventsRedaction('# a comment\nKEY=[redacted]\n', 'KEY=sk-ant-api03-abcdefgh\n')
)
check(
  'a file that already said it keeps the right to',
  !inventsRedaction('KEY=[redacted]\n', 'KEY=[redacted]\n')
)
check('and an ordinary proposal goes through', !inventsRedaction('const a = 1\n', 'const a = 2\n'))

console.log(
  failures === 0 ? `secrets: ${cases} cases PASS` : `secrets: ${failures} checks FAILED of ${cases} cases`
)
process.exit(failures === 0 ? 0 : 1)
