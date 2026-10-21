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

- **Reading the browser.** Only Google Chrome on macOS in v1 (`~/Library/Application Support/Google/Chrome`). From `Local State`, sideby takes each profile's directory, display name and the email of the Google account it is signed in to Chrome with (`user_name`, only when it is an email), nothing else. The email was added on 2026-10-16: display names are often nicknames such as `adonis1`, and the user wants to know which Google account to look in. It is identity data the user owns, like the Account emails sideby already shows, and the Panel masks it with them. From each profile's `Local Storage/leveldb` it parses the `.log` and `.ldb` files read-only (with Snappy decompression, no new dependency) and keeps only the key names of `https://claude.ai` and `https://chatgpt.com`. Values are skipped without being decoded, kept or compared. It never opens `Cookies`, `Login Data`, IndexedDB or the Keychain, never writes or locks a Chrome file, and makes no network request.
- **Reading the Host.** The identity amendment of ADR-0003 gains one id per Family, used only for this match: `oauthAccount.accountUuid` of Claude's `.claude.json`, and the `chatgpt_user_id` claim (else `user_id`) under `https://api.openai.com/auth` of Codex's `id_token`, decoded as the email claim already is. The id is compared in memory and never shown, returned, logged or cached; the token and every other claim are still dropped.
- **Matching.** A **Browser Sign-in** exists when a full id from the Host appears as a whole segment of a key name of that vendor's origin. A site keeps several keys for whoever is signed in and may leave one or two behind after a sign-out or a switch (seen on 2026-10-16: one `persisted.cowork-read-state.<id>` key in two profiles that had signed in to another account since). So a match counts only when its number of matching keys is at least half of the strongest match of the same id across profiles, and of the strongest id of the same website in the same profile. The matches left are all listed, the profile whose Local Storage changed last first. sideby says a Browser Profile *signed in to* an Account, never that it is signed in now, because the data may be left over from before a sign-out.
- **Off until asked.** Reading the browser is off until the user turns it on (config `browser.signIns`, from the Panel or `sideby browser --enable`), after being shown what is read. Every place that shows the result says the data is read from this computer and goes nowhere.
- **Opening.** sideby opens the vendor website in a Browser Profile with `/usr/bin/open -na "Google Chrome" --args --profile-directory=<dir> <url>`. It starts Chrome unchanged and never changes a profile. An Account with no Browser Sign-in, and every Grok Account, can still be opened in a Browser Profile the user picks.

## Consequences

- The lookup breaks without warning when claude.ai or chatgpt.com rename their keys; it then finds nothing and says so.
- A few keys left from an old sign-in are outweighed by the current one's, but a profile that signed out and signed in to nothing else still shows the old Account.
- Grok Build has no match until grok.com stores an id that `auth.json` also has. (Superseded 2026-10-20 by ADR-0043: it does now.)
- Other Chromium browsers (Arc, Brave, Edge, Chrome Beta) share the format and need only their directory added.

## Amendment 2026-10-16: WSL

On WSL, sideby reads the Chrome installed on Windows, because that is the only browser a WSL user has. It asks Windows for `%LOCALAPPDATA%` and the Program Files folders with one `cmd.exe /d /c echo` call through `DesktopDeps.exec`, and turns `X:\...` into `/mnt/x/...`. When `cmd.exe` fails it uses `/mnt/c/Users/*/AppData/Local/Google/Chrome` only when exactly one Windows user has Chrome data. What it reads and how it matches are unchanged; reading `Local State` and Local Storage through `/mnt/c` works while Chrome runs (checked on 2026-10-16: five profiles, 0.6 s on the first read). It opens a website with `cmd.exe /d /c start "" "<chrome.exe>" --profile-directory=<dir> <url>`: `start` returns at once, while `chrome.exe` itself would wait as long as a Chrome it started keeps running. Native Linux Chrome stays out until it can be tested on a Linux machine.

## Amendment 2026-10-20: the Google account, and the user's own choice

Websites keep Local Storage after a sign-out, so a profile that switched accounts holds keys of both, often in similar numbers. The order in which keys were written does not settle it either: on a Chrome profile in use for months (checked on 2026-10-20), the old Account's keys had been written after the current one's. Key names alone cannot always tell which profile an Account belongs to.

- **Narrowing by Google account.** `Local State` already gives each profile's Google account (`user_name`) and the identity reader already gives each Account's login email. When an Account matches several profiles and some of them use its login email as their Google account, only those are kept. An Account that matches none gets the one profile, if exactly one, whose Google account is its login email; this also lets Grok Accounts match. Nothing more is read.
- **The user's choice wins.** The user can choose an Account's profile (config `browser.choices`, ref → folder; `sideby browser set` and the Panel's **Change**). The choice replaces what was found until the user lets sideby find it again (`--auto`, **Let sideby find it again**), as link-routing tools such as Choosy and Velja leave the rule to the user. It writes only sideby's config, so it needs no `--yes`. A choice whose folder no longer exists is skipped and reported, and the Account is found as before.
