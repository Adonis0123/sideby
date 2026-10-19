# 0032. Auto Handoff hands over by each window's own pace

Date: 2026-10-18 · Status: accepted

## Context

Auto Handoff hands over when Quota Pressure, the used percent of the fullest open window, reaches a fixed `threshold` (95 by default, ADR-0010, spec §3.17). Two problems showed up:

- A user saw a session hand over while their status line showed the Quota 95% left. The 5-hour window was at 1%; the weekly window was at 95%. The hand-over was right, but nothing said which window caused it, so it looked like a bug.
- One fixed level cannot fit both windows and every task. With Claude Code on 2026-10-18, one heavy turn can use several percent of a 5-hour window (no first-hand number is published; community estimates for Opus with extended thinking put it at 5–7%), while it moves the weekly window by less than one percent. At 95% a heavy turn can still run into the limit before the Brief is written; for the weekly window 95% gives up a large share of the week for nothing.

Well-made usage monitors agree on watching the rate of use, not only the level: ccusage shows a burn rate and a projection, Claude-Code-Usage-Monitor predicts from recent use whether the window runs out before it resets. Hooks give sideby one reading per tool call and one at the end of each turn, from the same caches it already reads (no new source, ADR-0003).

Options considered:

- Raise the fixed default. Rejected: it makes the 5-hour case fail more often.
- A level per window (`threshold5h`, `threshold7d`). Rejected: two more numbers for the user, and still blind to a heavy task.
- Hand over when the window would not survive another turn like the recent ones. Chosen.

## Decision

- Each open window gets its own Hand-over Level: `100 − 1.5 × (the most that window grew in one turn, over the run's last 5 finished turns)`, rounded down, never below `prepareAt` and never above 99. A turn is the time between two `Stop` hooks. Use measured across a reset is ignored.
- Before the run has finished a turn that moved a window, that window's level is `threshold`, as before. `threshold` keeps its meaning for choosing the next Account (an Account at it counts as full) and for the wait rule (ADR-0018).
- The Handoff starts when any window reaches its level. The messages to the model, the terminal line and `chain.json` name that window, its used percent and its reset time.
- Config `handoff.adaptive` (default `true`) turns this off; then every window uses `threshold`, as before 2026-10-18.
- A Brief written by the session counts as finished only when it ends with the line `<!-- handoff brief complete -->`. Otherwise the `Stop` hook asks once more (as before for a Brief not updated), and if it is still unfinished, sideby keeps the session's text and adds what it put together from the session's records under it.

## Consequences

- The 5-hour window of a light task hands over at 97–99%, a heavy task's earlier (as early as `prepareAt`); the weekly window usually at 98–99%. The limit hook (`StopFailure`) stays the fallback when a turn uses more than any before it; Codex has no such hook, so a Codex run is only as safe as its recent turns predict.
- The hook keeps a little more per-run state (each window's reading at the last `Stop` and the last 5 turns' growth) in the run file it already writes.
- The Panel's "hand over at" field now means the level before any turn is measured; its wording is to follow.
