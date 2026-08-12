# Ember shell integration for bash.
#
# Emits the same OSC 133 semantic-prompt sequences as the PowerShell script:
#   133;A prompt start, 133;B input start, 133;C output start, 133;D;<exit> done.
# PS0 is expanded right before a command runs, which is exactly the hook we need
# for the output boundary; PROMPT_COMMAND closes the previous command.

if [[ "$EMBER_INTEGRATION_LOADED" == "1" ]]; then return 0; fi
export EMBER_INTEGRATION_LOADED=1

__ember_esc() {
  # Escape characters that would prematurely terminate the OSC string.
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//;/\\x3b}"
  v="${v//$'\n'/\\x0a}"
  v="${v//$'\r'/\\x0d}"
  printf '%s' "$v"
}

__ember_first_prompt=1

__ember_prompt_start() {
  local exit_code=$1
  local out=''
  if [[ "$__ember_first_prompt" == "1" ]]; then
    __ember_first_prompt=0
  else
    out+="\033]133;D;${exit_code}\007"
  fi
  out+="\033]133;A\007"
  out+="\033]633;P;Cwd=$(__ember_esc "$PWD")\007"
  printf '%b' "$out"
}

# Report the command about to run, then mark the start of its output.
__ember_preexec() {
  printf '\033]633;E;%s\007\033]133;C\007' "$(__ember_esc "$BASH_COMMAND")"
}

PS0='$(__ember_preexec)'

__ember_prompt_command() {
  local code=$?
  __ember_prompt_start "$code"
}

# Chain onto any existing PROMPT_COMMAND rather than replacing it.
if [[ -z "$PROMPT_COMMAND" ]]; then
  PROMPT_COMMAND='__ember_prompt_command'
elif [[ "$PROMPT_COMMAND" != *"__ember_prompt_command"* ]]; then
  PROMPT_COMMAND='__ember_prompt_command;'"$PROMPT_COMMAND"
fi

# Close the prompt region so 133;B lands after the user's own PS1.
PS1="$PS1"'\[\033]133;B\007\]'

printf '\033]633;Ready\007'
