# Grill: menu bar reset column, quota refresh speed and accuracy

Date: 2026-10-31. Interviewer: claude. Proxy: codex. Red-team: skipped (no hard-to-reverse decision). 2 rounds, frontier empty.

Request: the Menu Bar Item's "Resets" column (`7d · 4天20小时后`, grey) is hard to read; research and redo it; make quota checks faster and more accurate.

## Measurements (2026-10-31, macOS 27)

- `menubar snapshot --json` from cache: 0.46–0.48 s. With `--refresh` (14 accounts in parallel): 5.85 s.
- Per account in a joint refresh: grok 0.1–1.0 s, cursor 0.8 s, codex 1.4 s, claude 2.4–3.9 s, agy 5.2 s.
- One `claude -p /usage`: 2.1–2.4 s; `--safe-mode` saves about 60 ms. Per-call speed is bound by the Host.

## Decisions

| Id | Decision | Status |
|---|---|---|
| Q1 | Under 24 h: countdown (`4小时20分后`, `in 4h 20m`). Else the next local calendar day: `明天 16:59` / `tomorrow 4:59 PM`; up to 6 days: weekday and time (`周三 16:59`, `Wed 4:59 PM`); later: month, day and time (`11月11日 16:59`, `Nov 11, 4:59 PM`), with the year when it differs. Hover keeps the full date and the countdown. | Assumption (taste) |
| Q2 | One reset per row, of the binding window; the window tag always shown. | Decided |
| Q3 | Time in `labelColor`, tag in `secondaryLabelColor`; header stays "Resets". No "back at" wording: `fail` starts at 85 % / 95 %, not at 100 %. | Decided |
| Q4 | Re-ask a kept answer as soon as one of its windows has reset (an automatic ask inside `everyMinutes`). | **Escalation**: breaks the `everyMinutes` invariant |
| Q5, Q7 | During a manual refresh the menu draws each account as its answer lands: cache-only snapshots every 2 s with `--refreshing-since`; rows still waiting say "Refreshing…", failures "Refresh failed"; only accounts this refresh asks are marked; the final result wins over a late cache snapshot. | Decided |
| Q6 | Panel, CLI text and the menu share one pure formatter; `--json` keeps raw `resetsAt`. | Decided |
| Q8 | The tag uses the column labels `5h` / `7d` / `31d` in both languages; hover spells out the window. | Decided |
| Q9 | A window past its reset: grey bar, percent `–`, no part in the row's colour; reset cell "已到重置时间，待更新" / "Reset due; awaiting update" only when no window is still open. | Decided |
| Q10 | Order of the format rules as in Q1; "tomorrow" by local calendar, not +24 h. | Decided |

Run files: `.review-handoff/runtime/grill/menubar-reset-quota/` (not committed).
