# ADR-0062: Short and long Quota windows have their own limits

Status: accepted
Date: 2026-10-30

## Context

Until now every Quota window was judged by the same numbers. The CLI, the Panel and the menu bar warned at 60% and turned red at 85%, and an Account with any window at the Takeover Limit (Handoff Threshold − 10, 85% by default; ADR-0046) did not take over a Handoff. A 5-hour window and a weekly one counted the same.

Seen with Claude Code on 2026-10-30: every Account of a Family was red and "full" because its weekly window was between 87% and 99%, while most of their 5-hour windows were nearly empty. With Claude Code, one full 5-hour window costs only about a fifth (about 19%) of a weekly one. So a week at 87% still leaves room for several 5-hour windows of work. Red bars and a refused takeover said the opposite.

Other tools agree that the two windows need different lines:

- claude-meter warns at 75% for the 5-hour window and at 90% for the weekly one.
- ClaudeUsage turns the weekly window orange at 90% and red at 95%.
- Claude Code's own status line input reports `five_hour` and `seven_day` separately and does not merge them.

## Decision

- **Two kinds of window.** A **Short Window** lasts one day or less (the 5-hour window). A **Long Window** lasts longer than one day (weekly, a billing period). The length comes from `windowMinutes`, else from the label (`5h`, `7d`). No Host has a daily Quota, so nothing sits on the boundary. `core/quota-levels.ts` holds the rule (`isLongWindow`); the Panel keeps a copy (`longWindow` in `page-logic.ts`) and a test keeps the two equal.
- **Colors.** A Short Window warns at 60% and turns red at 85%, as before. A Long Window warns at 85% and turns red at 95%. `sideby quota`, the Panel and the menu bar use the same numbers (`windowLevel`). An Account's color is the worst of its windows, each judged by its own kind.
- **Takeover Limits.** A Short Window's limit stays at the Handoff Threshold − 10 (85% by default). A Long Window's limit is the Handoff Threshold itself (95% by default). Both move with the threshold. An Account is `full` once any counted window that has not reset is at or above its own limit.
- **Limit Use.** Ready Accounts rank by Limit Use, lowest first: the percent of its own Takeover Limit that the closest window has used. A weekly window at 87% under 95 is 91.6; a 5-hour window at 43% under 85 is 50.6. `sideby next`, Pick Commands, the Panel's Next tag, AI Tasks, Auto Handoff and the Last Resort (ADR-0046 amendment) all use it. The menu bar takes each Family's number from the same pick and its title from the Family with the highest Limit Use.
- **Unchanged.** Quota Pressure is still the used percent of the fullest window, and the `pressure` field keeps that meaning. The Handoff Threshold and the Hand-over Level still apply to every window, so a running session hands over at the same moment as before. Named windows (one group of models) still never count.
- **Outputs.** `sideby next --json` entries gain `limitUse` and `window: { label, usedPercent, limit }`, and `tight` gains `longLimit`. The text output names the window and its limit (`closest to its limit: 7d 87% of 95%`). The menu bar's reset column names the window that runs out first (`7d · 5d`), chosen by its use over its own red level (`bindingWindow`). The `takeover` Handoff Rule gains a `longLimit` parameter. Fields are only added, so `schemaVersion` stays 1.

## Consequences

- An Account whose week is at 87% is yellow, not red, and can take over a Handoff. It ranks after Accounts with more room.
- An Account that takes over with a weekly window just under the threshold may hand over again soon. Limit Use puts it last among ready Accounts, so this happens only when nothing better is left.
- The margin in the ADR-0060 amendment shrinks for Long Windows. An Account handed over by hand, whose hop records no window, comes back once it is `ready`. For a Long Window that now means below the threshold itself, no longer 10 points under it. Revisit if chains are seen handing a task back and forth on a weekly window.
- Revisit the numbers if a Host's 5-hour window stops being a small share of its weekly one, or if a Host adds a daily Quota.
