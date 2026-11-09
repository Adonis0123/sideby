# Grill: login-expiry-reminder

- Date: 2026-11-09
- Pairing: Interviewer Claude Code, Proxy Codex, Red-team Grok Build
- Rounds: 2; stopped because the frontier was empty
- Duration: about 25 minutes
- Status: implemented on 2026-11-09 (spec §3.39); ADR-0071 accepted

## Plan

Add a login-expired reminder to sideby, in the Panel, the `sideby` CLI and the shipped skill. Example: Claude Code shows `Login reached its time limit · Please run /login`.

## Decisions

| ID | Question | Decision | Status | Reversibility | Evidence |
| --- | --- | --- | --- | --- | --- |
| Q1 | Which Families in v1 | Optional per-Family reader; only Claude ships in v1, others stay unknown | Decided | easy | `src/families/claude/index.ts`, `src/families/grok/quota.ts` |
| Q2 | Contract shape | Keep `LoginState`; add optional `loginProblem: { kind: 'expired', since?, message }` on the account status; `schemaVersion` stays 1 | Decided | costly | `src/types.ts`, `schemas/list.json`, AGENTS.md "Output contract" |
| Q3 | Claude signal | Transcript record (primary) + a quota fetch that clearly asks for a new login (secondary); never Keychain or token fields; tail of the newest ~20 main sessions, last 256 KiB each, memoized | Decided | easy | `src/families/claude/session-files.ts`, `src/core/file-memo.ts`, `src/families/claude/quota-fetch.ts` |
| Q4 | What clears it | A later successful assistant turn in that same Account, or a successful quota fetch of that Account; login-file mtime only invalidates the cache; no permanent hide in v1 | Decided | easy | `src/core/quota-store.ts`, CONTEXT.md "Account" |
| Q5 | Where it shows | Panel row badge + "Sign in again" (existing `/api/login`, Preferred Terminal) + one summary banner; `sideby list` shows it; Menu Bar Item mark; no OS notification or hook message in v1; a Same Login row names the expired directory | Assumption | easy | `src/panel/handler.ts`, ADR-0026, `src/menubar/snapshot.ts` |
| Q6 | CLI shape | `list --json` carries `loginProblem`; Doctor adds `warn` Finding `login.expired` (`fixable: false`, says `sideby login <account>`); no new top-level command | Decided | easy | `src/cli/commands.ts`, `skills/sideby/references/diagnose.md` |
| Q7 | Handoff | `next`, Auto Handoff, Pick Commands and Panel recommendations skip an Expired Login; `next --json` gives reason `login-expired` and the login command | Decided | easy | `src/core/handoff.ts`, `src/core/handoff-select.ts`, `src/core/pick-commands.ts` |
| Q8 | Skill | Routing rows in `skills/sideby/SKILL.md`: checking → `references/diagnose.md`, signing in again → `references/accounts.md`; English and Chinese trigger phrases | Decided | easy | `skills/sideby/SKILL.md` |
| Q9 | Clearing after "Sign in again" | When the login sideby started exits 0 and quota checking is on (not CI), fetch that Account's quota at once and clear on success; otherwise show "Sign-in finished, waiting for confirmation" | Decided | easy | `src/cli/commands.ts` (`runLogin`), ADR-0063 |
| Q10 | Matching the record | Both `isApiErrorMessage` and `error:"authentication_failed"`, plus a list of verified expiry phrases (case, space and punctuation tolerant); `/login` or `Invalid API key` alone is not expiry; API Accounts never checked; UI shows sideby's own words | Decided | easy | `src/core/accounts.ts`, Claude Code 2.1.319 record |
| Q11 | Term | Expired Login; Panel "Sign-in expired" / 「登录已过期」, button "Sign in again" / 「重新登录」 | Decided | easy | CONTEXT.md |
| Q12 | Refresh | Reuse the existing refresh (Panel about 20 s while visible, Menu Bar 120 s, manual refresh); no new watcher; unchanged result redraws nothing | Decided | easy | `src/panel/page-script.ts`, `src/menubar/script.ts` |

## Reasons

### Q2 — Contract shape

- Reason: `LoginState` is a closed enum in the plugin contract and `schemas/list.json`; adding `expired` changes the meaning of `login` and would need a version bump. A new optional field is an addition. `schemas/list.json` has no `additionalProperties: false`, so existing validation keeps passing.
- Revisit if: the spec redefines `login` as "can authenticate right now", or a schema migration is planned anyway.
- Red-team: hold. Note: Handoff must read `loginProblem` explicitly (covered by Q7); `kind` is a closed enum and `message` is sideby's fixed sentence.

### Q9 — Clearing after "Sign in again"

- Reason: the exit code of `claude auth login` on success versus cancel is `UNVERIFIED`, so it is not enough to clear the state by itself.
- Revisit if: the supported Claude Code versions are verified to exit 0 only after a completed sign-in.

### Q10 — Matching

- Reason: a Subscription Account may still have past sessions that used an API key; calling every `/login` error "expired" would send the user to fix the wrong thing.
- Revisit if: Claude Code adds a structured error code for an expired login.

## Escalations

None.

## Assumptions

- Q5: surfaces follow the repo's existing patterns (badge, banner, list column, Menu Bar mark); no OS notification in v1.

## UNVERIFIED

- Scan size (20 sessions, 256 KiB): measured after implementation on 2000 fake transcripts, about 52 ms cold and 1 ms warm (ADR-0071 Consequences).
- Codex and Grok expiry signals were not found; they stay `unknown` in v1.

## Glossary and decision records

- Terms added to `CONTEXT.md`: Expired Login.
- Decision records written (now accepted): `docs/adr/0071-expired-login-is-a-separate-field.md`.
