// Table test for secret-prompt detection. Run: node scripts/test-secret-prompt.mjs
//
// Driving a real shell to reproduce every vendor's prompt wording is slow and
// flaky, so the wordings are pinned here instead — taken from the actual output of
// sudo, OpenSSH, git credential helpers, PowerShell and common 2FA flows.
import { looksLikeSecretPrompt } from '../src/shared/secrets.ts'

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
  'Cloning into repo...\nUsername: dkfli\nPassword:'
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
console.log(
  failures === 0
    ? `secret-prompt detection: ${total}/${total} PASS`
    : `secret-prompt detection: ${failures}/${total} FAILED`
)
process.exit(failures === 0 ? 0 : 1)
