# 0070. AI Tasks may keep the Account's own arguments

Date: 2026-11-02 · Status: accepted · Amends ADR-0031

## Context

ADR-0031 made every AI Task drop the arguments that switch a Host's permission checks off, and start Claude Code with `--permission-mode auto`. There was no way to change it. A user who put `--dangerously-skip-permissions` in an Account's arguments on purpose, and wants the AI Tasks they start to run like their own sessions, had to copy the Task Prompt and run `sideby run` by hand. ADR-0031 left the option open ("Not now") because the people AI Tasks are for could turn a Panel switch on without knowing what it does.

## Decision

- **One global setting, off by default.** Config `ask.permissions` takes `"checked"` (the default, also when the key is missing) or `"account"`. It is not per Account and has no Panel switch.
- **Name.** `ask` is already the config object for AI Tasks (`ask.account`, the account they start), so the setting sits beside it rather than in a new top-level key. `permissions` names what it decides. The values say where the arguments come from: `checked` keeps ADR-0031's checks, `account` takes the Account's own arguments as they are. Neither value names a Host's flag, so a Family Plugin's `aiTaskArgs` reads the same way.
- **`"account"` skips `FamilyDef.aiTaskArgs` everywhere ADR-0031 applies it**: the first Launch of the task, every Account Auto Handoff moves the task to, and the pass after the `launch.before` hooks. The Host gets exactly what `sideby run` would give it. Nothing is added: no `--permission-mode auto`, and sideby still never adds a dangerous flag on its own; it only stops removing the user's. The Runtime reads the setting on each `prepareLaunch`, as it already rereads `accounts`, so a change applies to the next start, also inside a running Handoff chain.
- **Changing it shows the change first.** `sideby ask --permissions [checked|account] [--yes] [--json]`: without a value it shows the setting; with one it prints the change and exits 10 until `--yes`, in both directions, like `network on|off`. `sideby config set ask.permissions …` needs `--yes` too.
- **The user is told.** With `"account"`, the Panel state carries `aiTaskPermissions: "account"` and no Family carries `aiTaskSafe`; the AI dialog's confirm line and `sideby ask` say for every Family that the AI Task starts with the Account's own arguments and its permission checks may be off.

Options considered:

- Per-Account setting. Rejected: one switch is easier to find and to explain, and a user who wants it usually wants it for every Account.
- A Panel switch. Rejected for the reason ADR-0031 gave: the dialog is for people who may not know what the Host can do. The Panel says what happens, and the setting stays one command (or one AI request) away.
- `"account"` also adding a safe mode where the user's arguments have none. Rejected: the point is to start exactly as `sideby run` does.

## Consequences

- Config gains `ask.permissions`; adding a key keeps `schemaVersion` 1. `editConfigAsk` now keeps the other `ask` keys when it saves the account.
- The Panel state gains an optional `aiTaskPermissions`, and `aiTaskSafe` now also depends on the setting. `--json` of `sideby ask --permissions` is a new output (`schemas/ask-permissions.json`).
- With `"account"`, an AI Task on an Account with a bypass runs without the checks ADR-0031 described. The user chose that with `--yes` after reading the change.
