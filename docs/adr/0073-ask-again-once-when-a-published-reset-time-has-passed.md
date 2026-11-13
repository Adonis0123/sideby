# ADR-0073: Ask again once when a published reset time has passed

Status: proposed
Date: 2026-11-12

## Context

A kept Quota answer is asked again only when it is older than the Family's `everyMinutes` or the user refreshes (`fetchedQuota` in `core/quota-fetch.ts`). When one of its windows passes its reset time inside that interval, the number shown is known to be wrong: the vendor has published the instant at which it stops being true. Until the next ask, the window can only be drawn as "reset due; awaiting update", and an Account that is free again still looks full. The 2026-10-31 grill left this open because it adds a request inside `everyMinutes`.

Separately, one Quota can hold windows read at different times: a model-group window from a Host query kept under a newer local reading (`shownQuota`). With one read time and one `stale` flag per Quota, the older window is shown as if it were as fresh as the newer one.

## Decision

**One extra ask per reset instant.** When a read that would otherwise serve the kept answer finds that a window's published reset time has passed since that answer was taken, sideby asks the Host once more:

- At most once per distinct reset instant per Account. Windows that reset at the same time count once, and a Same Login is asked once for the group. When another Account of the Same Login becomes the one asked (the Display Order changed, or the first signed out), an instant that Account already marked, or answered after, counts as asked.
- The attempt is marked on disk before asking, so a failed ask is not repeated for the same instant; the ordinary `everyMinutes` schedule goes on as before. When the mark cannot be saved, the extra ask is not sent: the kept answer shows on, with the reason.
- Never from `statusline-tap` or `handoff-hook`, never for an API Account or a signed-out one, off under config `quota.check.<family>: false` and in CI.
- Until the answer lands, the display of a window past its reset stays as it is today.

**Staleness per window.** `QuotaWindow` gains optional `observedAt` and `source`, each inherited from the Quota and written only when different. Merging, the kept store and the `--json` round trip preserve them, and a writer that moves the Quota's `observedAt` stamps the windows that read did not cover. Whether a number is old is decided per window from its own time, by one rule in `core/quota-levels.ts` shared by the Panel, the CLI and the Menu Bar Item. Both rules of ADR-0051 stay: unreadable Usage counts as old, and local use within 10 minutes of the reading keeps it current. No fixed one-day limit is added.

**Showing the age.** The exact read time and source are always one click or hover away. The age is written next to the number only once it is older than `everyMinutes`; a failed read or an impossible time is marked at once.

## Consequences

- The Credentials invariant's "at most every `everyMinutes` per Account" gains this one exception in `AGENTS.md`; spec §3.26 describes it.
- An Account whose window just reset shows its room within one read, and a Handoff can pick it without waiting out the interval.
- `schemaVersion` stays 1; `pnpm schemas` and `llms.txt` pick up the two optional window fields.
- A few more Host processes start: at most one per Account per window reset.
- Known limit: "once per reset instant" for a Same Login is judged from what each Account keeps, under that Account's own lock. Two sideby processes that read different Display Orders at the same moment can pick different Accounts to ask and each send the extra ask, so the login is asked twice for that instant. It is a read, and it ends once either mark is kept. A lock per Same Login would close it; it is left out until it shows in use.
- Revisit if a vendor starts to push Quota updates, if the extra asks are rate limited, or if use on another device shows that ADR-0051's rule still misleads.
