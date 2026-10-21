# ADR-0046: Show the Handoff Rules in one place, and let API Accounts take over only when the user allows it

Status: accepted
Date: 2026-10-21

## Context

Auto Handoff (ADR-0010, ADR-0013, ADR-0018, ADR-0032) decides when a session hands over and which Account takes over from about ten settings and three fixed rules. A user could not see them together: the Panel page showed three steps of explanation and a same-AI checkbox, the advanced dialog showed four numbers, `sideby handoff status` showed readiness, and the rest lived only in the spec. Three behaviours surprised users:

- With only `handoff.auto`, an API Account of any Family took over when no subscription could. API Accounts are billed per request, so turning on Auto Handoff silently allowed paid overflow. Every gateway and account switcher we compared (LiteLLM, Portkey, Cursor, claude-swap) makes paid overflow opt-in.
- An Account was "full" for taking over at 85% (`QUOTA_FAIL_PERCENT`) and at the Handoff Threshold; neither number was shown anywhere as a rule.
- Other Families' subscriptions took over only through a per-Family `order`, which a user had to build by hand.

## Decision

- **Handoff Rules**: `core/handoff-rules.ts` builds the rules in effect now, each with an id, its parameters, the `handoff` settings that change it and an English sentence. `sideby handoff rules [--json]` prints them with the command that changes each, and where each Account's work would go if a Handoff started now. The Panel's Auto Handoff page shows the same rules from the same ids in the user's language, each changed in place (a switch, an order, or the advanced dialog), with a toast that undoes the change. No new page.
- **API Accounts take over only with `handoff.api: true`** (default false), still last, after every subscription. Turning it on shows the cost and that sideby does not cap spending; the user confirms once. `sideby handoff enable --api` does the same.
- **Upgrade**: a user who already has `auto: true`, API Accounts and no `api` key gets the new default (off) and a one-time question on every Panel page, in `sideby handoff status` and `sideby handoff rules`: keep API Accounts out (writes `api: false`) or let them take over (writes `api: true`). Writing either answer ends the question (`apiUndecided`).
- **Takeover Limit**: an Account more than `threshold − 10` used does not take over (85% with the default 95%), so the next Account starts with room to work. It follows the threshold instead of being its own setting, and replaces the fixed 85% for Auto Handoff and for `sideby next`, so the two numbers can no longer drift apart.
- **Other AIs**: `handoff.otherFamilies` (default false) lets subscription Accounts of other Families take over when the origin's Family has none that can, Family by Family in `handoff.familyOrder` (the rest in load order), each by most quota left. A Family with `policy: order` keeps its own list; the switches still apply to it.
- Daily quota is not invented: every window a Host reports counts, the fullest decides. One threshold for all windows.

## Consequences

- An existing setup that relied on API Accounts taking over stops doing so until the user answers the question; the question is visible wherever the user looks at Auto Handoff, and answering takes one click with an undo.
- With the default threshold nothing changes for `next` or Auto Handoff. With another threshold the limit moves with it: a lower threshold passes over Accounts that used to take over, a higher one lets more take over.
- When no Account may take over, the reason names what the user could allow (`handoff.sameFamily`, `handoff.otherFamilies`, `handoff.api`), so "none" is never a dead end.
- Config gains `otherFamilies`, `familyOrder` and `api`; the JSON outputs gain fields only, so `schemaVersion` stays 1.
