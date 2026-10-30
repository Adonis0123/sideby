# ADR-0060: Auto Handoff returns to a used Account once its window has reset

Status: accepted
Date: 2026-10-30

## Context

Auto Handoff (ADR-0010, spec §3.17 "选号" 3) left out every Account the chain had already used, so that two Accounts would not hand a task back and forth. Seen with Claude Code on 2026-10-30: a chain went `claude:001` → `claude:002` → `claude:003`. When `claude:003` reached its 5-hour limit, `claude:001`'s 5-hour window had reset hours before (the `resetsAt` its hop in `chain.json` recorded) and it was at 76%, below the Takeover Limit. The decision was `none` only because `claude:001` was used, and the session waited for its own reset although another Account could have taken over.

Ping-pong happens only while the window an Account left for is still full. Once that window has reset, going back is what the user would do by hand (`sideby handoff ready --to`, which already allows a used Account).

## Decision

An automatic handoff (threshold, limit, the `plan.json` and Panel decisions) may pick an Account this chain already used when that Account's latest hop in `chain.json` recorded the `window` that made it hand over and that window's `resetsAt` is at or before now. The decision is made at the moment it is asked, so the plan the parent rewrites every minute takes the reset in as soon as it happens.

Everything else stays:

- The origin is never picked.
- A used Account whose latest hop has no `window` (a manual handoff, a chain written by an older sideby) stays out.
- The Account still passes every other rule: an Account whose window reset but is again at the Takeover Limit, signed out, of another organization, or not allowed by `sameFamily` is not picked.
- `--to` is unchanged.

`selectNext` stays pure: the Runtime's `handoffDecision` takes the chain's hops (a ref, or `{ ref, window }`) and `selectNext` decides with its `now`.

## Consequences

- A long chain can come back to its first Account after its 5-hour window resets instead of waiting for the current Account's reset.
- A chain can now visit the same Account more than once; each visit is a hop of its own in `chain.json`.
- Plain refs passed to `handoffDecision` (the Panel's overview) behave as before.
