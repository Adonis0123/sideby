# ADR-0072: Use a Limit Reset through the Host's own CLI

Status: proposed
Date: 2026-11-12

## Context

Vendors now give Subscription Accounts Limit Resets: one-time credits that restore Quota before a window's own reset time. A user who runs several Accounts wants to see which Account holds one and to spend it where the Quota is shown.

Codex CLI 0.167.2 (read from `codex app-server generate-json-schema` on 2026-11-12; no spend was sent) carries the stock in the answer sideby already asks for, `rateLimitResetCredits: { availableCount, credits? }`, each credit with `resetType`, `status`, `grantedAt` and an optional `expiresAt`. It also has a request `account/rateLimitResetCredit/consume` with `{ idempotencyKey, creditId? }`, answered with one of `reset`, `nothingToReset`, `noCredit`, `alreadyRedeemed`. The answer holds no new Quota.

Claude Code 2.1.322 shows neither the stock nor a way to spend one: `/usage` prints only the `Current …` lines. Anthropic's help page says a limit reset is used on `https://claude.ai/settings/usage` in a browser or the desktop or mobile app, and that it then applies to Claude Code too. ADR-0003 forbids private endpoints, so sideby cannot do more for Claude Code.

The Credentials invariant lets a Host's own CLI be asked only for its Quota. Spending a Limit Reset is a request that changes the Account and cannot be undone, so it needs its own decision.

## Decision

**Reading the stock (Codex).** Take `rateLimitResetCredits` from the `account/rateLimits/read` answer; no request is added. Keep the available count, the time it was read and, only when the detail rows are complete, the earliest expiry. A Host that cannot tell (Claude Code) has no `limitResets` at all, never a guessed `0`.

**Spending one (Codex).** A new, narrow exception next to the Host-query exception of ADR-0038:

- Only as one action a user confirmed for one Account, in the Panel or with `sideby quota reset <account> --yes`. Never from Auto Handoff, `sideby next`, Unattended Mode, the Menu Bar Item by itself, `statusline-tap`, `handoff-hook` or any other hook.
- The Host sends the request over the same account-isolated `codex app-server`; sideby reads no credential and makes no request of its own. `creditId` is left out so the vendor picks the credit; no credit id is stored.
- Before confirming, sideby reads the stock and the Quota fresh and shows: the Account, the other Accounts of the same Same Login, each window with its used percent and own reset time, the stock expected afterwards, and the next expiry or "unknown". It does not promise which windows refill.
- Each confirmation makes one operation with one idempotency key, written to `<state>/quota/limit-reset/<operation>.json` (directory 700, file 600, atomic writer) before the request is sent. The record holds a version, the operation id, the Account refs, the key, the state and the attempt times; never a Login Key, an Identity, a credit id or a credential. The record also holds a salted digest of the login's comparison key, usable only to tell that this operation's login is unchanged; never the Login Key or the Identity. One lock per Same Login, across processes, makes the Panel, the CLI and the menu take turns.
- A retry reuses the operation and its key until the Host gives a final outcome. A failed or timed-out attempt answers with the same `operationId` (in the `--json` error too), and a later `--yes` for that login resumes it instead of making a new key. A finished record is removed after 24 hours; an unresolved one is never aged out. Pruning removes a record only while holding that login's lock and after reading it again there, and a plan older than 24 hours is refused at confirmation under the same lock, so a plan that is being confirmed is never removed. When sideby cannot tell that the login is still the same, it sends nothing for that operation. Equal Account refs do not show that, because an Account can sign in as another login and keep its name: the digest is compared when a plan is confirmed and again under the lock, right before the request, for a plan and for a retry alike. A plan whose login changed or cannot be read is out of date and needs a new plan. An unresolved operation is then not sent and stays unresolved, so only its own login can ask about it again; a record without a digest is treated the same way. Nothing but the Host's final answer to its own key ends an unresolved operation: Accounts leaving or joining its Same Login do not, because its first request may already have spent a credit. It is found by the digest as well as by the Accounts it names, so an Account that signed in as that login later resumes it with the same key instead of getting a new one.
- An operation file that is there but cannot be read (no permission, damaged), or a folder that cannot be listed, may hide an unresolved operation. While there is one, no new operation is made and nothing is sent; the plan still shows, says why and names the path. Such a file is never removed by sideby.
- After `reset` or `alreadyRedeemed`, sideby asks that Account's Quota at once, outside `everyMinutes`, stores it for every Account of the Same Login and shows the real numbers. It never lowers the count or the bars by itself. A Quota answer of any Account of that login whose ask began before the spend and came back after it is not kept, so numbers from before the spend never show as the newest.
- Exit code 10 keeps its meaning: the plan was shown and waits for `--yes`. The plan says in plain words that a spend cannot be undone.

**Claude Code: a link.** "Use a reset on claude.ai" opens `https://claude.ai/settings/usage` in the Account's chosen Browser Profile, else the default browser. The Account's Identity is shown beside it, with a hint to check the web login; sideby never reads which login the browser has. When the user comes back from that jump, sideby asks that Account's Quota once. Nothing about which limit a Claude reset restores is modelled; the guide gives the vendor's rule.

**Where it shows.** A quiet count whenever the stock is above zero. A visible button when a plan-wide window is at its warning level (60% of a Short Window, 85% of a Long Window; for Claude Code a model-group week counts too) or a known credit expires within 72 hours; otherwise the action is in the row's menu and the command palette. The Menu Bar Item shows the count and "Use a reset…", which opens the Panel's confirmation for Codex and the vendor page for Claude Code.

**Contract.** Optional additions only: `limitResets` on the `ok` branch of `QuotaResult`, and `FamilyDef.limitReset: { use?, vendorPage? }` with at least one of the two. `use(account, ctx)` gets `QuotaFetchContext` plus `idempotencyKey` and returns `reset`, `nothing-to-reset`, `none-left` or `already-done`. A Family with `use` needs `identity` too: without it sideby cannot tell which login a spend would go to, and offers no plan. The Runtime owns confirmation, the lock, the record and the timeout. `shownQuota` and `keptQuota` keep `limitResets`. `schemaVersion` stays 1.

**Auto Handoff (amends ADR-0060).** An Account that was left because a window was full becomes pickable again after a confirmed spend, once the Quota read that follows is under the Takeover Limit, without waiting for the window's old reset time.

## Consequences

- The Credentials invariant in `AGENTS.md` gains this exception, and `docs/agents/host-directories.md` the state path. sideby still writes nothing into a Host directory for it.
- A plugin Family may offer the same through `limitReset`; plugin docs keep saying a plugin runs with the user's full permissions.
- Tests use a scripted `codex app-server` through `fakeHost`: every outcome, failure before sending, an answer lost after a spend, a hang, a crash, resume across processes and Same Login races. They assert at most one spend effect per key, no change under any Host directory, and no consume without a confirmation.
- Ships last of three changes (read and display; the Claude link; the spend), after the whole flow ran in an isolated HOME and the maintainer confirmed one real spend by hand. Not yet verified: whether `consume` is accepted with `experimentalApi: false`, which windows one credit restores, and how long the vendor remembers a key.
- Revisit if the consume request starts to cost money or to need a `creditId`, if the vendor offers a preview or an undo, or if Claude Code gains a command for the stock or the spend.
- Known limit: a Quota answer asked for before a spend is dropped by the spent operation's record. When the Host answered `reset` but that record could not be written (`outcome-not-saved`), there is no such record yet, and an answer of another Account of the login that began before the spend and arrives after the read that followed it can show the old numbers until the next check. The operation stays `pending` with its key, so nothing is spent twice.
