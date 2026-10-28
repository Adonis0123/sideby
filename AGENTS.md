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
| Check publish contents | `npm pack --dry-run` (no `.ts` sources except `.d.ts`) |
| Claude mod tests (not in `pnpm check`: they need Claude Code 2.1.287+) | `claude plugin test mods/claude` and `claude plugin validate mods/claude` |
| Demo HOME for manual testing | `node scripts/demo-home.ts <dir> [normal\|empty\|error\|slow]` |
| README media and copy that may be stale | `node scripts/readme-assets.ts` (then the `readme-assets` skill) |

Tests run the `.ts` sources directly with Node 22.18+; no build is needed. Run `pnpm check` before you hand work back, then `pnpm local` so the maintainer sees the change in the Panel and CLI they already use (it switches only a build that compiles and starts; say so if it failed).

### Demo HOME

`scripts/demo-home.ts` builds a throwaway HOME with fake accounts (claude main, work and a DeepSeek API account; codex main and team; grok main and lab with one fixable Finding; pi main), fake Host binaries, usage records and cached quota. Use it to retake the README screenshots and to try the CLI or the Panel by hand without touching the real HOME:

```sh
node scripts/demo-home.ts /tmp/sideby-demo normal      # or empty | error | slow
HOME=/tmp/sideby-demo/home XDG_CONFIG_HOME=/tmp/sideby-demo/home/.config \
  XDG_STATE_HOME=/tmp/sideby-demo/home/.local/state PATH=/tmp/sideby-demo/bin:$PATH node src/cli/main.ts ui
```

`empty` has Host binaries but no accounts; `error` and `slow` add a local plugin Family whose reader fails or answers after 6 s, for the Panel's error and loading states. The script recreates `<dir>`, and refuses a non-empty directory it did not create (it leaves a `.sideby-demo` marker). Set the XDG variables too, or a shell that already exports them would point the Panel at your real config and state. When the maintainer asks to update the README, in any words, follow `.claude/skills/readme-assets/SKILL.md`: it covers the copy and all media, not only the text. README media (Panel screenshots, menu bar pictures, demo GIF, banner, intro video) and the code each depends on are listed in `docs/assets/manifest.json`. `node scripts/readme-assets.ts` lists what may be stale since its last retake, and also `feat` commits since the README last changed; `npm version` runs it as `preversion` and only warns. The `readme-assets` skill (`.claude/skills/readme-assets/SKILL.md`) acts on that list: it retakes the screenshots (`node scripts/shoot-panel.ts`, light and dark, English and Chinese, 1280×860 from the `normal` variant) and the menu bar pictures (`node scripts/shoot-menubar.ts`, macOS: it opens the real menu with demo data over a plain backdrop) and the GIF (`node scripts/record-demo.ts`, a [Motion](https://motion.dev) scene in `docs/assets/demo.html` filled with real `sideby run` output, a Panel screenshot and a real Auto Handoff; needs ffmpeg, gifsicle and Chrome; `--frames 2,8` for a quick look; under 4 MB or GitHub may not show it) without asking, drafts copy changes, and asks before each paid retake of the banner (Codex image generation) or the intro video (`painted-animation`). Keep each README's `<picture>` block pointing at its own pair of screenshots. When a listed change does not affect a medium, `node scripts/readme-assets.ts --mark <id>` records that. The fixture Host is `scripts/demo-host.sh`; it is not Claude Code.

## Map

```
src/
├── cli/          argument parsing and subcommands; I/O only, no business logic
├── core/         paths, config, account discovery, Secret File, Share Modes, doctor, create, launch, atomic writes;
│                 handoff.ts ranks Accounts for `sideby next` (Quota Pressure in quota-levels.ts);
│                 handoff-select.ts, handoff-run.ts, handoff-chain.ts, handoff-brief.ts, handoff-doctor.ts: Auto Handoff (§3.17)
│                 tuning.ts: the pure replay that estimates a Compaction Threshold (§3.18); the per-Family readers are families/<id>/tuning.ts
│                 skill-check.ts compares an installed sideby skill with this version
│                 share-meaning.ts: the one-line meaning of each Shared Item that `sideby families` prints
│                 quota-fetch.ts and quota-store.ts: when a Family's `fetchQuota` is asked, and its kept answers (§3.26)
│                 update.ts: Update Check, Update Notice, Install Method, `sideby update` and Auto Update (§3.23)
│                 run-link.ts: the Run a Live Session works for, from an orchestrator's Session Index (§3.32 step 2b)
│                 session-select.ts: which Live Session a target names, for `sessions copy`, `sessions open-run` and `send`
│                 desktop-app.ts: `sideby desktop`, open a Family's Desktop App per Account (§3.20); definitions in families/desktop.ts (internal)
├── plugins/      loader (trust checks), hook bus, built-in account-script
│                 browser-profiles.ts: `sideby browser`, Browser Sign-ins from Chrome's Local Storage key names (§3.24); leveldb-keys.ts reads them; websites in families/browser.ts (internal)
├── families/     claude, codex, grok, pi, agy: each a Family Plugin; index.ts lists built-ins in load order
│                 agy/ is a Main-only Family (ADR-0047); agy/quota.ts asks `agy -p /usage` for its Quota (ADR-0048)
│                 logos.ts holds the built-in marks each FamilyDef sets as `logo`
│                 claude/ reads quota from the tap cache and usage from projects/**/*.jsonl;
│                 codex/rollout.ts reads quota and usage from sessions/**/rollout-*.jsonl;
│                 grok/quota.ts asks the grok CLI for its Quota, grok/quota-log.ts reads the Quota Grok logs (ADR-0025);
│                 identity readers pick only email/organization from login files (core/identity.ts);
│                 readers remember each file's parse until it changes (core/file-memo.ts)
├── quota/        `quota setup|teardown claude` and the `statusline-tap` entry (thin; cache logic in families/claude/quota-cache.ts)
├── handoff/      the `handoff-hook` entry (leaf imports only), its messages and the per-Host reader contract;
│                 each Family's reader is families/<id>/handoff-hook.ts, its `handoff` member families/<id>/handoff.ts
├── panel/        createPanelHandler, the standalone server, the inline page and theme.ts (host theme tokens);
│                 page-logic.ts suggestName/suggestAlias also pick the name and short command for `new --next`
│                 background.ts runs the server detached (`ui --background`, `--stop`)
├── desktop/      `sideby app install|uninstall`: macOS app bundle, Linux .desktop entry, icon drawn in pure Node
├── runtime.ts    createRuntime(): shared services for CLI and panel
├── types.ts      public plugin contract (Plugin, PluginApi, FamilyDef, Finding, ...)
└── index.ts      library entry: createPanelHandler and plugin types
testing/          fake HOME, fake Host binaries, snapshots; also published as `sideby/testing`
schemas/          generated JSON Schemas for config and every `--json` output
skills/sideby/    Agent Skill shipped in the package: SKILL.md routes to references/*.md; metadata.version = package version
scripts/          local.ts (`pnpm local`, Local Build, ADR-0024), release.ts (`pnpm release`), leak-check.sh, demo-home.ts, record-demo.ts (README demo GIF; demo-mark.ts writes its outro mark from brand-mark.ts), shoot-panel.ts (README screenshots), chrome.ts (shared by both), readme-assets.ts (run by `preversion`; manifest.ts formats what its `--mark` writes), sync-skill-version.ts (run by `npm version`), write-build-id.ts (run by `pnpm build`), pin-english-npm-readme.ts (run by `prepublishOnly`, so the npm readme is README.md)
docs/             adr/, specs/, plans/, verification/, guide/ (user guide, English and .zh-CN.md), assets/ (README banner and screenshots), release.md
```

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
- Never read a credential to call a model, pool logins, or rotate accounts on its own (ADR-0001; Auto Handoff is opt-in, ADR-0010). Never call private quota endpoints (ADR-0003). Built-in quota and usage readers make no network requests. The one exception is a Host's own CLI asked for its Quota without a session (Grok: `grok agent --no-leader stdio` and `_x.ai/billing`, ADR-0025; Codex: `codex app-server` and `account/rateLimits/read`, ADR-0038; Antigravity CLI: `agy -p /usage --output-format json`, which starts no model turn, ADR-0048; `core/quota-fetch.ts`): the Host sends the request with its own login, sideby reads no credential for it, asks at most every `everyMinutes` per Account (never from `statusline-tap` or `handoff-hook`), keeps only numbers, reset times and the plan name, and stays off under config `quota.check.<family>: false` and in CI. Only the `billing: fetched credits config` lines of Grok's `logs/unified.jsonl` are parsed, and only their Quota fields kept; the file's other lines hold the user id and a token's end. The Update Check (ADR-0021, `core/update.ts`) is one of sideby's two requests of its own: one GET of the `latest` dist-tag, at most daily, carrying no Account, path or identity; it stays off under `NO_UPDATE_NOTIFIER`, `SIDEBY_NO_UPDATE_NOTIFIER`, config `update.check: false` and CI, and `withFakeHome` sets `SIDEBY_NO_UPDATE_NOTIFIER` so tests never make it. Auto Update stays opt-in (config `update.auto`). Network Guard (ADR-0053, `core/egress.ts`, `core/network.ts`) is the other request of its own, only while config `network.guard` is on and not in CI: one GET of the vendor's own `/cdn-cgi/trace` (`api.anthropic.com`, `chatgpt.com`, `api.openai.com`) through the Account's proxy variables, carrying no credential, Account or identity; it keeps only the country and a SHA-256 of the address, never the address or the proxy URL, and tests replace it through `createRuntime`'s internal `network` option.

**Host directories**

- sideby writes none of its own files into a Host account directory. The exceptions are `quota setup claude --yes`, which wraps the main `settings.json` status line as `sideby statusline-tap --orig-b64 <base64>`, and `handoff setup grok --yes`, which adds `~/.grok/hooks/sideby-handoff.json` (ADR-0010). `teardown` restores the file byte for byte (removes the hook file and a hooks directory it emptied), only while the file still matches what setup wrote. The Panel's Auto Handoff page (ADR-0013) runs these same setups, plus a copy of that one hook file (only where it is missing) into the other accounts of the Family, as one plan the user confirms; it adds no other write. Setup refuses when `sideby` is not on PATH or comes from the npx cache, because the Host runs it by name.
- `network-hook` (spec §3.35) runs before every prompt and tool call in a session sideby started with Network Guard on. It imports only Node built-ins, `core/egress.ts` and `core/fs-safe.ts` (`src/network/hook.test.ts` walks its imports), and reads its settings from the session's environment only. Unlike `handoff-hook` it blocks: exit 2 with the reason when the country is not allowed or cannot be told, including when the check itself fails. It is injected only into sessions sideby starts (Claude `--settings`, merged with Auto Handoff's into one file; Codex `-c hooks.*`), by absolute path to this Node and this sideby, and nothing of it is written into a Host directory.
- `handoff-hook` (spec §3.17) runs on every tool call while Auto Handoff is on. Its imports follow the same rule as `statusline-tap`, and `src/handoff/hook.test.ts` walks its import graph to keep it so. It does nothing without `SIDEBY_HANDOFF_RUN` or for another Family's hook, never fails the Host (any problem: no output, exit 0), and a `StopFailure` counts only for a used-up Quota. Measured cold start (median of 21): about 40 ms from `dist`.
- `statusline-tap` runs on every status line refresh. It may import only Node built-ins and leaf modules: `families/claude/quota-cache.ts`, `families/claude/layout.ts`, `core/account-name.ts`, `core/fs-safe.ts`, `core/paths.ts`. Never import `runtime.ts`, a Family index or `core/accounts.ts` from it. It must never change what the original command receives, prints or returns. Measured cold start (median of 21): about 40 ms from `dist`, 71–79 ms from source.
- `sideby tune` and the Panel's context tuning (spec §3.18, ADR-0011) analyse read-only. The only Host config value they read is the auto-compact size: `autoCompactWindow` in Claude's `settings.json` (top level, and the numbers under `modelSettings`, where `/autocompact` saves a size per model) and `model_auto_compact_token_limit` in Codex's `config.toml`. No other value of those files may reach an output, an error or a cache, and the tests assert it. Codex gets observations only until its default threshold has a first-hand source.
- Auto Handoff's wait rule (ADR-0018) reads only `autoContinueAtUsageLimit` of Claude's `settings.json`, to tell whether a session continues by itself at the reset; nothing else of the file reaches an output.
- The model and effort shown per Account (spec §3.19, ADR-0014) read only `model`, `effortLevel` and `modelSettings.<model>.effortLevel` of Claude's `settings.json`, the top-level `model` and `model_reasoning_effort` of Codex's `config.toml`, and the `model` and `effort` of the newest session record. Changing them (`sideby model`, the Panel dialog) edits only the model and effort arguments in sideby's config `accounts.<ref>.args`, after a preview; it never writes a Host file.
- `sideby tune apply` / `undo` and the Panel's "Use" button (ADR-0012) are the third exception to "sideby writes nothing into a Host directory": they write only the top-level `autoCompactWindow` (100000 to 1000000, the range Claude Code accepts) of an Account's `settings.json`, only after a preview the user confirms, through `writeIfUnchanged`, keeping every other key; a symlinked file is written at its real target with the affected Accounts named, never replaced or retargeted. `undo` restores the old value only while the key still holds what was written.
- `sideby remote-control off` / `on` / `undo`, the Panel's "Turn all off" banner and its Remote Control switch (spec §3.22, ADR-0017) are the fourth exception: they write only the top-level `remoteControlAtStartup`, to `false` (`off`) where it is `true` or not set, or to `true` (`on`) where it is `false` or not set, of each Claude settings file, under the same rules as `tune apply` (preview first, `writeIfUnchanged`, every other key kept, links written at their real target and never created or retargeted). They never create a `settings.json`, never write `disableRemoteControl`, never touch `~/.claude.json`, and never turn it on unless the user asks; `undo` restores the old value only while the key still holds what sideby wrote.
- `sideby messages inbound accept` / `undo` (spec §3.32 step 2, ADR-0040) are the fifth exception: they write only the top-level `crossSessionInbound`, to `"accept"` where it is not set or `"hold"`, of each Claude settings file, under the same rules as `remote-control off` (preview first, `writeIfUnchanged`, every other key kept, links written at their real target and never created or retargeted, no `settings.json` created). They never change `"refuse"` or any other value: each is reported with its reason, and a run that changes nothing says so and exits 1. Undo records whether the key was there and its exact old value, and restores it only while the key still holds what sideby wrote. Doctor's `messages.inbound-held` warning reads only `crossSessionInbound` and `permissions.defaultMode` and is never fixed by `--fix`.
- `sideby send` (spec §3.32 step 2, ADR-0040) keeps every Message in sideby's state folder before any delivery, in folders under `<state>/messages` it checks one at a time (a real folder of the user, not a link, not writable by others; never `.`, `..` or a name with a separator), copies each screenshot from the file it checked (opened without following a link, read up to the 20 MB limit, its type told again from the copied bytes), and once the Message is kept turns any failure into a paste; and writes into a Host only through a Claude Code message socket: the path named by the session's own `sessions/<pid>.json` whose `sessionId` and `procStart` match the running process, in a `cc-socks` folder right inside a system temp folder, that folder a real folder of the current user others cannot enter, the socket a socket of the current user and not a link. Right before connecting it reads the session record and the processes again; after connecting and before writing it checks that the socket and its folder are still the same files (device, inode, owner). It writes one line and closes the connection once it is flushed, sends no token, and never opens a `<pid>.<hash>.key` file or reads `CLAUDE_CODE_MESSAGING_TOKEN`. Of a transcript it reads only the last 256 KB, and of that only the lines with a Message id or a `permission-mode` record. It never resumes, copies or starts a session to deliver. To a Codex session (step 4) it only runs `codex queue --thread <session id> --message <paste line>` with that Account's launch environment, never the Message text on the command line, ends only that process on its 20 s timeout and reads none of its output.
- `sideby desktop` and the Panel's "Open desktop app" (spec §3.20, ADR-0015) start the unchanged app with `/usr/bin/open` only: never copy, modify or re-sign the `.app`, never end a process (an Account's running window is only brought to the front), and never write into a Host account directory. They write only the Account's App Data under `~/Library/Application Support/sideby/<family>/<name>/` (mode 700) and, in a new one, a link to the Main Account's `claude_desktop_config.json` where nothing is. Every program they run goes through `DesktopDeps.exec` in `core/desktop-app.ts`; tests replace it through `createRuntime`'s internal `desktop` option and never start a real app.
- The Run Link (spec §3.32 step 2b, ADR-0041, `core/run-link.ts`) reads an orchestrator's Session Index (`<state>/session-index.json`, at most 256 KB, not a link, `schemaVersion` 1) and makes no request. It shows or opens a Run Board only when the board is a regular `.html` file of the current user, not a link, right inside `<state>/boards` (itself a real folder of the user), and the entry's `url` is exactly `file://<board>` with an optional `#lane-<id>`. Opening runs `/usr/bin/open <board>` (xdg-open on Linux) through `DesktopDeps.exec`, with the path found again from the index for the Session id the page sends, never a path from the page, after checking the board and its folder once more (not links, owner, device and inode unchanged) right before the program starts; a read-only Panel refuses it.
- Session History (spec §3.33, ADR-0042, `core/history*.ts`, `families/<id>/history.ts`) reads the Hosts' session records read-only and never a credential file. The History Index (`<state>/history/index.sqlite`, folder 700, file 600) keeps only the fields §3.33 lists and the text of typed prompts and model replies: never tool calls or output, injected context, reasoning, or Codex's `session_meta` account ids and instructions; tests assert it. Config `history.index: false` stops it and deletes the file. Searching tool output reads the records at that moment and keeps nothing.
- Quota warning levels and the Usage window live in `core/quota-levels.ts`; the CLI and the Panel page both use them.
- `sideby browser` and the Panel's "Open in browser" (spec §3.24, ADR-0023) read nothing of a browser until config `browser.signIns` is true. Then they read only Chrome's `Local State` (each profile's folder, `name`, and `user_name` when it is an email: the Google account the profile uses in Chrome) and the Local Storage key names of claude.ai and chatgpt.com: a value is never decoded, kept or compared, and `Cookies`, `Login Data`, IndexedDB and the Keychain are never opened. Nothing of Chrome is written, locked or copied, and no request is made. The Host-side ids they compare (Claude's `oauthAccount.accountUuid`, Codex's `id_token` claim `chatgpt_user_id` or `user_id`, Grok's `auth.json` `user_id`, and the id a plugin Family's `website.match.signInId` returns) never reach an output, an error, a log or a cache; tests assert it. Opening runs `/usr/bin/open -na <Chrome.app> --args --profile-directory=<dir> <url>` through `DesktopDeps.exec`, only for a folder `Local State` lists.
- `sideby shell-init setup --yes` and the Panel's "Add the line" (ADR-0036) are the only writes to a shell rc file: they append one marked block (`eval "$(sideby shell-init <shell>)"`) to `~/.zshrc` or `~/.bashrc` after showing it, only when no line there names `sideby shell-init` and no `shellInitFile` is set; a linked file is written at its real target; `--undo` removes only that exact block.
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
- Exit code 10 means a change was shown and waits for `--yes` (`quota setup`, `handoff setup`, `update`, `browser --enable|--disable` and `network on|off|allow`). Doctor never uses it: it exits 1 only for `fail` Findings.

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

1. Confirm the Host supports an isolated config directory through an environment variable, and record the tested version. A Host without one can still be added as a Main-only Family (`mainOnly: true`, no `selectVar` and no `layout.account`; ADR-0047): sideby then knows only its Main Account and refuses `new` for it. Write the family row in spec §3.4 (Hijack Variables, Shared Items with Share Modes, sign-in command, login-state rule that reads no credential values).
2. Create `src/families/<id>/index.ts` exporting a `Plugin` that calls `api.family(def)` with a `FamilyDef` from `src/types.ts`. Add its mark to `src/families/logos.ts` (one 24x24 SVG path with its source and license) and set it as `logo`.
3. Add it to `BUILTIN_PLUGINS` in `src/families/index.ts`.
4. Add `src/families/<id>/index.test.ts` with a fake HOME and a fake Host binary: discovery, launch env, every Shared Item's check and fix.
5. Quota or usage only from local files or official CLI output (ADR-0003); otherwise leave `readQuota` and `readUsage` out so the panel shows "no public source". sideby reads usage itself; do not add a dependency such as ccusage.
6. Update the supported hosts tables in both READMEs, the Host notes and the "What each account shares" table in `docs/guide/usage*.md` (check it against `sideby families <id>`), the shared-items line in `llms.txt`, and `skills/sideby/SKILL.md`.

## Commits and releases

- Commit messages: emoji + Conventional Commits, for example `✨ feat(codex): read quota from rollout files`. `changelogithub` builds release notes from them.
- Never run `npm publish` by hand. The only exception is the one-time first publish described in `docs/release.md`.
- Releases go through tags only, with `pnpm release <patch|minor>` (`scripts/release.ts`): it runs `npm version <patch|minor> -m "🔖 chore(release): v%s"` and `git push --follow-tags`, waits until the registry serves the version, then runs `pnpm local --off` when a Local Build was live, so the maintainer is back on the published package. `.github/workflows/release.yml` publishes with npm trusted publishing and provenance. Wait for CI on `main` to be green before releasing; a release run that fails on a test publishes nothing.
- Never add a long-lived npm token, never use `pull_request_target`, and keep every action pinned to a full commit SHA with the version in a trailing comment.
- Roll back with `npm deprecate`, never `npm unpublish`.
- Do not push, tag or create releases unless the maintainer asks.
