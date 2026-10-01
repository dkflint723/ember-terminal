// Which commands are labelled, and how. Run: node scripts/test-risk.mjs
//
// The audit's acceptance for R29 is a table of 200 commands with their expected
// classes. A label is a warning, never a permission, so the table holds both halves:
// what must be labelled, and the ordinary commands that must not be — a warning on
// everything is a warning on nothing. Then the -WhatIf preview: offered only where it
// cannot run anything for real, and on Windows it is run, and must change nothing.
import { classifyCommand, needsSecondClick, riskSentence, visibleRisks, whatIfPreview } from '../src/shared/risk.ts'

let failures = 0
let cases = 0
const check = (label, ok, detail) => {
  cases += 1
  if (!ok) {
    failures += 1
    console.log(`  - ${label}${detail !== undefined ? ` — ${detail}` : ''}`)
  }
}

const I = 'irreversible'
const N = 'network-executes'
const E = 'elevation'
const H = 'history-rewriting'

/** [command, classes expected, in the fixed order irreversible, network, elevation, history]. */
const TABLE = [
  // --- deleting files -----------------------------------------------------------------
  ['Remove-Item .\\build -Recurse -Force', [I]],
  ['Remove-Item notes.txt', [I]],
  ['rm -rf node_modules', [I]],
  ['rm file.txt', [I]],
  ['del /s /q dist', [I]],
  ['erase old.log', [I]],
  ['rd /s /q out', [I]],
  ['rmdir build', [I]],
  ['ri *.tmp', [I]],
  ['Get-ChildItem *.log | Remove-Item', [I]],
  ['gci -Recurse -Filter *.bak | rm -Force', [I]],
  ['& rm -r .\\cache', [I]],
  ['"C:\\Windows\\System32\\cmd.exe" /c del x', []],
  ['Clear-Content .\\log.txt', [I]],
  ['clc app.log', [I]],
  ['Clear-RecycleBin -Force', [I]],
  ['shred -u secret.txt', [I]],
  ['dd if=/dev/zero of=/dev/sdb bs=1M', [I]],
  ['dd if=image.iso of=disk.img', [I]],
  ['dd --help', []],
  // --- disks and the machine -------------------------------------------------------------
  ['Format-Volume -DriveLetter E', [I]],
  ['format E: /q', [I]],
  ['Clear-Disk -Number 1 -RemoveData', [I]],
  ['Initialize-Disk 2', [I]],
  ['Remove-Partition -DriveLetter F', [I]],
  ['diskpart', [I]],
  ['Stop-Computer', [I]],
  ['Restart-Computer -Force', [I]],
  ['shutdown /r /t 0', [I]],
  ['sudo reboot', [I, E]],
  ['poweroff', [I]],
  // --- registry ---------------------------------------------------------------------------
  ['reg delete HKCU\\Software\\Foo /f', [I]],
  ['reg query HKCU\\Software', []],
  ['Remove-ItemProperty -Path HKCU:\\Software\\Foo -Name Bar', [I]],
  ['Get-ItemProperty HKCU:\\Software\\Foo', []],
  // --- infrastructure and packages -----------------------------------------------------------
  ['terraform destroy', [I]],
  ['terraform plan', []],
  ['terraform apply', []],
  ['kubectl delete pod web-1', [I]],
  ['kubectl get pods', []],
  ['docker system prune -a', [I]],
  ['docker volume rm data', [I]],
  ['docker volume prune', [I]],
  ['docker image prune -a', [I]],
  ['docker rm web -f', [I]],
  ['docker rm -f web', [I]],
  ['docker rmi app:old', [I]],
  ['docker compose down -v', [I]],
  ['docker compose down', []],
  ['Get-ChildItem *.log | ForEach-Object { Remove-Item $_ }', [I]],
  ['gci | % { rm $_ }', [I]],
  ['find . -name "*.tmp" -delete', [I]],
  ['find . -name "*.o" -exec rm {} +', [I]],
  ['find . -name "*.ts"', []],
  ['ls *.bak | xargs rm', [I]],
  ['git checkout -f main', [I]],
  ['git switch --discard-changes main', [I]],
  ['git switch main', []],
  ['aws s3 rm s3://bucket/key', [I]],
  ['aws s3 ls', []],
  ['gh repo delete me/old --yes', [I]],
  ['gh repo view', []],
  ['wsl --unregister Ubuntu', [I]],
  ['wsl -l -v', []],
  ['vssadmin delete shadows /all', [I]],
  ['cipher /w:C:\\', [I]],
  ['& ([scriptblock]::Create((irm https://x.test/a.ps1)))', [N]],
  ['echo hi\rRemove-Item -Recurse C:/x', [I]],
  ['git commit -m "x; rm -rf y"', []],
  ['git grep "drop table"', []],
  ['git commit -m "drop table migration"', []],
  ['echo "a | rm b"', []],
  ['docker ps', []],
  ['docker run --rm -it alpine sh', []],
  ['docker build -t app .', []],
  ['podman system prune', [I]],
  ['npm unpublish my-pkg@1.0.0', [I]],
  ['npm install', []],
  ['npm run build', []],
  ['npm test', []],
  ['npm exec -- cowsay hi', []],
  ['npm exec --yes cowsay', [N]],
  ['npx create-react-app my-app', []],
  ['npx prettier --check .', []],
  ['npx tsc --noEmit', []],
  ['npx -y create-vite my-app', [N]],
  ['npx create-vite@latest my-app', [N]],
  ['npx --package=cowsay cowsay hi', [N]],
  ['pnpm dlx degit user/repo', [N]],
  ['pnpm install', []],
  ['yarn dlx create-vite', [N]],
  ['yarn build', []],
  ['bunx cowsay', [N]],
  ['uvx ruff check', [N]],
  ['pipx run black .', [N]],
  ['pipx install black', []],
  ['pip install requests', []],
  ['winget install Git.Git', [N]],
  ['winget search git', []],
  ['choco install nodejs -y', [N]],
  ['scoop install ripgrep', [N]],
  ['scoop list', []],
  ['msiexec /i https://example.com/setup.msi', [N]],
  ['msiexec /i .\\setup.msi', []],
  // --- downloaded, then run ---------------------------------------------------------------------
  ['iwr https://get.example.com/install.ps1 | iex', [N]],
  ['irm https://example.com/x.ps1 | iex', [N]],
  ['Invoke-WebRequest https://x.test/a.ps1 -UseBasicParsing | Invoke-Expression', [N]],
  ['iex (irm https://example.com/x.ps1)', [N]],
  ['iex ((New-Object System.Net.WebClient).DownloadString("https://x.test/a.ps1"))', [N]],
  ['Invoke-Expression (Invoke-RestMethod https://x.test/a.ps1)', [N]],
  ['powershell -c "irm https://x.test/a.ps1 | iex"', [N]],
  ['curl -fsSL https://get.example.sh | sh', [N]],
  ['curl -sSL https://install.example.com | sudo bash', [N, E]],
  ['wget -qO- https://x.test/install.sh | bash', [N]],
  ['curl https://x.test/script.py | python3', [N]],
  ['bash <(curl -s https://x.test/install.sh)', [N]],
  ['sh -c "$(curl -fsSL https://x.test/install.sh)"', [N]],
  ['curl -O https://example.com/file.zip', []],
  ['curl https://api.github.com/repos/x/y', []],
  ['wget https://example.com/data.csv', []],
  ['iwr https://example.com/data.json -OutFile data.json', []],
  ['irm https://api.github.com/users/x', []],
  ['Invoke-Expression "Get-Date"', []],
  // --- administrator rights -------------------------------------------------------------------------
  ['Start-Process powershell -Verb RunAs', [E]],
  ["Start-Process pwsh -Verb 'RunAs'", [E]],
  ['saps notepad -Verb runas', [E]],
  ['Start-Process notepad', []],
  ['sudo apt update', [E]],
  ['sudo rm -rf /var/cache', [I, E]],
  ['gsudo winget upgrade --all', [N, E]],
  ['runas /user:Administrator cmd', [E]],
  ['doas pkg_add vim', [E]],
  ['Set-ExecutionPolicy Unrestricted', [E]],
  ['Get-ExecutionPolicy', []],
  ['Add-MpPreference -ExclusionPath C:\\tools', [E]],
  ['Set-MpPreference -DisableRealtimeMonitoring $true', [E]],
  ['Get-MpPreference', []],
  ['bcdedit /set testsigning on', [E]],
  ['takeown /f C:\\Windows\\x.dll', [E]],
  ['netsh advfirewall set allprofiles state off', [E]],
  ['netsh interface show interface', []],
  ['New-NetFirewallRule -DisplayName x -Direction Inbound', [E]],
  ['Get-NetFirewallRule', []],
  // --- git ----------------------------------------------------------------------------------------
  ['git clean -fd', [I]],
  ['git clean -xdf', [I]],
  ['git clean --force -d', [I]],
  ['git clean -n', []],
  ['git reset --hard', [I]],
  ['git reset --hard HEAD~1', [I, H]],
  ['git reset HEAD~2', [H]],
  ['git reset --soft HEAD~1', []],
  ['git reset', []],
  ['git reset HEAD file.txt', []],
  ['git checkout -- .', [I]],
  ['git checkout .', [I]],
  ['git checkout -- src/app.ts', [I]],
  ['git checkout main', []],
  ['git checkout -b feature', []],
  ['git restore src/app.ts', [I]],
  ['git restore --staged src/app.ts', []],
  ['git restore --staged --worktree x', [I]],
  ['git stash drop', [I]],
  ['git stash clear', [I]],
  ['git stash', []],
  ['git stash pop', []],
  ['git branch -D old-feature', [I]],
  ['git branch -d merged-feature', []],
  ['git branch --delete --force x', [I]],
  ['git branch', []],
  ['git push --force', [I, H]],
  ['git push -f origin main', [I, H]],
  ['git push --force-with-lease', [I, H]],
  ['git push origin +main', [I, H]],
  ['git push origin --delete old', [I]],
  ['git push origin :old', [I]],
  ['git push', []],
  ['git push -u origin feature', []],
  ['git rebase main', [H]],
  ['git rebase -i HEAD~3', [H]],
  ['git commit --amend', [H]],
  ['git commit --amend --no-edit', [H]],
  ['git commit -m "fix"', []],
  ['git filter-branch --tree-filter x HEAD', [H]],
  ['git filter-repo --path secret --invert-paths', [H]],
  ['git reflog expire --expire=now --all', [I]],
  ['git reflog', []],
  ['git gc --prune=now', [I]],
  ['git gc', []],
  ['git -C ../other reset --hard', [I]],
  ['git -c core.pager=cat clean -fdx', [I]],
  ['git status', []],
  ['git log --oneline', []],
  ['git diff', []],
  ['git fetch --all --prune', []],
  ['git pull --rebase', []],
  ['git merge main', []],
  ['git cherry-pick abc123', []],
  ['git tag v1.0', []],
  ['git worktree add ../x -b x', []],
  // --- SQL in a client --------------------------------------------------------------------------------
  ['sqlcmd -Q "DROP TABLE users"', [I]],
  ['psql -c "drop database app"', [I]],
  ['mysql -e "TRUNCATE TABLE sessions"', [I]],
  ['psql -c "select * from users"', []],
  // --- several at once ---------------------------------------------------------------------------------
  ['npm run build && git push --force', [I, H]],
  ['cd C:\\tmp; Remove-Item * -Recurse', [I]],
  ['git add . && git commit -m wip && git push', []],
  ['Get-Process node | Stop-Process', []],
  ['ls; pwd; whoami', []],
  // --- the ordinary, which must stay unlabelled -----------------------------------------------------
  ['ls -la', []],
  ['Get-ChildItem', []],
  ['dir', []],
  ['cd ..', []],
  ['Set-Location C:\\work', []],
  ['cat README.md', []],
  ['Get-Content .\\app.log -Tail 20', []],
  ['echo hello', []],
  ['Write-Output "rm -rf /"', []],
  ['mkdir build', []],
  ['New-Item -ItemType Directory out', []],
  ['Copy-Item a.txt b.txt', []],
  ['Move-Item a.txt archive\\', []],
  ['code .', []],
  ['node server.js', []],
  ['python -m venv .venv', []],
  ['pytest -q', []],
  ['cargo build --release', []],
  ['go test ./...', []],
  ['dotnet build', []],
  ['make', []],
  ['ssh user@host', []],
  ['grep -r "TODO" src', []],
  ['Select-String -Path *.ts -Pattern TODO', []],
  ['Get-Service', []],
  ['tasklist', []],
  ['ping example.com', []],
  ['Test-NetConnection example.com -Port 443', []],
  ['history', []],
  ['claude', []],
  ['format-table', []],
  ['Format-List *', []],
  ['Get-Date | Format-Table', []]
]

check(`the table has 200 commands`, TABLE.length >= 200, String(TABLE.length))
for (const [command, want] of TABLE) {
  const got = classifyCommand(command).map((r) => r.class)
  check(`${command} → [${want.join(', ')}]`, got.join(',') === want.join(','), `[${got.join(', ')}]`)
}

// --- what is shown, and what takes a second click --------------------------------------------------
const both = classifyCommand('sudo rm -rf /var/cache')
check('every label at the default sensitivity', visibleRisks(both, 'all').length === 2)
check('only what cannot be undone, when asked for that', visibleRisks(both, 'irreversible').map((r) => r.class).join() === 'irreversible')
check('none, when turned off', visibleRisks(both, 'off').length === 0)
check('a second click for anything irreversible', needsSecondClick(classifyCommand('git reset --hard'), false))
check('but not for the other classes, in an ordinary window', !needsSecondClick(classifyCommand('npx -y foo'), false))
check('in the administrator’s window, for anything labelled', needsSecondClick(classifyCommand('npx -y foo'), true))
check('and nothing for nothing', !needsSecondClick([], true))
check('each risk says why', classifyCommand('git push --force').every((r) => r.why.length > 10))
check('a paste’s question is told in a sentence', /^Among them is something that deletes files outright/.test(riskSentence(classifyCommand('rm -rf x'))), riskSentence(classifyCommand('rm -rf x')))
check('and nothing, for nothing', riskSentence([]) === '')

// --- -WhatIf, only where it cannot run anything for real ------------------------------------------------
const preview = (c) => whatIfPreview(c)
check('a lone cmdlet that honours it is previewed', preview('Remove-Item .\\build -Recurse') === 'Remove-Item .\\build -Recurse -WhatIf', String(preview('Remove-Item .\\build -Recurse')))
check('an alias by the cmdlet’s full name, which cmd and bash cannot run', preview('rm .\\x.txt') === 'Remove-Item .\\x.txt -WhatIf', String(preview('rm .\\x.txt')))
check('with an environment variable', preview('Remove-Item $env:TEMP\\x') === 'Remove-Item $env:TEMP\\x -WhatIf', String(preview('Remove-Item $env:TEMP\\x')))
check('after readers in a pipeline', preview('Get-ChildItem *.tmp | Remove-Item') === 'Get-ChildItem *.tmp | Remove-Item -WhatIf')
for (const unsafe of [
  'Remove-Item x; Remove-Item y',
  'Get-ChildItem | ForEach-Object { Remove-Item $_ }',
  'Remove-Item $(Get-Content list.txt)',
  'iwr https://x | iex',
  'Remove-Item x -WhatIf',
  'Remove-Item x > out.txt',
  'Invoke-Command { Remove-Item x }',
  '& Remove-Item x',
  'git reset --hard',
  'npm install | Remove-Item x',
  'Stop-Process -Name node && Remove-Item x',
  'Remove-Item `\n x',
  // QA's, each of which ran its deletion for real before the allowlist:
  "Remove-Item 'x' # tidy up",
  "Remove-Item (Remove-Item 'x')",
  "Remove-Item ([IO.File]::Delete('x'))",
  "Get-Item (Remove-Item 'x') | Remove-Item",
  "Remove-Item $ExecutionContext.InvokeCommand.InvokeScript('Remove-Item x')",
  '.\\remove-item.ps1 x',
  'C:\\x\\get-thing.ps1 | Remove-Item',
  'Remove-Item a\rRemove-Item b',
  'Remove-Item "a|b"',
  "Remove-Item 'unbalanced",
  'Remove-Item x -wh'
]) {
  check(`no preview for ${JSON.stringify(unsafe)}`, preview(unsafe) === null, String(preview(unsafe)))
}

/*
 * --- and the preview, run, changes nothing -----------------------------------------------------------
 *
 * The acceptance: -WhatIf previews run without changing anything. In each PowerShell
 * there is, a file is "removed" with the preview, and must still be there.
 */
if (process.platform === 'win32') {
  const { spawnSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ember-whatif-'))
  const file = path.join(dir, 'keep.txt')
  fs.writeFileSync(file, 'still here')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    const line = whatIfPreview(`Get-ChildItem '${dir}' | Remove-Item`)
    const run = spawnSync(shell, ['-NoProfile', '-Command', line], { encoding: 'utf8' })
    if (run.error) continue
    check(`${shell}: the preview says what it would do`, /What if/i.test(run.stdout ?? ''), (run.stdout ?? '').slice(0, 120))
    check(`${shell}: and does nothing`, fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'still here')
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`command risk: ${cases} cases ${failures === 0 ? 'PASS' : `FAIL (${failures})`}`)
process.exit(failures === 0 ? 0 : 1)
