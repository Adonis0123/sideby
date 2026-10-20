# 0037. Grok Accounts are a Same Login when their email, x.ai user and team match

Date: 2026-10-20 · Status: accepted · Extends ADR-0016 (Same Login) and ADR-0028 (Login Key)

## Context

ADR-0016 grouped only Claude, and ADR-0028 added Codex. Grok was never considered, so two Grok Build directories signed in as the same x.ai login stayed two rows with two separate quota readings, although x.ai counts one Quota for them, and Handoff could move a task between them without gaining any Quota. Observed with Grok Build 1.0.60 on 2026-10-20: two directories with the same email showed the same weekly percent and reset.

Grok's `auth.json` holds one sign-in entry, keyed by the auth server, with `email` (already read as the Identity, ADR-0003), `user_id` and `team_id` next to the tokens. One email can sign in on its own or in an x.ai team, so the email alone does not tell one Quota apart, as with Codex workspaces.

## Decision

- **Grok joins Same Login and has a Login Key** (ADR-0028). The key is a SHA-256 hash, cut to 16 hex characters, of the single entry's `team_id` (empty when it is missing or null) and `user_id`. Tokens and every other field are dropped at once. It is used only while the Runtime groups a Same Login and never reaches an output, an error, a log, a cache or the Panel; tests assert it.
- Two Subscription Accounts of the grok Family are a Same Login when their email matches and both have a Login Key and the keys are equal. Without a key on either side, or with several sign-in entries in `auth.json`, they do not group.
- Everything ADR-0016 says about a Same Login then applies to Grok: one Panel row, the freshest Quota shown with where it came from, and Handoff never landing on the same login.

## Consequences

- Two Grok directories of one login show one row and one Quota; different teams stay apart.
- If Grok Build renames `user_id` or `team_id`, the key is missing and Grok Accounts simply stop grouping, as before this ADR.
