# ADR-0038: Read current Codex quota through its official app server

Status: accepted
Date: 2026-10-20

## Context

Codex rollout events repeat a cached quota snapshot. A recent event can therefore carry an old percentage and reset time. Re-reading the rollout cannot discover a reset until the Host records it. The menu bar also dated its successful reads rather than the quota observations, making old readings appear current.

The official [app-server protocol](https://developers.openai.com/codex/app-server) offers `account/rateLimits/read` without a thread or model turn. A read with Codex CLI 0.163.0 on 2026-10-20 confirmed the initialization handshake and the `codex` bucket.

## Decision

Ask each subscription Account's Codex CLI through stdio, with its isolated environment and file credential store for non-main Accounts. Codex handles authentication. sideby never extracts a token, calls a private endpoint, starts a conversation or consumes a reset credit.

Reuse `fetchQuota`: checks are at most every 15 minutes unless explicitly refreshed, stop after 20 seconds, and respect CI and `quota.check.codex: false`. Keep only the quota windows, observation time, source and plan. Discard account identifiers, credit details and raw errors.

Add optional `QuotaFetch.localFallbackOnly`, default false. Codex opts in: once a successful fetch exists, rollout events cannot overwrite it. The same priority applies when sharing quota across directories of one Same Login. Other Families retain their existing newest-observation policy. Failed queries retain the last successful reading and its original time with a failure explanation.

Select `rateLimitsByLimitId.codex`, or the legacy single view when the map is absent. Never substitute a different model bucket for general Codex quota.

Show per-row observation time and stale state in menu snapshots. Read failures and readings older than one hour are visibly stale. A snapshot's check time does not refresh a reading's age. Manual refresh asks the Host again through the same controlled fetch path.

## Consequences

An idle Account can report its current quota without a conversation. Older Codex versions and failed queries retain a clearly dated fallback. The built-in Host-query exception now includes Codex as well as Grok; all credential and Panel security invariants remain.

Tests use fake Homes and fake Host processes. Manual acceptance includes a real read-only Codex query, the CLI, the Panel and the menu bar.
