# ADR 0016: Accounts with the Same Login share one Quota

Date: 2026-10-14 · Status: accepted

## Context

Users end up with two directories of one Family signed in as the same Identity, for example `~/.claude` and `~/.claude-001` both signed in to one claude.ai account and organization. The vendor counts one Quota for that login. sideby caches Claude Quota per directory (the status line tap writes `quota/claude/<name>.json`), so each directory shows only the numbers its own last session saw: one showed 5h 64% / 7d 62% (fresh), the other 5h — / 7d 25% (six hours old). Handoff ranking (`sideby next`, Auto Handoff, the Panel's "Next" tag) treated them as two Accounts, and could hand off from one to the other, which has no real headroom.

Options:

- Ask the user to merge or delete one directory (Doctor Finding or a migration). Rejected: the two directories hold separate sessions, settings links and short commands the user chose; deleting is destructive, and a Doctor Finding for a working setup is noise.
- Hide one of them. Rejected: both are real, startable Accounts with their own sessions and Usage.
- Keep treating them as separate (as before). Rejected: it shows wrong headroom and can hand a session over to the same Quota.
- Recognize the Same Login and share the Quota reading between the directories. Chosen.

## Decision

- Two or more Subscription Accounts of one Family are a Same Login when their Identity (ADR-0003) has the same email and the same organization: both have an organization and it is equal, or neither has one. An Account without an email (API Accounts, signed-out ones) never groups. Comparison ignores case.
- v1 groups only the claude Family. Codex Identity has an email only, and one email can belong to several ChatGPT workspaces with separate Quota, so Codex is left out until its Identity can tell workspaces apart (ADR-0003 would need a revision). The switch is internal, not part of `FamilyDef`.
- Quota: every member shows the group's freshest reading (latest `observedAt`), marked with the Account it was read from (`from`). Usage stays per Account: it counts each directory's own records.
- Handoff: ranking uses the shared Quota. `sideby next`, run from an Account sideby started (`SIDEBY_ACCOUNT`), and Auto Handoff never pick an Account of the current Account's Same Login; a Handoff Order entry that names one is skipped with the reason in the output.
- Panel: one row per Account as before, with a "Same login as …" tag; the Quota warning appears once per group, on the member the reading comes from.
- Doctor reports nothing about it. No directory is moved, merged or written.

## Consequences

- Both directories show the same, freshest Quota, with where it came from, so the numbers no longer contradict each other.
- A Handoff from one directory never lands on the other.
- sideby relies on Identity fields only, as before; no credential is read. If the vendor ever counts Quota per device instead of per login, this ADR is wrong and grouping must be switched off.
- `sideby list --json` and the Panel state gain `sameLogin`; Quota results gain `from`; `sideby next --json` gains `from`, and `quotaFrom` and `sameLoginAs` per account; Auto Handoff decisions gain `skipped`. All additive, `schemaVersion` stays 1.

## Revisit when

Codex Identity can tell ChatGPT workspaces apart, or a vendor reports Quota per device.
