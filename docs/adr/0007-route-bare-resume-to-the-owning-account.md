# ADR 0007: Route a bare resume to the Account that holds the session

Date: 2026-10-08 · Status: accepted

## Context

Terminal managers such as Orca remember a Host session id and, when a pane is reopened, type a bare command into the shell: `claude --resume <id>`, `codex resume <id>`, `grok --resume <id>`. The line carries no Account directory, so the Host looks only in the Main Account and answers `No conversation found` for every session started with `sideby run` in another Account. Orca has its own account list for Claude and Codex, but it does not see the select variable sideby sets inside the launched process, and it ignores the transcript path its own hooks report.

Options considered:

- Ask each terminal manager to prefix the select variable. Out of our hands, and every tool would need it.
- Point the terminal manager at a per-Account command. A pane reopens many sessions over time; one fixed command cannot fit them all.
- Copy or move sessions into the Main Account. Breaks "the directory is the identity" and double counts Usage (spec §3.13 already declined it).
- A shell function with the Host's own name that asks sideby which Account holds the session. Works for any tool that types the bare command, needs no change in the tool, and copies nothing.

## Decision

- `sideby resume <family> [-- host args]` reads the session id from the Host arguments (a Family's `resumedSession`), asks every Account of the Family whether it holds that session (`sessionWrittenAt`, local files only), and starts the newest holder exactly as `sideby run` would. In every other case it runs the Host unchanged, as if sideby were not there.
- Only UUID-shaped ids are routed. Titles, `--continue` and `--last` stay with the Host, which picks by the current directory.
- `shell-init` writes the Host-named function only when the config says `resumeRouting: true`. Shadowing a Host command is a change to the user's shell that nobody should get by upgrading sideby.
- The function calls sideby only when the select variable is unset and an argument looks like a session id (UUID-shaped, alone or as `--resume=<id>`). Everything else goes straight to the Host, so a plain command costs nothing, and a Host that sideby started, or a shell inside it, is never routed twice.

## Consequences

- With routing on, a bare resume by id starts sideby first, about 140 ms from `dist` (it loads every Family and finds the Accounts). Other Host commands are not affected.
- `FamilyDef` gains two optional members. Plugin Families without them are never routed, and `sideby resume` refuses them.
- A session copied into two Accounts resumes in the one written last.

## Revisit when

A terminal manager can be told which command or environment to use per session, or a Host stores sessions outside its account directory.
