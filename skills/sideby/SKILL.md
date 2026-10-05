---
name: sideby
description: Use when the user wants to run several AI coding accounts at the same time (Claude Code, Codex, Grok Build, pi), create a new Claude, Codex, Grok or pi account or API account, check how much quota or usage each account has left, or repair a broken or drifted account directory (skills, hooks, rules, settings not shared, wrong symlinks, credential file permissions). Drives the `sideby` CLI with `--json` for diagnosis and leaves sign-in and credentials to the user.
---

# sideby

`sideby` runs each AI coding account from its own directory (`~/.claude-work`, `~/.codex-api`, ...) and keeps skills, hooks and rules shared with the Main Account (`~/.claude`, `~/.codex`, `~/.grok`, `~/.pi/agent`). Use `npx sideby` if the command is not installed. Requires Node 22.18+.

## Hard rules

- **Never read credential files**: `proxy.env`, `auth.json`, `.claude.json`, or anything under an account directory that may hold a token. Do not `cat`, `grep`, `head`, open or summarize them. sideby already reports their type and mode, and `sideby list --json` gives the signed-in email as `identity.email`; that is all you need.
- **Never sign in for the user.** After creating a subscription account, tell the user to run `sideby login <ref>` in their own terminal. OAuth needs their browser and their decision.
- **Never put a secret on the command line or in chat.** For API accounts, the user edits `proxy.env` themselves.
- **Show before you change.** Run `doctor` without `--fix` first and show the findings; run `quota setup claude` only after the user has seen the diff.
- Do not edit Host config files (`settings.json`, `config.toml`, symlinks in account directories) by hand when a `sideby` command does the job.

## Diagnose

Start read-only. Every `--json` output carries `schemaVersion: 1`.

```sh
sideby list --json        # accounts: ref, family, kind (subscription|api), dir, login, model, hostInstalled, problems
sideby doctor --json      # findings: level ok|warn|fail, account, item, code, message, hint, fixable
sideby quota --json       # per account: quota windows (5h, 7d, usedPercent, resetsAt, observedAt) and 7-day tokens
sideby plugins --json     # loaded plugins (setting names only, never values) and load errors
```

Narrow with an account or family: `sideby doctor claude:work --json`, `sideby doctor codex --json`, `sideby quota work --json`.

Account refs are `<family>:<name>`. A bare `<name>` works only when unique across families; on an ambiguity error, use the full ref from the candidates listed.

Shared Items the Main Account does not have are skipped: no Finding, not counted in `shared`. A directory such as `~/.claude-code-router` that holds neither `proxy.env` nor any Shared Item is not listed as an account.

Read the results like this:

| Signal | Meaning | What to do |
|---|---|---|
| `fail` / `warn` with `fixable: true` | Safe repair exists | Offer `doctor --fix` (see below) |
| `fixable: false` with a `hint` | sideby will not touch it on purpose (real file where a link belongs, API account item) | Show the hint; the user decides |
| `warn` `link.other-target` | The link resolves, but not to the Main Account's item; often deliberate | Mention it; change nothing unless the user asks |
| `fail` `link.dangling` | The link points at nothing | Show the hint (`ls -l <path>`); the user decides how to repair it |
| `fail` `symlink-forbidden` without `fixable` | The Host needs a real file here, but the link points somewhere other than the Main Account | Show the hint; sideby will not replace a link it did not create |
| credential item, mode not 600 | `proxy.env`, `auth.json`, `.claude.json` readable by others | `--fix` resets the mode to 600 |
| name looks like a backup (`bak`, `backup`, `old`, `tmp`) | A stray directory was picked up as an account | Suggest adding its ref to `ignore` in `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json` |
| `login: "not-needed"` (`key` in `sideby list`) | API account; it authenticates with `proxy.env` | Nothing to do |
| `problems` on an account in `list --json` | A plugin failed while reading it (for example a settings file that is not valid JSON) | Show the message; the account itself still works |
| quota `unavailable` / `not-enabled` | Claude quota source is off | Offer `quota setup claude` (see below) |
| quota `unavailable` / `no-session` | No session since the source was enabled | Ask the user to start one session with that account |
| quota `unavailable` / `no-source` | Grok, pi: the Host has no public source | Nothing to fix |
| quota `unavailable` / `api-account` | API accounts have no quota | Nothing to fix |
| quota `unavailable` / `unrecognized` | Host changed its file format | Report it; suggest filing an issue with the Host version |
| host not installed | Accounts exist but the CLI is missing | Point to the Host's install docs; do not install it unasked |

## Repair

1. Run `sideby doctor [ref] --json` and show the user every finding you plan to fix, grouped by account.
2. After the user agrees, run `sideby doctor [ref] --fix`, then `sideby doctor [ref] --json` again and report what is still open.
3. `--force` is only for `json-key` items (for example `.claude.json#mcpServers`) when a fix would remove entries the account already has. Never add `--force` without telling the user exactly which entries would disappear.

`--fix` never replaces a real file with a link, never re-points an existing symlink (wrong or dangling links are only reported), never writes through a link into the Main Account, and never changes credential contents. Findings it skips need a human decision; explain the hint, do not work around it with `rm` or `ln`.

## Create an account

Check the name first: `^[a-z0-9][a-z0-9-]{0,31}$`, and not already taken (`sideby list --json`).

```sh
sideby new claude work            # subscription account: ~/.claude-work
sideby new claude deepseek --api  # API account: ~/.claude-deepseek with a proxy.env template (mode 600)
sideby new claude 008 --alias cc008  # also adds the short command cc008 to config aliases
```

Only pass `--alias` when the user wants a short command; follow their existing pattern (`cc001`…`cc007` for `claude:001`…`claude:007` suggests `cc008`). An invalid, reserved or taken alias is refused before anything is created. If `alias.added` is false in `--json`, the account exists but the alias is missing: tell the user the message, do not edit the config by hand.

Families: `claude`, `codex`, `grok`, `pi`. Then:

- **Subscription account**: tell the user to run `sideby login claude:work` in their own terminal (for pi, `sideby login pi:<name>` starts pi; then they type `/login`). Do not run it for them.
- **API account**: tell the user to open the `proxy.env` path printed by `new` in their editor and fill in the values. Do not read or write it yourself. It then shows `login: "not-needed"`.
- **pi**: a `proxy.env` in a pi account only loads provider keys; the account stays a subscription account and still needs `/login`.
- Afterwards: `sideby doctor <ref> --json` to confirm the new account is healthy, then the user starts it with `sideby run <ref>`.

## Claude quota

Claude quota needs a one-time change to `~/.claude/settings.json`: the status line command becomes `sideby statusline-tap --orig-b64 <base64 of the original command>`.

1. sideby must be installed globally (`npm i -g sideby`), because Claude Code runs the wrapper on every status line refresh. Setup is refused when `sideby` is missing from PATH or comes from the npx cache; tell the user to install it rather than working around it.
2. Run `sideby quota setup claude` without `--yes`. It prints the diff and changes nothing; show the diff to the user.
3. Only after the user approves, run `sideby quota setup claude --yes`.
4. To undo: `sideby quota teardown claude`. It restores the file byte for byte only if nothing changed since setup. If it refuses, show its diff and tell the user to set `statusLine.command` back to the original command (the base64 after `--orig-b64`), or delete `statusLine` if there was none.

Accounts with their own (not linked) `settings.json` show quota `not-enabled` until that file's status line is wrapped the same way; tell the user instead of editing it.

Usage (7-day tokens) is read by sideby itself from Claude Code and Codex local records; no ccusage is needed. Grok and pi have no quota or usage source.

## Launching

`sideby run <ref> [-- host args]` starts an interactive Host session in the user's terminal. Do not start it from an agent shell; give the user the command. `eval "$(sideby shell-init zsh)"` defines one function per account (`sideby-claude-work`) plus the `aliases` map in config. Users who source a file instead set config `shellInitFile` (for example `{ "zsh": "~/.config/sideby/shell-init.zsh" }`); `new` keeps it current, and `sideby shell-init zsh --write` rewrites it on demand. New functions work in a new shell.

## Panel

`sideby ui` opens a local panel on `127.0.0.1:17420` with the same data and actions (`--no-open` prints the address only). Suggest it when the user wants to see every account at once.

For someone who would rather double-click than use a terminal, `sideby app install` adds a desktop app (macOS `~/Applications/sideby.app`, Linux app menu) that runs `sideby ui --background` and opens the panel; `sideby ui --stop` stops it and `sideby app uninstall` removes the app. Ask before running `app install`: it writes outside sideby's own directories.
