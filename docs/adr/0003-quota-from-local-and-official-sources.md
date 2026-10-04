# ADR 0003: Read Quota only from local records and official CLI output

Date: 2026-10-05 · Status: accepted

## Context

The Panel's headline is each Account's Quota. Popular tools get it in ways sideby will not copy:

- `api.anthropic.com/api/oauth/usage` and `chatgpt.com/backend-api/wham/usage` are private endpoints called with the user's subscription token and a spoofed client identity. Users have reported persistent 429 responses from the Claude one since 2026-03.
- Sending a minimal `/v1/messages` request with a subscription token and reading rate-limit headers routes traffic through subscription credentials, which Anthropic's terms forbid for third parties.

Official or local sources exist for two Families:

- Claude Code passes `rate_limits` (5-hour and 7-day used percentage and reset time) to the status line command.
- Codex writes `rate_limits` into `token_count` events in its local session files.

## Decision

- Built-in Quota sources make no network requests and never read credential values.
- Claude: a status line wrapper caches `rate_limits` per Account, enabled only by an explicit `sideby quota setup claude`.
- Codex: read the newest `token_count` event from local session files.
- Grok, pi and API Accounts show no Quota.
- Third-party Plugins may add other sources; sideby does not ship or endorse them.

## Consequences

- Quota is only as fresh as the Account's last session; the Panel always shows how old the data is.
- Claude Quota needs a one-time change to the shared `settings.json`, which must be reversible byte for byte.

## Revisit when

A vendor publishes an official usage API or CLI command that reports Quota without starting a session.
