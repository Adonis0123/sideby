# Configuration

English | [中文](configuration.zh-CN.md)

← [README](../../README.md)

Optional. `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json`, schema in [`schemas/config.json`](../../schemas/config.json):

```json
{
  "accounts": {
    "claude:work": { "args": ["--model", "opus"] }
  },
  "aliases": {
    "cc": "claude:main",
    "ccw": "claude:work",
    "cx": "codex:main",
    "pi-kimi": { "account": "pi:main", "args": ["--model", "kimi-coding/k3"] }
  },
  "ignore": ["claude:backup"],
  "pluginDirs": ["~/code/sideby-plugins/litellm-gateway"],
  "plugins": {
    "account-script": { "enabled": true },
    "litellm-gateway": { "port": 4000 }
  },
  "extraSharedItems": {
    "claude": [
      { "path": "statusline-command.sh", "mode": "link" },
      { "path": "scripts", "mode": "link" }
    ]
  },
  "shellInitFile": { "zsh": "~/.config/sideby/shell-init.zsh" },
  "resumeRouting": true
}
```

| Field | Meaning |
|---|---|
| `accounts.<ref>.args` | Arguments added for one account. Order: family defaults, then these, then an alias's `args`, then what you pass after `--`. sideby adds no dangerous flags by default; put them here per account if you want them. |
| `aliases` | Short names mapped to an account ref, or to `{ "account": "<ref>", "args": [...] }` for one account started with fixed Host arguments (another model, say). `shell-init` turns each into a shell function, and commands such as `sideby run` and `sideby doctor` accept them too; only `sideby run` adds the `args`. Two aliases of one account share its login and sessions. An alias cannot set environment variables. |
| `ignore` | Account refs (`<family>:<name>`) that look like accounts but are not. Doctor warns about names containing `bak`, `backup`, `old` or `tmp` and suggests adding them here. |
| `pluginDirs` | Extra plugin directories. Absolute paths or paths starting with `~/`. |
| `plugins.<name>` | Settings for one plugin; `enabled` turns it on or off, built-in families included. |
| `shellInitFile` | Optional `{ "zsh": …, "bash": … }`, absolute or `~/` paths. Whenever sideby adds an account or adds or removes an alias (`sideby new`, `sideby alias`, the panel), it rewrites each file with what `sideby shell-init <shell>` prints, so a shell that sources the file picks up new commands. It never overwrites a file that `shell-init` did not write. |
| `accountTitle` | Optional, off by default. When `true`, starting an account sets the terminal tab title to `[<short command or ref>]`, and Codex is started with `-c tui.terminal_title=[]` so it keeps that title (unless your arguments set `tui.terminal_title`). Other Hosts may replace the title with their own; see [Show which account a session is](usage.md#show-which-account-a-session-is). |
| `resumeRouting` | Optional, off by default. When `true`, `shell-init` also defines functions named after the Hosts (`claude`, `codex`, `grok`) that resume a session by id in the account that holds it; see [Resuming from other tools](#resuming-from-other-tools). |
| `extraSharedItems.<family>` | Your own Shared Items on top of the built-in list, each with a Share Mode (`link`, `copy`, `link-or-copy`, `link-or-local`, `local`, `local-if-api`, `info`, `json-key`). `path` is relative to the account directory; absolute paths and `..` are rejected. |

## Shell functions

```sh
# ~/.zshrc (or ~/.bashrc with `bash`)
eval "$(sideby shell-init zsh)"
```

This defines one function per account, such as `sideby-claude-work`, plus one per alias. With the config above, `ccw --resume` is the same as `sideby run claude:work -- --resume`. Accounts created later need a new shell (or another `eval`) before their function exists.

To add a short command when you create an account, pass `--alias` (`sideby new claude 008 --alias cc008`) or fill in "Short command" in the panel's New account dialog. The panel suggests one from your other aliases of that family: `cc001` … `cc007` for `claude:001` … `claude:007` suggest `cc008`; aliases that do not end in their account's name, such as `codex001` for `codex:main`, are ignored. The alias goes into `aliases` in the config file, which sideby rewrites with every other key kept in order; it refuses a config that is not valid JSON and leaves it alone. If the account was created but the alias could not be written, it says so.

For an account that already exists, or to start one account with other Host arguments, use `sideby alias add`:

```sh
sideby alias add pi-kimi pi:main -- --model kimi-coding/k3   # pi-kimi = pi001 with another model
sideby alias rm pi-kimi
```

The panel shows every alias next to its account (hover one to see its arguments) and finds an account by them in search. Entry points that also change environment variables are not aliases; keep them in your shell rc.

If you prefer sourcing a file over `eval` (a new shell then does not start Node), set `shellInitFile` and source it:

```sh
sideby shell-init zsh --write                            # writes ~/.config/sideby/shell-init.zsh once
echo 'source ~/.config/sideby/shell-init.zsh' >> ~/.zshrc
```

sideby keeps that file up to date from then on. With `eval "$(sideby shell-init zsh)"` there is nothing to set up.

## Resuming from other tools

Terminal managers such as Orca reopen a pane by typing the bare Host command, for example `claude --resume <id>`. That command does not say which account the session belongs to, so the Host looks only in the Main Account and reports `No conversation found`. Set `"resumeRouting": true` and regenerate the functions (`sideby shell-init --write`, or a new shell with `eval`). For each family that has an account besides the main one, `shell-init` then also defines a function with the Host's name:

```sh
function claude { local a; if [ -z "${CLAUDE_CONFIG_DIR-}" ]; then for a in "$@"; do case $a in ????????-????-????-????-????????????|--resume=????????-????-????-????-????????????) command sideby resume 'claude' -- "$@"; return;; esac; done; fi; command claude "$@"; }
```

`sideby resume` finds the account whose directory holds that session id (Claude `projects/*/<id>.jsonl`, Codex `sessions/**/rollout-*-<id>.jsonl`, Grok `sessions/*/<id>/`) and starts it as `sideby run` would. Anything else, including `--continue`, a session title, or a session in the Main Account, runs the Host unchanged. A Host started by sideby already has its selection variable set, so it is never routed twice. An alias such as `alias claude='claude --dangerously-skip-permissions'` keeps working. Only a command with an argument shaped like a session id goes through sideby (about 140 ms more); every other Host command runs directly. sideby never copies or moves sessions.
