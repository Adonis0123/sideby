# 0025. Grok's Quota comes from the Grok CLI itself, asked at most every 15 minutes

Date: 2026-10-17 · Status: accepted

## Context

Grok Build shows each subscription's weekly credit use in its TUI (`/usage`) and on the web, and Grok accounts reach that limit as Claude and Codex accounts do. sideby showed "no public source" for Grok (ADR-0003), so `sideby next grok` could not rank Grok Accounts and Auto Handoff could start from Grok only after a turn failed at the limit (ADR-0010).

Other tools show it. Orca (stablyai/orca, read 2026-10-16) reads the bearer token from `~/.grok/auth.json` and calls `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` itself every 15 minutes, for one account only. That is a private endpoint called with a credential sideby would have to read, which ADR-0003 rules out.

What Grok Build 1.0.60 offers by itself (source: the public `xai-org/grok-build`; tried on this machine 2026-10-17):

- `grok agent stdio` speaks ACP (Agent Client Protocol) and answers the extension method `_x.ai/billing` with `{ config: { creditUsagePercent, currentPeriod: { type, start, end }, billingPeriodStart, billingPeriodEnd, … }, subscription_tier }`. It needs no `initialize` and no session; with `--no-leader` it uses no shared background process. The Grok CLI makes the request with its own login, read from the `GROK_HOME` it runs under. It answered in 0.7 to 2 seconds and wrote one line to `$GROK_HOME/logs/unified.jsonl`. The method name without the leading underscore answers -32601 (method not found), which is why another tool reported it missing.
- Every session start and every finished turn of the TUI writes the same numbers to `$GROK_HOME/logs/unified.jsonl`, as a line whose `msg` is `billing: fetched credits config`. Other lines of that file carry the user id and the end of the bearer token.
- No CLI command prints the Quota, and the status line command's JSON has no Quota field.

ADR-0003 says to revisit it when a vendor ships "a CLI command that reports Quota without starting a session". `_x.ai/billing` is such a command.

Options considered:

- Do what Orca does: read the token, call the endpoint. Rejected: it breaks two promises every sideby user relies on (never read a credential value, never call a private Quota endpoint), and a third-party tool sending a spoofed client identity is what ADR-0003 rejected for Claude and Codex.
- Read only the log lines. Local and allowed today, but an Account not used this week shows nothing: on the maintainer's machine three of four Grok Accounts had no line from the current week.
- Ask the Grok CLI, at most every 15 minutes per Account, and also read the log lines between asks. Chosen.

## Decision

- **Families may fetch Quota.** `FamilyDef.fetchQuota` (beside the local `readQuota`) asks for an Account's Quota in a way that costs a request. sideby, not the Family, decides when: it keeps the last answer per Account in `$XDG_STATE_HOME/sideby/quota/<family>/<name>.fetched.json` (numbers, reset times and the plan name only), asks again only when that answer is older than the Family's `everyMinutes`, or when the user asks for a refresh (the Panel's refresh button, `sideby quota --refresh`). Readings that cannot wait for an answer, `statusline-tap` and `handoff-hook`, read only the kept answer. Of the kept answer and `readQuota`'s, the newer one is shown.
- **Grok fetches through its own CLI.** sideby starts `grok agent --no-leader stdio` with the Account's environment as at Launch (its `GROK_HOME`, Hijack Variables cleared) plus `GROK_DISABLE_AUTOUPDATER=1`, sends `_x.ai/billing`, reads one answer (20 seconds at most), and closes the CLI. sideby never reads `auth.json` for this and never sends a request of its own. Every 15 minutes at most, for every subscription Grok Account that is signed in.
- **Grok also reads its log.** The local reader takes the newest `billing: fetched credits config` line of `$GROK_HOME/logs/unified.jsonl`. It matches that `msg` exactly and keeps only the Quota fields of its `config` and the plan name; nothing else of the file reaches an output, an error, a log or a cache, and tests assert it. The handoff hook reads only the end of the file.
- **On unless turned off.** Fetching is on by default, as Orca does and as the Update Check is (ADR-0021). Config `quota.check.<family>: false` (the Panel's settings switch writes it) and CI (`CI`, `CONTINUOUS_INTEGRATION`, `BUILD_NUMBER`) turn it off; the log lines are still read.
- **Grok starts Handoffs on Quota too.** With Quota Pressure, `sideby next grok` ranks Grok Accounts, and Auto Handoff starts from Grok at the Handoff Threshold; the turn that fails at the limit stays as the fallback.
- **Third-party plugins** may use `fetchQuota` for their own sources, under the cache and the switch above; sideby still does not ship or endorse a source that reads credentials.

## Consequences

- ADR-0003's rule now reads: built-in Quota sources never read a credential value and never send a request themselves; a Host's own CLI may be asked, without starting a session, at most once per `everyMinutes`.
- Each ask starts a Grok process for about one to three seconds. The Grok CLI may refresh its own token or caches while it runs, as it would when the user starts it; sideby writes nothing into the Account directory.
- A Grok older than the version that answers `_x.ai/billing`, a signed-out Account and one signed in with an API key show why there is no Quota and what to do.
- When xAI renames the method or its fields, the Panel says the answer was not recognised; the log lines keep working until the TUI changes too.

## Revisit when

xAI ships a non-interactive `grok` command that prints the Quota, or puts it in the status line command's JSON.
