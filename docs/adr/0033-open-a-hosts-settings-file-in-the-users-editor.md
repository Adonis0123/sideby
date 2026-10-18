# 0033. Open a Host's settings file in the user's editor

Date: 2026-10-19 · Status: accepted

## Context

Users want to look at and change an Account's own Host settings (`settings.json` for Claude Code, `config.toml` for Codex and Grok Build) from the row they already see, without finding the directory first. The Panel offers "Copy folder path" only.

Showing the file inside the Panel was considered and rejected: Claude's `settings.json` often holds API keys under `env`, and the Invariants keep every value of that file except the few named keys out of any output (ADR-0011, ADR-0014, ADR-0017). Masking keys reliably would need a list of what counts as a secret, which the Host does not publish. Editors such as VS Code, Cursor and the system text editor already open, show and save these files well.

## Decision

- A Family may name its settings file with `FamilyDef.settingsFile`, a relative path inside the account directory (the same rule as Shared Item paths). Built-ins: Claude `settings.json`, Codex and Grok `config.toml`, pi `settings.json`.
- `sideby edit <account> [--path] [--json]` opens that file with the system's default program: macOS `/usr/bin/open -t <file>` (the default text editor), WSL the Windows default program through `cmd.exe /c start` with the `wslpath -w` path (`explorer.exe` was tried first and opened a file only now and then; a path with a character cmd reads itself, `&|<>^%"`, is refused), other Linux `xdg-open`. `--path` only prints where it is. Every program goes through `DesktopDeps.exec`, so tests start nothing.
- sideby reads none of the file's content: it checks only that the file exists, and where it is a link, its real target and which other Accounts of the Family reach the same file, so the user knows a change applies to them too.
- A missing file is refused with what to do next; sideby never creates or changes the file.
- The Panel's ⋯ menu of each directory has "Open settings.json" (named after the file); a read-only Panel does not offer it, because it starts a program.

## Consequences

- No new exception to "sideby writes nothing into a Host account directory": the user's editor does the writing.
- `FamilyDef` gains one optional field; plugin Families without it get no menu item and `sideby edit` says the Family names no settings file.
