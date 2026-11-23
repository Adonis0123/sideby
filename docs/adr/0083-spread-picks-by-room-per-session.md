# ADR-0083: Picks spread by Room per Session, expiring weekly room first

Status: accepted
Date: 2026-11-23

Amends ADR-0062 (ready Accounts rank by lowest Limit Use).

## Context

Every way sideby picks an Account (Auto Handoff, `sideby next`, a Pick Command, the Panel's start and an AI Task's pick) ranks with `planHandoff`: `ready` Accounts by lowest Limit Use. The ranking ignores how many Sessions already run on an Account. A user who runs many tasks at once sees them all move to the same Account:

- Handoffs that fire close together compute the same answer and all pick the emptiest Account.
- An Account's Quota is only as fresh as its last report, so for minutes after it was picked it still looks the emptiest and keeps being picked.

Seen with a Claude Code Main Account and one Same Login partner holding 8 Live Sessions while other Accounts with room had one or none (2026-11-23).

Request routers that sit between the agent and the vendor, such as magpie (https://github.com/yetone/magpie, `routing=smart|usage|pace`), choose an account per request, so their usage numbers move with every request and they spread by themselves. sideby chooses once per Session, for hours, so it has to account for the Sessions already running. magpie's `smart` routing also uses first the room that renews soonest, so it is not lost at the reset.

## Decision

- **Room per Session** ranks `ready` Accounts: the room under the Takeover Limits (100 − Limit Use) divided by the Live Sessions of the Account's Same Login group plus its unexpired Pick Records, plus one. Highest first; ties as before (Main Account, then name). A Live Session counts wherever it was started.
- **Expiring room first**: a `ready` Account with a counted Long Window that resets within 24 hours, and every open window still at least 10 points under its own Takeover Limit, ranks before every other `ready` Account (with less room a new Session would soon hand over again); among those, Room per Session decides. The 24 hours is fixed, not a setting.
- **Pick Record**: while it picks, sideby holds one lock in its state directory across counting, ranking and writing a record `{ref, at, liveAtPick}`. `liveAtPick` is the login's load at that moment (its Live Sessions plus the records still counting), so two records of one login waiting for their Sessions do not expire together. The record counts as one Live Session of that login until the login's Live Session count rises above `liveAtPick` or 2 minutes pass. Every pick that starts something writes one, including Last Resort and fallback picks; a dry run (`--dry-run`, `--json` without a start, the Panel's recommendation) counts and reads records but writes none. Previews refreshed every minute (`plan.json`, the Auto Handoff page's overview, the Menu Bar Item's snapshot) neither count nor read, to avoid a process scan every minute; the real Auto Handoff pick counts.
- `unknown`, Last Resort and API Accounts keep their places and order (§3.13). The fallback order is unchanged.
- Each ranked Account reports `liveSessions` and the plan says why the pick won (expiring room, or most room per session).

## Considered

- magpie's `pace` (room per hour until the reset) as one continuous score: smoother, but a user cannot tell why an Account was chosen. Left for later; the expiring tier covers the common case.
- Tie-breaking by Session count only: almost never fires, since Limit Use rarely ties.
- Per-request routing: sideby does not proxy requests (ADR-0001).

## Consequences

Concurrent tasks spread over Accounts in proportion to their room. An Account whose week ends tomorrow may take several Sessions at once and run out early; that room would be lost at the reset anyway, and the next pick moves on. Picking reads Live Sessions (about half a second), never from `statusline-tap` or `handoff-hook`.

A Pick Record is an estimate, not an exact count. In rare orderings it counts a Session twice or not at all until it expires: a process that pauses for longer than the lock's stale time and then writes, a cancelled pick whose later record of the same login included it in `liveAtPick`, a manual start or an old Session ending while a record waits (records are pruned only when one is written), and a Same Login partner still loading in the Panel. Each error lasts at most the 2 minutes a record lives, so sideby accepts it rather than track Sessions by id.
