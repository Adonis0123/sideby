# ADR-0092: Active-only, jittered, and serialized quota checks for Antigravity CLI

Status: accepted
Date: 2026-11-28

## Context

Under ADR-0048 and ADR-0090, sideby reads Antigravity CLI (`agy`) quota by running the official `agy -p /usage --output-format json` command (`num_turns: 0`, no credential reads, no direct HTTP calls), up to once every 15 minutes per Account, with up to four concurrent fetches across the machine.

When the Panel or menu bar stays open, that cadence sends ~96 background `/usage` checks per day per Account even while the Account is completely idle, and multi-account setups (`agy:main`, `agy:002`, ...) can fire `/usage` concurrently from the same machine and IP. Recent vendor enforcement around third-party Antigravity usage checking makes 24/7 fixed-interval polling and simultaneous multi-account queries an unnecessary anti-abuse risk.

Verified on Antigravity CLI 1.5.19 (2026-11-28): `agy -p /usage --output-format json` updates only logs and cache files in the Account folder, never `conversation_summaries.db`, `conversation_summaries.db-wal`, or `conversations/`, whereas real user conversations update those files immediately. Three read-only `stat()` calls therefore detect real local activity without opening SQLite, reading credentials, or self-triggering from `/usage`.

## Decision

Add four optional, additive capabilities to `QuotaFetch` (`src/types.ts`, `src/core/quota-fetch.ts`):

1. **`onlyWhenActive` + `lastActivityAt`**: Once an Account has a kept reading, automatic checks (both regular interval checks and passed-reset extra asks under ADR-0073) run only when local activity occurred after the last `attemptedAt` or within a 10-minute grace window. The first check when no reading exists and explicit manual refreshes (`mode: 'force'`) still run immediately.
2. **`jitterMinutes`**: Spread each automatic interval deterministically across `[everyMinutes, everyMinutes + jitterMinutes]` by hashing `(account.ref, kept.attemptedAt)`. The offset stays stable across repeated 20-second Panel polls and re-rolls after each fetch, avoiding both robotic fixed intervals and polling collapse.
3. **`serialGapMs`**: Serialize fetches within the same Family via a cross-process lock (`<stateDir>/quota/asking/family-<family>.lock`) and space consecutive Accounts by `serialGapMs` plus a small deterministic spread (`family-<family>.last`), preventing concurrent multi-account requests from the same host/IP.

Configure `agyQuotaFetch` (`src/families/agy/quota.ts`) with:

- `everyMinutes: 30`
- `jitterMinutes: 15` (effective 30–45 minutes while active)
- `onlyWhenActive: true` with `lastActivityAt: agyLastActivityAt`
- `serialGapMs: 3_000` (3–5 seconds between consecutive `agy` accounts)

Update the Panel Settings quota-check list so `every` uses the minimum interval across Families (keeping 15 minutes for Claude/Codex/Grok) and displays a per-row hint for `onlyWhenActive` Families.

## Consequences

- Idle `agy` accounts send zero automatic `/usage` requests overnight or when unused.
- Active `agy` accounts refresh at irregular 30–45 minute intervals, take at most one final post-session reading, and never overlap across multiple `agy` accounts.
- Manual refresh (`sideby quota --refresh` or the Panel/menu bar Refresh action) and `sideby quota check agy off` continue to work as before.
- Claude Code, Codex, and Grok Build keep their existing behaviour unchanged.
