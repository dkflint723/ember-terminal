# Ember shell integration for PowerShell.
#
# Emits OSC 133 "semantic prompt" sequences so the UI can slice the byte stream
# into command blocks, plus OSC 7 for the working directory. This mirrors the
# FinalTerm/iTerm2 convention that VS Code also implements:
#
#   OSC 133;A  prompt start
#   OSC 133;B  prompt end / command input begins
#   OSC 133;C  command output begins
#   OSC 133;D;<exit>  command finished
#
# Ember additionally reads OSC 633;E;<cmdline> to learn the command text when the
# user typed it into the shell directly rather than through Ember's editor.

if ($env:EMBER_INTEGRATION_LOADED -eq '1') { return }
$env:EMBER_INTEGRATION_LOADED = '1'

$Global:__EmberESC = [char]0x1b
$Global:__EmberBEL = [char]0x07

<#
  Ask PowerShell to write its colours into the stream.

  Blocks are cut out of the pty byte stream between the markers below, and under
  the default rendering PowerShell colours its output by setting console
  attributes rather than by emitting escape sequences. ConPTY then carries those
  colours in the screen repaints it sends at its own frame boundaries — which
  routinely fall outside a command's markers, so the bytes a block is built from
  held the text and none of the styling. A directory listing came back as plain
  text with the colour visible only on the live screen.

  `Ansi` makes PowerShell emit the sequences itself, in line with the text it is
  colouring, so what a block is cut from is what was on screen. It is also what
  PowerShell already does when it detects a capable terminal; naming it here stops
  the answer depending on that detection.
#>
if ($null -ne $PSStyle) {
  try {
    $PSStyle.OutputRendering = 'Ansi'
  } catch {
    # Older hosts have no such setting, and a shell that will not load its
    # integration is a worse outcome than a block without colour in it.
  }
}

function Global:__Ember-Escape([string]$value) {
  if ($null -eq $value) { return '' }
  # Backslash-escape the control characters that would otherwise terminate the
  # OSC string, so arbitrary command text and paths survive the round trip.
  $value = $value.Replace('\', '\\')
  $value = $value.Replace("`n", '\x0a')
  $value = $value.Replace("`r", '\x0d')
  $value = $value.Replace(';', '\x3b')
  $value = $value.Replace("$([char]0x1b)", '\x1b')
  $value = $value.Replace("$([char]0x07)", '\x07')
  return $value
}

$Global:__EmberOriginalPrompt = $function:Prompt

function Global:Prompt {
  # Capture success/exit state before anything else can clobber it.
  $succeeded = $global:?
  <#
    PowerShell never resets $LASTEXITCODE. It only ever holds the exit code of the
    last *native* process, so after `cmd /c exit 7` every failing cmdlet reported 7
    — a wrong number, which is worse than no number, because the block showed it as
    the command's own result.

    So it is only believed when it changed during this command. Anything else that
    failed is a cmdlet failure, which has no exit code of its own; 1 is the
    conventional stand-in.
  #>
  $currentExit = $global:LASTEXITCODE
  $nativeRan = $currentExit -ne $Global:__EmberLastExit
  $Global:__EmberLastExit = $currentExit
  $lastExit = if ($succeeded) { 0 } elseif ($nativeRan -and $currentExit) { $currentExit } else { 1 }

  $out = ''
  # Close the previous command, unless this is the very first prompt.
  if ($Global:__EmberFirstPrompt -ne $false) {
    $Global:__EmberFirstPrompt = $false
  } else {
    $out += "$__EmberESC]133;D;$lastExit$__EmberBEL"
  }

  $out += "$__EmberESC]133;A$__EmberBEL"

  $cwd = (Get-Location).Path
  $out += "$__EmberESC]633;P;Cwd=$(__Ember-Escape $cwd)$__EmberBEL"

  # Preserve whatever prompt the user already had (oh-my-posh, starship, etc).
  $inner = ''
  try { $inner = [string](& $Global:__EmberOriginalPrompt) } catch { $inner = "PS $cwd> " }
  $out += $inner

  $out += "$__EmberESC]133;B$__EmberBEL"
  return $out
}

# PSReadLine drives interactive line editing, including the Enter that Ember
# synthesises when it writes a command into the pty. Hooking AcceptLine is how we
# learn the final command text and mark the output boundary.
if (Get-Module -ListAvailable -Name PSReadLine) {
  Import-Module PSReadLine -ErrorAction SilentlyContinue

  function Global:__Ember-AcceptLine([string]$handler) {
    $line = ''
    $cursor = 0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    $Host.UI.Write("$__EmberESC]633;E;$(__Ember-Escape $line)$__EmberBEL")
    $Host.UI.Write("$__EmberESC]133;C$__EmberBEL")
    switch ($handler) {
      'AcceptLine' { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() }
      'ValidateAndAcceptLine' { [Microsoft.PowerShell.PSConsoleReadLine]::ValidateAndAcceptLine() }
    }
  }

  Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
    __Ember-AcceptLine 'AcceptLine'
  }
  Set-PSReadLineKeyHandler -Chord 'Ctrl+Enter' -ScriptBlock {
    __Ember-AcceptLine 'AcceptLine'
  }
}

# Tell Ember the integration is live; the UI falls back to raw mode until it
# sees this, so a shell without integration still works, just without blocks.
$Host.UI.Write("$__EmberESC]633;Ready$__EmberBEL")
