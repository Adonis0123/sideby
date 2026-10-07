---
name: sideby
description: Use when the user runs several AI coding accounts (Claude Code, Codex, Grok Build, pi) and wants to see them, check how much quota or usage each has left, move on to another account because one hit its 5-hour or weekly limit, create an account or API account, add a short command (alias) for one, or repair a broken or drifted account directory (skills, hooks, rules or settings not shared, wrong symlinks, credential file permissions). Drives the `sideby` CLI with `--json` and leaves sign-in, credentials and starting sessions to the user.
metadata:
  version: "0.1.0"
---

# sideby

`sideby` runs each AI coding account from its own directory (`~/.claude-work`, `~/.codex-api`, ...) and keeps skills, hooks and rules shared with the Main Account (`~/.claude`, `~/.codex`, `~/.grok`, `~/.pi/agent`). Use `npx sideby` if the command is not installed. Requires Node 22.18+.

## Hard rules

- **Never read credential files**: `proxy.env`, `auth.json`, `.claude.json`, or anything under an account directory that may hold a token. Do not `cat`, `grep`, `head`, open or summarize them. `sideby list --json` gives the signed-in email as `identity.email`; that is all you need.
- **Never sign in for the user.** Tell them to run `sideby login <ref>` in their own terminal. OAuth needs their browser and their decision.
- **Never put a secret on the command line or in chat.** For API accounts, the user edits `proxy.env` themselves.
- **Never start a Host session from your shell.** `sideby run`, `sideby next` (without `--dry-run`) and `sideby login` open an interactive session; give the user the command instead.
- **Never switch, rotate or proxy accounts.** sideby does not do it, and you must not work around that by editing config, copying session files or moving credentials. Choosing the next account is the user's call; `sideby next` only recommends.
- **Show before you change.** Read-only commands first; changes only after the user has seen what will change.
- Do not edit Host config files (`settings.json`, `config.toml`, symlinks in account directories) by hand when a `sideby` command does the job.

## Output and exit codes

- Every `--json` output has `schemaVersion: 1`. On an error it is `{ "schemaVersion": 1, "error": "<what to do next>", "code": "<reason>" }`; `code` is `usage` for a malformed command line.
- Exit codes: `0` done, `1` failed or found a `fail` problem, `2` malformed command line, `10` **needs the user's confirmation**. `run`, `next` and `login` return the Host's own exit code once it starts.
- On `10`: show the user the change the command printed, ask, and only after a clear yes run the same command again with `--yes` added. Never add `--yes` on your own.

## What do you want to do

Account refs are `<family>:<name>`; a bare `<name>` works only when it is unique. Families: `claude`, `codex`, `grok`, `pi`.

| The user wants to | Run | Then read |
|---|---|---|
| See accounts, health, quota and usage | `sideby list --json`, `sideby doctor --json`, `sideby quota --json` | `references/diagnose.md` |
| Repair drift or permissions | `sideby doctor [ref] --json`, then `--fix` after they agree | `references/diagnose.md` |
| Keep working because an account hit its limit | `sideby next <family> --json` | `references/handoff.md` |
| Create an account, an API account or a short command | `sideby new`, `sideby alias add` | `references/accounts.md` |
| See Claude quota (it shows `not-enabled`) | `sideby quota setup claude` (exits 10) | `references/quota.md` |
| See everything at once | `sideby ui` (local panel on `127.0.0.1:17420`; `--no-open` prints the address) | — |
| Start an account | give them `sideby run <ref> [-- host args]` | — |

Read only the reference the task needs.

## Launching and the panel

`eval "$(sideby shell-init zsh)"` defines one function per account (`sideby-claude-work`) plus the config `aliases`. Users who source a file instead set config `shellInitFile` (for example `{ "zsh": "~/.config/sideby/shell-init.zsh" }`); `new` and `alias add|rm` keep it current, and `sideby shell-init zsh --write` rewrites it. New functions work in a new shell.

For someone who would rather double-click than use a terminal, `sideby app install` adds a desktop app (macOS `~/Applications/sideby.app`, Linux app menu) that runs `sideby ui --background`; `sideby ui --stop` stops it and `sideby app uninstall` removes the app. Ask before `app install`: it writes outside sideby's own directories.

## Keeping this skill current

If `sideby doctor --json` reports `skill.outdated`, this skill was written for another sideby version. Tell the user to update it with `npx skills add Adonis0123/sideby -g`.
