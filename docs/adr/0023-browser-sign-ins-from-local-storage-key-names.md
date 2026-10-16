# 0023. sideby finds which Browser Profile signed in to an Account from Local Storage key names

Date: 2026-10-16 · Status: accepted

## Context

A user with many Accounts forgets which Chrome profile they signed in to each one with on claude.ai or chatgpt.com, and wants to open the vendor website in the right one. Nothing in sideby links an Account to a **Browser Profile** (`CONTEXT.md`).

What exists (researched 2026-10-16, on the maintainer's machine read-only, and on the web):

- Chrome stores cookies encrypted with the "Chrome Safe Storage" Keychain key, which also protects saved passwords. claude.ai's `sessionKey` and chatgpt.com's session token are credentials. Endpoints such as claude.ai `/api/organizations` or chatgpt.com `/api/auth/session` are private and need that token.
- Since Chrome 136 `--remote-debugging-port` does nothing for the default user data directory, so DevTools cannot read a daily profile.
- A browser extension with a native messaging host could read the page, but must be installed in every profile.
- Local Storage (`<profile>/Local Storage/leveldb`) is not encrypted. No email is stored in it for either site, but key names carry ids:
  - claude.ai keys such as `persisted.ccd-session-presets.<accountUuid>.<orgUuid>` hold the account UUID that Claude Code keeps as `oauthAccount.accountUuid` in `.claude.json`.
  - chatgpt.com keys such as `cache/user-<id>/<workspace>/models` hold the ChatGPT user id that Codex's `id_token` carries as `chatgpt_user_id` (with `user_id` as its fallback, `codex-rs/login/src/token_data.rs`). `tokens.account_id` is the workspace id and does not appear there.
  - grok.com keeps only analytics keys, with no id that Grok Build's `auth.json` has.
- The email does not tell the maintainer's Accounts apart: five Claude Accounts share one email and organization but have different account UUIDs.
- Matching key names only, four of six profiles matched Claude Accounts and two matched Codex Accounts.

Options considered:

- Decrypt cookies or call the private endpoints. Rejected: reads credentials (ADR-0001, ADR-0003).
- A browser extension. Deferred: an install in every profile for a lookup the files already answer for two Families.
- Read Local Storage values, where some ids also appear. Rejected: values of the same origin may hold tokens; key names are enough.
- Read Local Storage key names only, and match them with one more id from each Host's login file. Chosen.

## Decision

- **Reading the browser.** Only Google Chrome on macOS in v1 (`~/Library/Application Support/Google/Chrome`). From `Local State`, sideby takes each profile's directory and display name, nothing else. From each profile's `Local Storage/leveldb` it parses the `.log` and `.ldb` files read-only (with Snappy decompression, no new dependency) and keeps only the key names of `https://claude.ai` and `https://chatgpt.com`. Values are skipped without being decoded, kept or compared. It never opens `Cookies`, `Login Data`, IndexedDB or the Keychain, never writes or locks a Chrome file, and makes no network request.
- **Reading the Host.** The identity amendment of ADR-0003 gains one id per Family, used only for this match: `oauthAccount.accountUuid` of Claude's `.claude.json`, and the `chatgpt_user_id` claim (else `user_id`) under `https://api.openai.com/auth` of Codex's `id_token`, decoded as the email claim already is. The id is compared in memory and never shown, returned, logged or cached; the token and every other claim are still dropped.
- **Matching.** A **Browser Sign-in** exists when a full id from the Host appears as a whole segment of a key name of that vendor's origin. A profile may match several Accounts, and an Account several profiles; all are listed, the profile whose Local Storage changed last first. sideby says a Browser Profile *signed in to* an Account, never that it is signed in now, because the data may be left over from before a sign-out.
- **Off until asked.** Reading the browser is off until the user turns it on (config `browser.signIns`, from the Panel or `sideby browser --enable`), after being shown what is read. Every place that shows the result says the data is read from this computer and goes nowhere.
- **Opening.** sideby opens the vendor website in a Browser Profile with `/usr/bin/open -na "Google Chrome" --args --profile-directory=<dir> <url>`. It starts Chrome unchanged and never changes a profile. An Account with no Browser Sign-in, and every Grok Account, can still be opened in a Browser Profile the user picks.

## Consequences

- The lookup breaks without warning when claude.ai or chatgpt.com rename their keys; it then finds nothing and says so.
- A key left from an old sign-in still counts, so an Account can show a Browser Profile that has since signed out.
- Grok Build has no match until grok.com stores an id that `auth.json` also has.
- Other Chromium browsers (Arc, Brave, Edge, Chrome Beta) share the format and need only their directory added.
