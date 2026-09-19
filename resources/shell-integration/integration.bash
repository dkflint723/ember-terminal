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
# Disarmed until a prompt has actually been drawn. Anything running before that —
# including the rest of this script — is not something anybody typed.
__ember_at_prompt=0

__ember_prompt_start() {
  local exit_code=$1
  # Whether this is the first prompt, read before it is cleared. The signed marker
  # below used to ask again afterwards, by which time the answer had changed — so
  # the shared 133;D was correctly withheld on the first prompt and Ember's own was
  # sent anyway, closing a block that had never been opened.
  local first=$__ember_first_prompt
  __ember_first_prompt=0
  local out=''
  if [[ "$first" != "1" ]]; then
    out+="\033]133;D;${exit_code}\007"
  fi
  out+="\033]133;A\007"
  printf '%b' "$out"
  if [[ "$first" != "1" ]]; then
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
  # Ember's own functions are not commands anybody typed. Matching them anywhere in
  # the line rather than at the start of it used to be part of this, back when the
  # prompt hook ran armed and had to be recognised mid-line; it is not needed now
  # that the whole prompt runs disarmed, and it cost the user any command that so
  # much as mentioned the name — `type -t __ember_prompt_command` produced no block
  # at all.
  case "$BASH_COMMAND" in
    __ember_*) return 0 ;;
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

__ember_prompt_command() {
  local code=$?
  # Disarmed for the length of the prompt. Everything from here to __ember_arm
  # belongs to the prompt — the user's own hooks and whatever they run — and none
  # of it is a command anybody typed.
  __ember_at_prompt=0
  __ember_prompt_start "$code"
}

# Armed again once the prompt is finished, and not before.
__ember_arm() { __ember_at_prompt=1; }

<<'__EMBER_NOTE__' 2>/dev/null
Ember's hooks go around the user's, not in front of them.

Two things were wrong with one hook at the front. PROMPT_COMMAND has been an array
since bash 5.1 and Fedora ships one, so a string assignment welded
`__ember_prompt_command;` onto element zero and left the rest of the array behind
it. And arming at the front meant the user's own hooks ran armed, so the DEBUG trap
took the first of them for the command: every block was named after a prompt hook,
the command the user actually typed was never captured at all, and the pre-output
clear fired once per hook rather than once per command.

A bare Git Bash has no PROMPT_COMMAND, which is why this survived — anyone running
starship, direnv, atuin or oh-my-bash was in the broken case.
__EMBER_NOTE__

if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__ember_prompt_command "${PROMPT_COMMAND[@]}" __ember_arm)
elif [[ -z "${PROMPT_COMMAND:-}" ]]; then
  PROMPT_COMMAND='__ember_prompt_command;__ember_arm'
elif [[ "$PROMPT_COMMAND" != *"__ember_prompt_command"* ]]; then
  PROMPT_COMMAND='__ember_prompt_command;'"$PROMPT_COMMAND"';__ember_arm'
fi

# Close the prompt region so 133;B lands after the user's own PS1.
PS1="$PS1"'\[\033]133;B\007\]'

# Installed last: until it is, nothing this script does on the way in can be
# mistaken for a command, whatever the flag above happens to say.
trap '__ember_preexec' DEBUG

__ember_mark 'Ready'
