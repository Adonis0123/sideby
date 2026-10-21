# ADR-0043: Plugin Families declare a website for Browser Sign-ins

Status: accepted
Date: 2026-10-20

## Context

Browser Sign-ins (ADR-0023, spec §3.24) kept the vendor websites in an internal list: claude.ai and chatgpt.com with a match, grok.com without. A Family added by a plugin had no website, so its Accounts showed "—" under the Panel's sign-in cell and had no **Choose** button. A user who runs a plugin Family next to the built-in ones sees one tool that cannot do what the others can, and nothing explains why.

Whether a plugin Family can be matched at all was checked on 2026-10-20 with Cursor CLI (cursor-agent 2026.10.19) as the sample: its `cli-config.json` keeps `authInfo.authId`, whose part after `|` is the WorkOS user id (`user_…`), and cursor.com keeps that id in Local Storage key names such as `radar_last_evaluated_<id>` and `dashboard.<team>:user:<id>:personal`. Two Accounts were found in two Chrome profiles that way. The first key name did not match under ADR-0023's rule, which counted `_` as part of an id, so `evaluated_user_…` read as one longer word.

## Decision

- **`FamilyDef.website`** (public, `src/types.ts`): `{ url, match? }`. `url` is where "Open in browser" goes. `match` is `{ origin, signInId(account) }`: the origin whose Local Storage key names may hold the id, and a reader of that id from the Host's own login file. Built-in Families keep their websites in `families/browser.ts`; a plugin's is looked up when no built-in one exists.
- **What sideby checks.** The loader drops an invalid `website` with a plugin error and keeps the Family, as it does for `logo`; `sideby plugins check` reports it as `website.invalid`. `url` must be `https://` with a host of letters, digits, `.` and `-`, and a path of letters, digits and `._~/-` only (no query or fragment, at most 200 characters), because it reaches `open` and, on WSL, `cmd.exe /c start`. `origin` must be an https origin with no path. `signInId` must be a function.
- **How the id is used.** The same rules as ADR-0023's Host ids: compared in memory with the key names, never shown, returned, logged or cached. An id shorter than 8 characters is ignored, so a careless reader cannot match every key. A reader that throws adds one problem that names the Account and the Family only, never the error's text, which could quote the login file. sideby reads nothing for it: the plugin reads its own login file, as it already does for `identity`.
- **Without `match`.** The Account can be opened in a browser user the user picks, and is still found when exactly one browser user's Google account is its login email, as Grok's are.
- **Key segments.** An id now matches when it is not glued to a letter or digit; `_` separates, like `.`, `:` and `/`. Random ids are long, so an id glued to another one by `_` is not a realistic false match.
- **Output.** `sideby browser --json` and the Panel's state gain `sites` (Family → url), so the Panel no longer keeps its own list of addresses. Adding a field keeps `schemaVersion` 1.

## Consequences

- Any plugin Family gets "Open in browser" and **Choose** with one field, and a match when its website keeps an id the Host also has.
- A plugin author decides which login-file value is compared. sideby cannot check that the value is not a token; the docs say to return an id only, and the value never leaves the Runtime either way.
- The built-in list stays internal, so sideby's own Families cannot be changed by a plugin; a plugin cannot register a built-in Family's id.

## Amendment 2026-10-20: Grok Build is matched too

ADR-0023 found no id on grok.com. Checked again on 2026-10-20 with Grok Build on two Accounts: grok.com now keeps the x.ai `user_id` in Local Storage key names such as `dismissed:<x>:<user_id>`, and Grok Build's `auth.json` holds the same `user_id` in its one sign-in entry, the entry the Login Key (ADR-0037) already reads. Grok's built-in website gains `match: { origin: 'https://grok.com', signInId }`, where `signInId` returns that `user_id` (`families/grok/browser.ts`). The rules above apply unchanged: compared in memory only, never shown, returned, logged or cached, and no token is read. pi stays without a website: it has no vendor site of its own, and sideby never reads the contents of its login file.
