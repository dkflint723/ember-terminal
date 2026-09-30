// Where a proposed file would be written, and whether that matters. Run: node scripts/test-proposal-path.mjs
//
// A proposal's path was joined to the terminal's folder with `..` left in, and nothing
// said where it led (audit R27, SE-05). This holds the resolver and the judgement.
import { assessProposal, insideFolder, resolveProposalPath } from '../src/shared/proposal-path.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}
const eq = (label, got, want) => check(label, got === want, `${got} ≠ ${want}`)

const cwd = 'C:\\work\\proj'
eq('a relative path joins the folder', resolveProposalPath('src/a.ts', cwd), 'C:\\work\\proj\\src\\a.ts')
eq('./ is nothing', resolveProposalPath('./a.ts', cwd), 'C:\\work\\proj\\a.ts')
eq('.. climbs out', resolveProposalPath('..\\..\\x.ps1', cwd), 'C:\\x.ps1')
eq('and no further than the drive', resolveProposalPath('..\\..\\..\\..\\x', cwd), 'C:\\x')
eq('.. in the middle of an absolute path too', resolveProposalPath('C:\\work\\proj\\..\\other\\.git\\hooks\\pre-commit', cwd), 'C:\\work\\other\\.git\\hooks\\pre-commit')
eq('forward slashes become the system’s', resolveProposalPath('C:/a/b/../c.txt', cwd), 'C:\\a\\c.txt')
eq('a UNC share keeps its server and share', resolveProposalPath('\\\\srv\\share\\..\\..\\x', cwd), '\\\\srv\\share\\x')
eq('doubled separators collapse', resolveProposalPath('a\\\\b.ts', cwd), 'C:\\work\\proj\\a\\b.ts')

check('inside is inside', insideFolder('C:\\work\\proj', 'c:/WORK/proj/src/a.ts'))
check('a sibling sharing a prefix is not', !insideFolder('C:\\work\\proj', 'C:\\work\\project2\\a.ts'))
check('no folder has nothing inside', !insideFolder('', 'C:\\a'))

const inside = assessProposal('C:\\work\\proj\\src\\a.ts', cwd)
check('a file in the project is not outside, and not risky', !inside.outside && inside.risk === null, JSON.stringify(inside))
check('one outside it is', assessProposal('C:\\work\\a.ts', cwd).outside)
check('with no project, everything is outside', assessProposal('C:\\work\\proj\\a.ts', null).outside)
const risky = (p, words) => {
  const r = assessProposal(p, cwd).risk ?? ''
  check(`${p}: ${words}`, r.toLowerCase().includes(words), r)
}
risky('C:\\work\\proj\\.git\\hooks\\pre-commit', 'git hook')
risky('C:\\Users\\me\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1', 'powershell starts')
risky('C:\\Users\\me\\Documents\\WindowsPowerShell\\profile.ps1', 'powershell')
risky('C:\\Users\\me\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\run.cmd', 'sign in to windows')
risky('C:\\Users\\me\\.ssh\\authorized_keys', '.ssh')
risky('C:\\work\\proj\\.vscode\\tasks.json', 'what to run')
risky('C:\\work\\proj\\.claude\\settings.local.json', 'claude code')
risky('C:\\Users\\me\\.claude\\settings.json', 'claude code')
risky('C:\\work\\proj\\.husky\\pre-commit', 'git hook')
check('an ordinary .ps1 in the project is not flagged', assessProposal('C:\\work\\proj\\build.ps1', cwd).risk === null)

console.log(`proposal path: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
