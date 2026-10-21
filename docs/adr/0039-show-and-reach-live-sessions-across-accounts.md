# ADR-0039: Show and reach Live Sessions across Accounts

Status: accepted
Date: 2026-10-20

## Context

A user who runs many Accounts side by side cannot tell which terminal tab is which, cannot find the session id of "the session running in cc002", and passes messages between sessions by hand. Each Host lists only its own sessions: Claude Code's `ListAgents` and `claude agents` see only sessions of the current `CLAUDE_CONFIG_DIR` (tried with Claude Code 2.1.304 on 2026-10-20). No tool surveyed (Claude Code, Codex, Grok Build, Orca, Amp, claude-squad, cmux, mcp_agent_mail) answers which session an Account is running, and there is no cross-tool messaging standard.

## Decision

1. sideby lists Live Sessions of every Account from the Hosts' own non-credential files (Claude `sessions/<pid>.json`, Grok `active_sessions.json`, Codex rollout files and process environment, pi session files), checks that the process still runs and belongs to the current user, skips a process whose environment or start time it cannot check (reporting it in `problems`), and marks a guess as a guess. It never copies or edits a session.
2. The copy button copies a Session Reference first, because a user copies a session to hand it to another AI; the bare id and the resume command are secondary.
3. A Message is kept as a file in sideby's state directory before any delivery, so it is never lost and works for every Host; native delivery is used where the Host has it, and otherwise the user is told to paste one line.
4. sideby does not run its own message server and does not type into another terminal (both interrupt or need a daemon).
5. Claude Code sessions launched by sideby load a sideby mod through `--plugin-dir` (no write into the Account directory) that shows the Session Label, a toast for an arriving Message, and a `/sessions` pane fed by `sideby sessions --json`. It is on by default, can be turned off in config, and is skipped on a Claude Code version without the mod API. This is the first time sideby changes a Host's interface; it adds only views and reads only sideby output. (Implemented 2026-10-20 as `mods/claude`, for Claude Code 2.1.287 or later, config `claudeMod`; spec §3.32 step 3.)
6. Recommending `crossSessionInbound: "accept"` writes one top-level key of a Claude `settings.json`, under the rules of `tune apply` (preview, `writeIfUnchanged`, undo).
7. Orca is optional: when its CLI is present and the Host process carries `ORCA_TERMINAL_HANDLE` that `orca terminal list` still lists, a row can jump to its tab (`orca terminal switch`, run by the Panel server with an argument array; the handle never reaches the page). `terminal list` has no pid or tty, so this variable is the only reliable link (tried with Orca 1.4.230 on 2026-10-20).
8. The resume command a row copies is the form each Family already supports (`sideby resume claude -- --resume <id>`, `sideby resume codex -- resume <id>`, `sideby run <ref> -- --session <id>` for pi); a bare `sideby resume <id>` may come later.

## Consequences

The Panel, the CLI and the skill gain a Sessions view. The mod depends on an early-access Claude Code API and must be version-gated. Codex and pi sessions can only be guessed when the process does not hold its rollout file open. Message delivery to Codex and Grok comes in a later step.
