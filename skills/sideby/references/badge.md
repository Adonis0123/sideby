# Show which account a session is

For "show the account in the status line", "加上 [cc001] 这个标识". sideby sets `SIDEBY_ACCOUNT` (`claude:001`) and `SIDEBY_LABEL` (`cc001`, the short command, else the ref) for every account it starts. Configure each Host the user runs; tell them what you change. Always check the family prefix of `SIDEBY_ACCOUNT`, because a Host started inside another inherits both variables.

## Claude Code: status line

1. Read `statusLine` in `~/.claude/settings.json` (linked, so one edit covers every account). Do not touch the env section or anything else in it.
2. If `command` is `sideby statusline-tap --orig-b64 <base64>`, the real script is the base64-decoded original: edit that script, never the wrapper.
3. If there is a script, add before its first output: `case "${SIDEBY_ACCOUNT-}" in claude:*) printf '[%s] ' "$SIDEBY_LABEL" ;; esac`. Keep the rest.
4. If there is no status line: write `~/.claude/statusline.sh` (badge, then `jq -r '.model.display_name // empty'` from stdin), `chmod +x` it, and set `"statusLine": { "type": "command", "command": "~/.claude/statusline.sh" }`. When quota setup was already on with no original command, run `sideby quota teardown claude` first and `sideby quota setup claude` again after (it exits 10; get the user's yes before `--yes`).

## Grok Build: status line

1. Write `~/.grok/statusline.sh`, `chmod +x`: badge from `SIDEBY_LABEL` when `SIDEBY_ACCOUNT` is `grok:*`, else the `GROK_HOME` directory name; then `jq -r` of `.workspace.current_dir`, `.model.display_name` and `.context_window.used_percentage` from stdin, because `type = "command"` replaces the built-in row.
2. In `~/.grok/config.toml`, after the `[ui]` keys, add:

   ```toml
   [ui.status_line]
   type = "command"
   command = "~/.grok/statusline.sh"
   ```

   Never add a second `[ui]` table; if `[ui.status_line]` exists, change it.
3. `sideby doctor grok --fix` copies `config.toml` to subscription accounts (it must be a real copy there). API accounts (`kind: "api"`) keep their own `config.toml`: add the same table to each.
4. `GROK_HOME=<dir> grok inspect` must not report the new keys as unrecognized. It takes effect in a new Grok session.

## Codex: terminal tab title

Codex's status line and title accept only built-in items, so the badge goes in the tab title. Set `"accountTitle": true` in `~/.config/sideby/config.json`, keeping every other key. sideby then sets the title to `[codex002]` at launch and starts Codex with `-c tui.terminal_title=[]` so Codex keeps it; the title no longer shows Codex's own spinner. Check `sideby --version` first: it must be 0.3.0 or later. An older sideby rejects the unknown key and then every sideby command and short command fails; upgrade with `npm i -g sideby` before adding it.

Finish by telling the user to start a new session (`cc001`, `grok001`, `codex002`) to see it.
