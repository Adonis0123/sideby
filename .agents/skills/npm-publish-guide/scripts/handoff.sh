#!/bin/sh
# Prepare a handoff script for commands that need the Publisher's Second Factor.
# The Agent never runs those commands itself: npm can only show the browser link or the
# OTP prompt in a Real Terminal (F-43, F-44). This script writes the steps to a file in the
# temp folder, copies one line ("sh <file>") to the clipboard, and prints where the log goes.
#
# Usage:
#   sh handoff.sh [-n "note"] "command" [-n "note"] "command" ...
#   printf '%s\n' '# note' 'command' '# note' 'command' | sh handoff.sh
#
# A note describes the next command in plain words; the Publisher sees it before the step runs.
# Each step's exit code is appended to <file>.log, so the Agent can read the outcome afterwards.
# The generated file never pipes a command (no "| tee"): a pipe takes away the terminal and npm
# then fails with EOTP instead of asking (F-43).
#
# shellcheck disable=SC2016,SC2094
# SC2016: the single-quoted $vars are written into the generated file on purpose.
# SC2094: q "$script" only quotes the path string; it does not read the file.

usage() {
  echo 'usage: sh handoff.sh [-n "note"] "command" [[-n "note"] "command"] ...' >&2
  printf '%s\n' '   or: printf "%s\n" "# note" "command" | sh handoff.sh' >&2
  exit 2
}

# shell-quote one string with single quotes
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }

umask 077
tmp=${TMPDIR:-/tmp}
tmp=${tmp%/}
# Private, unpredictable folder (0700) for the script and its log; no fixed path in a shared /tmp.
dir=$(mktemp -d "$tmp/npm-publish-guide-handoff.XXXXXX") || exit 1
script="$dir/handoff.sh"
log="$dir/handoff.log"
body="$dir/body.tmp"
trap 'rm -f "$body"' EXIT
inline=""
n=0

add_step() {
  n=$((n + 1))
  note=${1:-"Running the next command."}
  inline="${inline:+$inline && }{ $2; }"
  {
    printf '\nprintf '"'"'\\n[Step %s of %%s] %%s\\n$ %%s\\n\\n'"'"' "$total" %s %s\n' "$n" "$(q "$note")" "$(q "$2")"
    printf '%s\n' "$2"
    printf 'rc=$?\n'
    printf 'echo "step %s exit $rc" >>"$LOG"\n' "$n"
    printf 'if [ "$rc" -ne 0 ]; then\n'
    printf '  printf '"'"'\\nStep %s stopped (exit code %%s). Tell your Agent the error code and the lines that start with npm error. Never send one-time codes, tokens or links.\\n'"'"' "$rc"\n' "$n"
    printf '  echo "stopped at step %s" >>"$LOG"\n' "$n"
    printf '  exit "$rc"\n'
    printf 'fi\n'
  } >>"$body"
}

note=""
if [ $# -gt 0 ]; then
  while [ $# -gt 0 ]; do
    case "$1" in
      -n) [ $# -ge 2 ] || usage; note=$2; shift 2 ;;
      -h|--help) usage ;;
      *) add_step "$note" "$1"; note=""; shift ;;
    esac
  done
elif [ ! -t 0 ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      '') ;;
      '#'*) note=$(printf '%s' "${line#\#}" | sed 's/^ *//') ;;
      *) add_step "$note" "$line"; note="" ;;
    esac
  done
else
  usage
fi
[ "$n" -gt 0 ] || usage

(
  umask 077
  {
    printf '#!/bin/sh\n'
    printf '# Made by npm-publish-guide. Run it yourself in a Terminal window: sh %s\n' "$(q "$script")"
    printf 'LOG=%s\n' "$(q "$log")"
    printf 'total=%s\n' "$n"
    printf 'if [ ! -t 0 ] || [ ! -t 1 ]; then\n'
    printf '  echo "This must run in your own Terminal window, pasted by you." >&2\n'
    printf '  echo "It cannot run through a pipe (such as | tee) or from an Agent: npm would not be able to ask for your approval." >&2\n'
    printf '  echo "refused: no terminal $(date '"'"'+%%Y-%%m-%%d %%H:%%M:%%S'"'"')" >>"$LOG"\n'
    printf '  exit 3\n'
    printf 'fi\n'
    printf 'cd %s || exit 1\n' "$(q "$(pwd)")"
    printf 'echo "started $(date '"'"'+%%Y-%%m-%%d %%H:%%M:%%S'"'"')" >>"$LOG"\n'
    printf 'printf '"'"'This runs %%s step(s). If a browser page opens, approve it there.\\n'"'"' "$total"\n'
    cat "$body"
    printf 'echo "finished" >>"$LOG"\n'
    printf 'printf '"'"'\\nAll steps finished. Go back to your Agent and say "done".\\n'"'"'\n'
  } >"$script"
) || exit 1

case "$script" in
  *[!A-Za-z0-9_./-]*) run_line="sh $(q "$script")" ;;
  *) run_line="sh $script" ;;
esac

copied="no (no clipboard tool found; copy the line below by hand)"
if command -v pbcopy >/dev/null 2>&1; then
  printf '%s' "$run_line" | pbcopy && copied="yes (pbcopy)"
elif [ -n "$WAYLAND_DISPLAY" ] && command -v wl-copy >/dev/null 2>&1; then
  printf '%s' "$run_line" | wl-copy && copied="yes (wl-copy)"
elif [ -n "$DISPLAY" ] && command -v xclip >/dev/null 2>&1; then
  printf '%s' "$run_line" | xclip -selection clipboard && copied="yes (xclip)"
fi

printf 'handoff_script: %s\n' "$script"
printf 'steps: %s\n' "$n"
printf 'log: %s\n' "$log"
printf 'runs_in: %s\n' "$(pwd)"
printf 'clipboard: %s\n' "$copied"
printf 'run_line: %s\n' "$run_line"
# For an Agent on another machine, where the Publisher cannot read this file: the same steps as one line.
printf 'remote_fallback: %s\n' "$inline"
