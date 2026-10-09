# ADR 0010: Auto Handoff: move a running task to the next Account when its Quota runs low

Date: 2026-10-09 · Status: proposed (accepted once the checks in spec §3.17 pass)

Amends ADR-0001: sideby may now move work to another Account on its own, only when the user turns it on. Everything else in ADR-0001 stands.

## Context

`sideby next` (spec §3.13) recommends the Account with the lowest Quota Pressure and a person starts it. In practice the moment a Quota runs low is the moment nobody is watching: a long agent turn stops, and the task waits until someone comes back, picks an Account, starts it and explains the task again.

Ways to keep the task going:

- A proxy that pools subscription logins and picks an Account per request (magpie, TeamClaude, Maxpool). Needs the credentials, and Anthropic blocks third-party proxying of subscription traffic since 2026-01. Rejected again, as in ADR-0001.
- Swap the active login in place (claude-swap, ccswitch). Breaks "the directory is the identity" and lets one login overwrite another.
- Wait in the same Account until the window resets (Claude Code's `autoContinueAtUsageLimit`). No risk and the full context survives, but it can wait up to five hours.
- Let the running session write a Handoff Brief while it still has Quota, end it, and start the next Account with a new session from that Brief, in the same terminal. Uses only the official Host binaries, their documented hooks and local files.

The vendors' terms matter here. Anthropic's Consumer Terms (effective 2025-10-08) forbid "bypassing any of our systems or protective measures" and automated access except where explicitly permitted; OpenAI's terms forbid "circumventing any rate limits or restrictions". Holding several subscriptions is reported to be tolerated, while rotating through Accounts of one vendor to get past a limit is the pattern vendors act on, and users report suspensions. Moving to another vendor's Account, or to an API Account, does not get past any one vendor's limit.

## Decision

- Auto Handoff is off unless the config says `handoff.auto: true`. Moving between two Accounts of the same Family also needs `handoff.sameFamily: true`, because that is the riskiest kind; README and the guide say so.
- It acts only on interactive sessions sideby started (`sideby run`, an Alias, `sideby next`); headless runs are left alone. sideby stays the parent process and starts the next Account in the same terminal after the old Host has ended.
- The running session writes the Handoff Brief itself when it reaches the preparing level (default 80% Quota Pressure) and finishes it at the Handoff Threshold (default 95%). When it could not (the limit was hit first, or the Host gives no Quota), sideby puts a Brief together from the session's local records and the git state, without calling a model. Only a used-up Quota starts a Handoff after a failed turn: a transient rate limit or an overloaded server does not. The next Account gets the Brief's path, not its text, so the text never appears in a process list.
- Before moving on, sideby waits instead when the full window resets soon (default 30 minutes), skips Accounts of another Identity organization unless allowed in the config, uses each Account at most once per chain, never goes back to a full Account, and shows a countdown that a person at the terminal can cancel.
- The next Account starts a new session from the Brief. Sessions are never copied between Accounts.
- Hooks reach the Host through a launch option where the Host has one (Claude Code's `--settings`, Codex's `-c hooks.<event>=…`). Where it has none (Grok Build, or a Host whose option fails the checks), `sideby handoff setup <family> --yes` adds one sideby-owned hook entry to the Main Account, and `teardown` restores the file byte for byte while its hash still matches. This is the second exception to "sideby writes nothing into a Host directory", after `quota setup claude`. The hook does nothing in a session sideby did not start.
- Still never: read a credential, pool logins, proxy requests, rewrite which Account is globally active, or call a private quota endpoint (ADR-0003). Grok Build therefore starts a Handoff only after its limit is hit, since its Quota is only available from a private endpoint. Codex starts one only before its limit, since it has no hook for a failed turn.

## Consequences

- A task can keep going across Accounts without a person, at the cost of a new session that knows only what the Brief says, and a cold prompt cache.
- Users who turn on `sameFamily` accept a suspension risk that sideby can lower (countdown, waiting, organization guard) but not remove.
- `FamilyDef` gains an optional `handoff` member, the config gains `handoff`, and the CLI gains `sideby handoff ready|setup|teardown` and a hidden hook entry. The hook entry runs on every tool call, so it has the same import limits as `statusline-tap`.
- Two chains that reach the threshold at the same time may move to the same Account. They run side by side; there is no coordination.

## Revisit when

A vendor states that moving a task between a person's own subscriptions on one machine violates its terms, a Host ships its own cross-account handoff, or a Host exposes Quota and hooks well enough that the setup exception is no longer needed.
