# 0018. Auto Handoff waits visibly, and only when the session resumes by itself

Date: 2026-10-16 · Status: accepted

## Context

When an Account's full window resets within `waitIfResetWithinMinutes` (30 by default), Auto Handoff stays in the Account instead of moving on (ADR-0010, spec §3.17 "选号" 1). A user saw cc008 hit its limit and nothing happen: the window reset 26 minutes later and Claude Code's own `autoContinueAtUsageLimit` continued the task. The wait was the cheaper choice (the session keeps its full context and spends no other Account's Quota), but nothing told the user sideby had chosen it, so it looked broken, and there was no way to move on now: once the limit is hit the model cannot answer, so asking it to hand over does nothing, and a manual `sideby handoff ready` was itself turned into a wait.

Waiting is only right when the session continues by itself at the reset. Claude Code does that only while `autoContinueAtUsageLimit` is on (default `true`, https://code.claude.com/docs/en/settings-reference#autocontinueatusagelimit). Codex and Grok do not: there a wait leaves the session stopped until someone types.

Options considered:

- Never wait (`waitIfResetWithinMinutes: 0` by default). Rejected: it guesses the user is watching. When they are not, moving on loses context and spends another Account's Quota for nothing.
- Shorten the wait. Rejected for the same reason; it only moves the guess.
- Keep waiting by default, make it visible, and let the user override it without the model. Chosen.

## Decision

- Wait only when the Family says the session resumes at the reset (`FamilyHandoff.resumesAtReset`). Claude reads one key, `autoContinueAtUsageLimit`, of the Account's `settings.json` (missing means the default, `true`). Families without it never wait.
- A manual `sideby handoff ready` never waits: the user asked to move on.
- Tell the user before it happens: once the Quota passes the threshold and the plan is to wait, the hook returns a `systemMessage` (shown to the user, not the model) once per run, with the reset time and the override. When the limit is hit, `StopFailure` output is discarded except `terminalSequence`, so the hook sends a desktop notification (OSC 9 and OSC 777) with the same text.
- The override is `! sideby handoff ready` typed in the session: Claude Code runs it in the session's shell without the model, with sideby's environment. While the parent's `waiting.json` says the run waits, the command writes `ready.json` directly (no `Stop` will come to pick up a request), and the parent hands over as usual. The parent keeps watching for it during the wait.

## Consequences

- Codex and Grok hand over at the threshold or the limit even when the window resets soon. Users who want that time back can still resume the old Account by hand.
- sideby reads one more key of Claude's `settings.json`; nothing else of the file reaches an output (AGENTS.md "Host directories"). Managed settings, project settings and `--settings` can also set the key; sideby does not read them and the guide says so.
- The notice depends on Claude Code showing `systemMessage` for `PostToolUse` and `Stop`, and on the terminal supporting OSC 9 or 777 for the desktop notification; neither changes what the Host does.
