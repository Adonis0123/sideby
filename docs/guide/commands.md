# Commands

English | [中文](commands.zh-CN.md)

← [README](../../README.md)

| Command | What it does | Exit code |
|---|---|---|
| `sideby` | Same as `sideby list` | 0 |
| `sideby list` | Accounts, type (main, sub or api), login state, model, directory; reading problems go to stderr | 0 |
| `sideby run <acct> [-- args]` | Start the Host for one account | the Host's code; 128+n if killed by signal n |
| `sideby new <family> <name>\|--next [--api] [--alias <short>]` | Create an account and lay out its Shared Items; `--next` picks the next free name and short command (`cc008`); `--alias` also adds a short command such as `cc008` to `aliases` | 0; 1 if partly failed or the alias was not added |
| `sideby families [family]` | What each Host's accounts share with the main account, where they live and how they sign in | 0 |
| `sideby alias add <short> <acct> [-- args]` | Add a short command for an existing account, optionally with Host arguments that `sideby run` adds | 0, also when it already exists; 1 if the name is taken, invalid or the account does not exist |
| `sideby alias rm <short>` | Remove a short command | 0, also when it is not there |
| `sideby resume <family> [-- args]` | Run the Host; when the arguments resume a session by id (`claude --resume <id>`, `codex resume <id>`, `grok --resume <id>`), start the account that holds it, as `run` would. A Claude session that was never saved starts anew in the account that started it. Otherwise run the Host unchanged | the Host's code; 1 if the family is unknown or cannot route sessions (pi) |
| `sideby login <acct>` | Run the family's sign-in command for that account; for pi, start pi and tell you to type `/login` | the Host's code |
| `sideby next <family> [--dry-run] [--include-api] [-- args]` | Recommend the account with the most quota left (Claude, Codex) and start it; `--dry-run` only recommends | the Host's code; 0 for `--dry-run` or `--json` with a pick; 1 if no account can be used, none has quota data yet, the family has no quota source or no accounts |
| `sideby doctor [acct\|family] [--fix] [--force]` | Check Shared Items, credential file modes, leftovers; `--fix` repairs what is safe | 0 no failures (warnings allowed); 1 at least one failure |
| `sideby quota [acct]` | Quota and 7-day usage | 0 |
| `sideby quota setup claude [--yes]` | Show the change; with `--yes`, turn the Claude quota source on | 10 when it only showed the change; 0 once on; 1 if blocked or failed |
| `sideby quota teardown claude` | Turn it off and restore the original file | 0; 1 if refused or failed |
| `sideby tune [acct\|family]` | Estimate the cheapest auto-compact threshold per model from your last 7 days of sessions (Claude suggests, Codex only observes); read-only | 0; 1 if the account or family does not exist; 2 for extra arguments |
| `sideby model <acct> [<model>\|default] [--effort <level>\|default] [--yes]` | Show the model and effort this account starts with and where each comes from; with a change, show it and save it with `--yes` (Claude, Codex) | 0; a change waiting for `--yes` is 10; a bad value or an API account is 1 |
| `sideby tune apply <acct> [tokens] [--yes]` / `sideby tune undo <acct> [--yes]` | Use the suggested auto-compact size for a Claude account (or a size you give, such as `120k`), or put the old value back. Writes one key of that account's `settings.json`; without `--yes` it only shows the change | 10 when it only showed the change; 0 once done; 1 if blocked, nothing to undo or no suggestion; 2 for a malformed command line |
| `sideby remote-control [off\|undo] [--yes]` | Show whether each Claude settings file starts Remote Control by itself; `off` sets `remoteControlAtStartup` to false in every one that is on or not set, `undo` puts back what was there (both show the change first) | 10 when it only showed the change; 0 done or nothing to do; 1 blocked, failed or nothing to undo |
| `sideby handoff status` | What Auto Handoff still needs on this machine, family by family, with the commands to run next | 0 |
| `sideby handoff enable [--same-family] [--order <family>=<acct,…>] [--threshold n] [--prepare-at n] [--yes]` | Show the config change; with `--yes`, turn Auto Handoff on (other settings kept) and list what is still to do | 10 when it only showed the change; 0 once written or already so; 1 if an `--order` account is unknown |
| `sideby handoff disable [--yes]` | Turn it off, keeping the other settings | 10 when it only showed the change; 0 once written or already off |
| `sideby handoff ready [--to <account>] [--brief <file>]` | Inside a session sideby started with Auto Handoff: hand over to the next account when this turn ends, and say which one; `--to` names it, also one this chain already used (to hand back to an account whose quota came back); `--brief` uses your own handoff note | 0; 1 outside such a session, when the brief cannot be read, or when no account (or not the one named) can take over |
| `sideby handoff setup grok [--yes]` | Show the change; with `--yes`, add sideby's hook file so Grok can hand over at its limit | 10 when it only showed the change; 0 once on; 1 if blocked or failed |
| `sideby handoff teardown grok` | Remove that file while it is unchanged | 0; 1 if refused or failed |
| `sideby ui [--port n] [--no-open]` | Local panel; runs until Ctrl+C | — |
| `sideby ui --background` / `--stop` | Start the panel detached from the terminal (reusing a running one, or replacing it after sideby was upgraded) and open it / stop it | 0; 1 if it could not start or stop |
| `sideby desktop <acct>` | Open Claude Desktop or the Codex app as that account, alongside the other accounts; brings its window to the front when it is already open (macOS) | 0; 1 not macOS, no desktop app for that host, an API account, app not installed, or it did not open |
| `sideby desktop grok-bot:<name> [--remove [--yes]]` | Open a Grok Bot window by name, making a new signed-out one for a new name; `--remove` deletes a window you made and its data (macOS) | 0; 1 not macOS, bad name, app not installed, window open (for `--remove`) or it did not open; 10 `--remove` without `--yes` |
| `sideby app install [--url <url>]` | Add a panel app (macOS, Linux) that opens the panel, or `<url>` | 0; 1 on an unsupported platform or a file it did not create in the way |
| `sideby app uninstall` | Remove what `app install` created | 0; 1 if it left a file it did not create |
| `sideby shell-init zsh\|bash` | Print shell functions for every account and your aliases | 0 |
| `sideby shell-init [zsh\|bash] --write` | Rewrite the configured `shellInitFile` with that output | 0; 1 if a file could not be written or none is configured |
| `sideby plugins` | Loaded plugins and load errors | 0; 1 if any plugin failed to load |
| `sideby update [--yes]` | Ask the npm registry for the newest sideby and show the command that installs it; with `--yes`, run it and restart a background panel (see [Updates](configuration.md#updates)) | 0 up to date or updated; 10 when it only showed the command; 1 when this install cannot update itself (the command to run is printed), the registry is unreachable or the install failed |

- Every command exits 2 on a usage error (unknown option, missing argument) and 1 when sideby itself fails (unknown account, invalid name, unreadable config). Exit code 10 means a change was shown and waits for your yes: run the same command again with `--yes`.
- `<acct>` is `<family>:<name>`, or just `<name>` when it is unique across families. An ambiguous name is an error that lists the candidates.
- `list`, `new`, `next`, `alias`, `doctor`, `quota` (including `setup` and `teardown`), `tune`, `model`, `remote-control`, `handoff`, `families`, `plugins`, `app` and `desktop` accept `--json`. JSON output carries `schemaVersion: 1`, and the JSON Schemas ship in [`schemas/`](../../schemas/). With `--json`, an error prints `{ "schemaVersion": 1, "error": "…", "code": "…" }`, where `code` is `usage` for a malformed command line or a reason such as `no-quota-source`. Adding a field keeps the version; removing, renaming or changing the meaning of a field bumps it.
- No output, log or error message ever contains a credential value.
