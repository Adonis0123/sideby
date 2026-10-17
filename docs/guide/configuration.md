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
| `display` | The order you dragged tools and accounts into in the panel: `{ "families": ["codex", "claude"], "accounts": { "claude": ["003", "main"] } }`, account names, not refs. Anything not listed follows in the usual order. The panel writes it; **Default order** removes it. Display only; see [Your own order](usage.md#your-own-order). |
| `quota.check.<family>` | `false` stops quota checks that cost a request, for that tool. Today that is Grok, whose CLI is asked at most every 15 minutes per account; see [Grok quota](usage.md#grok-quota). On by default, off in CI. |
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

`sideby resume` finds the account whose directory holds that session id (Claude `projects/*/<id>.jsonl`, Codex `sessions/**/rollout-*-<id>.jsonl`, Grok `sessions/*/<id>/`) and starts it as `sideby run` would. A Claude session that was opened but never got a message has no such file: when no account holds it, `sideby resume` looks for the account that started it (`session-env/<id>/`), drops `--resume <id>` and starts a new session there, saying so on stderr. Anything else, including `--continue`, a session title, or a session in the Main Account, runs the Host unchanged. A Host started by sideby already has its selection variable set, so it is never routed twice. An alias such as `alias claude='claude --dangerously-skip-permissions'` keeps working. Only a command with an argument shaped like a session id goes through sideby (about 140 ms more); every other Host command runs directly. sideby never copies or moves sessions.

## Updates

Once a day sideby asks the npm registry which sideby version is the newest (one `GET` of `https://registry.npmjs.org/-/package/sideby/dist-tags`, carrying nothing about you or your accounts). When there is a newer one:

- after a command, the terminal shows one line such as `sideby 0.12.0 is available (you have 0.11.0) · run \`sideby update\``, at most once a day per version. It never shows with `--json`, when the output is not a terminal, from `shell-init`, or inside a Host: `sideby run`, `next` and `resume` print it after the Host exits.
- the panel shows "v0.12.0 available" next to Refresh. Click it, or the version at the bottom of the panel, to see what changed, the command an update runs, and an **Update** button.

`sideby update` asks the registry right away, shows the command and runs it with `--yes`. What it runs depends on how sideby was installed:

| Installed with | Update runs |
|---|---|
| `npm i -g sideby` | `npm install -g sideby@<version>` (in the same Node prefix) |
| `pnpm add -g sideby` | `pnpm add -g sideby@<version>` |
| `bun add -g sideby` | `bun add -g sideby@<version>` |
| Volta (`volta install sideby`) | nothing: sideby prints `volta install sideby@<version>` |
| `npx sideby`, a project dependency, a source checkout, or a global folder you cannot write | nothing: sideby prints the command for you to run |

After an update, a background panel (`sideby ui --background`) restarts itself and open pages reload. The panel app (`sideby app install`), if you installed it, is installed again from the new version, with its new icon. A `sideby ui` running in a terminal and sessions already running keep the old version until you restart them. The sideby skill agents read (`~/.agents/skills/sideby`) is updated with it, keeping the agents you installed it for; when sideby is already current and only the skill is old, `sideby update` and the panel's **Update skill** button update the skill alone. sideby counts as up to date only when the skill matches it too: until then the panel's version shows a dot, and with Auto Update off the terminal says so once a day. A skill inside a git repository, such as a dotfiles clone, is left to that repository, unless the skills tool records installing it there (`.skill-lock.json` next to the `skills` folder); then sideby updates it and the change shows in that repository's `git status`.

| Setting | Meaning |
|---|---|
| `"update": { "check": false }` | No daily check and no notice. `NO_UPDATE_NOTIFIER=1` or `SIDEBY_NO_UPDATE_NOTIFIER=1` do the same; CI turns it off by itself. `sideby update` still works. |
| `"update": { "auto": true }` | Off by default; the panel's update dialog has the same switch. After the daily check sideby installs a newer version by itself, only for an npm, pnpm or bun global install, only when no `sideby run`, `next` or `resume` is running, and never a new major version (0.x to 1.0). It brings the sideby skill along, and brings a skill that is behind a current sideby up to date by itself. The next command says it updated, once. |

`SIDEBY_UPDATE_REGISTRY` points the check at a mirror, for example `https://registry.npmmirror.com`.
