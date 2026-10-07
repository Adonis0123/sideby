# Claude quota

Claude quota needs a one-time change to `~/.claude/settings.json`: the status line command becomes `sideby statusline-tap --orig-b64 <base64 of the original command>`. Claude Code then hands each refresh's official `rate_limits` (5-hour and 7-day used percent and reset time) to sideby, which caches them per account. Nothing is sent anywhere.

1. sideby must be installed globally (`npm i -g sideby`), because Claude Code runs the wrapper on every status line refresh. Setup is refused when `sideby` is missing from PATH or comes from the npx cache; tell the user to install it rather than working around it.
2. Run `sideby quota setup claude`. It prints the diff, changes nothing and exits **10**: show the diff to the user.
3. Only after the user approves, run `sideby quota setup claude --yes`.
4. To undo: `sideby quota teardown claude`. It restores the file byte for byte only if nothing changed since setup. If it refuses, show its diff and tell the user to set `statusLine.command` back to the original command (the base64 after `--orig-b64`), or delete `statusLine` if there was none.

Accounts with their own (not linked) `settings.json` show quota `not-enabled` until that file's status line is wrapped the same way; tell the user instead of editing it.

After setup, each account shows quota once it has had one session with a reply. Codex quota needs no setup: sideby reads it from Codex's own session files.

Usage (7-day tokens) is read by sideby itself from Claude Code and Codex local records; no ccusage is needed. Grok and pi have no quota or usage source.
