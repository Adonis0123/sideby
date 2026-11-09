# 0071. An Expired Login is a separate field, read from the Host's own record

Date: 2026-11-09 · Status: accepted

## Context

A Claude Code login can expire while its login file still holds `oauthAccount`, so sideby's `loginState` keeps saying `logged-in`. Claude Code then writes a record into the session transcript (`isApiErrorMessage: true`, `error: "authentication_failed"`, text such as "Login reached its time limit · Please run /login"; seen with Claude Code 2.1.319 on 2026-11-08). The user only finds out when a session fails, and `sideby next` may still pick that Account.

## Decision

- **A separate optional field.** The account status gains `loginProblem: { kind: 'expired', since?, message }`. `LoginState` keeps its three values, so plugins and JSON consumers that switch on it are unchanged and `schemaVersion` stays 1. `kind` is a closed enum; `message` is sideby's own sentence, never the transcript text; `since` is when the Host reported it, not when a token ends.
- **Read only what the Host wrote.** A Family may add an optional reader. Claude's reads the tail of its newest main transcripts and needs both structured fields plus a known expiry phrase. A quota fetch through the Host's own CLI that clearly asks for a new login counts too. No token, Keychain item or `expiresAt` is ever read.
- **Cleared only by evidence from the same Account**: a later successful turn, or a successful quota fetch. After a sign-in that sideby started, it fetches that Account's quota once (when quota checking is on).
- **Handoff and picks skip an Expired Login.**

Options considered:

- Add `'expired'` to `LoginState`. Rejected: it changes the meaning of an enum in the public contract and would need a `schemaVersion` bump.
- Read the OAuth `expiresAt`. Rejected by the credential invariant (ADR-0001, ADR-0003).
- Treat any `/login` error as expiry. Rejected: an invalid API key is a different problem with a different fix.

## Consequences

- `list --json`, the Panel state and Doctor (`login.expired`, warn) gain the field; `pnpm schemas` and `llms.txt` change.
- Codex, Grok, pi and Antigravity CLI report nothing until a reliable signal is found.
- Scan cost (measured 2026-11-09, Node 22, macOS, a fake HOME with 2000 main transcripts in 40 project folders, 200 lines each): the first `readLoginEvents` of a process takes about 52 ms; later ones about 1 ms, since the listing is redone only when a project folder changes or a minute has passed, and only the 20 newest transcripts are stat-ed again in between.
