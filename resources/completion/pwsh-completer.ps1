# Completion side-channel for PowerShell panes.
#
# Ember replaces the shell's own line editor with its input editor, which means
# PSReadLine's Tab completion is out of reach. Rather than approximate it, this
# script exposes PowerShell's real completion engine — the same
# CommandCompletion::CompleteInput that PSReadLine calls — so cmdlets, parameter
# names, enum values and registered argument completers all behave as they should.
#
# It runs as a separate process from the interactive shell on purpose: querying the
# live pty would mean writing into the user's prompt and cleaning up after it.
# The trade is that session-local functions and variables are not visible here.
#
# Protocol: one JSON request per line on stdin, one JSON response per line on
# stdout. Always exactly one response per request, so the caller can never hang.

$ErrorActionPreference = 'Stop'
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Write-Response($payload) {
  $json = $payload | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
  [Console]::Out.Flush()
}

# Warm the engine before saying so. The first CompleteInput in a fresh process
# loads PowerShell's command table, which on a slow machine takes longer than a
# Tab can wait — the first completion of a session then came back empty. Done
# here, "ready" means the next answer will be quick.
try { [void][System.Management.Automation.CommandCompletion]::CompleteInput('Get-ChildIt', 11, $null) } catch { }

# Announce readiness so the host does not send queries into a starting process.
Write-Response @{ type = 'ready' }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }

  $id = -1
  try {
    $req = $line | ConvertFrom-Json
    $id = $req.id

    # Completion is relative to the pane's directory; a bad path must not be fatal.
    if ($req.cwd) {
      try { Set-Location -LiteralPath $req.cwd -ErrorAction Stop } catch { }
    }

    $result = [System.Management.Automation.CommandCompletion]::CompleteInput(
      [string]$req.input, [int]$req.cursor, $null)

    # A switch is not a path.
    #
    # PowerShell reads a token beginning with `/` as a path from the root of the
    # current drive, which is right for `cd /Users` and actively harmful for the
    # whole family of native Windows tools that take `/switches` — dism, robocopy,
    # sfc, chkdsk, ipconfig, reg, icacls. Typing `dism /On` and pressing Tab
    # replaced the switch with `C:\OneDriveTemp`: not a completion at all, since it
    # shares nothing with what was typed, and it destroys the line it lands in.
    #
    # This is PowerShell's own behaviour rather than anything Ember added — a bare
    # console does the same — but faithfully reproducing a surprise is not a reason
    # to keep it. So when the token being completed starts with `/` AND the command
    # it belongs to is a native executable rather than a cmdlet, filesystem answers
    # are dropped. Nothing is offered instead of the wrong thing, which is what Tab
    # doing nothing already means everywhere else.
    #
    # Narrowed to native commands on purpose: `cd /Users` is a real PowerShell
    # gesture and keeps working, because `Set-Location` is not an Application.
    if ($result -and $result.CompletionMatches -and $result.ReplacementLength -ge 0) {
      $token = ''
      if ($result.ReplacementIndex -ge 0 -and
          $result.ReplacementIndex + $result.ReplacementLength -le ([string]$req.input).Length) {
        $token = ([string]$req.input).Substring($result.ReplacementIndex, $result.ReplacementLength)
      }
      if ($token.StartsWith('/')) {
        $head = (([string]$req.input).TrimStart() -split '\s+')[0]
        $native = $false
        if ($head) {
          try {
            $cmd = Get-Command -Name $head -ErrorAction Stop | Select-Object -First 1
            $native = ($cmd.CommandType -eq 'Application')
          } catch {
            # An unknown head is not a cmdlet, and a path offered for its switch is
            # no more welcome for being unrecognised.
            $native = $true
          }
        }
        if ($native) {
          $kept = @($result.CompletionMatches | Where-Object {
            $_.ResultType -ne 'ProviderItem' -and $_.ResultType -ne 'ProviderContainer'
          })
          $result = [System.Management.Automation.CommandCompletion]::new(
            [System.Collections.ObjectModel.Collection[System.Management.Automation.CompletionResult]]$kept,
            -1, $result.ReplacementIndex, $result.ReplacementLength)
        }
      }
    }

    $matches = @()
    if ($result -and $result.CompletionMatches) {
      $matches = @(
        $result.CompletionMatches |
          Select-Object -First 300 |
          ForEach-Object {
            @{
              text  = [string]$_.CompletionText
              label = [string]$_.ListItemText
              type  = [string]$_.ResultType
              tip   = [string]$_.ToolTip
            }
          }
      )
    }

    Write-Response @{
      type          = 'result'
      id            = $id
      replaceIndex  = [int]$result.ReplacementIndex
      replaceLength = [int]$result.ReplacementLength
      matches       = $matches
    }
  } catch {
    Write-Response @{ type = 'result'; id = $id; matches = @(); error = "$($_.Exception.Message)" }
  }
}
