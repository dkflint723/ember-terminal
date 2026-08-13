// Table test for secret-prompt detection. Run: node scripts/test-secret-prompt.mjs
//
// Driving a real shell to reproduce every vendor's prompt wording is slow and
// flaky, so the wordings are pinned here instead — taken from the actual output of
// sudo, OpenSSH, git credential helpers, PowerShell and common 2FA flows.
import { containsInlineSecret, looksLikeSecretPrompt } from '../src/shared/secrets.ts'

const SHOULD_MASK = [
  '[sudo] password for dkfli:',
  '[sudo] password for dkfli: ',
  "dkfli@example.com's password:",
  "Enter passphrase for key '/c/Users/dkfli/.ssh/id_ed25519':",
  'Enter passphrase (empty for no passphrase):',
  'Enter same passphrase again:',
  "Password for 'https://dkfli@github.com':",
  'Password:',
  'password:',
  'Enter PIN for authenticator:',
  'Verification code:',
  'Enter the one-time code:',
  'Two-factor authentication code:',
  'Enter your authentication code:',
  // Redrawn in place; only the segment after the last \r is on screen.
  'downloading...\rPassword:',
  // Preceded by unrelated output on earlier lines.
  'Cloning into repo...\nUsername: dkfli\nPassword:',
  // ConPTY repaints rather than stopping at the prompt: PowerShell's Read-Host
  // emits the prompt, a CRLF and an erase, then moves the cursor back up to sit
  // after the colon. Taken as "the last line", this is blank. Verbatim from a pty
  // read, with the escape sequences left in so the stripping is exercised too.
  '\x1b[?25l\r\nPassword:\x1b[K\r\n\x1b[K\x1b[17;11H\x1b[?25h',
  // The same shape without the escapes, which is what survives stripping.
  '\r\nPassword:\r\n',
  'Enter passphrase:\r\n\r\n'
]

const SHOULD_NOT_MASK = [
  'Name:',
  'Enter your name:',
  'Continue? [y/N]',
  'Select an option:',
  'PS D:\\git_projects\\terminal>',
  'Username:',
  'Sorry, try again.',
  'Permission denied, please try again.',
  'sudo: 1 incorrect password attempt',
  'Password incorrect:',
  'Authentication failed:',
  'Usage: ssh-keygen [-q] [-b bits] passphrase:',
  'Note: your password will be stored:',
  'Password changed:',
  'Password updated successfully:',
  // Mentions a password but is not asking for one now.
  'The password file was copied to /tmp:',
  ''
]

let failures = 0

for (const text of SHOULD_MASK) {
  if (!looksLikeSecretPrompt(text)) {
    console.log(`FAIL (should mask):     ${JSON.stringify(text)}`)
    failures++
  }
}
for (const text of SHOULD_NOT_MASK) {
  if (looksLikeSecretPrompt(text)) {
    console.log(`FAIL (should NOT mask): ${JSON.stringify(text)}`)
    failures++
  }
}

const total = SHOULD_MASK.length + SHOULD_NOT_MASK.length

// Commands that must never be written to persistent history.
const SHOULD_NOT_PERSIST = [
  'mysql -u root -pSuperSecret123',
  'curl -H "Authorization: Bearer sk-ant-abc123" https://api.example.com',
  'docker login --password hunter2 --username me',
  'gh auth login --token ghp_abcdefghijklmnop',
  'export API_KEY=sk-live-1234567890',
  'PASSWORD=letmein ./deploy.sh',
  'psql postgres://user:secretpw@localhost:5432/db',
  'aws configure set aws_secret_access_key AKIAIOSFODNN7EXAMPLE --secret abc123'
]

const SHOULD_PERSIST = [
  'git push origin main',
  'npm run build',
  'docker login --username me --password-stdin',
  'echo $env:PASSWORD',
  'kubectl get pods -n prod',
  'ls -la',
  'ssh user@host',
  'grep -rn "token" src/',
  'git commit -m "add password reset flow"',
  'code --diff a.txt b.txt',
  'tar -xzf archive.tar.gz'
]

for (const cmd of SHOULD_NOT_PERSIST) {
  if (!containsInlineSecret(cmd)) {
    console.log(`FAIL (should NOT persist): ${JSON.stringify(cmd)}`)
    failures++
  }
}
for (const cmd of SHOULD_PERSIST) {
  if (containsInlineSecret(cmd)) {
    console.log(`FAIL (should persist):     ${JSON.stringify(cmd)}`)
    failures++
  }
}

const total2 = total + SHOULD_NOT_PERSIST.length + SHOULD_PERSIST.length
console.log(
  failures === 0
    ? `secret handling: ${total2}/${total2} PASS`
    : `secret handling: ${failures} of ${total2} FAILED`
)
process.exit(failures === 0 ? 0 : 1)
