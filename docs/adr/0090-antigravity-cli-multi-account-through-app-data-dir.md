# ADR-0090: Antigravity CLI multi-account support through `--app_data_dir`

Status: accepted
Date: 2026-11-27

Supersedes ADR-0047 for Antigravity CLI (`agy`), while keeping the `Main-only Family` contract for plugins whose Host has no isolation mechanism. Links architecture snapshot `docs/architecture/2026-11-27-agy-multi-account.md`.

## Context

Under ADR-0047 (tried with `agy` 1.4.4 on 2026-10-21), `agy` was registered as a `Main-only Family` because it has no `CLAUDE_CONFIG_DIR`/`CODEX_HOME` equivalent environment variable and stores its global OAuth login in one shared OS keyring item (`service="gemini"`, `account="antigravity"`).

Re-verified with Antigravity CLI `1.5.18` on macOS on `2026-11-27`:

- While `agy --help` still hides directory variables and flags, the binary registers `--app_data_dir` (a directory name or relative path inside `~/.gemini`, alongside `~/.gemini/antigravity-cli`) and `--gemini_dir`, and checks `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1|true` (`cliFileTokenStorage`), which bypasses the OS keyring and writes the Account's OAuth token to `<appDataDir>/antigravity-oauth-token` at mode `0600` (the same native file store `agy` falls back to over SSH or when the keychain is locked).
- Passing `--app_data_dir=antigravity-cli-<name>` with `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` while keeping the real `HOME` leaves `~/.gemini/config/` (MCP config, plugins, rules, and ADR-0089's `hooks.json`) natively shared across Accounts without altering `git`, `ssh`, `gh`, or the Main Account's Keychain login shared with Antigravity App / IDE.
- Live verification with `agy` 1.5.18 on `2026-11-27` confirmed two distinct Google accounts (`agy:main` on the Keychain and a second account in `~/.gemini/antigravity-cli-<name>`) running concurrently and answering `agy -p /usage --output-format json` independently.

## Decision

1. **Additive `FamilyDef` selection contract (`src/types.ts`)**:
   - Add optional `selectArgs?(account: Account): string[]` and `selectEnv?(account: Account): Env` on `FamilyDef`, keeping `schemaVersion: 1`.
   - Allow `layout.account` to place `<name>` in any path segment (for example `.gemini/antigravity-cli-<name>`), generalized in `splitLayout` / `discoverAccounts` (`src/core/accounts.ts`) while still requiring every segment along the path to be a real directory (never following symlinks).
   - `mainOnly` remains available: a `mainOnly: true` Family leaves out `selectVar`, `selectArgs`, `selectEnv`, and `layout.account`; every other Family declares `layout.account` (relative to HOME with `/` separators, no `.`/`..` segments, and `<name>` appearing once total) and at least one of `selectVar` or `selectArgs`. `discoverAccounts` checks that every parent, `<name>`, and nested segment is a real directory (`lstatOrNull().isDirectory()`), and `defProblems` enforces the identical `layoutPathProblem` rule.
   - `accountEnv` (`src/core/launch.ts`) applies `selectEnv` for non-main Accounts (after clearing `hijackVars`, and re-applying after any Secret File). `launchCommand` prepends `selectArgs` for non-main Accounts across `run`, `login`, and `probe` (`sideby try`), and `QuotaFetchContext` exposes them as `ctx.hostArgs`.

2. **Antigravity CLI (`agy`) multi-account configuration (`src/families/agy/index.ts`)**:
   - Drop `mainOnly: true` and set `layout: { main: '.gemini/antigravity-cli', account: '.gemini/antigravity-cli-<name>' }`.
   - `selectArgs(account)` returns `[]` for `agy:main` and `['--app_data_dir=antigravity-cli-<name>']` for non-main Accounts. Both `launch.before` and `prepareLaunch` reject user/account/plugin `--app_data_dir` or `--gemini_dir` overrides so launch attribution and `/usage` never diverge.
   - `selectEnv(account)` returns `{}` for `agy:main` and `{ AGY_CLI_FORCE_FILE_TOKEN_STORAGE: '1' }` for non-main Accounts. Add `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` to `hijackVars` so `agy:main` launched inside a child shell of a non-main session never inherits the variable and stays on the OS Keychain.
   - Shared Items: `settings.json` (`link-or-local`), `skills` (`link`), and `antigravity-oauth-token` (`info`, `credential: true`, `noSymlink: true` so Doctor checks regular-file mode `0600` and rejects symlinks/directories without reading content). Config `extraSharedItems` is blocked from sharing or reading `.`, `proxy.env`, or any path overlapping a built-in credential item. `markers` includes `conversations`, `brain`, and `conversation_summaries.db` so accounts without shared files stay discoverable. Sessions (`conversations/`, `conversation_summaries.db`, `brain/`, `history.jsonl`) stay isolated per Account, matching `CONTEXT.md`.
   - `loginState(account)` returns `'unknown'` for `agy:main` (OS Keychain, never read) and checks whether `<account.dir>/antigravity-oauth-token` is a regular file (`!isSymbolicLink()`) for non-main Accounts (`'logged-in'`, `'logged-out'`, or `'unknown'`).
   - Refuse `--api` (`new --api` / Panel API checkbox) via `noApi: true` on `FamilyDef` and `account.create.before` (`code: 'create-refused'`) because `agy` requires `modelProvider: "gemini"` in `settings.json` alongside `GEMINI_API_KEY`; stray `proxy.env` files are ignored at discovery/launch and warned in `doctor.check`.
   - Keep `agy` excluded from Handoff, `sideby next`, Pick Commands, and `pickNow` via `noHandoff: true`, avoiding consumer-plan automatic account rotation.

3. **Multi-account parity across `agy` modules and Unattended Mode**:
   - **`agy/quota.ts`**: pass `ctx.hostArgs` (`selectArgs(account)`) alongside `AGY_QUOTA_ARGS` and `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` for non-main Accounts. Detect upstream flag removal (unknown/undefined flag on stderr when non-main fails immediately with empty stdout) and fail explicitly without falling back to the Main Account's Keychain, still never storing or printing raw stderr (ADR-0048).
   - **`agy/mod.ts`**: treat `--app_data_dir` and `--gemini_dir` (and hyphenated variants) and inline prompt flags (`-p`/`--print`/`--prompt`) properly in `classifyAgyArgs`, and read Main's `settings.json` when the extra Account's `settings.json` is sideby's verified symlink to Main (keeping external symlinks ignored).
   - **`agy/live-sessions.ts` & `agy/statusline.ts`**: match each running `agy` process against its target `--app_data_dir`/`--gemini_dir` while skipping valued flags, fall back to verified `<state>/agy-live/<pid>.json` `account` on flat `ps` command lines, and guard live-record pruning against concurrent launches with snapshot timestamp and mtime/inode re-checks.
   - **`unattended/hook.ts`**: validate `transcriptPath`/`artifactDirectoryPath` canonically under `<home>/.gemini/antigravity-cli[-<name>]/` (rejecting substring-only `/tmp/antigravity-cli` paths, symlinks, `SIDEBY_ACCOUNT` mismatches, and `conversationId` path mismatches) before handling either `PreToolUse` or `Stop` (including `lastAssistantMessage`).
   - **Panel, CLI & Skill**: support `agy` account creation (disabling the API key checkbox for `noApi` families, suggesting `agy<name>` when `<name>` is numeric without hijacking bare `agy`, previewing nested `FamilyInfo.layout`), and update `sideby families`, `skills/sideby/`, READMEs, `docs/guide/usage*.md`, and `llms.txt`.

## Consequences

- Users can run `agy:main` alongside `agy:002`, `agy:work`, etc. (`agy002` short commands) with independent Google logins, independent `/usage` quotas, and independent session histories, without modifying `HOME` or touching the Main Keychain.
- Because `--app_data_dir` and `AGY_CLI_FORCE_FILE_TOKEN_STORAGE` are undocumented internal interfaces of `agy`, sideby pairs them with an explicit upstream-breakage check that refuses to fall back to `agy:main`. Revisit if Google ships an official `AGY_HOME` / `ANTIGRAVITY_CONFIG_DIR` or `--profile` contract (issues `#155`, `#1695`, `#1784`).
