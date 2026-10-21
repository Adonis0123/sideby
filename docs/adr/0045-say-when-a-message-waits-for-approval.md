# ADR-0045: Say when a delivered Message waits for approval, and let the Panel turn on direct receiving

Status: accepted
Date: 2026-10-21

## Context

ADR-0040 delivers a Message to a running Claude Code session through its own message socket. When the target's `crossSessionInbound` is `hold`, or it is not `accept` and the session runs in bypass permission mode, Claude Code takes the Message but shows it only after the user approves it in that session's terminal, and drops it after about five minutes. sideby recorded such a Message as `delivered` with a note. On the Sessions page and in `sideby messages` it then looked the same as a Message the session already shows, so a user believed it had arrived when it was waiting, and lost it after five minutes. The fix, `sideby messages inbound accept`, existed only as a command.

## Decision

- A receipt gets `needsApproval: true` when the deliverer knows the target holds the Message (the same rule as the note). The status stays `delivered`: the Host did take it, and `--json` consumers keep the meaning of every existing status. The field is new and optional, so `schemaVersion` stays 1.
- When `sideby messages`, the Panel or `sideby send` reads receipts again: a held Message that shows in the target's record becomes `read` and loses the field; one still unread six minutes after it was sent becomes `paste-needed`, with a note that it was not approved in time, and is saved so. Six minutes leaves a minute of margin over Claude Code's five.
- The Panel shows such a Message as "Waits for approval" (warn) instead of "Delivered", announces it once, and its chip opens the reason and the way out. The Sessions page shows a banner while a Claude settings file holds Messages (`hold`, or not set for an Account that starts in bypass mode), and has a "Receiving messages" dialog of its own. Both run the same previewed change as `sideby messages inbound accept` (and its undo) through `/api/messages/inbound`, `/api/messages/inbound/accept` and `/api/messages/inbound/undo`: the dialog lists each file, its value now, `accept`, and the Accounts that use it, and only the confirmation writes. A read-only Panel shows the state and refuses the writes.

## Consequences

The user sees the difference between "shown" and "waiting" where they look, and fixes it in two clicks with an undo. Running sessions keep their old setting until they restart; the Panel says so after the change. The writes are the ones ADR-0040 already allows (the fifth exception in AGENTS.md); this ADR adds no new write.
