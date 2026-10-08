#!/bin/bash
# Prepares the two-pane demo that docs/assets/demo.tape attaches to.
# Run from the repository root with SIDEBY_DEMO set to a directory from scripts/demo-home.ts.
# The fake accounts and this fixture are the only Host; nothing here reads a real login.
set -eu
R=$(pwd)
D=${SIDEBY_DEMO:?set SIDEBY_DEMO to the directory you passed to scripts/demo-home.ts}
NODE=$(command -v node)
if [ -z "$NODE" ]; then
  echo "node is not on PATH" >&2
  exit 1
fi
install -m 755 "$R/scripts/demo-host.sh" "$D/bin/claude"
# A shim, not a shell function: tmux panes do not inherit functions.
cat >"$D/bin/sideby" <<EOF
#!/bin/sh
exec $(printf '%q' "$NODE") $(printf '%q' "$R/src/cli/main.ts") "\$@"
EOF
chmod 755 "$D/bin/sideby"

export HOME="$D/home"
export XDG_CONFIG_HOME="$D/home/.config"
export XDG_STATE_HOME="$D/home/.local/state"
export PATH="$D/bin:$PATH"
export BASH_SILENCE_DEPRECATION_WARNING=1
export TERM="${TERM:-xterm-256color}"
unset TMUX
printf "PS1='%s '\n" '$' >"$D/bashrc"

SOCK=sideby-demo
tmux -L "$SOCK" kill-server >/dev/null 2>&1 || true
tmux -L "$SOCK" new-session -d -s sideby -x 200 -y 48 -- bash --noprofile --rcfile "$D/bashrc"
tmux -L "$SOCK" set -t sideby status off
tmux -L "$SOCK" set -t sideby pane-border-status top
tmux -L "$SOCK" set -t sideby pane-border-format ' #{pane_title} '
tmux -L "$SOCK" split-window -h -t sideby -- bash --noprofile --rcfile "$D/bashrc"
tmux -L "$SOCK" select-pane -t sideby:0.0 -T 'personal'
tmux -L "$SOCK" select-pane -t sideby:0.1 -T 'work'
tmux -L "$SOCK" send-keys -t sideby:0.0 'sideby run claude:main' Enter
tmux -L "$SOCK" send-keys -t sideby:0.1 'sideby run work' Enter
# Both Hosts are in the foreground before the tape attaches.
sleep 0.8
