#!/bin/sh
# Retake docs/assets/demo.gif: two fake accounts in two terminals, then the local quota panel.
# Needs Node 22.18+, vhs (https://github.com/charmbracelet/vhs), tmux, ffmpeg and Google Chrome.
# Usage, from the repository root: sh scripts/record-demo.sh
set -eu
cd "$(dirname "$0")/.."

node_ok() {
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)'
}
if ! node_ok; then
  echo "Node $(node -v) is older than 22.18. Put a newer Node first on PATH and run this again." >&2
  exit 1
fi
for cmd in vhs tmux ttyd ffmpeg google-chrome; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing $cmd" >&2
    exit 1
  fi
done

demo=/tmp/sideby-demo
node scripts/demo-home.ts "$demo" normal
export SIDEBY_DEMO=$demo
unset TMUX
bash docs/assets/demo-setup.sh
vhs docs/assets/demo.tape

log=/tmp/sideby-demo-panel.log
port=17421
: >"$log"
HOME=$demo/home \
  XDG_CONFIG_HOME=$demo/home/.config \
  XDG_STATE_HOME=$demo/home/.local/state \
  PATH=$demo/bin:$PATH \
  node src/cli/main.ts ui --no-open --port "$port" >"$log" 2>&1 &
panel=$!
cleanup() {
  kill "$panel" 2>/dev/null || true
  if [ -f /tmp/sideby-demo-typer.pid ]; then
    kill "$(cat /tmp/sideby-demo-typer.pid)" 2>/dev/null || true
  fi
  tmux -L sideby-demo kill-server >/dev/null 2>&1 || true
}
trap cleanup EXIT
url=
i=0
while [ "$i" -lt 40 ]; do
  url=$(sed -n 's/^sideby panel: \(http:\/\/127\.0\.0\.1:[0-9]*\/\).*/\1/p' "$log" | head -n 1)
  if [ -n "$url" ]; then
    break
  fi
  i=$((i + 1))
  sleep 0.25
done
if [ -z "$url" ]; then
  echo "panel did not start; log:" >&2
  cat "$log" >&2
  exit 1
fi

# The page fills quota after its own fetch. A fresh profile, and a timeout, so Chrome cannot
# sit on the debugging port the distro wrapper sometimes adds.
shot=/tmp/sideby-panel.png
rm -rf /tmp/sideby-chrome-profile
chrome=$(command -v google-chrome || command -v google-chrome-stable)
timeout 40 "$chrome" --headless=new --no-sandbox --disable-gpu --hide-scrollbars \
  --user-data-dir=/tmp/sideby-chrome-profile \
  --force-prefers-color-scheme=dark \
  --window-size=1280,860 \
  --virtual-time-budget=12000 \
  --screenshot="$shot" \
  "${url}" >/tmp/sideby-chrome.log 2>&1 || true
if [ ! -s "$shot" ]; then
  echo "chrome screenshot failed; log:" >&2
  cat /tmp/sideby-chrome.log >&2
  exit 1
fi

# Terminal clip, then the panel. Same frame size (setsar: the two sources otherwise
# refuse to concat). The tape is shorter than the panel, so pad it to 860 and center it.
term_h=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 /tmp/sideby-demo-term.gif)
pad_top=$(( (860 - term_h) / 2 ))
ffmpeg -y -i /tmp/sideby-demo-term.gif \
  -vf "fps=8,scale=1280:${term_h}:flags=lanczos,pad=1280:860:0:${pad_top}:color=0x1e1e2e,setsar=1,format=yuv420p" \
  /tmp/sideby-demo-term.mp4
ffmpeg -y -loop 1 -framerate 8 -t 7 -i "$shot" \
  -vf "scale=1280:860:flags=lanczos,setsar=1,format=yuv420p" \
  -r 8 /tmp/sideby-demo-panel.mp4
ffmpeg -y -i /tmp/sideby-demo-term.mp4 -i /tmp/sideby-demo-panel.mp4 -filter_complex \
  "[0:v][1:v]concat=n=2:v=1:a=0,fps=8,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" \
  docs/assets/demo.gif

bytes=$(wc -c <docs/assets/demo.gif | tr -d ' ')
echo "wrote docs/assets/demo.gif ($bytes bytes)"
if [ "$bytes" -gt 3145728 ]; then
  echo "GIF is over 3 MB; lower the framerate or the panel hold in this script and retake" >&2
  exit 1
fi
