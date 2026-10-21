# Grill: agy-family

- Date: 2026-10-21
- Pairing: Interviewer claude (this session), Proxy codex, Red-team grok
- Rounds: 2 plus one batch of Escalations answered by the user; stopped because the frontier is empty
- Duration: about 25 minutes
- Status: implemented 2026-10-21 (ADR-0047 and ADR-0048 accepted; Q13 changed, see below)

## Plan

> 支持接入一下 agy

With a screenshot of Antigravity CLI 1.4.4 (Google's agent CLI) signed in with a Google AI Pro account, model Gemini 3.8 Flash.

## Facts verified before the grill (agy 1.4.4, macOS, 2026-10-21)

- `agy --help` has `-p/--print`, `--model`, `--effort`, `--mode`, `--continue`, `--conversation <id>`, `--dangerously-skip-permissions`, `--output-format json|stream-json`; no `login` subcommand (signing in happens when `agy` starts with no arguments). Official docs list `/logout` and `/usage` (alias `/quota`).
- No config-dir environment variable. Everything comes from `$HOME`: app data `$HOME/.gemini/antigravity-cli`, customization `$HOME/.gemini/config`, global rules `$HOME/.gemini/GEMINI.md`. `~/.gemini` also holds Gemini CLI and Antigravity IDE files.
- The login token is the fixed macOS keychain item service `gemini`, account `antigravity`, found through `$HOME/Library/Keychains`. With a throwaway HOME agy is signed out; linking that HOME's `Library/Keychains` to the real one signs it in as the main account. A second login cannot live next to the first.
- `agy -p /usage --output-format json` answers with `num_turns: 0`, every token count 0 and an empty `conversation_id`, and returns per model group (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`) buckets with `window` (`5h`, `weekly`), `remaining_fraction` and `reset_time`. Some groups have a weekly window only.
- Environment variables in the binary that change how agy signs in or routes: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AGY_ADC_AUTH`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE`, `ANTIGRAVITY_PROJECT_ID`. `AGY_ACCOUNT` picks a connected sandbox account (such as GitHub), not the agy login.

## Decisions

| ID | Question | Decision | Status | Reversibility | Evidence |
| --- | --- | --- | --- | --- | --- |
| Q1 | How far to go | Built-in Family, Main Account only; no Session History in v1 | Decided | costly | `AGENTS.md` "Adding a family"; `src/core/launch.ts` |
| Q2 | Override `HOME` for more accounts | Not in this change; only after full isolation is verified; never link `.ssh`, `.gitconfig` or `Library/Keychains` to make it work | Decided (user) | costly | spec §3.5; facts above |
| Q3 | Id, title, directory, logo | id `agy`, title `Antigravity CLI`, Main directory `.gemini/antigravity-cli`, initials until a licensed mark exists; no default short command named `agy` | Decided | costly | `src/families/grok/index.ts`; `src/core/shell-init.ts` |
| Q4 | Login-state rule | `unknown` (see Q13 for what the quota fetch adds) | Decided | easy | `src/types.ts` |
| Q5 | Identity shown | None in v1 | Decided | easy | ADR-0003; `CONTEXT.md` |
| Q6 | Shared Items | `sharedItems: []`; candidates are a research list only | Decided | easy | spec §3.3 |
| Q7 | Hijack Variables, API Accounts | Clear the six variables above; leave `GOOGLE_CLOUD_PROJECT` and `AGY_ACCOUNT`; no API Accounts, refused at every entry | Decided (user) | easy | `src/core/accounts.ts` |
| Q8 | Quota | `fetchQuota` through `agy -p /usage --output-format json` under the `core/quota-fetch.ts` rules, new ADR; no `readUsage` | Decided | easy | ADR-0025; ADR-0038; `src/core/quota-fetch.ts` |
| Q9 | Probe, AI Task args, resume | `probe: ['-p', 'Reply with OK']` only on demand; `aiTaskArgs` drops `--dangerously-skip-permissions`; no `imageArg`; no resume routing | Decided | easy | `src/types.ts` |
| Q10 | Delivery scope | Panel, CLI `--json` and skill together, the Main-only limit said in all three, refused at one place for every create entry | Decided | costly | `AGENTS.md`; `src/core/create.ts` |
| Q11 | How the contract says Main-only | Explicit `mainOnly: true` with `selectVar` and `layout.account` absent; every other combination rejected (red-team's version over the Proxy's) | Decided (user) | costly | `src/plugins/check.ts`; `src/core/accounts.ts` |
| Q12 | Official isolation | None: no variable or flag besides `HOME`, sign-in only in the system credential store, switching means `/logout` and signing in again (confirmed by agy itself) | Decided | easy | https://www.antigravity.google/docs/cli/reference/ |
| Q13 | Sign-in and login wording | Sign-in command `agy`; base state `unknown`; an auth failure in the quota check says to run `sideby login agy:main`; a network error never shows "signed out". Changed at implementation: `loginState` cannot see the quota cache, so no "recently verified" state | Decided | easy | `src/core/quota-fetch.ts` |
| Q14 | Worth building Main-only now | Yes: Main-only Family now, multi-account once Google ships isolation | Decided (user) | easy | `src/core/handoff.ts` |
| Q15 | Cross-Family handoff into agy | Target only (fresh session, Brief path), after one real cross-Family handoff is verified; never a source in v1; separate "can receive" from "can detect exhaustion" | Decided | easy | `src/core/handoff-select.ts`; ADR-0010 |

## Reasons

### Q1 — Main Account only

- Reason: a `HOME` override would also move git, ssh and gh for the agent, and the keychain login is one fixed entry, so a second account would either be signed out or silently share the first login. Quota and `sideby run agy` are worth having alone.
- Revisit if: Google ships a config-dir variable and a per-account login store, verified with two accounts running in parallel.
- Red-team: hold. The change must also rewrite step 1 of "Adding a family" in `AGENTS.md`, or the Family fails the repository's own gate.

### Q3 — Names

- Reason: the id matches the binary, like `pi` and `grok`; the title tells it apart from the Antigravity IDE; `.gemini` as a whole would mix in Gemini CLI and the IDE.
- Revisit if: the official layout changes or a mark with a verifiable license is found.
- Red-team: hold, adding that sideby must not create a short command named `agy` by default, or `shell-init` would route every `agy` the user types through `sideby run`.

### Q8 — Quota from the CLI

- Reason: the Host signs in by itself and runs no model turn, the same exception as Grok and Codex. Quota Pressure follows the model actually launched: the tightest window among the groups that model belongs to. A weekly-only group gets no invented 5-hour window. When the model-to-group mapping is unknown, show the data and do not auto-pick on it.
- Revisit if: the command ever starts a model turn or spends quota; signed-out, timeout or other-plan answers differ.

### Q10 — Delivery scope

- Reason: the three-places rule; `sideby new` and `POST /api/accounts` both go through `Runtime.createAccount`, so the refusal lives there.
- Revisit if: a Portal or script already treats `families --json`'s `selectVar` as a required string; then decide in the ADR whether `schemaVersion` moves.
- Red-team: hold. Also update §3.28, `CONTRIBUTING.md` and `src/cli/json-schemas.ts` `FamilyDetail`.

### Q11 — Contract shape

- Reason (Proxy): no fake `selectVar`; both fields present or both absent, checked at registration.
- Red-team: overturn. "Missing fields mean Main-only" lets a plugin author who forgot `selectVar` pass `plugins check`, which today reports `select-var.missing`. Require an explicit `mainOnly: true` with both fields absent and reject every other combination; discovery must stop scanning HOME for it (`splitLayout` throws without `layout.account`), and `accountEnv` must not run `delete env[undefined]`.
- Revisit if: tests guard `plugins check`, discovery and `accountEnv` for both forms.

### Q13 — Login wording

- Reason: a recent quota answer is evidence of a sign-in, not a lasting login state; no extra request is made only to check login.
- Revisit if: a successful answer can come from an unauthenticated cache.

### Q15 — Handoff

- Reason: the current candidate contract ties being a target to the `handoff` capability; working directory, arguments, reading the Brief and model choice are unverified, and once in agy the automatic chain stops, which the Panel must say.
- Revisit if: agy cannot read the Brief reliably; then manual start only.

## Escalations

1. **Q14 + Q2 + Q12 — Main-only now?** Proxy recommended building the Main-only Family now. The user asked to check with agy first and to go with Main-only if it has no isolation. agy 1.4.4, asked through `agy --sandbox -p` on 2026-10-21 with its own guide, answered no to all three: no variable or flag besides `HOME` moves `~/.gemini/antigravity-cli` or `~/.gemini/config`; the sign-in lives only in the system credential store with no way to keep several; switching means `/logout` and signing in again. Decided: Main-only.
2. **Q11 — Contract shape.** The user chose the red-team's version: explicit `mainOnly: true`, `selectVar` and `layout.account` absent, every other combination rejected.
3. **Q7 — Variables cleared at Launch.** The user chose the recommendation: clear the six sign-in and routing variables, keep `GOOGLE_CLOUD_PROJECT` and `AGY_ACCOUNT`.

## Assumptions

None.

## Not covered

- Model and effort per Account (spec §3.19), the status line account label, live sessions and messaging for agy: left for after v1.
- Linux and Windows: where agy keeps its login there is unverified.

## Process notes

- Round 2: the Proxy answered in prose; `--resume` started a new session that had lost the context, so a re-ask came back `OPEN`. The host session transcribed the Proxy's own round-2 prose into the answer format without changing its positions (`.review-handoff/runtime/grill/agy-family/answers-2.md`).

## Glossary and decision records

- Terms added to `CONTEXT.md`: Main-only Family.
- Decision records written (proposed, accepted at implementation): `docs/adr/0047-antigravity-cli-is-a-main-only-family.md`, `docs/adr/0048-antigravity-quota-from-its-own-cli.md`.
