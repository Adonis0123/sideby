# ADR-0048: Read Antigravity quota through its own CLI

Status: accepted
Date: 2026-10-21

## Context

Antigravity CLI keeps no quota file sideby could read. Its `/usage` command (alias `/quota`) is documented. Tried with agy 1.4.4 on 2026-10-21: `agy -p /usage --output-format json` answers with `num_turns: 0`, every token count 0 and an empty `conversation_id`. The CLI handles the command itself and asks Google with its own sign-in. The answer lists model groups (such as "Gemini Models" and "Claude and GPT models"), each with buckets carrying `window` (`5h` or `weekly`), `remaining_fraction` and `reset_time`. Some groups have a weekly window only.

## Decision

Add agy to the Host-query exception of ADR-0025 and ADR-0038 through `fetchQuota`:

- Run `agy -p /usage --output-format json` with the Account's launch environment. agy signs in; sideby reads no credential and makes no request of its own.
- Same rules as the other Hosts: at most every `everyMinutes` unless the user refreshes, a timeout, never from `statusline-tap` or `handoff-hook`, off under config `quota.check.agy: false` and in CI.
- Keep only group names, windows, used percent (from `remaining_fraction`), reset times and the observation time. Drop descriptions, raw errors and anything else.
- Each window carries its group name. sideby cannot yet tell which group the launched model belongs to, so it shows every group and, as for every named window, none of them counts toward Quota Pressure: the Account is not picked on this data. A weekly-only group gets no invented 5-hour window.
- No `readUsage`: agy keeps no token records sideby has verified.
- Login state stays `unknown` (ADR-0047). An answer that says to sign in shows, in the Quota column, that agy is not signed in and to run `sideby login agy:main`. Any other failure says sideby asks again later and never claims the Account is signed out. stderr, which holds a sign-in link when signed out, is never read.

## Consequences

The Panel, `sideby quota` and the menu bar show agy's 5-hour and weekly windows per model group. A failed query keeps the last reading with its original time and the reason.

Revisit if `/usage` ever starts a model turn or spends quota, or if signed-out and other-plan answers differ from the shape above.
