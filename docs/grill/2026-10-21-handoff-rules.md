# Grill: handoff-rules

- Date: 2026-10-21
- Pairing: Interviewer claude, Proxy codex, Red-team skipped: no hard-to-reverse decision
- Rounds: 2 (round 1 answered by the user, round 2 by the Proxy); stopped because the frontier is empty apart from Escalations
- Duration: about 15 minutes
- Status: decided; implementation follows

## Plan

> 去 github 调研一下，当前的额度接力消耗 cli skill 页面，没有一个可配置可调整的地方，就是额度接力规则说明和调整。比如天额度，周额度，更新时间，同 ai 接力，不同 ai 接力， api 和 额度接力，我需要一个非常正常合适的默认规则

Standing instruction: user experience first; the user must be able to see every rule clearly.

## Decisions

| ID | Question | Decision | Status | Reversibility | Evidence |
| --- | --- | --- | --- | --- | --- |
| Q1 | One place for the rules | A "Handoff Rules" section on the Panel's Auto Handoff page: every rule in effect in plain words, each editable in place with preview and undo; `sideby handoff rules [--json]`; skill routing. No new page | Decided (user) | easy | `src/panel/page-script.ts`, `docs/guide/usage.md` |
| Q2 | Daily quota | None invented; show each Host's own windows as 5 hours / weekly / billing period | Decided (user) | easy | `src/families/*/quota*.ts` |
| Q3 | Per-window thresholds | One Handoff Threshold for every window; the reset-wait rule covers short windows | Decided (user) | easy | `src/core/quota-levels.ts` |
| Q4 | Hidden 85% | Becomes the visible Takeover Limit, a fixed distance below the Handoff Threshold, not its own setting | Decided (user) | easy | `src/core/quota-levels.ts:7-8` |
| Q5 | Same-AI handoff | Off by default; the enable flow asks it explicitly | Decided (user) | easy | ADR-0001, ADR-0010 |
| Q6 | API fallback default | Off by default; turning it on previews the cost impact; no spend cap of sideby's own; ADR | Decided (user) | easy | `src/core/handoff-select.ts:161-163` |
| Q7 | Existing users on upgrade | Proxy: off when the new setting is missing, with a one-time prompt to turn it back on. Interviewer: keep it on for users who already run Auto Handoff with API Accounts. User chose the Proxy's | Decided (user) | easy | `src/core/config.ts` |
| Q8 | Default numbers and wording | Keep 80 / 95 / adaptive / wait 30 min / countdown 10 s. Wording: "95% until sideby has measured this session's pace; then between 80% and 99%", and show the current window's actual level | Decided (user) | easy | `src/handoff/levels.ts`, ADR-0032 |
| Q9 | Cross-AI handoff | One switch, default off, "when this AI has no account that can take over", plus an AI order; accounts inside an AI by most quota left; API still last and separately allowed; the per-account order stays advanced and obeys the same switches | Decided | easy | `src/core/handoff-select.ts` |
| Q10 | Waiting for reset | Unchanged: only sessions that continue by themselves wait (Claude today). When all are full, show the earliest time an allowed account is free again, counting all its blocking windows | Decided | easy | ADR-0018, `handoff-select.ts` `waitUntil` |
| Q11 | Per-account thresholds | Not built | Decided | easy | `CONTEXT.md` |
| Q12 | Live preview | "If a handoff started now, it would go to …", naming the current account or session, with the data's age; reuses `selectNext`; recomputed before acting | Decided | easy | `src/core/handoff-select.ts`, `src/core/handoff.ts` |
| Q13 | Hidden settings | `adaptive` shown as "Adjust the timing to recent use" with a switch; `crossOrganization` edited under "Advanced", but its effect stated in the main rules | Decided | easy | `src/core/config.ts`, `handoff-select.ts` `sameOrganization` |

## Reasons

### Q6 — API fallback off by default
- Reason: paying extra must be the user's explicit choice; every gateway and switcher researched (LiteLLM, Portkey, Cursor, claude-swap) makes paid overflow opt-in. Wording: "sideby cannot limit spending; check your provider's budget or limit".
- Revisit if: an official source can report and enforce API spend.

### Q7 — Existing users on upgrade
- Reason (Proxy): having an API Account is not consent to automatic paid handoff. Risk: an existing workflow stops handing over to the API Account until the user confirms.
- Reason (Interviewer): users who already rely on it would find their handoff silently stopped.
- Revisit if: older versions recorded an explicit consent to paid fallback.

### Q8 — Default numbers and wording
- Reason: `adaptive` can move the level up to 99 (`src/handoff/levels.ts`); "at the latest 95%" would be wrong. Keeping numbers is safe; a hard 95% cap would be a behaviour change with its own ADR.
- Revisit if: the user wants 95% to be a hard cap.

### Q9 — Cross-AI handoff
- Reason: an AI may have no taker because of sign-in or permissions, not only quota, so the wording names the condition. The advanced order list must not bypass the switches.
- Revisit if: existing custom orders cannot be kept unchanged.

### Q10 — Waiting for reset
- Reason: a session that does not continue by itself only waits longer for nothing. A reset of one window does not free an account still blocked by another.

### Q12 — Live preview
- Reason: Auto Handoff and `next` pick under different conditions; the preview must say which it shows and how fresh the data is.

### Q13 — Hidden settings
- Reason: folding the editor away must not hide who a task may be handed to.

## Escalations

- Q6: held because it concerns spending money. User: off by default, the user turns it on.
- Q7: Proxy and Interviewer differed. User: off after upgrade, with a one-time prompt and a one-click way back.
- Q8: held over whether 95% should be a hard cap. User: keep the numbers, fix the wording.

## Assumptions

None.

## Glossary and decision records

- Terms in `CONTEXT.md`: Handoff Threshold (redefined: no longer also the taking-over limit), Takeover Limit, Handoff Rules.
- Decision records: an ADR for Q6 follows once the Escalation is answered.
