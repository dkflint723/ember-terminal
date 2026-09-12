# Ember shell integration for bash.
#
# Emits the same markers as the PowerShell script: OSC 133;A and ;B for the prompt
# region, and Ember's own OSC 633 for output start, the exit code, the command
# line, the working directory, and readiness. Every 633 marker carries the nonce
# this shell was started with, because anything that can print could otherwise
# print a marker — and a printed working directory is one the git poll then reads
# every few seconds.

# bash only. Sourced by zsh or fish this would define nothing they can use and
# report a readiness that never comes.
[ -n "$BASH_VERSION" ] || return 0

if [[ "$EMBER_INTEGRATION_LOADED" == "1" ]]; then return 0; fi
export EMBER_INTEGRATION_LOADED=1

__ember_nonce="${EMBER_NONCE:-}"

__ember_esc() {
  # Escape what would otherwise end the OSC string early, and every `;` — which is
  # what leaves the nonce unambiguously the last field.
  local v="$1"
  v="${v//\\/\\\\}"
  v="${v//;/\\x3b}"
  v="${v//$'\n'/\\x0a}"
  v="${v//$'\r'/\\x0d}"
  printf '%s' "$v"
}

# One Ember marker, signed when this shell has a nonce to sign it with.
__ember_mark() {
  if [ -n "$__ember_nonce" ]; then
    printf '\033]633;%s;%s\007' "$1" "$__ember_nonce"
  else
    printf '\033]633;%s\007' "$1"
  fi
}

<<'__EMBER_NOTE__' 2>/dev/null
The directory is reported in the shape the window can act on. Git Bash and WSL
both hand out POSIX paths that mean nothing to the Windows side — it cannot stat
/d/projects, and the git poll would ask about a path that does not exist. cygpath
and wslpath are the translators each of them ships; without one, the directory is
left alone rather than reported wrong.
__EMBER_NOTE__

__ember_cwd() {
  local out=''
  if command -v cygpath >/dev/null 2>&1; then
    out="$(cygpath -w "$PWD" 2>/dev/null)"
  elif command -v wslpath >/dev/null 2>&1; then
    out="$(wslpath -w "$PWD" 2>/dev/null)"
  fi
  printf '%s' "$out"
}

__ember_first_prompt=1
__ember_at_prompt=1

__ember_prompt_start() {
  local exit_code=$1
  local out=''
  if [[ "$__ember_first_prompt" == "1" ]]; then
    __ember_first_prompt=0
  else
    out+="\033]133;D;${exit_code}\007"
  fi
  out+="\033]133;A\007"
  printf '%b' "$out"
  if [[ "$__ember_first_prompt" == "0" ]]; then
    __ember_mark "D;${exit_code}"
  fi
  local win
  win="$(__ember_cwd)"
  if [ -n "$win" ]; then
    __ember_mark "P;Cwd=$(__ember_esc "$win")"
  fi
}

<<'__EMBER_NOTE__' 2>/dev/null
The command is captured with a DEBUG trap rather than PS0. PS0 is expanded by the
prompt machinery, so a command run from a keybinding or a function never went
through it, and the block took the name of whatever was typed last. The trap sees
every command — including the ones inside the prompt itself — so it fires once per
prompt and then stands down until the next one.
__EMBER_NOTE__

__ember_preexec() {
  [ "$__ember_at_prompt" = "1" ] || return 0
  [ -n "$COMP_LINE" ] && return 0
  case "$BASH_COMMAND" in
    __ember_*|*__ember_prompt_command*) return 0 ;;
  esac
  __ember_at_prompt=0
  __ember_mark "E;$(__ember_esc "$BASH_COMMAND")"
  # The pre-output clear, for the reason the PowerShell script gives at length:
  # conpty repaints from its own buffer, and a repaint landing inside a command
  # puts the previous commands' output into this command's block.
  printf '\033[H\033[2J\033[3J'
  printf '\033]133;C\007'
  __ember_mark 'C'
}

trap '__ember_preexec' DEBUG

__ember_prompt_command() {
  local code=$?
  __ember_at_prompt=1
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

__ember_mark 'Ready'
