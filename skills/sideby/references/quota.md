# Claude quota

Claude quota needs no setup: sideby asks Claude Code itself (ADR-0063). For each signed-in subscription account it runs `claude -p /usage --no-session-persistence --output-format json` with that account's config directory, with the user's hooks and MCP servers off, at most every 15 minutes. Claude Code answers with its own sign-in and starts no model turn (tried with Claude Code 2.1.314 on 2026-10-30); sideby reads no credential and keeps only the 5-hour, weekly and per-model weekly windows. `sideby quota claude --refresh` asks again now. `sideby quota check claude off --json` (config `quota.check.claude: false`) turns it off, as does CI. On `reason: "fetch-failed"`, relay the next step in `detail` (update Claude Code or sideby, or `sideby login <ref>`). A window with a model `name` (Claude Code's `Current week (<model>)`) covers only that model: show it, but it does not decide which account is picked.

## Live quota for Auto Handoff (the status line tap)

While a session runs, Claude Code also hands each reply's official `rate_limits` (5-hour and 7-day used percent and reset time) to its status line command; sideby shows the newer of that and the `/usage` answer. Auto Handoff reads only this one, so it needs a one-time change to `~/.claude/settings.json`: the status line command becomes `sideby statusline-tap --orig-b64 <base64 of the original command>`, and sideby caches the readings per account. Nothing is sent anywhere. Offer it when the user turns on Auto Handoff, not just to see quota.

1. sideby must be installed globally (`npm i -g sideby`), because Claude Code runs the wrapper on every status line refresh. Setup is refused when `sideby` is missing from PATH or comes from the npx cache; tell the user to install it rather than working around it.
2. Run `sideby quota setup claude`. It prints the diff, changes nothing and exits **10**: show the diff to the user.
3. Only after the user approves, run `sideby quota setup claude --yes`.
4. To undo: `sideby quota teardown claude`. It restores the file byte for byte only if nothing changed since setup. If it refuses, show its diff and tell the user to set `statusLine.command` back to the original command (the base64 after `--orig-b64`), or delete `statusLine` if there was none.

Setup also sets `statusLine.refreshInterval: 30` (kept if the user set one), so the quota stays current while a session waits on background agents. When `sideby handoff status` or `sideby doctor` (`handoff.quota-refresh`) asks for it, the status line was wrapped by an older sideby: run `sideby quota setup claude` again; the plan has `upgrade: true` and adds only that key. Ask before `--yes` as above.

Accounts with their own (not linked) `settings.json` get no status line readings until that file's status line is wrapped the same way; they still show the `/usage` answer. Tell the user instead of editing it.

Codex quota needs no setup: sideby asks the official `codex app-server` every 15 minutes, without a conversation. `sideby quota codex --refresh --json` asks now; `sideby quota check codex off --json` disables querying, as does CI. Local session records are a fallback only until the first successful query; they cannot overwrite fetched quota afterward. On failure, relay `fetchError` and `observedAt`, never call old numbers current. The menu's checked time is separate from each row's `observedAt` and `stale`; readings older than one hour or with a query failure show as older readings, except a reading over an hour old whose login has had no local session since (it stays current; use on the web or other computers is not seen). Claude Code quota refreshes on demand the same way (`sideby quota claude --refresh`). Tested with Codex CLI 0.163.0.

Two accounts of one tool signed in as the same login (Claude: same email and organization; Codex and Grok also compare the workspace or team; `sameLogin` in `sideby list --json`) share one quota: both show the freshest reading, and `quota.from` names the account it was read from. Explain that to the user rather than calling the numbers wrong; usage stays per account, and sideby never merges or deletes either directory.

Grok quota needs no setup: sideby asks the `grok` CLI of each signed-in account (`grok agent --no-leader stdio`, the Host makes the request with its own login; sideby never reads `auth.json`) at most every 15 minutes, and also reads the quota Grok logs after each turn. `sideby quota grok --refresh` asks again now. `quota.status: "unavailable"` with `reason: "fetch-failed"` carries the cause and next step in `detail` (update Grok, `sideby login grok:<name>`); `"not-enabled"` means the user turned it off (config `quota.check.grok: false`, or the Panel's Settings) or it runs in CI. A reading with `fetchError` is the last good one; say it may be old.

Antigravity CLI (`agy`, main account only) quota also needs no setup: sideby runs `agy -p /usage --output-format json` (agy answers with its own Google sign-in and starts no model turn) at most every 15 minutes; `sideby quota agy --refresh` asks again now, and config `quota.check.agy: false` turns it off. Each window carries a model group `name` (5-hour and 7-day windows per group, some groups weekly only); tell the user which group each number belongs to. Named windows never count toward picking an account. A `detail` saying agy is not signed in means the user runs `sideby login agy:main` (it starts `agy`; they sign in with Google in the browser).

A window with a `name` (a plugin's Cursor "Other models") covers only some models: show it, but it does not make the account full.

Colors depend on the window's length (ADR-0062): a 5-hour (or any one-day-or-shorter) window is yellow from 60% and red from 85%; a weekly or longer window is yellow from 85% and red from 95%. One full 5-hour window costs only about a fifth of a week, so a week at 87% still leaves several 5-hour windows of work. When the user asks why a weekly 87% is not red, or why such an account was still picked, say that.

Usage (7-day tokens) is read by sideby itself from Claude Code and Codex local records; no ccusage is needed. Grok and pi have no usage source; pi has no quota either.

## Quota checks and refresh

`sideby quota check <family> on|off --json` saves the fetching switch immediately, returning `family`, `on`, `changed`. For example, `sideby quota check grok off --json`. Only Families with a quota fetcher support it; the error tells you to choose one through `sideby families`. Turning it off keeps local readings available. CI still blocks fetching when the switch is on.

`sideby quota [account|family] --refresh --json` refreshes every selected Family that fetches quota, including plugin Families; without a target it refreshes all. It does not override a disabled check or CI. Read the returned accounts' `quota` and `usage`, including `fetchError` and observation time; do not call stale data a successful refresh.
