# Using sideby

English | [中文](usage.zh-CN.md)

← [README](../../README.md)

## Accounts

| Family | Main Account | Other accounts | Selected with |
|---|---|---|---|
| claude | `~/.claude` | `~/.claude-<name>` | `CLAUDE_CONFIG_DIR` |
| codex | `~/.codex` | `~/.codex-<name>` | `CODEX_HOME` |
| grok | `~/.grok` | `~/.grok-<name>` | `GROK_HOME` |
| pi | `~/.pi/agent` | `~/.pi-<name>/agent` | `PI_CODING_AGENT_DIR` |

Accounts are found on disk; you never list them by hand. A name matches `^[a-z0-9][a-z0-9-]{0,31}$`, so `004` and `work` are both fine. A directory counts as an account only if it holds a `proxy.env` or at least one of the family's Shared Items, so another tool's directory that happens to match the pattern, such as claude-code-router's `~/.claude-code-router`, is not picked up. The Main Account is always called `main` and runs without the selection variable. Before every launch sideby clears Hijack Variables (for example a global `ANTHROPIC_API_KEY`) so an inherited value cannot override the account's identity.

EMAIL is who the account is signed in as, read from the host's login file (Claude Code, Codex, Grok Build). sideby reads only that identity field there, never a token (ADR-0003).

If a family plugin fails while reading an account (for example its settings file is not valid JSON), `list` still shows the account and prints the problem on stderr; `list --json` puts it in that account's `problems` array.

## What each account shares

A new account starts with the Main Account's skills, hooks, rules and settings. Its sign-in, sessions and history stay its own, which is what lets two accounts run at once. `sideby families <family>` prints this list for your machine, including plugin families and items you add with [`extraSharedItems`](configuration.md).

| Host | Linked to the Main Account | Copied or synced | The account's own |
|---|---|---|---|
| Claude Code | `settings.json`, `settings.local.json`, `skills`, `commands`, `plugins`, `hooks`, `themes`, `CLAUDE.md` | MCP servers: the `mcpServers` entry of the account's `.claude.json`, kept equal to `~/.claude.json` | sign-in, the rest of `.claude.json`, sessions (`projects/`), history |
| Codex | `AGENTS.md`, `hooks.json`, `plugins`, `rules`, `skills`; `config.toml` of a subscription account | — | sign-in (`auth.json`), sessions, history; `config.toml` of an API account |
| Grok Build | `skills`, `installed-plugins` | `hooks`, `hooks-paths`, and `config.toml` of a subscription account: Grok refuses links there | sign-in (`auth.json`), `trusted_folders.toml` (copied once, then yours), sessions; `config.toml` of an API account |
| pi | `AGENTS.md` | — | sign-in (`auth.json`), sessions, everything else |

- **Linked**: change it once in the Main Account and every account sees it.
- **Copied or synced**: `sideby doctor --fix` brings the copy back in line when the Main Account's changes.
- **An API account's `config.toml`** is its own, so changing its endpoint or model never changes the Main Account's.
- An item the Main Account does not have is skipped when an account is created, and Doctor does not report it.

## Show which account a session is

Every time sideby starts an account it sets two variables for the Host: `SIDEBY_ACCOUNT` (the ref, `claude:001`) and `SIDEBY_LABEL` (the short command it was started with or owns, `cc001`, else the ref). A status line or prompt can show them. Check the family prefix of `SIDEBY_ACCOUNT` first: a Host started inside another one inherits both.

| Host | Where the badge goes | How |
|---|---|---|
| Claude Code | status line | Add `case "${SIDEBY_ACCOUNT-}" in claude:*) printf '[%s] ' "$SIDEBY_LABEL" ;; esac` to the script in `settings.json`'s `statusLine.command`. `settings.json` is linked, so one edit covers every account. |
| Grok Build | status line | Save a script that prints the badge (for example `~/.grok/statusline.sh`), then add `[ui.status_line]` with `type = "command"` and `command = "~/.grok/statusline.sh"` to `~/.grok/config.toml`. Run `sideby doctor grok --fix` to copy it to subscription accounts; an API account's `config.toml` is its own, so edit that one too. The command replaces the built-in row, so print the directory, model and context yourself (the payload has `workspace.current_dir`, `model.display_name`, `context_window.used_percentage`). Grok hides the row on its welcome screen; it appears after the first message. |
| Codex | terminal tab title | Codex's status line and title take only built-in items. Set `"accountTitle": true` in the [config](configuration.md): sideby sets the title to `[codex002]` and starts Codex with `-c tui.terminal_title=[]` so Codex leaves it, losing its own spinner in the title. |

With `sideby quota setup claude` on, the status line command is `sideby statusline-tap --orig-b64 …`: edit the script it runs, not that command. To add a status line where there was none, run `sideby quota teardown claude`, set `statusLine`, then `sideby quota setup claude --yes` again.

## API accounts

```sh
sideby new claude deepseek --api
$EDITOR ~/.claude-deepseek/proxy.env     # fill in the variables; the file stays mode 600
sideby run deepseek
```

`proxy.env` uses a small dotenv subset (`KEY=VALUE`, optional `export `, quotes, `#` comments, and `$NAME` / `${NAME}` referring to a key set earlier in the same file or to `HOME`, `USER`, `LOGNAME`, `TMPDIR` or an `XDG_*_HOME` location; no other shell variable is read and there is no command substitution). Its variables reach only the launched Host process. sideby refuses to start unless the file's mode is exactly 600 and tells you to run `chmod 600`.

An API account needs no sign-in: its login state is `not-needed`, shown as `key` in the LOGIN column of `sideby list`.

pi is the exception. pi can keep a `proxy.env` in any account to load provider keys, so sideby loads the file at launch but still treats the account as a subscription account that signs in with `/login`.

## Doctor

```sh
sideby doctor            # every account
sideby doctor work       # one account, or a family: sideby doctor grok
sideby doctor --fix      # apply the safe repairs
```

```
✓ claude:work subscription shared 4/4  ~/.claude-work
✗ grok:lab subscription shared 2/3  ~/.grok-lab
    fail hooks must be a real copy, not a link (host says: "Grok hooks directory has wrong type (expected real directory)")
         run `sideby doctor --fix` to replace the link with a copy

1 issue(s) can be fixed with `sideby doctor --fix`.
```

- `shared n/m` counts the Shared Items the Main Account actually has. An item the Main Account does not have (many people have no `commands` or `themes`) is skipped: no warning, not counted.
- A link whose target exists but is not the Main Account's item is a warning (`link.other-target`), since you may have set it up on purpose; where the Host needs a real file or copy, any link is a failure (`symlink-forbidden`). A dangling link is a failure (`link.dangling`). sideby never changes where a link points; it only reports.
- A real file or directory where a link belongs is reported with a command to keep it (`mv <x> <x>.local && ln -s …`). sideby never replaces it.
- Credential files (`proxy.env`, `auth.json`, `.claude.json`) are checked for type and mode 600; `--fix` sets the mode back to 600. The only content sideby reads from them is the `mcpServers` key of `.claude.json`, which it keeps in sync with the Main Account, and the identity fields shown as the account's email (`oauthAccount.emailAddress` and `organizationName` of `.claude.json`, the `email` of Grok's `auth.json` entry, the `email` claim of Codex's `id_token`); tokens are never read out, stored or shown. `--force` allows that sync to remove servers the account has and the Main Account does not.
- Backup leftovers (`*.bak*`, `*backup*`, `*.tmp*`) are counted, never touched.

Warnings alone exit 0; any failure exits 1.

## Claude quota

Claude Code passes quota data only to its status line command, so sideby needs a one-time, reversible change:

```sh
npm i -g sideby                   # the status line calls `sideby` on every refresh
sideby quota setup claude         # shows the diff, changes nothing
sideby quota setup claude --yes   # writes the change
sideby quota                      # 5h / 7d per account, with data age
sideby quota teardown claude      # restores the original file byte for byte
```

`setup` edits `~/.claude/settings.json`. It wraps your `statusLine.command` as `sideby statusline-tap --orig-b64 <base64 of your command>`; base64 keeps your command's quotes and spaces intact. If you have no status line, it sets `sideby statusline-tap`, which prints a short line such as `5h 72% · 7d 44%`. The original bytes go to sideby's state directory. Your status line output does not change; in our tests the extra cold start had a median of about 82 ms.

Because Claude Code runs the wrapper on every refresh, `setup` refuses when `sideby` is not on `PATH` or comes from the npx cache, and tells you to run `npm i -g sideby` first.

`teardown` writes the original back only if the file is still exactly what `setup` wrote. If you changed it since, `teardown` refuses and shows the diff; set `statusLine.command` back to your original command by hand (it is the base64 after `--orig-b64`), or delete `statusLine` if you had none.

Accounts that link `settings.json` to the Main Account (the default) get quota from the same setup. An account with its own `settings.json` shows quota as not enabled until that file's status line is wrapped the same way. Codex quota needs no setup: sideby reads it from local session files.

### Two directories, one login

Sometimes two accounts of Claude Code are signed in as the same claude.ai login, for example `~/.claude` and `~/.claude-001` with the same email and organization. Claude counts one quota for that login, but each directory only records the numbers its own sessions saw, so one could look half full and the other almost empty. sideby notices this by itself (it compares the email and organization it already shows) and:

- shows the same, freshest quota on both, with where it was read: `sideby quota` says `read from claude:001 (same login)`, the panel says so when you hover the quota;
- marks them: `claude:001 = main` in `sideby list`, a **Same login as main** tag in the panel; the quota warning shows once, on the account that has the reading;
- never hands over between them: `sideby next` run inside a session sideby started skips the other directory of that login, and Auto Handoff skips it too, also when your `order` lists it, and says why.

Usage (tokens) still counts per directory. Nothing is moved or deleted; keep both or remove one yourself. Codex is not grouped yet: one email can belong to several ChatGPT workspaces, each with its own quota.

## Model and effort

Each account row shows the model and effort it runs with, for example `opus · high`; hover to see where each comes from: set by sideby for this account, the last session, or the tool's own settings (used only before the account's first session). Click it (or **Model and effort…** in the account menu) to pick a model and effort for that account alone. sideby saves the choice as that account's launch arguments in its own config (`--model` and `--effort` for Claude Code, `-m` and `-c model_reasoning_effort=…` for Codex), so accounts that share one `settings.json` can still differ, and the tool's own files stay as they are. It applies to new sessions started with sideby (a short command, `sideby run`, `sideby next`, Auto Handoff); a plain `claude` ignores it. `ANTHROPIC_MODEL` or `CLAUDE_CODE_EFFORT_LEVEL` in your shell and settings from your organization still win, and sideby cannot see them. From a terminal: `sideby model cc002 opus --effort high` (add `--yes`); `default` clears one.

## Desktop apps

On macOS, sideby can open Claude Desktop or the Codex app as one account, and keep several accounts' windows open side by side:

```sh
sideby desktop claude:work     # or a short command: sideby desktop ccw
```

In the panel, click **Open desktop app** in the account's row (it says **Desktop app open** while that account's window runs; a click brings it to the front). `sideby list` shows a DESKTOP column, and `--json` a `desktopApp` field per account.

- The main account opens the app as usual. Any other subscription account opens a new window that uses that account's directory (`CLAUDE_CONFIG_DIR`, so Claude Desktop's Code tab uses the account's Claude Code settings; `CODEX_HOME`, so the Codex app shares the account's terminal sign-in) and its own data folder, `~/Library/Application Support/sideby/<family>/<name>/`.
- When that account's window is already open, sideby brings it to the front instead of opening a second one. It never closes a window and never copies or changes the app.
- API accounts cannot open a desktop app: the apps sign in with a subscription only.
- The first time, sign in inside Claude Desktop. Close the other Claude Desktop windows while you do: the browser sends the sign-in back through a `claude://` link, and another window may catch it. Codex usually needs no sign-in in the app; run `sideby login <account>` first if the account is signed out.
- The sign-in screen may suggest your main account, for example the Codex app's "Welcome back" with your main email. Do not pick it for another account: that signs this account in as your main one. Choose to use another account, or for Codex sign in with `sideby login <account>` first.
- Claude Desktop's MCP settings, `claude_desktop_config.json`, link to the main account's when a new account's data folder is made. `sideby doctor` checks that link: it never replaces a file there. If the main account had no such file yet, Claude Desktop makes its own copy (it may also replace the link later); doctor shows that as a warning with the command to share the main account's file instead.

Known limits: every window has the same Dock icon. While another account's window runs and the main one does not, clicking the Dock icon brings that other window forward; open the main account from sideby then. After the app updates itself it restarts on the main account; open the others again from sideby. Claude in Chrome cannot pair with a window that uses another data folder. sideby opens the apps with settings they read today (`--user-data-dir`, and for Codex `CODEX_ELECTRON_USER_DATA_PATH`); a future app version may change them. An app opened from inside a Claude Code or Codex session does not inherit that session's variables. Other platforms and hosts are not supported yet.

## Context tuning

Every Host compacts a session by itself once its context grows past a threshold. `sideby tune` replays your last 7 days of local sessions against other thresholds and estimates which one spends the fewest tokens:

```sh
sideby tune                  # every account
sideby tune claude:work      # one account, or a family such as `claude`
```

It is an estimate, not a measurement: a different threshold changes what the summary keeps, which the records cannot show. Claude gets a suggested value per model (needs 200+ calls of that model in the window and at least one recorded compaction). Claude Code also compacts by itself when a conversation has sat idle for about an hour (just before its one-hour prompt cache runs out) and holds 200K tokens or more. That is separate from this size, which only controls compaction while you work; most of the compactions in a typical log are the idle kind, and the page says how many. Claude Code accepts sizes from 100K to 1M tokens, so sideby never suggests anything below 100K; when 100K is the cheapest, that is the answer ("as low as it allows"). Codex only shows how large the context was when it compacted, because its default threshold has no public source. Grok and pi have none.

Nothing changes until you say so. Open the panel's **Context tuning** tab (or an account's menu), and press **Use 80K**: sideby first shows the file and the change (and which other accounts share that file), and only writes after you confirm. It writes one key, `autoCompactWindow`, in that account's `settings.json`, keeps everything else, and one click on **Undo** puts it back. Sessions already running keep the old value; new ones use the new one. The same from a terminal:

```sh
sideby tune apply claude:work            # shows the change, exit 10
sideby tune apply claude:work 120k --yes # writes it (leave the size out to take the suggestion; `default` removes it)
sideby tune undo claude:work --yes       # puts the old value back
```

Under the suggestion each Claude account also has a **size menu** (Default, common sizes, the suggested one marked): pick one and press **Use this**; the same preview, confirmation and undo apply. Choosing Default removes the key.

Accounts that link `settings.json` to the Main Account share one file, so they share one setting: the panel shows one card for them (the suggestion follows the model used most among them), each account's own numbers sit under "Details for each account", and the confirmation names every account the change reaches. To show your current value, sideby reads exactly that key (Claude) or `model_auto_compact_token_limit` from `config.toml` (Codex), and nothing else in those files.

## When an account hits its limit

```sh
sideby next claude              # pick the account with the most quota left and start it
sideby next codex --dry-run     # only show the pick
sideby next claude -- --model opus  # Host arguments go after --
```

`next` ranks the family's accounts by their fullest quota window that has not reset yet, starts the lowest one, and lists the rest with why they were left out:

```
   ACCOUNT        STATE       NOTE
→  claude:work    ready       fullest window 23%
   claude:new     unknown     no quota data yet
   claude:key     api         left out; add --include-api to use it
   claude:main    full        back at 14:30
```

- Accounts with a window at 85% or more are full; a window whose reset time has passed counts as empty again.
- Accounts without quota data yet come after the ones with known room. API accounts cost money per request, so they join only with `--include-api`.
- When every account is full, nothing starts and sideby tells you which one comes back first. When no account has quota data yet, nothing starts either: the pick would only be a guess. Turn quota on (`sideby quota setup claude`) or choose with `sideby run`.
- The new account starts a new session: each account keeps its own sessions. Ask the old session for a short handoff note and paste it in.
- Claude and Codex only; Grok and pi publish no quota, so `next grok` lists the accounts for you to choose.
- Two directories signed in as the same login share one quota (see [Two directories, one login](#two-directories-one-login)); run inside a session sideby started, `next` never picks the other one.

sideby recommends; you start the account. It never switches or rotates by itself unless you turn on Auto Handoff below (see the FAQ). The panel marks the same pick as **Next** in each family.

## Auto Handoff

Off by default. The easiest way to turn it on is the panel's **Auto Handoff** page: press **Turn on**, read the list of what sideby will change (its settings, the Claude quota display, the Grok hook), and confirm once. The page then shows where each account's work goes next and the recent hand-overs, and finishes any step that is still missing. Accounts of the same tool only switch between each other if you tick that box (the risk is explained there). From a terminal, use `sideby handoff enable` (it shows the config change first; add `--yes`); `sideby handoff status` lists, family by family, what is still missing and the command for each. When it is off and an account passes the threshold, sideby says so once a day after the session ends, and the panel shows a hint with **Set up**.

With it on, a session that sideby started (`sideby run`, a short command or `sideby next`) hands its task to the next account when its quota runs low: the old session writes a handoff brief, sideby ends it, and the next account starts a new session from that brief in the same terminal.

```sh
sideby handoff status
sideby handoff enable --order claude=codex001,cc002 --yes
sideby handoff enable --same-family --yes   # cc001 → cc002 too; read the risk below first
sideby handoff disable --yes
```

The same settings live under `handoff` in the config file (see the [configuration](configuration.md) schema).

- **When.** At 80% of the fullest window (`prepareAt`) the session is asked to start a brief and keep it current; at 95% (`threshold`) it finishes the current step, updates the brief and ends its turn. If the window resets within 30 minutes (`waitIfResetWithinMinutes`), sideby waits instead.
- **Where to.** `policy: "order"` follows your list (accounts or short commands, any family); without it sideby picks the family's account with the most room, then API accounts of other families. Each account is used once per chain, a full or signed-out account is skipped (so is one already at your `threshold`), and so is an account of another organization (compared by organization, else by email domain) unless it is listed in `crossOrganization`. An account signed in as the same login as the old one is always skipped, even when `order` lists it: it has the same quota.
- **Same family.** `auto` alone hands over to API accounts (of any family) and to accounts of other families that you list in `order`. Moving between two accounts of the same vendor (cc001 → cc002) also needs `"sameFamily": true`. Vendors may treat that as getting past a usage limit and act on the account; the risk is yours.
- **Before it moves.** A 10-second countdown (`countdownSeconds`); press Enter to stay, and sideby resumes the same session in the old account.
- **By hand.** Inside such a session, run `sideby handoff ready` (or ask the agent to), optionally with `--brief <file>` from your own handoff tool; the next account starts when the turn ends.
- **The brief.** Kept under `~/.local/state/sideby/handoffs/<chain>/`, mode 600, never in your repository; sideby adds the branch, uncommitted files and diff stat, and never commits or stashes. The next session gets the brief's path, not its text. When the old session could not write one, sideby puts one together from the session's records, marked as possibly incomplete.

| Host | Starts a handoff | Needs |
|---|---|---|
| Claude Code | at 80% / 95%, or when a turn fails at the limit | `sideby quota setup claude` (the quota tap); sideby adds its hooks with `--settings` |
| Codex | at 80% / 95% | trust sideby's hooks once per account: type `/hooks` in Codex; sideby says so the first time |
| Grok Build | only when a turn fails at the usage limit (Grok has no public quota) | `sideby handoff setup grok --yes`, then `sideby doctor grok --fix`; the default sandbox (`off` or `devbox`); `workspace` and `read-only` can only take over; `strict` and custom profiles take no part. A sandbox set by macOS device management is invisible to sideby |
| pi | never; it can take over | — |

A headless run (`claude -p`, `codex exec`, `grok -p`), Codex with `--remote`, or a session started without sideby never hands over. `sideby doctor` warns when Auto Handoff is on but the Claude quota tap or the Grok hook file is missing, or when `order` is empty or names an account sideby cannot find. Auto Handoff turns itself off for a run, and says so, when the `sideby` on your `PATH` is missing, comes from the npx cache, or is too old to have the hook.

## Host notes

Tested on 2026-10-05 with the versions below. sideby starts the official binary found on `PATH`; it never patches or wraps it.

| Host | Family | Tested version | Sign-in | Quota | Usage (7 days) |
|---|---|---|---|---|---|
| Claude Code | `claude` | 2.1.289 | `claude auth login` | status line cache (after `quota setup claude`) | local session records |
| Codex CLI | `codex` | 0.160.0 | `codex login` | local session files | local session files |
| Grok Build | `grok` | 1.0.46 | `grok login` | no public source | no public source |
| pi | `pi` | 1.0.2 | `/login` inside pi | no public source | no public source |

sideby counts usage itself from Claude Code's `projects/**/*.jsonl` and Codex's `sessions/**/rollout-*.jsonl`; you do not need ccusage. Grok Build and pi have no quota or usage source. API accounts show usage but no quota. If a Host is not installed, `list` still shows its accounts and marks the Host as missing; `run` tells you where to install it.

Host-specific notes:

- **codex**: non-main accounts get `-c cli_auth_credentials_store="file"` unless your arguments already set that key, so each account keeps its login in its own `auth.json`.
- **grok**: Grok's sandbox rejects symlinks for some paths, so `hooks` and `hooks-paths` are copies, not links, and `trusted_folders.toml` and `config.toml` are the account's own files. Doctor quotes the Host's own message when it finds one.
- **pi**: accounts live one level deeper (`~/.pi-<name>/agent`). `proxy.env` only loads provider keys; it does not make a pi account an API account.
