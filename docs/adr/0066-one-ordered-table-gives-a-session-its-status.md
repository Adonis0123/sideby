# ADR-0066: One ordered table gives a Session its status

Status: accepted
Date: 2026-11-01

## Context

A Live Session's `status` (ADR-0039) came only from the Host's own files: Claude Code's `sessions/<pid>.json` says `busy`, `idle` or something that waits for the user, and the other Hosts say nothing (`unknown`). sideby itself keeps two more things that mean the user has to act on a Session: an open Pending Decision (ADR-0058) that names it, and a Message to it that waits for the user to approve it in its terminal (ADR-0045) or to paste it (ADR-0040). A Session in either case still showed as `busy`, `idle` or `unknown`, so the list that puts `needs-you` first did not lead the user to it.

## Decision

- A Session's status is the first matching row of one ordered table (spec §3.32 step 1, `STATUS_RULES` in `core/session-status.ts`): the Host waits for the user; an open Pending Decision names the Session; a Message to it waits for approval; a Message to it waits to be pasted; the Host says busy; the Host says idle; otherwise unknown. The first four rows give `needs-you`.
- An optional `reason` (`host-waits`, `pending-decision`, `message-to-approve`, `message-to-paste`) says which row matched, only with `needs-you`. The CLI table appends it in words ("needs you: a decision") and names the command that shows it; the Panel explains it on hover and links a Pending Decision to the Unattended page.
- A Message to paste counts only for a Session with a record sideby can check: a paste shows there by its id and clears the row. For a Session without one, sideby would never see the paste.
- The stores are read, never written, while listing: done Pending Decisions are not pruned and a Message found read is not saved. Only the newest 50 Messages are looked at.
- No new status value. `schemaVersion` stays 1: the four values keep their names, and `needs-you` keeps its meaning, the user has to act on the Session, now with every signal sideby has for it. `reason` is an added field.

## Alternatives

- A new value per case (`decision`, `paste`). Rejected: a consumer that knows the four values would show a Session that needs the user as an unknown state; `needs-you` plus `reason` keeps old consumers right.
- A `failed` value. Rejected for now: no Host file or sideby store tells that a running Session has failed. A Handoff `StopFailure` is about a used-up Quota and ends the Session.
- Each Family reader mixing in the stores. Rejected: the rule would be spread over four readers; one table in core keeps the order in one place and testable row by row.

## Consequences

A Session that waits on a decision or a paste rises to the top of `sideby sessions`, the Panel's Sessions tab and the Claude mod's list. A JSON consumer that read `needs-you` as "the Host prompts in its terminal" now also sees it for these cases; `reason: host-waits` is that case alone.
