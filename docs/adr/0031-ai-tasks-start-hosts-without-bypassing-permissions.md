# 0031. AI Tasks start Hosts without bypassing permissions

Date: 2026-10-18 · Status: accepted · Amends ADR-0027

## Context

An AI Task (ADR-0027, ADR-0030) starts the Host "exactly as `sideby run` would", so it gets the Account's arguments from config `accounts.<ref>.args`. Users often put a permission bypass there, such as Claude Code's `--dangerously-skip-permissions`, because they want their own sessions to run without prompts. An AI Task is different: it starts from one click, often by someone who does not know what the Host may do, and its Task Prompt only asks the AI to wait for a yes before it changes files. With a bypass, nothing enforces that.

Asking before every action would make AI Tasks tiring. Claude Code has a mode for this (its "Choose a permission mode" docs, read 2026-10-18 with Claude Code 2.1.301): `--permission-mode auto` runs without routine prompts while a classifier blocks, by default, downloading and running code, sending sensitive data out, irreversibly deleting files that existed before the session, force pushes, `git reset --hard` and more. Deny rules apply in every mode. A command-line mode takes precedence over `permissions.defaultMode` in settings, and a session where auto mode is unavailable (an unsupported model, a setting that turns it off) starts in Manual, which asks.

## Decision

- **An AI Task never starts a Host with its permission checks switched off.** A `FamilyDef` may declare `aiTaskArgs(args)`: given every argument the Host would get (Family defaults, the Account's arguments, the task's own), it returns them without the bypasses, and may add the Host's own safe mode. sideby applies it to the prompt tasks `sideby ask --run` starts (the Panel's AI Tasks, `sideby ask`, Task Specs), to every Account Auto Handoff moves such a task to, and once more after the `launch.before` hooks, so a hook cannot add a bypass back. `sideby run`, `sideby next`, Auto Handoff outside an AI Task, sign-in and `sideby try` are unchanged.
- **Claude Code** drops `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and `--permission-mode bypassPermissions` (both spellings), then adds `--permission-mode auto` unless the arguments still pick another permission mode, which is kept. Text after `--` is left alone.
- **Codex** drops `--dangerously-bypass-approvals-and-sandbox` and its `--yolo` alias and adds nothing: Codex has no mode that blocks only risky actions, so its approvals and sandbox follow the user's own Codex config.
- **Other Families** are unchanged until a first-hand source says which of their arguments skip permission checks. A Family without `aiTaskArgs` starts AI Tasks as before.
- **The user is told.** For a Family with `aiTaskArgs`, the Panel's AI dialog and `sideby ask` say in one line that the permission checks stay on and risky actions are checked first. The Panel state marks such a Family `aiTaskSafe: true`. Task Prompts are unchanged.

Options considered:

- Refuse an AI Task on an Account with a bypass. Rejected: the user would have to edit their config for something sideby can do safely itself.
- Start AI Tasks in Claude Code's default (Manual) mode. Rejected: every edit and command would prompt, which defeats a one-click task; auto mode keeps the checks that matter.
- Let a Panel switch turn the bypass back on for AI Tasks. Not now: the people AI Tasks are for would be the ones to turn it on without knowing what it does. Someone who wants it can run `sideby run` with the same prompt.

## Consequences

- `FamilyDef.aiTaskArgs` is a new optional field of the public plugin contract; adding to it keeps compatibility. `Runtime.prepareLaunch` gains an optional fourth argument `{ aiTask }`.
- A Claude Code AI Task now starts with `--permission-mode auto`. The docs make auto the built-in starting mode from Claude Code 2.1.228 on macOS, Linux and WSL; a version older than auto mode may refuse the flag.
- Codex arguments that switch checks off through config (`-c approval_policy=never`, `--sandbox danger-full-access`) are not recognised and still reach an AI Task.
