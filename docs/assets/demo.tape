# The terminal demo in the README. Retake it from the repository root:
#   node scripts/demo-home.ts /tmp/sideby-demo normal
#   SIDEBY_DEMO=/tmp/sideby-demo vhs docs/assets/demo.tape
# It runs the CLI from source against the demo HOME; `doctor --fix` writes only there.
Output "docs/assets/demo.gif"

Set Shell "bash"
Set FontSize 14
Set Width 1320
Set Height 430
Set Padding 22
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set WindowBar Colorful
Env BASH_SILENCE_DEPRECATION_WARNING "1"

Hide
Type `R=$PWD D=$SIDEBY_DEMO; export HOME=$D/home XDG_CONFIG_HOME=$D/home/.config XDG_STATE_HOME=$D/home/.local/state PATH=$D/bin:$PATH PS1='$ '`
Enter
Type `sideby() { node "$R/src/cli/main.ts" "$@"; }`
Enter

Type "clear"
Enter
Sleep 300ms
Show
Type "sideby"
Sleep 400ms
Enter
Sleep 3.5s

Hide
Type "clear"
Enter
Sleep 300ms
Show
Type "sideby quota"
Sleep 400ms
Enter
Sleep 4s

Hide
Type "clear"
Enter
Sleep 300ms
Show
Type "sideby next claude --dry-run"
Sleep 400ms
Enter
Sleep 4s

Hide
Type "clear"
Enter
Sleep 300ms
Show
Type "sideby doctor"
Sleep 400ms
Enter
Sleep 4s

Hide
Type "clear"
Enter
Sleep 300ms
Show
Type "sideby doctor --fix"
Sleep 400ms
Enter
Sleep 4s
