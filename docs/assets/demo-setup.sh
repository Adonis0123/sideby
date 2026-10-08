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
export PS1='$ '
unset TMUX PROMPT_COMMAND BASH_ENV ENV
# Ubuntu's /etc/bash.bashrc prints the sudo hint unless one of these exists.
# The panes use --norc so that file is skipped; the markers cover a shell that
# still reads it. Both live only in this demo HOME.
touch "$HOME/.hushlogin" "$HOME/.sudo_as_admin_successful"

SOCK=sideby-demo
READY=/tmp/sideby-demo-view.ready
rm -f "$READY"
tmux -L "$SOCK" kill-server >/dev/null 2>&1 || true
# --norc: do not read /etc/bash.bashrc (that is the sudo banner).
tmux -L "$SOCK" new-session -d -s sideby -x 200 -y 48 -e 'PS1=$ ' -- bash --noprofile --norc
tmux -L "$SOCK" set -t sideby status off
tmux -L "$SOCK" set -t sideby pane-border-status top
tmux -L "$SOCK" set -t sideby pane-border-format ' #{pane_title} '
tmux -L "$SOCK" split-window -h -t sideby -- bash --noprofile --norc
tmux -L "$SOCK" select-pane -t sideby:0.0 -T 'personal'
tmux -L "$SOCK" select-pane -t sideby:0.1 -T 'work'
tmux -L "$SOCK" send-keys -t sideby:0.0 'sideby run claude:main' Enter
tmux -L "$SOCK" send-keys -t sideby:0.1 'sideby run work' Enter

# After the view is on screen, type one question into each pane, overlapping,
# so the two sessions are visibly working at the same time.
pane_at_prompt() {
  tmux -L "$SOCK" capture-pane -p -t "$1" | grep -q '^> *$'
}
(
  i=0
  while [ ! -f "$READY" ] && [ "$i" -lt 100 ]; do
    i=$((i + 1))
    sleep 0.1
  done
  i=0
  while [ "$i" -lt 80 ]; do
    if pane_at_prompt sideby:0.0 && pane_at_prompt sideby:0.1; then
      break
    fi
    i=$((i + 1))
    sleep 0.1
  done
  # demo.tape shows the view 700ms after the mirror starts. Wait past that.
  sleep 0.9
  type_line() {
    pane=$1
    text=$2
    n=${#text}
    k=0
    while [ "$k" -lt "$n" ]; do
      tmux -L "$SOCK" send-keys -t "$pane" -l -- "${text:$k:1}"
      k=$((k + 1))
      sleep 0.09
    done
    tmux -L "$SOCK" send-keys -t "$pane" Enter
  }
  type_line sideby:0.0 'where do skills live?' &
  sleep 0.55
  type_line sideby:0.1 'quota for this account?'
  wait
) &
echo $! >/tmp/sideby-demo-typer.pid
# Both Hosts are in the foreground before the tape starts.
sleep 0.8
