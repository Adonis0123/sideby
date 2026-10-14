# ADR 0014: Model and effort are set per Account as launch arguments in sideby's config

Date: 2026-10-14 · Status: proposed (accepted once the checks in spec §3.19 and acceptance item 18 pass)

## Context

Users want to see which model and effort level each Account runs with, and change them from the Panel. Claude Code saves both in `settings.json` (`model`, and `/effort` saves `modelSettings.<model>.effortLevel`); Codex in `config.toml` (`model`, `model_reasoning_effort`). Subscription Accounts usually share the Main Account's `settings.json` through a symlink, so a value written there changes every Account at once. Both Hosts accept the same choice at launch: Claude `--model` and `--effort`, Codex `-m` and `-c model_reasoning_effort=…`; a launch argument overrides the settings file for that session.

Options:

- Write the Host's settings file (as `/model` and `/effort` do). Rejected: with shared settings it cannot differ per Account, and it would be a fourth exception to "sideby writes nothing into a Host directory".
- Set environment variables at Launch (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`). Rejected: ADR-0005 keeps per-Account choices in Host arguments, and Codex has no such variables.
- Keep the choice as launch arguments in sideby's own config, `accounts.<ref>.args`, which `sideby run` already passes. Chosen.

## Decision

- sideby shows the effective model and effort per Account: what sideby sets for it, else the Host's config, else what the last session used (from the session logs), with the source.
- Changing them edits only the model and effort arguments in `accounts.<ref>.args`, after a preview the user confirms; "default" removes them. No Host file is written.
- It reads only the model and effort keys of the Host's config files; nothing else of them reaches an output.

## Consequences

- Each Account can run its own model and effort even with shared settings. A session started without sideby (plain `claude`) ignores it; the UI says so.
- Shell variables (`ANTHROPIC_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL`) and managed settings can still override it, and sideby cannot see them; the guide says so.
- `FamilyDef` gains an optional `modelChoice`, `UsageResult` optional `lastModel` and `lastEffort` (additive).
