# ADR-0066: Unattended Mode starts a turn that failed for a passing reason again

Status: accepted
Date: 2026-11-01

## Context

Unattended Mode (ADR-0058) keeps the sessions sideby starts from waiting on a person. A turn that ends on an API error still stops them: Claude Code retries a failing request by itself (10 times by default, `CLAUDE_CODE_MAX_RETRIES`), and when those run out the turn ends with the error and the session sits idle until someone types. An overloaded or failing server, a short throttle or a dropped connection overnight then costs the rest of the night, though the next request a few minutes later would have worked.

Auto Handoff's `StopFailure` hook (ADR-0010) acts only on a used-up Quota and leaves every other failure alone. Its output cannot help here anyway: Claude Code's hook reference says `StopFailure` "ignores the hook's output and exit code, apart from `terminalSequence`" (https://code.claude.com/docs/en/hooks#stopfailure).

What Claude Code offers (checked 2026-11-01):

- A command hook with `asyncRewake: true` "runs in the background and wakes Claude on exit code 2", and "an `asyncRewake` hook that exits with code 2 wakes Claude immediately even when the session is idle"; its stderr reaches the model as a system reminder; Claude Code still enforces `timeout` on it (https://code.claude.com/docs/en/hooks, "Run hooks in the background"). ADR-0056 uses it on `Stop`.
- The reference does not say whether `asyncRewake` works on `StopFailure`. Tried with Claude Code 2.1.316 on 2026-11-01, an interactive session in tmux with an isolated `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_MAX_RETRIES=0` and `ANTHROPIC_BASE_URL` pointed at a local server that fails the first request(s): a `StopFailure` command hook with `asyncRewake: true` that slept 3 s and exited 2 woke the idle session, the next request carried the hook's stderr, and the turn went on. Two failures in a row fired the hook twice and woke the session twice. The `error` field was `server_error` for HTTP 500 and for a refused connection, `rate_limit` for 429, and `unknown` for 408.
- `CLAUDE_CODE_RETRY_WATCHDOG=1` makes Claude Code retry 429 and 529 without end and other passing errors up to about three hours (https://code.claude.com/docs/en/env-vars). It is fixed for the whole session at launch, while Unattended Mode turns on and off inside a running session (ADR-0058), so sideby does not set it; a user may.

Reference practice: agent runners that resume work after a passing failure retry a few times with a growing wait, then report (for example a fixed three tries with exponential backoff, and "Your last turn failed for a passing reason … Continue the assignment where it stopped" as the resumed turn's note).

## Decision

- `unattended-hook` is also injected on Claude's `StopFailure`, with matcher `rate_limit|overloaded|server_error|unknown` (the error types a passing failure can have), `asyncRewake: true` and `timeout: 600`. It runs in the background, so Claude Code does not wait for it.
- While Unattended Mode is on, a failure is passing when its type is `overloaded` or `server_error`; `rate_limit` unless its text says a Quota, plan limit, spend cap or credits are used up (`hit your`, `usage limit`, `spend limit`, `credit balance`, `usage credits`, `limit reached` but not `rate limit reached`); `unknown` only when its text names a timeout, a 408/429/5xx status or a dropped connection (`passingFailure` in `core/unattended-retry.ts`). A used-up Quota stays with Auto Handoff or `autoContinueAtUsageLimit`.
- For a passing failure it counts the failure in the session's streak (`<state>/unattended/retries/<hash of the session id>.json`, `{ count, token, at }`, folder checked like `pending/`). For the first three in a row it waits 1, 2, then 4 minutes, and exits 2 with a note to the model: the turn failed for a passing reason, check what is already done, do not redo it, continue where it stopped (English or Chinese, by `LANG`). Before it wakes the session it checks again that Unattended Mode is still on, that its parent (the Host) is still there, and that its token is still the streak's: a later failure of the same session, or a finished turn, takes the wait over.
- A finished turn ends the streak: the `Stop` hook, which already runs at every turn end, removes the session's file. A streak older than six hours starts again from one.
- The fourth failure in a row wakes nothing: it keeps a Pending Decision of kind `deferred` with the error and the waits, so the user sees in the morning that the session stopped and why, and ends the streak.
- Off, any other error type or text, no session id, bad input or any problem: exit 0 and nothing else, as without the hook.

## Consequences

- A session stopped overnight by an outage of up to about seven minutes goes on by itself; a longer one is listed for the user instead of being retried without end.
- The model gets up to three extra turns per failure streak; each says what happened, so it checks its work before it continues.
- A plain rate limit of a Subscription Account that Auto Handoff judges used up by Quota Pressure rather than by its text may be retried while the Handoff starts; the retries end when the Host is ended (its process is gone) and the streak gives up after three.
- The hook now also writes `<state>/unattended/retries/`, and imports one more leaf module (`core/unattended-retry.ts`); `src/unattended/hook.test.ts` walks its imports.
- Codex and Grok are not covered: neither has a hook for a failed turn that can wake the session.
- What the model reads and the Pending Decision use existing kinds and fields; no `--json` output or config changes.
