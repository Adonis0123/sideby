# ADR 0079: Network Guard leaves API Accounts alone

Date: 2026-11-18 · Status: accepted · Amends ADR-0053

## Context

ADR-0053 checks an API Account's Egress when its base URL is the vendor's official one (`api.anthropic.com`, `api.openai.com`) and skips it only on a third-party endpoint. Network Guard exists because a subscription login can be flagged when its requests leave from an unsupported country. An API Account signs in with a key the user pays for by use, and users point it at relays and regional gateways whose route has nothing to do with the vendor's domain. Checking it blocked Launches and prompts of API Accounts for a risk the user did not ask sideby to guard, and `sideby network` showed them as "checked when it starts", which made the rule hard to predict.

## Decision

- Network Guard never checks an API Account, whatever its base URL: no request before a Launch, no `network-hook` in its sessions, no Network Guard variables in its environment. Subscription Accounts are checked as before.
- `networkTarget` returns `{ skip: 'api' }` for an API Account. `sideby network --json` gives `accounts[].skip: 'api'` for each one (it no longer reads the Secret File to decide). `at-launch` is no longer given; it stays in the schema so readers of older output keep validating. `third-party` stays for a Subscription Account whose environment sets another endpoint.
- The address `https://api.openai.com/cdn-cgi/trace` is no longer asked.

## Consequences

- An API Account starts even when the proxy is down or the exit is in a country outside the list. A user who wants an API Account guarded has no switch for it; that can be added later as config if asked for.
- Adding the `api` value to `accounts[].skip` keeps `schemaVersion: 1`.
