# Grill: messaging-and-delete-guard

- Date: 2026-10-31
- Pairing: Interviewer claude (host session), Proxy codex, Red-team grok
- Rounds: 3; stopped because the frontier was empty
- Duration: about 8 minutes
- Status: decided; messaging items 2 and 3 are being implemented

## Plan

"哪一个更好，能不能取长补短，另外就是删除命令改动大吗，能做到 sideby 里面吗" then "讨论完没问题之后你再做吧".

Context: `sideby send` (spec §3.32, ADR-0040, ADR-0045, ADR-0057) was compared with open-cross-session (ocs). sideby stays the base; four ocs ideas were proposed for Claude Code and Codex targets (Codex coalescing, an "outcome unknown" result, a `Reply:` line, an idle notice), plus a question on delete protection.

## Decisions

| ID  | Question | Decision | Status | Reversibility | Evidence |
| --- | -------- | -------- | ------ | ------------- | -------- |
| Q1 | Delivery shape | Separate changes; messaging first: items 2 and 3 now, 1 deferred, 4 not built; delete protection separate | Decided | easy | `AGENTS.md` Change process |
| Q2 | Unknown outcome in the receipt | New receipt status `unknown`, only for a Codex `codex queue` 20 s timeout after it started and a Claude write that began but got no flush callback; keeps `pasteText`, upgrades to `read` when the Message id appears | Decided (red-team: hold) | costly | `schemas/send.json`; `src/families/codex/deliver.ts`; `src/families/claude/messaging.ts` |
| Q3 | Codex coalescing | Not now; the "skip the queue while unread" shortcut is rejected (a missed wake is possible) | Decided | easy | ocs `src/codex-defer.ts`; `src/core/messages.ts` |
| Q4 | Reply line | `Reply: sideby send <full sender session id> "<text>"`, only when the sender is a Live Session sideby identifies | Decided | easy | `src/core/messages.ts`; `src/core/session-select.ts`; ADR-0057 |
| Q5 | Idle notice | Not built; document Claude Code's own `notify_when_idle` | Decided | easy | https://code.claude.com/docs/en/cross-session-messaging |
| Q6 | Where delete protection lives | Outside sideby, in the user's own global Claude and Codex config, strict mode, shown before installing | Decided (user) | easy | `src/network/hook.ts`; dcg README and LICENSE |
| Q7 | ADR-0045 pattern instead (`delivered` + `unconfirmed`) | Rejected: `delivered` means the channel took it, which a timeout cannot show; no timed fallback to `paste-needed` | Decided (red-team: hold) | costly | `docs/adr/0045-say-when-a-message-waits-for-approval.md` |
| Q8 | Where the Reply line and idle doc land | No Panel control or flag; spec, stored Message, Claude text, `skills/sideby/references/sessions.md`, guide | Decided | easy | `src/cli/commands.ts` `cmdSend` |
| Q9 | What the user sees for `unknown` | Warn tag "Not confirmed" / "未确认送达"; the reason and "Copy this line" behind a click; no auto copy, no paste toast; ended session adds "the session has ended" | Decided | easy | `src/panel/page-logic.ts`; `src/panel/page-script.ts` |
| Q10 | Version bump scope | Keep `schemaVersion: 1`; add `unknown` to the schemas; the Panel APIs get no version field; an ADR says the old four values keep their meaning | Decided (user) | costly | `src/cli/json-schemas.ts`; `src/panel/handler.ts`; ADR-0006 |

## Reasons

### Q2 — Unknown outcome

- Reason: `paste-needed` tells a client to paste, so a timeout reported that way invites a duplicate.
- Revisit if: Codex's queue state can be checked read-only by the Message id without reading a login; then a timeout splits into `delivered` or `paste-needed`, and `unknown` stays only for a failed check and Claude's half write.
- Red-team: hold. Start failures, refused connections, failed `verify` and a timeout before `end()` stay `paste-needed`; today `deliverCodex`'s `catch` mixes them with the timeout. `listMessages` must scan `unknown` for the id, and `sendResultView` must not fall back to the "stored" wording that asks for a paste.

### Q7 — ADR-0045 pattern

- Reason: ADR-0045 adds `needsApproval` only after a successful write, and its 6-minute fallback mirrors Claude's discard of an unapproved message. A timeout has neither fact.
- Revisit if: a Host gives a reliable accept, refuse or expiry signal.
- Red-team: hold.

### Q10 — Version bump scope

- Proxy reason: the schema enumerates four status values, so a fifth changes what consumers can receive.
- Red-team: overturn. Adding a value does not change the meaning of the existing four, and AGENTS.md bumps only on removing, renaming or changing meaning. Bumping to 2 makes a consumer that knows only 1 treat a successful send as a failure and resend it. The two Panel APIs carry no `schemaVersion` today and are not in the ADR-0006 Portal contract.
- Revisit if: a known consumer branches on the status set in a way a new value breaks.

## Escalations

1. **Q6, delete protection.** Recommendation: keep it out of sideby; set up a guard in the user's own Claude and Codex config. Held because it installs into the user's config, and dcg allows some temp-directory deletes and its license adds conditions, so "every delete goes to Trash" needs a strict setup checked first.
2. **Q10, version bump.** Proxy and red-team disagree on a costly contract choice. Interviewer recommendation: follow the red-team (keep `schemaVersion: 1`, add `unknown` to the schemas, an ADR records that the old four values keep their meaning).

User answers (2026-10-31): Q6, install into the global config only; after seeing the plan (dcg ruled out by its license rider against Anthropic and OpenAI; Host deny rules plus claude-code-safety-net), the user put it on hold. Q10, "按最合适的来吧，别把代码搞糟糕了": the red-team option, the smallest contract change.

## Assumptions

- Codex 0.163+ running N queued paste lines as N turns is `UNVERIFIED`; Q3 waits on an isolated test.

## Glossary and decision records

- Terms added to `CONTEXT.md`: none yet; "unknown" (未确认送达) is added with the spec change once Q10 is answered.
- Decision records written: none yet; one ADR for the `unknown` status follows Q10's answer.
