# Map

Where each part of the code lives. Linked from `AGENTS.md` ("Read when"); the public contract files are listed there.

```
src/
├── cli/          argument parsing and subcommands; I/O only, no business logic
├── core/         paths, config, account discovery, Secret File, Share Modes, doctor, create, launch, atomic writes;
│                 handoff.ts ranks Accounts for `sideby next` (Quota Pressure in quota-levels.ts);
│                 handoff-select.ts, handoff-run.ts, handoff-chain.ts, handoff-brief.ts, handoff-doctor.ts: Auto Handoff (§3.17)
│                 tuning.ts: the pure replay that estimates a Compaction Threshold (§3.18); the per-Family readers are families/<id>/tuning.ts
│                 skill-check.ts compares an installed sideby skill with this version
│                 share-meaning.ts: the one-line meaning of each Shared Item that `sideby families` prints
│                 quota-fetch.ts and quota-store.ts: when a Family's `fetchQuota` is asked (age, a passed reset time, one ask per
│                 Account across processes, four on the machine), and its kept answers (§3.26);
│                 quota-levels.ts: warning levels, how old each Quota window is (`windowAge`, ADR-0073) and when "use a reset" is a
│                 visible button (`limitResetOffer`), for the CLI, Panel and menu
│                 limit-reset.ts: the operation records and the per-login lock of using a Limit Reset (§3.40, ADR-0072); the flow
│                 itself is `limitResetPlan` and `limitResetUse` in runtime.ts
│                 update.ts: Update Check, Update Notice, Install Method, `sideby update` and Auto Update (§3.23)
│                 run-link.ts: the Run a Live Session works for, from an orchestrator's Session Index (§3.32 step 2b)
│                 session-select.ts: which Live Session a target names, for `sessions copy`, `sessions open-run` and `send`
│                 desktop-app.ts: `sideby desktop`, open a Family's Desktop App per Account (§3.20); definitions in families/desktop.ts (internal)
│                 browser-profiles.ts: `sideby browser`, Browser Sign-ins from Chrome's Local Storage key names (§3.24); leveldb-keys.ts reads them; websites in families/browser.ts (internal)
│                 claude-trust.ts: carried trust between Claude Accounts (§3.43, ADR-0078): which key trusts a folder, the one-field copy at Launch (`carryAtLaunch` in runtime.ts), its records and `sideby trust undo`
│                 claude-memory.ts: Shared Project Memory (§3.44, ADR-0081): the Main Account's memory folder of a Project for
│                 a Launch (`memoryPrepared` in runtime.ts puts it into sideby's `--settings`), Doctor's fold of an Account's
│                 own memory, the index and folder-name warnings, `sideby memory`
├── plugins/      loader (trust checks), hook bus, built-in account-script
├── families/     claude, codex, grok, pi, agy: each a Family Plugin; index.ts lists built-ins in load order
│                 agy/ is a Main-only Family (ADR-0047); agy/quota.ts asks `agy -p /usage` for its Quota (ADR-0048)
│                 logos.ts holds the built-in marks each FamilyDef sets as `logo`
│                 claude/ reads quota from the tap cache and asks `claude -p /usage` for it (quota-fetch.ts, ADR-0063), usage from projects/**/*.jsonl;
│                 codex/rollout.ts reads quota and usage from sessions/**/rollout-*.jsonl;
│                 grok/quota.ts asks the grok CLI for its Quota, grok/quota-log.ts reads the Quota Grok logs (ADR-0025);
│                 identity readers pick only email/organization from login files (core/identity.ts);
│                 readers remember each file's parse until it changes (core/file-memo.ts)
├── quota/        `quota setup|teardown claude` and the `statusline-tap` entry (thin; cache logic in families/claude/quota-cache.ts)
├── handoff/      the `handoff-hook` entry (leaf imports only), its messages and the per-Host reader contract;
│                 each Family's reader is families/<id>/handoff-hook.ts, its `handoff` member families/<id>/handoff.ts
├── unattended/   the `unattended-hook` entry (leaf imports only); Unattended Mode's state from the Schedule and the manual state (core/unattended-state.ts), its CLI and Panel operations (core/unattended.ts), the end-of-stretch event (core/unattended-ended.ts) the Pending Decision store (core/unattended-pending.ts), Turn Retry (core/unattended-retry.ts, ADR-0067), Answer Wait (core/unattended-wait.ts, ADR-0077: watching a question on screen through the Host's session record) and Pending Decisions by Project with the user's later replies (core/unattended-followup.ts, ADR-0078: read from the session's record with Session History's reader); the hook answers ask tools and Claude Code's permission requests, starts a failed Claude turn again, and lets a question nobody answers go on after the wait (§3.37)
├── progress/     the `progress-hook` entry (leaf imports only): Progress Reminders while a Claude session waits on background work
│                 (§3.42, ADR-0076); its records are core/progress-state.ts, the hook part, CLI and Panel operations core/progress.ts
├── network/      the `network-hook` entry (leaf imports only) for Network Guard (§3.35, ADR-0053): exit 2 blocks a prompt or tool call; the egress check is core/egress.ts and core/network.ts
├── panel/        createPanelHandler, the standalone server, the inline page and theme.ts (host theme tokens);
│                 page-logic.ts suggestName/suggestAlias also pick the name and short command for `new --next`
│                 background.ts runs the server detached (`ui --background`, `--stop`)
│                 changes.ts: the change feed (`GET /api/changes`, §3.45, ADR-0084) that watches Quota files while a page asks;
│                 the folders of each Family are in families/quota-watch.ts (internal)
├── desktop/      `sideby app install|uninstall`: macOS app bundle, Linux .desktop entry, icon composited in pure Node
├── menubar/      the Menu Bar Item (§3.31, ADR-0034): script.ts is the JXA `osascript` runs, agent.ts its LaunchAgent, snapshot.ts what it shows
│                 (`menubar snapshot --json`), hotkey.ts its shortcut, strings.ts its words in English and Chinese
├── runtime.ts    createRuntime(): shared services for CLI and panel
├── types.ts      public plugin contract (Plugin, PluginApi, FamilyDef, Finding, ...)
└── index.ts      library entry: createPanelHandler, startPanelServer, createRuntime and plugin types
testing/          fake HOME, fake Host binaries, snapshots; also published as `sideby/testing`
schemas/          generated JSON Schemas for config and every `--json` output
skills/sideby/    Agent Skill shipped in the package: SKILL.md routes to references/*.md; metadata.version = package version
mods/claude/      Claude Code mod `sideby run` loads with `--plugin-dir` (§3.32 step 3, ADR-0039): Session Label band, Message toast,
                  `/sessions` pane; hooks/register.js, tested with `claude plugin test mods/claude`
scripts/          local.ts (`pnpm local`, Local Build, ADR-0024), release.ts (`pnpm release`), leak-check.sh, demo-home.ts, record-demo.ts (README demo GIF; demo-mark.ts writes its outro mark from brand-mark.ts), shoot-panel.ts (README screenshots), chrome.ts (shared by both), readme-assets.ts (run by `preversion`; manifest.ts formats what its `--mark` writes), sync-skill-version.ts (run by `npm version`), write-build-id.ts (run by `pnpm build`), pin-english-npm-readme.ts (run by `prepublishOnly`, so the npm readme is README.md), design-system.ts (`pnpm design-system`: the Design System's files from the code, into `design-system/dist/`)
assets/brand/     the painted mark (Sai, ADR-0064) as PNGs, shipped in the package; core/brand-mark.ts reads them
docs/             adr/, specs/, plans/, verification/, guide/ (user guide, English and .zh-CN.md), assets/ (README banner and screenshots), release.md
```
