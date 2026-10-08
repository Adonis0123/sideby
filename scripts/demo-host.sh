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
printf 'Claude Code (demo)\naccount: %s\nconfig:  %s\n\n> ' "$name" "$cfg"
# A real session stays in the foreground. The demo typer sends one question;
# anything else just returns to the prompt. Nothing here is a real model call.
while IFS= read -r line; do
  case "$line" in
    'where do skills live?') printf 'linked to the main account\n\n> ' ;;
    'quota for this account?') printf 'its own 5h and 7d windows\n\n> ' ;;
    *) printf '> ' ;;
  esac
done
