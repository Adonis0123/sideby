#!/bin/sh
# Fixture Host for the README demo. sideby starts it the same way it starts Claude Code:
# `CLAUDE_CONFIG_DIR` is set for every account except the main one. This is not the real CLI.
# It prints the account and waits at a prompt, so two terminals can sit open together.
name=personal
cfg='~/.claude'
if [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
  base=$(basename "$CLAUDE_CONFIG_DIR")
  cfg="~/$base"
  case "$base" in
    .claude-*) name=${base#.claude-} ;;
    *) name=$base ;;
  esac
fi
# A session that Auto Handoff starts gets its first prompt after `--`.
prompt=
while [ $# -gt 0 ]; do
  if [ "$1" = -- ]; then
    prompt=${2:-}
    break
  fi
  shift
done
printf 'Claude Code (demo)\naccount: %s\nconfig:  %s\n\n' "$name" "$cfg"
[ -n "$prompt" ] && printf '> %s\nread the brief; carrying on\n\n' "$prompt"
printf '> '
# A real session stays in the foreground. The demo typer sends one question;
# anything else just returns to the prompt. Nothing here is a real model call.
while IFS= read -r line; do
  case "$line" in
    'where do skills live?') printf 'linked to the main account\n\n> ' ;;
    'quota for this account?') printf 'its own 5h and 7d windows\n\n> ' ;;
    'write the release notes')
      printf 'drafted docs/notes.md\n\n> '
      # Stands in for sideby's hook when the quota reaches the hand-over level: tell sideby the turn is done.
      if [ -n "${SIDEBY_HANDOFF_DIR:-}" ]; then
        printf '{"runId":"%s","at":"%s","trigger":"threshold","sessionId":"demo"}\n' \
          "$SIDEBY_HANDOFF_RUN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$SIDEBY_HANDOFF_DIR/ready.json"
      fi
      ;;
    *) printf '> ' ;;
  esac
done
