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

sideby recommends; you start the account. It never switches or rotates by itself (see the FAQ). The panel marks the same pick as **Next** in each family.

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
