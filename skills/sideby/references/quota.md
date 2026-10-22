# Claude quota

Claude quota needs a one-time change to `~/.claude/settings.json`: the status line command becomes `sideby statusline-tap --orig-b64 <base64 of the original command>`. Claude Code then hands each refresh's official `rate_limits` (5-hour and 7-day used percent and reset time) to sideby, which caches them per account. Nothing is sent anywhere.

1. sideby must be installed globally (`npm i -g sideby`), because Claude Code runs the wrapper on every status line refresh. Setup is refused when `sideby` is missing from PATH or comes from the npx cache; tell the user to install it rather than working around it.
2. Run `sideby quota setup claude`. It prints the diff, changes nothing and exits **10**: show the diff to the user.
3. Only after the user approves, run `sideby quota setup claude --yes`.
4. To undo: `sideby quota teardown claude`. It restores the file byte for byte only if nothing changed since setup. If it refuses, show its diff and tell the user to set `statusLine.command` back to the original command (the base64 after `--orig-b64`), or delete `statusLine` if there was none.

Accounts with their own (not linked) `settings.json` show quota `not-enabled` until that file's status line is wrapped the same way; tell the user instead of editing it.

After setup, each account shows quota once it has had one session with a reply. Codex quota needs no setup: sideby asks the official `codex app-server` every 15 minutes, without a conversation. `sideby quota codex --refresh --json` asks now; `sideby quota check codex off --json` disables querying, as does CI. Local session records are a fallback only until the first successful query; they cannot overwrite fetched quota afterward. On failure, relay `fetchError` and `observedAt`, never call old numbers current. The menu's checked time is separate from each row's `observedAt` and `stale`; readings older than one hour or with a query failure show as older readings, except a reading over an hour old whose login has had no local session since (it stays current; use on the web or other computers is not seen). Claude Code quota cannot be refreshed on demand: tell the user it updates when a session runs in that account. Tested with Codex CLI 0.163.0.

Two accounts of one tool signed in as the same login (Claude: same email and organization; Codex and Grok also compare the workspace or team; `sameLogin` in `sideby list --json`) share one quota: both show the freshest reading, and `quota.from` names the account it was read from. Explain that to the user rather than calling the numbers wrong; usage stays per account, and sideby never merges or deletes either directory.

Grok quota needs no setup: sideby asks the `grok` CLI of each signed-in account (`grok agent --no-leader stdio`, the Host makes the request with its own login; sideby never reads `auth.json`) at most every 15 minutes, and also reads the quota Grok logs after each turn. `sideby quota grok --refresh` asks again now. `quota.status: "unavailable"` with `reason: "fetch-failed"` carries the cause and next step in `detail` (update Grok, `sideby login grok:<name>`); `"not-enabled"` means the user turned it off (config `quota.check.grok: false`, or the Panel's Settings) or it runs in CI. A reading with `fetchError` is the last good one; say it may be old.

Antigravity CLI (`agy`, main account only) quota also needs no setup: sideby runs `agy -p /usage --output-format json` (agy answers with its own Google sign-in and starts no model turn) at most every 15 minutes; `sideby quota agy --refresh` asks again now, and config `quota.check.agy: false` turns it off. Each window carries a model group `name` (5-hour and 7-day windows per group, some groups weekly only); tell the user which group each number belongs to. Named windows never count toward picking an account. A `detail` saying agy is not signed in means the user runs `sideby login agy:main` (it starts `agy`; they sign in with Google in the browser).

A window with a `name` (a plugin's Cursor "Other models") covers only some models: show it, but it does not make the account full.

Usage (7-day tokens) is read by sideby itself from Claude Code and Codex local records; no ccusage is needed. Grok and pi have no usage source; pi has no quota either.

## Quota checks and refresh

`sideby quota check <family> on|off --json` saves the fetching switch immediately, returning `family`, `on`, `changed`. For example, `sideby quota check grok off --json`. Only Families with a quota fetcher support it; the error tells you to choose one through `sideby families`. Turning it off keeps local readings available. CI still blocks fetching when the switch is on.

`sideby quota [account|family] --refresh --json` refreshes every selected Family that fetches quota, including plugin Families; without a target it refreshes all. It does not override a disabled check or CI. Read the returned accounts' `quota` and `usage`, including `fetchError` and observation time; do not call stale data a successful refresh.
