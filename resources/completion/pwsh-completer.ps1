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
