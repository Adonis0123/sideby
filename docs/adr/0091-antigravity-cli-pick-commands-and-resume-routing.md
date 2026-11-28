# ADR-0091: Antigravity CLI pick commands, primary quota group ranking, and resume / Orca Chat routing

Status: accepted
Date: 2026-11-28

Amends ADR-0090 for Antigravity CLI (`agy`) account selection and session routing, keeping Auto Handoff off (`FamilyDef.handoff` remains absent).

## Context

ADR-0090 enabled multiple Antigravity CLI subscription accounts (`agy:main`, `agy:<name>`) via `--app_data_dir` and `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`, while excluding `agy` from Pick Commands, `sideby next`, and Panel recommendations via `noHandoff: true` because `agy /usage` reports only named per-model-group quota windows (`Gemini Models`, `Claude and GPT models`) rather than plan-wide windows.

Users running multiple `agy` accounts in terminals and in Orca Chat (`agy acp`) want a single pick command (`sideby run ag --`, matching `sideby run cc --`) that starts whichever account has the most room, while still returning resumed sessions to the account that holds their conversation database.

Verified with Antigravity CLI `1.5.19` and Orca `1.4.280` on macOS on `2026-11-28`:

- `agy --app_data_dir=<name> acp` initializes inside the target account directory and answers ACP `initialize` identically to `agy acp --app_data_dir=<name>`.
- Terminal resume uses `--resume <uuid>`, `--conversation <uuid>`, or `-r <uuid>`, with conversation records at `<account.dir>/conversations/<uuid>.db`.
- Orca Chat launches `agy acp` without `--conversation` on the command line (loading sessions over ACP JSON-RPC stdin) and exports `ORCA_STRUCTURED_SESSION=1` and `ORCA_AGENT_SESSION_ID=<id>`. Child shells spawned inside a Chat inherit those variables, so Orca Chat launches are distinguished by `classifyAgyArgs(args).subcommand === 'acp'`.

## Decision

1. **Primary quota group ranking**:
   - Add optional additive `FamilyDef.defaultQuotaGroup?: string` (`src/types.ts`) and optional `config.agy.pickGroup` (`src/core/config.ts`, default `'Gemini Models'`).
   - Remove `noHandoff: true` from `agyFamily` (`src/families/agy/index.ts`) and set `defaultQuotaGroup: 'Gemini Models'`. Keep `FamilyDef.noHandoff` on the public type for plugins, and keep `agyFamily.handoff` undefined so mid-session Auto Handoff stays off.
   - Extend `openWindows`, `quotaPressure`, `limitUse` (`src/core/quota-levels.ts`), and `planHandoff` (`src/core/handoff.ts`) with an optional `quotaGroup?: string`. When omitted, behaviour is unchanged (only unnamed windows count). When set, only windows whose `name` matches `quotaGroup` (trimmed, case-insensitive) count.
   - Expose the active `pickGroup` on `FamilyInfo` (`src/runtime.ts`, `schemas/list.json`, `schemas/families.json`) so the Panel's "Best to use now" card and Pick Commands dialog display and switch `agy.pickGroup` (`POST /api/agy/pick-group`).

2. **Default pick command name (`ag`)**:
   - Add `agy: 'ag'` to `DEFAULT_PICK_NAMES` (`src/core/pick-commands.ts`).
   - In `suggestPickName`, when numbered aliases share a prefix equal to the Host binary name (such as `agy001`/`agy002` → `agy`), fall back to `DEFAULT_PICK_NAMES[family]` instead of returning `null`.

3. **Terminal resume routing and Orca Chat sticky account binding**:
   - Add `resumedSession` (`--resume`, `--conversation`, `-r`), `sessionWrittenAt` (`<account.dir>/conversations/<id>.db`), and `withoutResume` to `agyFamily` so `sideby run <pick> -- --resume <id>` and `sideby resume agy -- --conversation <id>` route to the owning account.
   - Add `<stateDir>/orca-chat-accounts.json` (`src/core/orca-chat-bindings.ts`, mode `0600`, locked atomic writes, bounded LRU) keyed by `ORCA_AGENT_SESSION_ID`.
   - Only when `ORCA_STRUCTURED_SESSION=1`, `ORCA_AGENT_SESSION_ID` is valid, and `classifyAgyArgs(args).subcommand === 'acp'`:
     - `sideby run <agy-pick>` checks the binding first and starts that account if it still exists (ignoring quota, matching by-id resume semantics).
     - Any `sideby run` of an `agy` account records `ORCA_AGENT_SESSION_ID → account.ref` so waking a sleeping Orca Chat returns to the account holding its conversation database.
     - Non-`acp` `agy` commands run from a shell inside an Orca Chat never read or write bindings.

## Consequences

- `sideby alias add ag --pick agy --yes`, `sideby run ag --`, `sideby next agy`, and Panel "Best to use now" / "Next" tags work for Antigravity CLI using the configured primary quota group (`Gemini Models` by default, switchable via `sideby config set agy.pickGroup "<group>" --yes` or the Panel).
- New Orca Chats started through `sideby run ag --` (or `sideby run agy:<name> --`) stay pinned to their originating `agy` account across ACP restarts. Pre-existing Orca Chats never launched through this version have no recorded binding until started once via `sideby run`.
