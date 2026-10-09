# Commands

English | [中文](commands.zh-CN.md)

← [README](../../README.md)

| Command | What it does | Exit code |
|---|---|---|
| `sideby` | Same as `sideby list` | 0 |
| `sideby list` | Accounts, type (main, sub or api), login state, model, directory; reading problems go to stderr | 0 |
| `sideby run <acct> [-- args]` | Start the Host for one account | the Host's code; 128+n if killed by signal n |
| `sideby new <family> <name> [--api] [--alias <short>]` | Create an account and lay out its Shared Items; `--alias` also adds a short command such as `cc008` to `aliases` | 0; 1 if partly failed or the alias was not added |
| `sideby alias add <short> <acct> [-- args]` | Add a short command for an existing account, optionally with Host arguments that `sideby run` adds | 0, also when it already exists; 1 if the name is taken, invalid or the account does not exist |
| `sideby alias rm <short>` | Remove a short command | 0, also when it is not there |
| `sideby resume <family> [-- args]` | Run the Host; when the arguments resume a session by id (`claude --resume <id>`, `codex resume <id>`, `grok --resume <id>`), start the account that holds it, as `run` would. A Claude session that was never saved starts anew in the account that started it. Otherwise run the Host unchanged | the Host's code; 1 if the family is unknown or cannot route sessions (pi) |
| `sideby login <acct>` | Run the family's sign-in command for that account; for pi, start pi and tell you to type `/login` | the Host's code |
| `sideby next <family> [--dry-run] [--include-api] [-- args]` | Recommend the account with the most quota left (Claude, Codex) and start it; `--dry-run` only recommends | the Host's code; 0 for `--dry-run` or `--json` with a pick; 1 if no account can be used, none has quota data yet, the family has no quota source or no accounts |
| `sideby doctor [acct\|family] [--fix] [--force]` | Check Shared Items, credential file modes, leftovers; `--fix` repairs what is safe | 0 no failures (warnings allowed); 1 at least one failure |
| `sideby quota [acct]` | Quota and 7-day usage | 0 |
| `sideby quota setup claude [--yes]` | Show the change; with `--yes`, turn the Claude quota source on | 10 when it only showed the change; 0 once on; 1 if blocked or failed |
| `sideby quota teardown claude` | Turn it off and restore the original file | 0; 1 if refused or failed |
| `sideby handoff status` | What Auto Handoff still needs on this machine, family by family, with the commands to run next | 0 |
| `sideby handoff enable [--same-family] [--order <family>=<acct,…>] [--threshold n] [--prepare-at n] [--yes]` | Show the config change; with `--yes`, turn Auto Handoff on (other settings kept) and list what is still to do | 10 when it only showed the change; 0 once written or already so; 1 if an `--order` account is unknown |
| `sideby handoff disable [--yes]` | Turn it off, keeping the other settings | 10 when it only showed the change; 0 once written or already off |
| `sideby handoff ready [--brief <file>]` | Inside a session sideby started with Auto Handoff: hand over to the next account when this turn ends; `--brief` uses your own handoff note | 0; 1 outside such a session or when the brief cannot be read |
| `sideby handoff setup grok [--yes]` | Show the change; with `--yes`, add sideby's hook file so Grok can hand over at its limit | 10 when it only showed the change; 0 once on; 1 if blocked or failed |
| `sideby handoff teardown grok` | Remove that file while it is unchanged | 0; 1 if refused or failed |
| `sideby ui [--port n] [--no-open]` | Local panel; runs until Ctrl+C | — |
| `sideby ui --background` / `--stop` | Start the panel detached from the terminal (reusing a running one, or replacing it after sideby was upgraded) and open it / stop it | 0; 1 if it could not start or stop |
| `sideby app install [--url <url>]` | Add a desktop app (macOS, Linux) that opens the panel, or `<url>` | 0; 1 on an unsupported platform or a file it did not create in the way |
| `sideby app uninstall` | Remove what `app install` created | 0; 1 if it left a file it did not create |
| `sideby shell-init zsh\|bash` | Print shell functions for every account and your aliases | 0 |
| `sideby shell-init [zsh\|bash] --write` | Rewrite the configured `shellInitFile` with that output | 0; 1 if a file could not be written or none is configured |
| `sideby plugins` | Loaded plugins and load errors | 0; 1 if any plugin failed to load |

- Every command exits 2 on a usage error (unknown option, missing argument) and 1 when sideby itself fails (unknown account, invalid name, unreadable config). Exit code 10 means a change was shown and waits for your yes: run the same command again with `--yes`.
- `<acct>` is `<family>:<name>`, or just `<name>` when it is unique across families. An ambiguous name is an error that lists the candidates.
- `list`, `new`, `next`, `alias`, `doctor`, `quota` (including `setup` and `teardown`), `plugins` and `app` accept `--json`. JSON output carries `schemaVersion: 1`, and the JSON Schemas ship in [`schemas/`](../../schemas/). With `--json`, an error prints `{ "schemaVersion": 1, "error": "…", "code": "…" }`, where `code` is `usage` for a malformed command line or a reason such as `no-quota-source`. Adding a field keeps the version; removing, renaming or changing the meaning of a field bumps it.
- No output, log or error message ever contains a credential value.
