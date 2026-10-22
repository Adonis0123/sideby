# ADR-0051: An old Quota reading stays current while the login has no local use since

Status: accepted
Date: 2026-10-22

## Context

The Panel and the menu bar marked any Quota reading over an hour old as an older reading, greyed its bars and asked the user to refresh. Claude Code Quota comes only from the status line tap (ADR-0003): it changes when a session runs in that Account, and "Refresh" cannot ask Claude Code for it, because the Host has no command that reports Quota without a session (checked with Claude Code 2.1.305 on 2026-10-22). So every Claude Account not used in the last hour showed "older reading", and refreshing never cleared it. Those numbers were usually right: nothing had used the Quota since.

## Decision

- A reading over an hour old is still current when the newest local session of its login (the Account's own Usage `lastActivityAt` and that of its Same Login Accounts, spec §3.21) came no later than 10 minutes after the reading. The 10 minutes cover a session's last records, which land after its last status line.
- It is old as before when that session came later, when no Usage can be read, when the time is unreadable or ahead of now, or when the latest Host query failed.
- The hover text of such a current reading gives its age and says that use on the web or another computer is not included.
- Where the Family has no `fetchQuota`, an old reading says it updates when a session runs in the account, instead of asking the user to click Refresh. The menu bar's top card says the same when every old row is such a Family.
- The rule is `quotaIsStale` in `core/quota-levels.ts`, shared by the Panel and the menu bar. The menu bar reads Usage only for readings over an hour old, so a normal snapshot costs nothing more.

## Consequences

Accounts that simply have not been used keep their numbers in colour, with no false "refresh" prompt. Use of the same subscription outside this computer (claude.ai, another machine) is not seen; the hover text says so, and the next local session corrects the numbers. The menu bar snapshot's `stale` field keeps its shape; it now means "may have changed since".
