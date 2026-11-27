# ADR-0089: Unattended Mode for Antigravity CLI (`agy`)

Status: accepted
Date: 2026-11-26

Amends ADR-0058 (Unattended Mode denies questions by schedule) and ADR-0047 (Antigravity CLI is a Main-only Family).

## Context

Unattended Mode (spec §3.37, ADR-0058) currently covers Claude Code and Codex sessions that sideby starts, by injecting `sideby unattended-hook` per session through `--settings` (Claude) or `-c hooks.<event>` (Codex). Antigravity CLI (`agy`) sessions are listed as `not-covered`, so a long task running in `agy` still stops on `ask_question` or ends its turn on a plain-text question while Unattended Mode is on.

Checked with `agy` 1.5.18 on macOS on 2026-11-26:

- `agy --settings <file>` accepts only `settings.json` keys (such as `statusLine` and `title`, ADR-0088). It does **not** load lifecycle hooks.
- `agy` loads lifecycle hooks exclusively from `hooks.json` files (global `~/.gemini/config/hooks.json`, workspace `.agents/hooks.json`, or plugin `hooks.json`). Each top-level key in `hooks.json` is an independent named hook block merged at runtime.
- `PreToolUse` uses grouped entries (`[{ matcher, hooks: [{ type: "command", command, timeout }] }]`); `Stop` uses flat entries (`[{ type: "command", command, timeout }]`).
- All `agy` hooks run synchronously; there is no `async` or `asyncRewake` background wake-up, no `PermissionRequest` hook, and no `Elicitation` or `StopFailure` hook.
- For `PreToolUse` on `ask_question`, `agy` sends camelCase JSON on stdin (`conversationId`, `cwd`, `workspacePaths`, `transcriptPath`, `toolCall: { id, name, args }`) where `args.questions` has `{ question, options: string[], is_multi_select? }`. To block the tool, stdout returns `{"decision":"deny","reason":"..."}` with exit 0; to allow it unchanged, stdout is empty with exit 0.
- For `Stop`, `agy` sends camelCase JSON on stdin (`conversationId`, `cwd`, `workspacePaths`, `transcriptPath`, `terminationReason`, `continuationActive`, `fullyIdle`, `executionNum`) without `last_assistant_message`. The latest model reply lives in `transcriptPath` (under `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` or `~/.gemini/antigravity/brain/<id>/...`) as the last JSONL record with `type: "PLANNER_RESPONSE"` and string `content`. To continue once, stdout returns `{"decision":"continue","reason":"..."}` with exit 0; to allow the stop, stdout returns `{"decision":""}` with exit 0.

## Decision

1. **Explicit global hook setup for `agy` (`sideby unattended setup agy [--yes]` / `teardown agy`)**:
   - Because `agy` cannot receive hooks via per-session launch arguments, sideby adds a ninth explicit exception to its Host-directory invariant: `sideby unattended setup agy --yes` (and the matching preview-and-confirm action on the Panel's Unattended page) adds one top-level key, `"sideby-unattended"`, to `~/.gemini/config/hooks.json`, preserving every other key, indentation and trailing newline.
   - `sideby unattended setup agy` without `--yes` previews the target file and unified diff and exits `10`, matching `quota setup` and `handoff setup`. It refuses (`blocked`) when `sideby` is not on `PATH` or comes from the npx cache, when `~/.gemini/config/hooks.json` is a symlink, invalid JSON, or not a JSON object, or when `"sideby-unattended"` already exists with content not written by sideby.
   - Writes run under `<state>/settings-locks/<hash of file>.lock` via `writeIfUnchanged` (keeping existing file mode, or `0600` when creating a new file).
   - `sideby unattended teardown agy` removes `"sideby-unattended"` only while its value still matches what sideby wrote (exact equality against current or earlier known sideby entries). If removing the key leaves an empty JSON object `{}` with no other keys, sideby removes `~/.gemini/config/hooks.json` (never removing non-empty parent directories); otherwise it rewrites the remaining keys untouched.
   - Because `~/.gemini/config/hooks.json` is global to `agy`, once set up it covers every local `agy` session (including sessions started outside `sideby run`), and reacts immediately to `sideby unattended on|off` and the Schedule without restarting running sessions. Starting with `sideby run agy --unattended` still sets `SIDEBY_UNATTENDED=1` for that single session once the hook is installed.

2. **`sideby unattended-hook agy <PreToolUse|Stop>` protocol**:
   - Stays strictly inside the leaf-module import graph of `src/unattended/hook.ts`.
   - **`PreToolUse`** (`ask_question`): while Unattended Mode is on (global schedule/override or `SIDEBY_UNATTENDED=1`), records a `question` Pending Decision (`family: "agy"`, `sessionId: conversationId`, `cwd`, `account` from `SIDEBY_ACCOUNT` when present) and writes `{"decision":"deny","reason":...}\n` to stdout with exit 0. While off, or on any error before deciding, exits 0 with no output.
   - **`Stop`**: checks only when Unattended Mode is on, `continuationActive !== true`, and `terminationReason` is absent or `"NO_TOOL_CALL"`. Reads the last assistant message from `lastAssistantMessage`/`last_assistant_message` if present, else reads at most the last 2 MiB of `transcriptPath` **only** when `transcriptPath` is a regular file (never a symlink) whose real path stays inside `<real HOME>/.gemini/` and ends in `.jsonl`, extracting the final `PLANNER_RESPONSE` string `content` (never storing the transcript or any non-question text). When `endingQuestion` matches, records a `question` Pending Decision (deduped) and writes `{"decision":"continue","reason":...}\n` to stdout with exit 0. In all other cases (mode off, `continuationActive: true`, non-`NO_TOOL_CALL` termination, no question, unreadable/out-of-bounds transcript, or error), writes `{"decision":""}\n` to stdout with exit 0.

3. **Status, coverage, Panel and Skill**:
   - `coverage.agy` stays within the existing `'covered' | 'needs-trust' | 'not-covered'` enum (`'covered'` once `"sideby-unattended"` is installed in `~/.gemini/config/hooks.json`, else `'not-covered'`), keeping `schemaVersion: 1` backward compatible.
   - `UnattendedStatus` adds an optional `agySetup` summary (`{ status: 'enabled' | 'ready' | 'blocked', file, message }`) when `agy` is among the known families, so the CLI, Panel and Skill can distinguish "ready to set up" from "blocked" or "already enabled".
   - The Panel's Unattended page ("Where it works") shows Antigravity CLI with a one-click preview-and-confirm setup action (and remove action with undo once enabled), and `/api/unattended/setup` + `/api/unattended/teardown` back it.
   - `skills/sideby/references/unattended.md` and `SKILL.md` document `sideby unattended setup agy` / `teardown agy` and its scope.

## Considered

- **Passing hooks via `agy --settings`**: verified on `agy` 1.5.18 that `--settings` only overrides `settings.json` keys and never loads hooks.
- **Shipping an `agy` plugin directory**: requires installing/registering a plugin bundle inside `~/.gemini/config/plugins/` with extra lifecycle state, whereas `~/.gemini/config/hooks.json` natively supports independent named top-level keys (`"sideby-unattended"`) that can be diffed, added, and cleanly removed in one file.
- **Adding `PreInvocation` Attended-Session tracking, Answer Wait, or Turn Retry in v1**: `agy` hooks are synchronous only (no `async` / `asyncRewake`), have no `PermissionRequest` or `StopFailure` hook, and `PreInvocation` fires on tool continuations as well as user prompts. Deferring Attended Session detection to a follow-up keeps v1 predictable and avoids false-positive prompt attribution.
- **Adding a new `coverage` enum value (`needs-setup`)**: would break JSON consumers that switch on `covered | needs-trust | not-covered` without bumping `schemaVersion`. Keeping `coverage.agy` in the existing union and adding optional `agySetup` preserves `schemaVersion: 1`.

## Consequences

- `agy` reaches parity with Codex on Unattended Mode (`ask_question` tool refusal + plain-text `Stop` question continuation + Pending Decisions), while remaining transparent about what `agy` does not expose (permission prompts, MCP forms, Turn Retry, Answer Wait, Attended Sessions).
- Unlike Claude and Codex, installing the `agy` hook writes one named entry to `~/.gemini/config/hooks.json` after explicit user confirmation (`--yes` or Panel confirm) and covers all local `agy` sessions, not only those started via `sideby run`.
- `schemas/unattended.json` gains optional `agySetup` and new `unattended-setup` / `unattended-teardown` schemas under `schemaVersion: 1`.
