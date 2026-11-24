# ADR-0085: Ask Claude Code more often while it is in use, and keep the higher reading of a window

Status: proposed
Date: 2026-11-24

## Context

Tried with Claude Code 2.1.331 on 2026-11-24: in one long turn of a Subscription Account (`claude:work`), the 5-hour window went from about 35% to 100%. The Menu Bar Item showed 35% until the turn hit the limit and the status line finally reported 100%. Two things kept the old number on show:

- The status line cache is written only when a session's reading changes (spec §3.7). During a long turn it can sit on one reading, and a newer write from a session that reports older numbers can bring a lower percent with a newer `observedAt`. `shownQuota` took the newer reading whole, so the lower number won.
- `/usage` is asked at most every `everyMinutes` (15 for Claude Code, ADR-0063, ADR-0073). A window that fills in a quarter of an hour can go from comfortable to used up between two asks.

Other quota tools deal with both. CodexBar asks faster while a session log was written in the last five minutes (https://github.com/steipete/CodexBar/blob/main/docs/refresh-loop.md). Orca (`isStaleClaudeUsageWindow`) and ccstatusline treat a newer, lower reading of the same window (same reset time, within a few minutes) as old and keep the higher one.

## Decision

**A shorter interval while the login is in use.** `QuotaFetch` gains an optional `activeEveryMinutes`. When it is set and the login was used on this computer within the last 5 minutes, it replaces `everyMinutes` for that read: for the regular ask and for `localCovers`' "fresh enough" test alike, so the two never disagree. Only Claude Code sets it (5); Codex, Grok Build and Antigravity CLI keep 15.

- "In use" is the newest local Usage `lastActivityAt` of the Account and the other Accounts of its Same Login, the source ADR-0051 already uses to tell whether this computer used a login. Claude Code writes a transcript line for every reply, so a long turn keeps it current, and a session left open but idle, or one that crashed, does not. No session content is read beyond what Usage already reads, no `ps` is run, and no new reader of Host files is added. Unreadable Usage counts as not in use.
- Usage is read for this only when the two intervals could disagree: when the kept answer's ask, or the local reading, is older than `activeEveryMinutes` but younger than `everyMinutes`.
- Everything else stays: a Same Login is asked once, a reset instant is marked on disk before its extra ask (ADR-0073), at most four asks run on the machine, nothing is asked in CI or under config `quota.check.<family>: false`, and `statusline-tap` and `handoff-hook` never ask.
- The age written next to a number (`quotaEvery`, `windowAge`) still follows `everyMinutes`.

**The higher reading of one window wins over a newer local one.** When `shownQuota` meets a local reading newer than the kept answer, each window is compared with the kept one of the same `name` and `label` whose reset time is within 5 minutes (`/usage` gives minutes, the status line seconds). A local window lower by a whole point or more is taken for old (`/usage` rounds to whole percents, the status line does not, so 34.6 against 35 is one reading): the kept window shows instead, with its own `observedAt` and `source`, as model-group windows already do. `localCovers` does not let such a local reading stand in for an ask, so the Host is asked and the kept number can move.

**Only that direction.** A newer kept answer with a lower percent still wins, as before. Within one window the percent only falls after a Limit Reset (ADR-0072), and sideby has no record of one for the Families this merge applies to: the operation records under `<state>/quota/limit-reset/` exist only for Codex, whose `localFallbackOnly` keeps it out of this merge, and a Claude reset is used on claude.ai without sideby. So a fresh `/usage` answer (a refresh, the ask after the user comes back from the reset page) that says the number fell is believed. This is the fallback ADR-0072's missing marker leaves: the rule applies only to a local reading newer than an answer from the Host.

## Consequences

- The Credentials invariant in `AGENTS.md` now says "at most every `everyMinutes` per Account, or every `activeEveryMinutes` while the login was used on this computer in the last 5 minutes". Spec §3.7 and §3.26 describe both changes.
- An Account in a long Claude Code turn is asked about three times as often while the turn runs: one more `claude -p /usage` process (about 4 s, no model turn) every 5 minutes per Same Login, and none once the login is idle.
- A stale, lower status line reading no longer hides a fuller window that `/usage` reported.
- Known limit: after a Limit Reset used on claude.ai, a newer status line reading that fell still shows the kept higher number until the next `/usage` answer, at most one interval (5 minutes while in use).
- Known limit: the choice between the Accounts of a Same Login (`sharedQuota`) still takes the newest reading of the group, so another Account's newer, lower status line reading can still win there.
- `mergeQuotaCache`, the status line cache's own merge per session, is unchanged. No `--json` field changes, so `schemaVersion` stays 1 and no schema is regenerated.
- Revisit if Claude Code starts to push Quota mid-turn, if `/usage` gets rate limited, or if Claude Code gains a way to report a Limit Reset that sideby can read.
