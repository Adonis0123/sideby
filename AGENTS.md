# AGENTS.md

Rules for AI agents maintaining sideby. Terms are defined in `CONTEXT.md`; decisions in `docs/adr/`; the current design in `docs/specs/`. Specs and plans are in Chinese, everything public is in English.

## User experience first

The user's experience comes first. When a rule, a habit of this codebase or an easier implementation pulls another way, choose what saves the user effort; only the Invariants below (credentials, Host directories, the Panel's security checks) win over it. Every feature should be simple and useful enough that the user never has to stop and think: the default is already right, and the screen says what to do next.

Design every feature for a beginner. The first screen is simple, the default path is one clear action, and the words are plain: say what happens and what the user gets, not "weighted tokens" or "Host". Do the work for the user: when sideby recommends a setting, it offers to apply it, shows exactly what will change, and keeps an undo; it never asks the user to copy a snippet into a config file by hand. Do not make a feature something the user must already know about: give it a place of its own (a page, a tab) or show it where the problem appears. Details go behind a click. Before designing something new, look at how well-made software solves the same problem, and prefer what several of them agree on. Before handing work back, walk the path as that beginner would (empty, normal, error, slow) and fix whatever is confusing.

Every interaction feels smooth, never abrupt. Menus, popovers and dialogs ease in and out; a row, field or note that appears or goes away grows or fades instead of snapping the layout. Read what a view needs before it opens, so it opens at its final size instead of growing as answers arrive. A refresh that brings the same answer redraws nothing, and a redraw keeps focus and never closes a list or a field the user has open. Short (about 120 to 200 ms), and none under `prefers-reduced-motion`. Before handing work back, click through the change once at normal speed and fix whatever jumps, flickers or opens and closes by itself.

Every user-facing feature lands in three places in the same change: the Panel, a `sideby` command (with `--json`), and the shipped skill (`skills/sideby/`: a routing row in SKILL.md and its use in a reference file), so a user can click it, type it, or ask their AI for it. Only entries sideby runs itself are exempt (`statusline-tap`, `handoff-hook`, `update-check`); a CLI-only option that tunes something the Panel already shows needs no new button. The Panel tells users they can ask their AI instead (Settings, "Ask your AI to do it", and hints where a task starts). A feature that exists only as a button, or only as a command, is unfinished. `src/cli/skill-coverage.test.ts` fails when a dispatched command is missing from the skill.

## Write for every user

sideby is public, and everything in this repository (code, comments, tests, specs, ADRs, guides, commit messages) is read by people whose machines look nothing like the one the work was done on. A task often starts from one person's setup: their accounts, a page of their own that embeds the Panel, a local plugin. Solve it for everyone and write it that way:

- State behaviour and rules, with roles as subjects: a user, an Account, a Portal, a plugin author. Not who reported it or how their machine is set up.
- Give evidence by what makes it repeatable: the Host and its version, the date, the conditions ("tried with Grok Build 1.0.60 on 2026-10-17"). Never "on my machine" or "the maintainer has three accounts".
- Use the demo HOME's fake names in examples (`claude:work`, `me@example.com`, port 17420). Never real account names, emails, home paths, hostnames or ports from someone's setup, and never the names of their own tools or plugins.
- A fix that belongs to someone's own tool (their Portal, a local plugin) goes in that tool. Here, write only the general rule it needs from sideby, such as what any Portal must do.

Before you commit, read your diff once for these.

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Full gate (typecheck, biome, tests, leak-check) | `pnpm check` |
| All tests | `pnpm test` |
| One test file | `node --test src/core/share-modes.test.ts` |
| Format and auto-fix | `pnpm format` |
| Build `dist/` | `pnpm build` |
| Put this checkout behind the global `sideby` (Local Build, ADR-0024) | `pnpm local` (`--back` undoes the last switch, `--off` goes back to npm, installing `latest` when the kept copy is older) |
| Release (maintainer asks) | `pnpm release <patch\|minor>`: tag, push, wait for npm, then back off the Local Build |
| Regenerate JSON Schemas | `pnpm schemas` (commit the result; CI fails if `schemas/` is stale) |
| Rebuild the Design System on claude.ai (tokens, `bundle.css`, logos, guides) | `pnpm design-system`, then `/design-sync` in Claude Code with `design-system/dist/`. Values come from `src/panel/themes.ts`, `theme.ts`, `page-styles.ts` and `src/core/brand-mark.ts`; prose, previews and token usage notes from `design-system/`. Never edit the system on the page: the next sync replaces it |
| Check publish contents | `npm pack --dry-run` (no `.ts` sources except `.d.ts`) |
| Claude mod tests (not in `pnpm check`: they need Claude Code 2.1.287+) | `claude plugin test mods/claude` and `claude plugin validate mods/claude` |
| Demo HOME for manual testing | `node scripts/demo-home.ts <dir> [normal\|empty\|error\|slow]` |
| README media and copy that may be stale | `node scripts/readme-assets.ts` (then the `readme-assets` skill) |

Tests run the `.ts` sources directly with Node 22.18+; no build is needed. Run `pnpm check` before you hand work back, then `pnpm local` so the maintainer sees the change in the Panel and CLI they already use (it switches only a build that compiles and starts; say so if it failed).

## Read when

Each file below holds rules as binding as this one. Read it before the work it names.

| When | Read |
|---|---|
| Finding where something lives in `src/`, `scripts/` or `docs/` | `docs/agents/map.md` |
| Changing anything that reads or writes a Host directory or a shell rc file, or any hook entry (`network-hook`, `unattended-hook`, `handoff-hook`, `statusline-tap`), `tune`, the model and effort readers, `remote-control`, `messages inbound`, `send`, `desktop`, the Run Link, Session History, `browser` or `shell-init` | `docs/agents/host-directories.md` |
| Trying the CLI or the Panel by hand with a demo HOME; updating the README in any words (then follow `.claude/skills/readme-assets/SKILL.md`); retaking README screenshots, menu bar pictures, the GIF, the banner or the intro video | `docs/agents/demo-home.md` |
| Adding a Host as a new Family | `docs/agents/adding-a-family.md` |

## Map

The source tree is described in `docs/agents/map.md`.

Public contract files: `src/types.ts`, `src/runtime.ts`, `testing/index.ts`, `schemas/`, and what Portals rely on (ADR-0006; `src/index.ts`, `src/panel/handler.ts`, `src/panel/theme.ts`): every `createPanelHandler` option, its `Promise<boolean>` result and `token`, every `PanelTheme` field and `PanelThemeTokens` key, and the `app` and `version` fields of `/api/health`. Changing them affects plugin authors, Portal authors and JSON consumers; see "Change process".

## Invariants

Breaking any of these is a bug, even if tests pass.

**Share Mode "never do" rules** (spec §3.3). `doctor --fix` must never:

- `link`: replace a real file or real directory with a link. Report it and suggest `mv <x> <x>.local && ln -s …`.
- `copy`: write through a symlink into the Main Account; touch an item whose type differs from the main one.
- `link-or-copy`: act when the main item is empty or its type differs.
- `link-or-local`: compare content or overwrite anything.
- `local`: replace a symlink; it only reports.
- `local-if-api`: fix an API Account's item; a symlink or missing file there is reported only.
- `info`: count or fix anything.
- `json-key`: shrink the account's entries (including emptying them) without `--force`; touch a file that is a symlink, is not a JSON object, or whose key is not an object, even with `--force`; write if the file hash changed between read and write.
- Any mode: change where an existing symlink points (a link to another existing target is a warning, `link.other-target`, or a failure, `symlink-forbidden`, where the item may not be a link; a dangling link is a failure, `link.dangling`; all are reported only); create a Shared Item that is missing from the Main Account; touch backup leftovers (`*.bak*`, `*backup*`, `*.tmp*`) beyond counting them.

Shared Item paths must be relative and stay inside the account directory: config rejects absolute or `..` paths, and Doctor reports a plugin-defined one as `path.invalid` without touching it. A Shared Item the Main Account does not have is not a problem: it gets no Finding and does not count toward `shared.total`. Doctor exits 1 only for `fail` Findings; warnings alone exit 0.

**Accounts**

- A directory matching a family's pattern is an Account only if it holds `proxy.env` or at least one of the family's Shared Items (so `~/.claude-code-router` is not one).
- `proxy.env` makes an Account an API Account, except where `secretFileMeansApi: false` (pi): there it is loaded at Launch for provider keys and the Account stays a subscription.
- An API Account's login state is `not-needed` (`key` in `sideby list`); `loginState` is not called for it.
- Plugin errors met while reading an Account go to `AccountStatus.problems` (stderr in `sideby list`), never abort the listing.

**Credentials**

- Never print, log, return, or put in an error message the value of anything from `proxy.env`, `auth.json` or `.claude.json`. Errors name the path or the variable, and for parse errors the line number only. The values shown are a Claude API Account's `ANTHROPIC_MODEL`, as its model, and the identity fields a Family's `identity` reader picks (email, organization; ADR-0003). Never a token: Codex's `id_token` is decoded only to take its `email` claim, and is never stored or returned. A Login Key (ADR-0028, ADR-0037) hashes Codex's workspace and user ids or Grok's `user_id` and `team_id` only to compare Accounts, and never leaves the Runtime.
- Doctor checks credential files for type and mode 600 only. The only content it reads is the single key a `json-key` item names. `proxy.env` is parsed only at Launch and for that model name.
- Never read a credential to call a model, pool logins, or rotate accounts on its own (ADR-0001; Auto Handoff is opt-in, ADR-0010). Never call private quota endpoints (ADR-0003). Built-in quota and usage readers make no network requests. The one exception is a Host's own CLI asked for its Quota without a session (Grok: `grok agent --no-leader stdio` and `_x.ai/billing`, ADR-0025; Codex: `codex app-server` and `account/rateLimits/read`, ADR-0038; Antigravity CLI: `agy -p /usage --output-format json`, which starts no model turn, ADR-0048; Claude Code: `claude -p /usage --no-session-persistence --output-format json` with hooks and MCP servers off, run in `<state>/quota/claude-run`, which starts no model turn, ADR-0063; `core/quota-fetch.ts`): the Host sends the request with its own login, sideby reads no credential for it, asks at most every `everyMinutes` per Account, plus once more for each distinct reset instant a kept answer published once that instant has passed (ADR-0073: windows that reset at the same instant count once, a Same Login is asked once for the group, and the attempt is marked in sideby's state directory before the ask, so a failed one is not repeated), never from `statusline-tap` or `handoff-hook`, keeps only numbers, reset times, the plan name and the count and next expiry of Limit Resets (never a credit id), and stays off under config `quota.check.<family>: false` and in CI. A second exception to "only its Quota" is using a Limit Reset (ADR-0072, spec §3.40; `core/limit-reset.ts`): Codex's own `codex app-server` is sent `account/rateLimitResetCredit/consume` with an idempotency key and no credit id, only as one action a user confirmed for one Account (the Panel's confirmation, or `sideby quota reset <account> --yes`). It is never reached from Auto Handoff, `sideby next`, Unattended Mode, the Menu Bar Item by itself, `statusline-tap`, `handoff-hook` or any other hook, and is off in CI. The Host sends it with its own login and sideby reads no credential; the key is on disk before the request leaves, a retry reuses it until the Host gives a final answer, and one lock per Same Login makes callers take turns. The record of an operation also holds a salted digest of the login's comparison key, usable only to tell that this operation's login is unchanged; never the Login Key or the Identity; a plan or a retry whose login changed or cannot be read is not sent, nor is anything while an operation file is there but cannot be read. Of the answer only the outcome is kept; the Quota is then read again from the Host, and sideby never lowers the count or the bars by itself. Claude Code has no such request: sideby only opens `https://claude.ai/settings/usage`. Only the `billing: fetched credits config` lines of Grok's `logs/unified.jsonl` are parsed, and only their Quota fields kept; the file's other lines hold the user id and a token's end. The Update Check (ADR-0021, `core/update.ts`) is one of sideby's two requests of its own: one GET of the `latest` dist-tag, at most daily, carrying no Account, path or identity; it stays off under `NO_UPDATE_NOTIFIER`, `SIDEBY_NO_UPDATE_NOTIFIER`, config `update.check: false` and CI, and `withFakeHome` sets `SIDEBY_NO_UPDATE_NOTIFIER` so tests never make it. Auto Update stays opt-in (config `update.auto`). Network Guard (ADR-0053, `core/egress.ts`, `core/network.ts`) is the other request of its own, only while config `network.guard` is on and not in CI: one GET of the vendor's own `/cdn-cgi/trace` (`api.anthropic.com`, `chatgpt.com`, `api.openai.com`) through the Account's proxy variables, carrying no credential, Account or identity; it keeps only the country and a SHA-256 of the address, never the address or the proxy URL, and tests replace it through `createRuntime`'s internal `network` option.

**Host directories**

- sideby writes none of its own files into a Host account directory. The exceptions are `quota setup claude --yes`, which wraps the main `settings.json` status line as `sideby statusline-tap --orig-b64 <base64>` and sets `statusLine.refreshInterval` to 30 where it is not set (ADR-0056), and `handoff setup grok --yes`, which adds `~/.grok/hooks/sideby-handoff.json` (ADR-0010). `teardown` restores the file byte for byte (removes the hook file and a hooks directory it emptied), only while the file still matches what setup wrote. The Panel's Auto Handoff page (ADR-0013) runs these same setups, plus a copy of that one hook file (only where it is missing) into the other accounts of the Family, as one plan the user confirms; it adds no other write. Setup refuses when `sideby` is not on PATH or comes from the npx cache, because the Host runs it by name.
- The other exceptions to that rule, and the rules for each hook entry, reader and writer that touches a Host or a shell rc file, are in `docs/agents/host-directories.md`. They are Invariants too.
- Quota warning levels, the Usage window and the rule for how old a Quota window is (`windowAge`, ADR-0073) live in `core/quota-levels.ts`; the CLI, the Panel page and the Menu Bar Item all use them.
- Fixes write only inside the account being fixed, through the atomic writer (temp file in the same directory, mode 600, rename). Credential files end at mode 600.
- `launch` never changes the parent shell environment, never adds dangerous flags by default, and clears Hijack Variables for every account.
- `sideby next` (Handoff, spec §3.13) only ranks local Quota and starts its pick exactly as `run` would. It starts nothing when nothing can be picked, nor when no signed-in Subscription Account of the Family has Quota data (`hasQuota: false`, the pick would be a guess), and never copies sessions between Accounts.
- Auto Handoff (spec §3.17, ADR-0010) acts only with config `handoff.auto`, and between two Accounts of one Family only with `sameFamily` too. It never ends a Host before a pick exists, never kills one (SIGTERM, then 10 s, then it gives up), never copies sessions, and passes the Brief's path, never its text, on the command line. It adds no dangerous flag: hooks come through `--settings` (Claude), `-c hooks.*` (Codex, which the user must trust in `/hooks`) or the Grok setup file.

**Plugins**

- A plugin is local code with the user's full permissions. Docs, `sideby plugins` output and errors must keep saying so.
- Plugins may only `import type` from `sideby`. Never add an API that requires a plugin to import a value from sideby; pass it through `PluginApi`.
- Loader trust checks (owner is the current user, not group or other writable) stay on for plugin directories, `plugin.json`, entry files and `sideby-before-launch`.
- Hook errors carry the plugin name. A failing plugin affects only itself, except that a failing `launch.before` stops the launch and a failing `account.create.before` stops `new` before anything is written.

**Panel**

- The Panel's CSP (`frame-ancestors 'self'` included) and its Host, Origin (`http://<Host>`) and token checks are never loosened, also not to suit a Portal (ADR-0006).

**Output contract**

- Every `--json` output has `schemaVersion: 1`, and an optional `_notice` (`update`, `skill`; spec §3.23) that never changes the result. A `--json` error is `{ schemaVersion, error, code }` (plus `_notice`); `error` stays a string. Adding a field keeps the version; removing, renaming or changing meaning bumps it and needs an ADR.
- Every user-facing error says what to do next.
- Exit code 10 means a change was shown and waits for `--yes` (`quota setup`, `quota reset`, `handoff setup`, `update`, `browser --enable|--disable`, `network on|off|allow`, `advisor <model>|off|undo` and `advisor unlock`). Doctor never uses it: it exits 1 only for `fail` Findings.

## Tests

- Use only `withFakeHome` and `fakeHost` from `testing/`. A test that could touch the real HOME, real Host binaries or the network is wrong; `withFakeHome` fails if it resolves inside the real HOME.
- One test file per Share Mode and per family. Each "never do" case compares Main Account hashes, symlink targets and credential hashes before and after `--fix`.
- Write paths: snapshot the fake Host directories before and after (`snapshot`, `diffSnapshots`) and assert no unexpected writes.
- Fixtures live under `fixtures/` with fake values only; leak-check rejects real credentials, home paths and credential-shaped files elsewhere.
- Do not run `sideby doctor --fix`, `new`, `login` or `quota setup` against the real HOME. Real-host checks are read-only: `list`, `doctor` without `--fix`, `quota`. For anything else, use a demo HOME (`scripts/demo-home.ts`).

## Change process

1. Behaviour or contract change: update the spec in `docs/specs/` first. A new decision, or reversing one, gets an ADR in `docs/adr/`. Then change code and tests.
2. Keep `README.md` and `README.zh-CN.md` in sync, and each `docs/guide/<page>.md` with its `<page>.zh-CN.md`, with the same terms (`CONTEXT.md`). The README stays a short landing page (pitch, quick start, hosts, links); details go in `docs/guide/`.
3. If `--json` output or config changed, run `pnpm schemas` and update `llms.txt`.
4. A new or changed feature, whichever side it starts from: add or update its Panel place, its CLI command and the matching part of `skills/sideby/` (SKILL.md routing and the reference file), and an example phrase in the Panel's "Ask your AI" list when it is a common task.
5. Run `pnpm check` and `pnpm build`.

### Adding a family

Follow `docs/agents/adding-a-family.md`.

## Commits and releases

- Commit messages: emoji + Conventional Commits, for example `✨ feat(codex): read quota from rollout files`. `changelogithub` builds release notes from them.
- Never run `npm publish` by hand. The only exception is the one-time first publish described in `docs/release.md`.
- Releases go through tags only, with `pnpm release <patch|minor>` (`scripts/release.ts`): it runs `npm version <patch|minor> -m "🔖 chore(release): v%s"` and `git push --follow-tags`, waits until the registry serves the version, then runs `pnpm local --off` when a Local Build was live, so the maintainer is back on the published package. `.github/workflows/release.yml` publishes with npm trusted publishing and provenance. Wait for CI on `main` to be green before releasing; a release run that fails on a test publishes nothing.
- Never add a long-lived npm token, never use `pull_request_target`, and keep every action pinned to a full commit SHA with the version in a trailing comment.
- Roll back with `npm deprecate`, never `npm unpublish`.
- Do not push, tag or create releases unless the maintainer asks.
