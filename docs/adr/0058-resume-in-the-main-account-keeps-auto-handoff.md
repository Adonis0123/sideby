# ADR-0058: Resuming in the Main Account keeps Auto Handoff

Status: accepted
Date: 2026-10-29

## Context

Resume routing (ADR-0007) sends a bare `claude --resume <id>` to the Account that holds the session. When that Account is the Main Account it runs the Host unchanged, as if sideby were not there, because the bare command already works there.

Auto Handoff (ADR-0010) is set up only by `sideby run`: it injects the hooks and the `SIDEBY_HANDOFF_*` variables. Seen with Claude Code 2.1.312 on 2026-10-29: a terminal manager reopened its tabs after the machine froze and resumed a session that an earlier handoff had moved to the Main Account. Routing ran the Host unchanged, so the session had no Auto Handoff. It used up its 5-hour window and waited for the reset while other Accounts had Quota left, and nothing told the user why.

## Decision

When the session is in the Main Account and config `handoff.auto` is on, `sideby resume` starts it exactly as `sideby run <main> -- <args>` would, so Auto Handoff starts under the same conditions as for `run`, and says so in one stderr line. The same holds for a session that was never saved and that only the Main Account started. With `handoff.auto` off, or with the Family's select variable already set, the Host still runs unchanged.

## Consequences

- A user who turned Auto Handoff on gets it in every session sideby routes, also after a terminal manager restores tabs.
- A Main Account resume under `handoff.auto` now gets what `run` adds: the Account's config `args`, the sideby mod and the Auto Handoff hooks.
- Users without `handoff.auto` see no change.
