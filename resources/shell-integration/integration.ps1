# Ember shell integration for PowerShell.
#
# Emits OSC 133 "semantic prompt" sequences so the UI can slice the byte stream
# into command blocks, plus Ember's own OSC 633 markers for the things 133 has no
# room for: the working directory, the command line as the shell finally read it,
# and the fact that integration is live.
#
#   OSC 133;A  prompt start
#   OSC 133;B  prompt end / command input begins
#   OSC 633;C;<nonce>          command output begins
#   OSC 633;D;<exit>;<nonce>   command finished
#   OSC 633;E;<cmdline>;<nonce>
#   OSC 633;P;Cwd=<dir>;<nonce>
#   OSC 633;Ready;<nonce>
#
# Every Ember marker carries the nonce this shell was started with, because a
# marker is only worth as much as the proof that the shell printed it: anything
# that can print could otherwise move the pane to another directory or rename the
# command a block records. `cat` of a file is enough. The nonce arrives in the
# environment, which output cannot reach.

if ($env:EMBER_INTEGRATION_LOADED -eq '1') { return }
$env:EMBER_INTEGRATION_LOADED = '1'

$Global:__EmberESC = [char]0x1b
$Global:__EmberBEL = [char]0x07
# Empty when Ember started this shell the old way; the marks below then go out
# unsigned and the window falls back to believing them, which is what that
# fallback costs.
$Global:__EmberNonce = if ($env:EMBER_NONCE) { [string]$env:EMBER_NONCE } else { '' }

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
  # OSC string, so arbitrary command text and paths survive the round trip — and
  # so the nonce is unambiguously the last `;` field, whatever is in the value.
  $value = $value.Replace('\', '\\')
  $value = $value.Replace("`n", '\x0a')
  $value = $value.Replace("`r", '\x0d')
  $value = $value.Replace(';', '\x3b')
  $value = $value.Replace("$([char]0x1b)", '\x1b')
  $value = $value.Replace("$([char]0x07)", '\x07')
  return $value
}

# One Ember marker, signed if this shell has a nonce to sign it with.
function Global:__Ember-Mark([string]$body) {
  if ($Global:__EmberNonce) {
    return "$__EmberESC]633;$body;$Global:__EmberNonce$__EmberBEL"
  }
  return "$__EmberESC]633;$body$__EmberBEL"
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
  $first = $Global:__EmberFirstPrompt -ne $false
  if ($first) {
    $Global:__EmberFirstPrompt = $false
  } else {
    $out += "$__EmberESC]133;D;$lastExit$__EmberBEL"
    $out += (__Ember-Mark "D;$lastExit")
  }

  $out += "$__EmberESC]133;A$__EmberBEL"

  <#
    Draw the prompt from the top of an empty console.

    PSReadLine remembers the row its prompt started on and never asks again, so a
    console made shorter under a waiting prompt leaves that row past the bottom:
    the next key it draws throws, prints PSReadLine's bug report, and puts up a
    fresh prompt before it runs the line. Ember changes the console's height
    between commands — the live strip is a share of the room the blocks leave —
    and after anything long the prompt sits on the last row, so the first few
    commands in a pane did exactly that. From the top row, no height can strand it.

    Nothing is lost by it. The console is cleared again when the next line is
    accepted, Ember has already emptied its own view, and the command before this
    prompt was captured by its end marker above. The very first prompt is left
    alone, so whatever a profile printed on the way in is still there to be seen.
  #>
  if (-not $first) {
    $out += "$__EmberESC[H$__EmberESC[2J$__EmberESC[3J"
  }

  $cwd = (Get-Location).Path
  $out += (__Ember-Mark "P;Cwd=$(__Ember-Escape $cwd)")

  # Preserve whatever prompt the user already had (oh-my-posh, starship, etc).
  $inner = ''
  try { $inner = [string](& $Global:__EmberOriginalPrompt) } catch { $inner = "PS $cwd> " }
  $out += $inner

  $out += "$__EmberESC]133;B$__EmberBEL"
  return $out
}

# PSReadLine drives interactive line editing, including the Enter that Ember
# synthesises when it writes a command into the pty. Hooking Enter is how we learn
# the final command text and mark the output boundary.
if (Get-Module -ListAvailable -Name PSReadLine) {
  Import-Module PSReadLine -ErrorAction SilentlyContinue

  <#
    Whatever was on Enter before this, so it still happens.

    Replacing the binding outright — which is what this did — quietly took away
    whatever the user's own profile had put there: PSFzf, a validating handler, a
    custom accept. Only a named PSReadLine function can be called back; a handler
    bound as a script block is not readable from here, and for that one case
    AcceptLine is the honest approximation, since it is what Enter means by
    default.
  #>
  $Global:__EmberPrevEnter = 'AcceptLine'
  try {
    $bound = Get-PSReadLineKeyHandler -Bound | Where-Object { $_.Key -eq 'Enter' } | Select-Object -First 1
    if ($bound -and $bound.Function) { $Global:__EmberPrevEnter = [string]$bound.Function }
  } catch {
    # An older PSReadLine without -Bound; the default stands.
  }

  function Global:__Ember-AcceptLine {
    $line = ''
    $cursor = 0
    [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
    $Host.UI.Write((__Ember-Mark "E;$(__Ember-Escape $line)"))
    <#
      Clear the console before the command runs, so a block can only contain what
      that command printed.

      A block is cut from the bytes between the markers, and conpty does not stream
      those bytes — it repaints. It keeps its own console screen buffer, and when it
      decides to redraw it sends the whole of that buffer from home. The buffer
      holds everything the session has printed, so the redraw lands inside whatever
      command happens to be running and that command's block ends up holding the
      output of the ones before it. `cd .`, which prints nothing at all, measured 22
      rows and 450px of other commands' output.

      Ember clears its own terminal after each command, which is why the screen
      still looks right — but conpty is never told, so the two disagree and the
      redraw is conpty resending a screen Ember has already thrown away. Removing
      Ember's clear changes nothing, measured; conpty repaints from its own buffer
      regardless. The console itself has to be cleared, and only the shell can do
      that, because a write from Ember's side would be input to the shell rather
      than a command to the console.

      Cleared here rather than after the previous command so there is no window in
      which a redraw can carry the old screen: from this point the console holds
      this command and nothing else, so whatever conpty chooses to resend is this
      command's own output. Ember's own clear stays, since it is what empties the
      live view while the shell is idle.
    #>
    $Host.UI.Write("$__EmberESC[H$__EmberESC[2J$__EmberESC[3J")
    $Host.UI.Write("$__EmberESC]133;C$__EmberBEL")
    $Host.UI.Write((__Ember-Mark 'C'))

    $name = $Global:__EmberPrevEnter
    $method = [Microsoft.PowerShell.PSConsoleReadLine].GetMethod($name, [type[]]@())
    if ($method) { $method.Invoke($null, @()) }
    else { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() }
  }

  Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock { __Ember-AcceptLine }
  Set-PSReadLineKeyHandler -Chord 'Ctrl+Enter' -ScriptBlock { __Ember-AcceptLine }
}

# Tell Ember the integration is live; the UI falls back to raw mode until it
# sees this, so a shell without integration still works, just without blocks.
$Host.UI.Write((__Ember-Mark 'Ready'))
