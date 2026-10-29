# ADR-0057: A handed-over session id reaches its successor

Status: accepted
Date: 2026-10-29

## Context

Orchestrators remember sessions by id: a Run ledger records its coordinator's session (ADR-0041), a Brief or a note names the session that runs a task. Auto Handoff (ADR-0010) then moves that task to another Account, and the id stops matching any Live Session. Seen on 2026-10-29: a Run recorded its coordinator as `claude:002` with session `05966d31`; three handoffs later the work ran in `claude:main` as session `60849bdc`. Another session that needed to warn the coordinator found nothing under the recorded id. Claude Code's own `ListAgents` lists only the sessions of the same config directory, so it could not see `claude:main` either, and the message first went to the wrong session.

sideby already keeps what links the two ids: each hop of a Handoff chain writes `run-<id>.json` with its `sessionId` under `<state>/handoffs/<chain>/`, and run ids start with the time, so they sort in hop order.

## Decision

1. When a target is not an Account and its session id matches no Live Session, `pickSession` (shared by `sessions copy`, `sessions open-run` and `send`) looks for the chain whose run files hold that id, and picks the newest later hop whose session is running. The result carries `handedOverFrom` with the original id, and the text output says it followed the handoff.
2. `sideby sessions --json` adds `handedOverFrom[]` to a session that came from a handoff: the earlier hops' session ids, oldest first. The Run Link falls back to these ids when the session's own id is not in the Session Index, so a Run Board stays linked after its coordinator moves.
3. Only the `sessionId` of run files is read; Briefs and the other chain files are not, and nothing is written.

## Consequences

- An orchestrator can keep the id it recorded; `sideby send <old id>` reaches whoever carries the task now, across Accounts.
- A session id that was never in a chain behaves as before (`no-session`). A chain whose later sessions all ended is still `no-session`, now naming the last hop's session id, and its Account when the Host still has that session's record.
- Fields are added, not changed, so `schemaVersion` stays 1.
