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

## Amendment (2026-11-04): choose the editor, and let a Portal open the file

The default program is not always an editor that opens a file it is handed. Seen with Cursor 3.28.7 set as the macOS default text editor on 2026-11-04: `open -t <file>` brought up Cursor's "Cursor Agents" window and never opened the file. A user also had no way to say which editor sideby should use, while a Portal around the Panel may already have one place where the user picks "the app files open in".

- Config `editor` (spec §3.30): `system` (the default, the behaviour above, unchanged on every platform), `cursor`, `vscode`, `windsurf` or `zed`. `sideby edit --with <editor>` uses one once. The Panel's Settings has the row "Open settings files in". An editor is started through its own command line with the file as the one argument, except Cursor, which gets `--classic <the file's folder> <file>` (Cursor 3.28.7 handed only a file also opened its Agent Window and not the file; with the folder it opens an editor window on it): on macOS the command inside its app bundle in each of `DesktopDeps.appDirs` (`<App>.app/Contents/Resources/app/bin/<cmd>`; Zed `Zed.app/Contents/MacOS/cli`), then the command on PATH, then `/usr/bin/open -a <App> <file>`; on Linux and WSL the command on PATH, then the default program as above. Each is tried until one exits 0; every one goes through `DesktopDeps.exec`. Setting `editor` is the fix for a default program that shows a window but not the file, and the message, the docs and the Settings hint say so.
- `createPanelHandler` gains `open?: { bridge: 'postMessage' }` (ADR-0006: compatible, checked when the handler is created; anything else throws a `TypeError`). Inside a frame, "Open settings.json" asks `/api/account/edit-settings` with `open: false`, which starts nothing and adds `realPath`, the real file's absolute path, then posts `{ type: 'local-tools:open', version: 1, path }` to `window.parent` at the Panel's own origin. The Portal opens it with the app the user chose there, so one choice covers every page. Without the option, or opened on its own, the Panel's server opens the file with config `editor`. An older sideby ignores the option and opens the file itself.
- The invariant stays: sideby reads none of the file, and neither the answer nor the message carries its content, only paths.

What any Portal that passes `open` must do: accept the message only from its own frame's window at its own origin, with type `local-tools:open`, version 1 and an absolute `path`; open the path with its own checks (a file under the user's home, say); and tell the user whether it opened.
