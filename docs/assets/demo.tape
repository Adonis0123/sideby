# README demo: two accounts at once. scripts/record-demo.sh builds the fake HOME,
# runs docs/assets/demo-setup.sh (two real `sideby run` processes), then this tape.
# VHS cannot tmux-attach, so docs/assets/demo-view.py mirrors the two panes.
# The script then appends the local quota panel.
# From the repository root, with Node 22.18+, vhs, ttyd, tmux, ffmpeg and Chrome:
#   sh scripts/record-demo.sh
# Do not point it at a real HOME.
# Font 32 and height 560 give 11 rows, so the two sessions fill the window.
Output "/tmp/sideby-demo-term.gif"

Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 32
Set Width 1280
Set Height 560
Set Padding 12
Set Theme "Catppuccin Mocha"
Set TypingSpeed 12ms
Set Framerate 8
Set WindowBar Colorful
Env TERM "xterm-256color"

Hide
Type "python3 -u docs/assets/demo-view.py"
Enter
Sleep 700ms
Show
Sleep 6.5s
