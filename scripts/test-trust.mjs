// Which folders may run their own code. Run: node scripts/test-trust.mjs
//
// Opening a repository is not agreeing to run it, and the actions that blurred
// that line did not look like running anything: formatting loads the project's
// prettier config, Tab starts a completion helper, a launch configuration and a
// package script are somebody else's command lines.
//
// The rules below are the ones a trust check lives or dies by: containment, so a
// file deep in a trusted project is covered; canonical comparison, so the same
// folder spelled differently is the same folder; and revocation that actually
// revokes, rather than leaving a subtree trusted after its root was withdrawn.
import {
  isTrustedPath,
  mayRunFolderCode,
  mayRunIn,
  withTrust,
  withoutTrust
} from '../src/shared/trust.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const TRUSTED = ['C:\\projects\\ember']

// --- containment ---------------------------------------------------------------------
cases += 5
check('the folder itself is trusted', isTrustedPath('C:\\projects\\ember', TRUSTED))
check('and a file inside it', isTrustedPath('C:\\projects\\ember\\src\\main.ts', TRUSTED))
check('and one further down', isTrustedPath('C:\\projects\\ember\\a\\b\\c\\d.ts', TRUSTED))
check('a sibling is not', !isTrustedPath('C:\\projects\\other\\x.ts', TRUSTED))
// The one that matters: a folder whose name merely starts the same way.
check('nor is a folder that only shares a prefix', !isTrustedPath('C:\\projects\\ember-evil\\x.ts', TRUSTED))

// --- spelling, which is how a check like this gets walked around -----------------------
cases += 4
check('capitalisation does not change the answer', isTrustedPath('c:\\PROJECTS\\Ember\\src\\a.ts', TRUSTED))
check('nor do forward slashes', isTrustedPath('C:/projects/ember/src/a.ts', TRUSTED))
check('nor a trailing separator on the trusted root', isTrustedPath('C:\\projects\\ember\\a.ts', ['C:\\projects\\ember\\']))
check('an empty trusted entry trusts nothing', !isTrustedPath('C:\\projects\\ember\\a.ts', ['']))

// --- nothing trusted by default --------------------------------------------------------
cases += 3
check('an empty list trusts nothing', !isTrustedPath('C:\\projects\\ember\\a.ts', []))
const noFolder = mayRunFolderCode(null, TRUSTED)
check('no folder at all is not trusted', !noFolder.trusted, JSON.stringify(noFolder))
check('and says why', typeof noFolder.reason === 'string' && noFolder.reason.length > 0, JSON.stringify(noFolder))

cases += 3
const restricted = mayRunFolderCode('C:\\downloads\\zip\\x.ts', TRUSTED)
check('an untrusted folder is refused', !restricted.trusted, JSON.stringify(restricted))
check('with a reason a person can read', /restricted/i.test(restricted.reason ?? ''), JSON.stringify(restricted))
check('a trusted one is allowed', mayRunFolderCode('C:\\projects\\ember\\x.ts', TRUSTED).trusted)

// --- granting ---------------------------------------------------------------------------
cases += 4
check('trusting adds the folder', withTrust([], 'C:\\a').includes('C:\\a'))
check('trusting twice does not duplicate it', withTrust(['C:\\a'], 'C:\\a').length === 1, JSON.stringify(withTrust(['C:\\a'], 'C:\\a')))
check(
  'trusting a child of a trusted folder changes nothing',
  withTrust(['C:\\a'], 'C:\\a\\b').length === 1,
  JSON.stringify(withTrust(['C:\\a'], 'C:\\a\\b'))
)
// Trusting the parent subsumes the child, or revoking the parent would quietly
// leave the child trusted.
check(
  'trusting a parent absorbs a child already trusted',
  JSON.stringify(withTrust(['C:\\a\\b'], 'C:\\a')) === JSON.stringify(['C:\\a']),
  JSON.stringify(withTrust(['C:\\a\\b'], 'C:\\a'))
)

// --- revoking ----------------------------------------------------------------------------
cases += 4
check('revoking removes the folder', !withoutTrust(['C:\\a'], 'C:\\a').includes('C:\\a'))
check(
  'revoking a parent revokes what was under it',
  withoutTrust(['C:\\a\\b', 'C:\\other'], 'C:\\a').length === 1,
  JSON.stringify(withoutTrust(['C:\\a\\b', 'C:\\other'], 'C:\\a'))
)
check(
  'revoking a child of a trusted parent takes the trust with it',
  withoutTrust(['C:\\a'], 'C:\\a\\b').length === 0,
  JSON.stringify(withoutTrust(['C:\\a'], 'C:\\a\\b'))
)
check('revoking something untrusted leaves the rest alone', withoutTrust(['C:\\a'], 'C:\\z').length === 1)

/* --- the way back ---------------------------------------------------------------
 *
 * `workspaceTrust: false` restores what this replaced: every open folder may run
 * its own code. It is checked in one place so it cannot be honoured at three call
 * sites and forgotten at the fourth, which is the only way a rollback is worth
 * having — so the one place is worth its own cases.
 */
cases += 4
check(
  'with trust switched off, an untrusted folder may run',
  mayRunIn('C:\\downloads\\zip\\x.ts', { trustedFolders: [], workspaceTrust: false }).trusted
)
check(
  'with it on, the same folder may not',
  !mayRunIn('C:\\downloads\\zip\\x.ts', { trustedFolders: [], workspaceTrust: true }).trusted
)
// Absent means on: a settings file written before this existed must not read as
// permission to run everything.
check(
  'and an unset switch means on, not off',
  !mayRunIn('C:\\downloads\\zip\\x.ts', { trustedFolders: [] }).trusted
)
check(
  'a trusted folder is allowed either way',
  mayRunIn('C:\\projects\\ember\\x.ts', { trustedFolders: TRUSTED, workspaceTrust: true }).trusted
)

/*
 * --- a second name for the same folder --------------------------------------------
 *
 * The spelling cases above are the easy half: capitalisation and separators are
 * the differences a string can forgive. An 8.3 short name and a junction are not —
 * C:\Users\RUNNER~1 and C:\Users\runneradmin share no text to compare — so main
 * keeps the trusted list by each folder's real name and the caller brings the real
 * name of what it asks about. These are the rules for using it; that main actually
 * resolves both sides is verify-scripts' to show, against a real junction.
 */
const REAL = ['C:\\Users\\runneradmin\\proj']
cases += 5
check(
  'a folder asked about by its short name is trusted by its real one',
  mayRunIn('C:\\Users\\RUNNER~1\\proj', { trustedFolders: REAL }, 'C:\\Users\\runneradmin\\proj').trusted
)
check(
  'and so is a file inside it',
  mayRunFolderCode('C:\\Users\\RUNNER~1\\proj\\a.ts', REAL, 'C:\\Users\\runneradmin\\proj\\a.ts').trusted
)
check(
  'the name as given still counts before the real one is known',
  mayRunIn('C:\\Users\\runneradmin\\proj', { trustedFolders: REAL }, null).trusted
)
check(
  'a real name elsewhere does not borrow the trust of the spelling',
  !mayRunIn('C:\\link', { trustedFolders: REAL }, 'D:\\elsewhere').trusted
)
check(
  'and without its real name a short spelling is only its own text',
  !mayRunIn('C:\\Users\\RUNNER~1\\proj', { trustedFolders: REAL }).trusted
)

console.log(
  failures === 0 ? `workspace trust: ${cases} cases PASS` : `workspace trust: ${failures} checks FAILED of ${cases} cases`
)
process.exit(failures === 0 ? 0 : 1)
