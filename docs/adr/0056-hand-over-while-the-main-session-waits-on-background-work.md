# ADR-0056: Hand over while the main session waits on background work

Status: accepted
Date: 2026-10-29

## Context

Auto Handoff for Claude Code (ADR-0010, ADR-0032) decides at three moments: after a tool call (`PostToolUse`), when a turn ends (`Stop`) and when a turn fails at a used-up Quota (`StopFailure`). It reads the Quota from the status line tap's cache (ADR-0003).

A coordinator session often starts background subagents and ends its turn to wait for them. Seen with Claude Code 2.1.312 on 2026-10-29: the main session ended a turn at 93% of its 5-hour window (its hand-over level was 95%) and stayed idle while four background subagents used the window up. Nothing handed over for about 20 minutes, until a subagent finished and its notification started a main turn. Three things went wrong:

- **The Quota reading went stale.** Claude Code runs the status line on events in the main conversation; while the main session is idle those events stop (Claude Code's status line documentation says so and names the background-subagent case). The cache stayed at the last main-turn reading, so about 230 subagent `PostToolUse` hooks all read a number under the level.
- **The messages went to the wrong agent.** Hooks also run inside subagents (`PostToolUse` input then carries `agent_id`), and a `PostToolUse` hook's `additionalContext` goes to the agent that called the tool. The preparing message reached a subagent, which wrote the Handoff Brief from its own slice of the work.
- **Nothing could wake the idle main session.** A hook's output waits for the next turn, and `StopFailure` only fires for a main turn. Claude Code also lets a session run on a short grace allowance after the limit, and subagents keep going on it.

Tried with Claude Code 2.1.312 on 2026-10-29: `statusLine.refreshInterval` re-runs the status line every N seconds while the session is idle, with current `rate_limits`; the `Stop` hook input lists in-flight work in `background_tasks` (subagents, background shells); a `Stop` command hook with `asyncRewake: true` that exits 2 wakes the idle session with its stderr, and that turn ends with the usual `Stop` hooks.

## Decision

1. **Keep the reading current.** `sideby quota setup claude` writes `statusLine.refreshInterval: 30` together with the wrapper when the status line has no `refreshInterval`; a value the user set is kept. A status line sideby wrapped earlier without it is offered the same change by running setup again; the Doctor (`handoff.quota-refresh`), `sideby handoff status` and the Panel name that step while Auto Handoff is on. Teardown still restores the original bytes, `refreshInterval` included.
2. **Talk only to the main conversation.** The handoff hook ignores `PostToolUse` calls that carry `agent_id` (a subagent or a teammate): no message, nothing marked as sent. The main conversation gets the message at its next tool call or `Stop`.
3. **Wake the main session when it waits.** Claude's `--settings` file adds a second `Stop` hook, `sideby handoff-hook claude IdleWatch`, with `asyncRewake: true` and a 5-hour `timeout`. It does nothing unless `background_tasks` lists work in flight. Then it reads the cache every 15 seconds until a later `Stop` starts a new watch, the run is over or handing over, the parent process is gone, or its time runs out. When a window reaches its hand-over level and the plan is `pick`, it marks the threshold as sent, prints a message that tells the agent to write the Brief (naming the background work still running) and end its turn, and exits 2. The existing `Stop` logic then hands over, with sideby's assembled Brief if the agent wrote none. A `wait` or `none` plan never wakes the session.

## Consequences

- A coordinator waiting on subagents hands over within about 30 seconds of the status line's next reading past the level, instead of when a subagent happens to finish.
- The status line tap runs every 30 seconds in every open Claude session, also outside Auto Handoff; it costs about 40 ms and writes only when the reading changed.
- One small Node process waits per main session that is idle with background work, and only while Auto Handoff is on.
- Background subagents are stopped when sideby ends the session; the Brief names them so the next account can pick their work up.
- Codex and Grok are unchanged: neither has a way for a hook to wake an idle session.
