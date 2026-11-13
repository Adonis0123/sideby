# Grill: limit resets and quota refresh

- Date: 2026-11-12
- Pairing: Interviewer claude, Proxy codex, Red-team grok
- Rounds: 2; stopped because the frontier was empty
- Duration: about 35 minutes
- Status: proposed (no decision here has been implemented)

## Plan

> 给 claude 和 codex 加一个可以使用重置额度的功能，如果有的话，claude 还可以重置 fable 和 calude 的额度的
>
> claude 和 codex 重置额度的共都做到 ui 上吧，另外看看如何优化一下查询额度的功能，使得它跟准确一点，查询更快用户体验更好，不过是 ui 还是顶部的导航栏

In English: let a user spend a banked Limit Reset for Claude Code and Codex accounts where the vendor offers one (for Claude, the Fable week and the plan-wide limits have their own resets), from the Panel and the Menu Bar Item; and make the quota check more accurate, faster and nicer in both.

## Measurements (2026-11-12, macOS 27)

- Codex CLI 0.167.2: `codex app-server generate-json-schema` lists `account/rateLimitResetCredit/consume` (params `idempotencyKey`, optional `creditId`; outcomes `reset`, `nothingToReset`, `noCredit`, `alreadyRedeemed`) and `rateLimitResetCredits` (`availableCount`, optional `credits` with `expiresAt`, `resetType`, `status`). Read from the schema only; no consume was sent.
- Claude Code 2.1.322: the program holds no text about limit resets, and `claude -p /usage` prints only the `Current session` and `Current week (...)` lines. Anthropic's help page says the reset is used on `https://claude.ai/settings/usage` (browser, desktop or mobile app), not in Claude Code.
- UNVERIFIED: whether `consume` works with the `experimentalApi: false` that `src/families/codex/quota.ts` sends at initialize; which Codex windows one credit restores; how long the vendor remembers an idempotency key.

## Decisions

| ID | Question | Decision | Status | Reversibility | Evidence |
| --- | --- | --- | --- | --- | --- |
| Q1 | The term | **Limit Reset**; the Panel says *use a reset*; 中文「重置次数」/「使用一次重置」. A window's own reset stays "reset time". | Decided | easy | `CONTEXT.md` |
| Q2 | Codex: read and spend through its own CLI | Read `rateLimitResetCredits` from the answer already asked for; spend with `consume` over the same `codex app-server`, as a new narrow exception to the Credentials invariant: only one user-confirmed action for one Account, `creditId` omitted, no id kept. | Decided by the user | costly | `src/families/codex/quota.ts`; ADR-0038; https://learn.chatgpt.com/docs/app-server#authentication-endpoints |
| Q3 | Claude: no way in the CLI | A link, not a spend: "Use a reset on claude.ai" opens the vendor page (the Account's chosen Browser Profile, else the default browser, with a hint to check the web login). One Quota ask for that Account when the user comes back from that jump; no stock shown. | Decided | easy | https://support.claude.com/en/articles/17007452-what-is-a-limit-reset |
| Q4 | Claude: Fable and plan-wide limits | No model of which window a Claude reset restores. The hint names the tight windows; the guide explains the vendor's rule (a Fable reset gives back the Fable share of the week; a five-hour window is restored whole). | Decided | easy | https://support.claude.com/en/articles/17506494-claude-fable-5-2-launch-offers |
| Q5 | Confirming a spend | Always confirm: read stock and Quota fresh, show the Account, the Accounts sharing the login, each window with its reset time, the stock left as "expected", expiry or "unknown". No promise of which windows refill. CLI exits 10 without `--yes`. One operation id and idempotency key per confirmation, serial across the Panel, CLI and menu, reused on retry. Never from Auto Handoff, `next`, Unattended Mode or a hook. | Decided by the user | costly | `AGENTS.md` Output contract; `src/core/lock.ts` |
| Q6 | When the action shows | Codex: a quiet count whenever the stock is above zero; a visible button when a plan-wide window is at its warning level (60% short, 85% long) or a known credit expires within 72 hours; else in the row menu. Old data is refreshed first; a passed `resetsAt` alone never disables it. | Decided | easy | `src/core/quota-levels.ts`; ADR-0062 |
| Q7 | The Menu Bar Item | Shows the count and "Use a reset…". Codex: opens the Panel on that Account's confirmation; the menu never spends. Claude: opens the vendor page, and the next menu open asks that Account once. | Decided | easy | `src/menubar/script.ts`; ADR-0034 |
| Q8 | Same Login | One stock and one spend lock per group; sent through the first signed-in, unexpired Account in Display Order; one read afterwards updates the whole group. | Decided | easy | `src/core/same-login.ts`; `src/runtime.ts` |
| Q9 | CLI and JSON shape | `sideby quota reset <account> [--yes] [--json] [--operation <id>]`, `--open` for Claude; `limitResets: { available, observedAt, nextExpiresAt? }`; outcomes `reset`, `nothing-to-reset`, `none-left`, `already-done`, `open-vendor-page`. | Decided by the user, with the red team fix | costly | `src/cli/commands.ts`; `src/cli/main.ts` |
| Q10 | After a spend | Keep the old bars with a progress state; on `reset` or `alreadyRedeemed` read again at once and show real numbers; "used, quota pending" if that read fails; "outcome unknown" on a timeout, retry with the same key. ADR-0060 needs an amendment so an Account reset early can take over again. | Decided by the user | costly | `src/core/handoff-select.ts` (`stillUsed`); ADR-0060 |
| Q11 | A window that has reset | Not built today. One extra ask per distinct published reset instant, merged across a Same Login, attempt marked on disk so a failure does not repeat it; off under the existing switches, CI and both hooks. | Decided by the user | easy | `src/core/quota-fetch.ts` (`fetchedQuota`); `docs/grill/2026-10-31-menubar-reset-quota.md` Q4 |
| Q12 | How old a number is | Exact time and source always one click away; age shown once older than `everyMinutes`; ADR-0051's rule after an hour; always old after a day; per-window times kept. | Decided by the user, with the red team fix | costly | `src/core/quota-levels.ts` (`quotaIsStale`); ADR-0051 |
| Q13 | What happens on open | Kept answers first, then due Same Login groups in the background: the Account the user picked, then visible and tight ones, then most recently used; at most four asks machine-wide, coordinated by the file lock; rows update as answers land; the same answer redraws nothing. | Decided | easy | `src/panel/handler.ts`; `src/menubar/script.ts` |
| Q14 | Asking fewer Hosts | Save time by asking a Same Login once, joining an ask already running, scanning less and drawing row by row. A Claude local reading skips the ask only when it covers every needed window; Codex rollout files never replace a due ask. No daemon, no shorter `everyMinutes`. | Decided | easy | ADR-0038; `src/core/quota-fetch.ts` (`shownQuota`) |
| Q15 | Claude: when the link shows | A visible button only when a window (the Fable week included) is at its warning level; else in the row menu and the command palette. The hint says sideby cannot see whether the Account holds one. | Decided | easy | `src/core/quota-levels.ts` |
| Q16 | Claude: the page and the login | Open `https://claude.ai/settings/usage`; show the Account's Identity next to the button (email masking respected); never read which login the browser has; no extra dialog. | Decided | easy | `src/core/browser-profiles.ts` |
| Q17 | Family and plugin contract | Optional `limitResets` on the `ok` branch of `QuotaResult`; optional `FamilyDef.limitReset: { use?, vendorPage? }` with at least one; `use(account, ctx)` extends `QuotaFetchContext` with `idempotencyKey`. The Runtime owns confirmation, lock, record and timeout. | Decided (red team: hold, with notes) | costly | `src/types.ts`; `src/plugins/loader.ts` |
| Q18 | Per-window read time | Optional `QuotaWindow.observedAt` and `source`, inherited from the quota and written only when different; `schemaVersion` stays 1. | Decided (red team: hold, with a note) | costly | `src/core/quota-store.ts` (`keptQuota`) |
| Q19 | The pending operation | `<state>/quota/limit-reset/<operation>.json`, directory 700, file 600, saved before the request: version, operation id, Account refs, idempotency key, state, attempt times. No Login Key, Identity, credit id or credential. Finished records go after 24 hours; an unresolved one is never aged out or bypassed with a new key. | Decided by the user | costly | ADR-0028; `src/core/quota-store.ts` |
| Q20 | Tests without a real spend | Reuse `fakeHost.onStart` and the Codex protocol test script: four outcomes, failure before sending, answer lost after a spend, hang, crash, resume across processes, Same Login races. Assert at most one spend effect per key (several RPCs with one key are fine), no Host directory change, no consume without confirmation. | Decided | easy | `testing/index.ts`; `src/families/codex/quota.test.ts` |
| Q21 | Decision records | Two new ADRs (use a Limit Reset through the Host's own CLI; ask once more after a published reset time passed) and amendments to ADR-0060 and ADR-0051. Refresh order and optional JSON fields go in the spec. | Decided | easy | `AGENTS.md` Change process |
| Q22 | Rollout order | Three changes, each in the Panel, the menu, the CLI and the skill: read and display first; the Claude link second; the Codex spend last, after the full flow in an isolated HOME and one real spend the maintainer confirms by hand. | Decided | easy | `AGENTS.md` |

## Reasons

### Q9 — CLI and JSON shape

- Reason: missing, zero and unconfirmed stock must be told apart; the stock needs its own read time.
- Red-team: overturn. A timeout answered with today's JSON error (`schemaVersion`, `error`, `code` only, `src/cli/main.ts`) drops the operation id; the retry it invites, a fresh `--yes`, makes a new key and spends a second credit. Exit code 10 today means "run again with `--yes`" for changes that have a teardown; a spend has none.
- Would hold if: the failure JSON carries the same `operationId`, the key is on disk before the request, and the next `--yes` reuses it until the Host gives a final outcome.

### Q12 — How old a number is

- Reason: one rule for every surface; "old when the age exceeds the window's remaining time" was rejected because a number would turn old only as its countdown shrinks.
- Red-team: overturn. As written it reverses `quotaIsStale`: unreadable Usage already counts as old, and local use within 10 minutes of the reading stays current (ADR-0051). A one-day cliff would grey an unused weekly window that ADR-0051 keeps current on purpose, and there is one `stale` bit per row while `shownQuota` can hang an older model-group window under a newer plan reading.
- Would hold if: staleness is computed per window from its own time, and the one-day limit keeps both ADR-0051 rules.

### Q17, Q18 — notes the red team attached to "hold"

- `shownQuota` and `keptQuota` drop unknown fields today; they must keep `limitResets`, or "absent" comes to mean "stripped".
- The spend lock must work across processes, with the key stored before the request; `vendorPage` opens through the Account's own browser path.
- A writer that moves `QuotaResult.observedAt` must stamp the windows that read did not cover, or the old-snapshot problem of ADR-0038 returns. Needs a test.
- After a spend, `fetchedQuota` would not ask again inside `everyMinutes`; the spend must force one read and store it.

### Other reasons

- Q2: the vendor's own channel exists, so no credential is read and no request of sideby's own is added; `availableCount` is the number to trust, the detail rows may be missing or cut short.
- Q3: Anthropic's page says the button is not in a terminal or IDE and that a web reset applies to Claude Code; a focus event must not become a way around `everyMinutes`.
- Q10: the consume answer holds no new Quota, so sideby must not lower the count or zero the bars by itself.
- Q19: storing a Same Login key would break the Login Key invariant (ADR-0028); the vendor does not say how long a key stays valid, so safe resume across processes is UNVERIFIED.
- Q20: an idempotent retry may send the request again, so "one consume per key" is the wrong assertion; "one spend effect per key" is the right one.

## Escalations

Held during the session (it ran under Unattended Mode, so none was asked). On 2026-11-12 the user answered all five: take the recommendation. They are recorded as Decided.

1. **Q2 + Q5 + Q10 — let sideby spend a Codex Limit Reset.** Recommended: yes, through `codex app-server`, only after a confirmation, never automatic, with a new ADR that widens the Credentials invariant. Held because a spend cannot be undone and it changes an Invariant.
2. **Q9 — the command and JSON shape.** Recommended: adopt it with the red team's fix (failure JSON carries `operationId`; the key is stored before the request; a later `--yes` reuses it), and keep exit code 10 for the preview, whose text says a spend cannot be undone.
3. **Q19 — the pending-operation record.** Recommended as in the table. Held because resume rests on vendor behaviour nobody has verified.
4. **Q11 — one extra ask after a published reset time passes.** Recommended: yes, one per reset instant. Held because it adds a request inside `everyMinutes` (the same Escalation as Q4 of the 2026-10-31 grill, still open).
5. **Q12 — the age rule.** Recommended: per-window staleness; keep both ADR-0051 rules; no fixed one-day limit, so ADR-0051 stands unchanged.

## Assumptions

None.

## Glossary and decision records

- Terms added to `CONTEXT.md`: **Limit Reset**.
- Decision records written (status proposed): `docs/adr/0072-use-a-limit-reset-through-the-hosts-own-cli.md` (it also amends ADR-0060) and `docs/adr/0073-ask-again-once-when-a-published-reset-time-has-passed.md`. ADR-0051 needs no amendment.
- Run files: `.review-handoff/runtime/grill/limit-resets-and-quota-refresh/` (not committed).
