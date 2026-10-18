# 0028. Codex Accounts are a Same Login when their email and ChatGPT workspace match

Date: 2026-10-18 · Status: accepted · Revises ADR-0003 (Identity) and ADR-0016 (Same Login)

## Context

ADR-0016 left Codex out of Same Login: its Identity is an email only, and one email can belong to several ChatGPT workspaces, each with its own Quota. Two Codex directories signed in to the same workspace therefore show two different numbers. Observed on 2026-10-18 with Codex 0.163.0: two directories with the same email showed the same weekly reset on one day; the next day one showed 0% with a new reset, read 7 minutes earlier, and the other 96%, read 10 hours earlier. The user could not tell which was true.

Codex's `auth.json` holds `tokens.id_token`, a JWT whose payload has the claim `https://api.openai.com/auth` with `chatgpt_account_id` (the workspace) and `chatgpt_user_id`. sideby already decodes this payload for the email (ADR-0003) and, for Browser Sign-ins, reads `chatgpt_user_id` only to compare it and drop it (ADR-0023, `families/codex/browser.ts`).

Options considered:

- Keep Codex out and mark an older reading as possibly stale. Rejected: the numbers still disagree, and the user still has to work out which one is right.
- Let the user mark two Accounts as sharing a Quota. Rejected: a beginner would not know to do it, and it goes stale when a login changes.
- Compare the workspace id inside sideby, never showing it. Chosen.

## Decision

- **A Family may provide a Login Key.** An internal reader returns an opaque key for an Account (a SHA-256 hash, cut to 16 hex characters, of the vendor's own workspace and user ids). It is used only to compare Accounts while the Runtime groups a Same Login. It is not part of `AccountIdentity`, never reaches an output, an error, a log, a cache or the Panel, and tests assert it.
- **Codex's Login Key** hashes `chatgpt_account_id` and `chatgpt_user_id` from the auth claim of `tokens.id_token`, decoded as the email is. The token and every other claim are dropped at once; no value is kept beyond the hash.
- **Same Login for Codex**: two Subscription Accounts of the codex Family are a Same Login when their email matches as before and both have a Login Key and the keys are equal. Without a key on either side they do not group. Claude keeps its rule (email plus organization).
- Everything ADR-0016 says about a Same Login then applies to Codex too: one Panel row, the freshest Quota shown with where it came from, and Handoff never landing on the same login.

## Consequences

- ADR-0003's rule now reads: the Identity readers pick only email and organization; a Family may also derive a Login Key from the same login file, kept only as a hash and only for comparing.
- Two Codex directories in one workspace show one Quota, the freshest; two in different workspaces stay apart.
- If OpenAI changes the claim names, the key is missing and Codex Accounts simply stop grouping, as before this ADR.
