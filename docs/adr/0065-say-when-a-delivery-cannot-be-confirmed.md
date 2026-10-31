# ADR-0065: Say when a delivery cannot be confirmed

Status: accepted
Date: 2026-10-31

## Context

ADR-0040 delivers a Message through the Host's own channel and records the outcome in its receipt: `delivered` when the channel took it, `paste-needed` when the user must paste a line into the target. Two failures did not fit either value. `codex queue` can start, queue the line and then not end within its 20 s timeout; and a Claude Code message socket can take the line and its end without the flush callback ever coming (a timeout or an error after `end()`). In both, the Message may already be in the session. sideby reported them as `paste-needed`, and a client (the CLI copied the line, the Panel asked for a paste for 12 seconds) told the user to paste it, so the target could get it twice.

## Decision

- A receipt gets a fifth status, `unknown`, used only for those two cases: a `codex queue` that started and timed out, and a Claude write that began (line written, `end()` called) but got no flush callback. Everything that shows the Message did not get through stays `paste-needed`: Codex not starting or exiting non-zero, a refused connection, a failed check after connecting, and a timeout before `end()`.
- `unknown` keeps `pasteText` and a `note` with the reason. When sideby reads receipts again it looks for the Message id in the target's record, as for `delivered` and `paste-needed`, and turns `unknown` into `read` when it shows. Nothing turns it into anything else: there is no timed fallback. When the target's process is already gone right after the delivery, the note says the session has ended; the status stays `unknown`.
- What the user sees: the CLI says sideby could not confirm it arrived, that it may still show up, and to check the session before sending again, and copies nothing; `sideby messages` shows `Not confirmed` with the same advice and no paste line. The Panel shows a warn tag "Not confirmed" / "未确认送达", whose popover gives the reason and a "Copy this line" button with a warning that a paste may deliver it twice; it announces it once with a "View" button, never copies and never shows the 12-second paste notice. A status the page does not know is shown the same way, never as the "stored" wording that asks for a paste. The Sessions tab counts running Sessions whose latest Message is `paste-needed` or `unknown`, as "messages to check".
- `schemaVersion` stays 1. AGENTS.md bumps the version for removing, renaming or changing the meaning of a field; adding a value keeps the four old values meaning what they meant. Bumping to 2 would make a consumer that knows only version 1 reject the output, so a successful send would look like a failure and be sent again, the duplicate this change is meant to avoid. The two Panel APIs (`/api/sessions/send`, `/api/sessions/messages`) carry no version field and are not part of the Portal contract (ADR-0006), so they get none.

## Alternatives

- ADR-0045's pattern, `delivered` with a flag (`unconfirmed`). Rejected: `delivered` means the channel took it, and a timeout cannot show that. ADR-0045 adds `needsApproval` only after a write that succeeded, and its six-minute fallback to `paste-needed` mirrors a fact about the Host: Claude Code drops an unapproved Message after five minutes. A timeout has neither fact.
- A timed fallback from `unknown` to `paste-needed`. Rejected for the same reason: no Host behaviour says the Message is gone after some time, so the fallback would ask for a paste that may duplicate it.

## Consequences

A user is no longer told to paste a Message that may already be there; they look at the session first. A JSON consumer that branches on the status set sees a new value it may not handle; one that treats unknown values as "not delivered" may still paste, which is why `note` and the schema description say to check the target first.

Future work: when Codex offers a read-only way to check its queue by the Message id without reading a login, a `codex queue` timeout can be split into `delivered` or `paste-needed`, and `unknown` stays only for a failed check and Claude's half write.
