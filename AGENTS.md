# AGENTS.md

Rules for AI agents maintaining sideby. Terms are defined in `CONTEXT.md`; decisions in `docs/adr/`; the current design in `docs/specs/`. Specs and plans are in Chinese, everything public is in English.

## Commands

| Task | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Full gate (typecheck, biome, tests, leak-check) | `pnpm check` |
| All tests | `pnpm test` |
| One test file | `node --test src/core/share-modes.test.ts` |
| Format and auto-fix | `pnpm format` |
| Build `dist/` | `pnpm build` |
| Regenerate JSON Schemas | `pnpm schemas` (commit the result; CI fails if `schemas/` is stale) |
| Check publish contents | `npm pack --dry-run` (no `.ts` sources except `.d.ts`) |
| Demo HOME for manual testing | `node scripts/demo-home.ts <dir> [normal\|empty\|error\|slow]` |

Tests run the `.ts` sources directly with Node 22.18+; no build is needed. Run `pnpm check` before you hand work back.

### Demo HOME

`scripts/demo-home.ts` builds a throwaway HOME with fake accounts (claude main, work and a DeepSeek API account; codex main and team; grok main and lab with one fixable Finding; pi main), fake Host binaries, usage records and cached quota. Use it to retake the README screenshots and to try the CLI or the Panel by hand without touching the real HOME:

```sh
node scripts/demo-home.ts /tmp/sideby-demo normal      # or empty | error | slow
HOME=/tmp/sideby-demo/home XDG_CONFIG_HOME=/tmp/sideby-demo/home/.config \
  XDG_STATE_HOME=/tmp/sideby-demo/home/.local/state PATH=/tmp/sideby-demo/bin:$PATH node src/cli/main.ts ui
```

`empty` has Host binaries but no accounts; `error` and `slow` add a local plugin Family whose reader fails or answers after 6 s, for the Panel's error and loading states. The script recreates `<dir>`, and refuses a non-empty directory it did not create (it leaves a `.sideby-demo` marker). Set the XDG variables too, or a shell that already exports them would point the Panel at your real config and state. README screenshots live in `docs/assets/panel.png` (light) and `docs/assets/panel-dark.png` (dark); both are 1280×860. Retake them from the `normal` variant, once with the system in light mode and once in dark mode. Keep the `<picture>` block in both READMEs pointing at them. The terminal demo `docs/assets/demo.gif` is recorded with [VHS](https://github.com/charmbracelet/vhs) from `docs/assets/demo.tape` (steps in its header); retake it when the output of `list`, `quota`, `next` or `doctor` changes. `docs/assets/banner.jpg` is an illustration; keep any command shown in it valid.

## Map

```
src/
├── cli/          argument parsing and subcommands; I/O only, no business logic
├── core/         paths, config, account discovery, Secret File, Share Modes, doctor, create, launch, atomic writes;
│                 handoff.ts ranks Accounts for `sideby next` (Quota Pressure in quota-levels.ts);
│                 skill-check.ts compares an installed sideby skill with this version
│                 share-meaning.ts: the one-line meaning of each Shared Item that `sideby families` prints
├── plugins/      loader (trust checks), hook bus, built-in account-script
├── families/     claude, codex, grok, pi: each a Family Plugin; index.ts lists built-ins in load order
│                 logos.ts holds the built-in marks each FamilyDef sets as `logo`
│                 claude/ reads quota from the tap cache and usage from projects/**/*.jsonl;
│                 codex/rollout.ts reads quota and usage from sessions/**/rollout-*.jsonl;
│                 identity readers pick only email/organization from login files (core/identity.ts);
│                 readers remember each file's parse until it changes (core/file-memo.ts)
├── quota/        `quota setup|teardown claude` and the `statusline-tap` entry (thin; cache logic in families/claude/quota-cache.ts)
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
scripts/          leak-check.sh, demo-home.ts, sync-skill-version.ts (run by `npm version`), write-build-id.ts (run by `pnpm build`)
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

- Never print, log, return, or put in an error message the value of anything from `proxy.env`, `auth.json` or `.claude.json`. Errors name the path or the variable, and for parse errors the line number only. The values shown are a Claude API Account's `ANTHROPIC_MODEL`, as its model, and the identity fields a Family's `identity` reader picks (email, organization; ADR-0003). Never a token: Codex's `id_token` is decoded only to take its `email` claim, and is never stored or returned.
- Doctor checks credential files for type and mode 600 only. The only content it reads is the single key a `json-key` item names. `proxy.env` is parsed only at Launch and for that model name.
- Never read a credential to call a model, pool logins, or rotate accounts (ADR-0001). Never call private quota endpoints (ADR-0003). Built-in quota and usage readers make no network requests.

**Host directories**

- sideby writes none of its own files into a Host account directory. The only exception is `quota setup claude --yes`, which wraps the main `settings.json` status line as `sideby statusline-tap --orig-b64 <base64>`; `teardown` restores it byte for byte, only while the file hash still matches what setup wrote. Setup refuses when `sideby` is not on PATH or comes from the npx cache, because Claude Code runs the wrapper on every refresh.
- `statusline-tap` runs on every status line refresh. It may import only Node built-ins and leaf modules: `families/claude/quota-cache.ts`, `families/claude/layout.ts`, `core/account-name.ts`, `core/fs-safe.ts`, `core/paths.ts`. Never import `runtime.ts`, a Family index or `core/accounts.ts` from it. It must never change what the original command receives, prints or returns. Measured cold start (median of 21): about 40 ms from `dist`, 71–79 ms from source.
- Quota warning levels and the Usage window live in `core/quota-levels.ts`; the CLI and the Panel page both use them.
- Fixes write only inside the account being fixed, through the atomic writer (temp file in the same directory, mode 600, rename). Credential files end at mode 600.
- `launch` never changes the parent shell environment, never adds dangerous flags by default, and clears Hijack Variables for every account.
- `sideby next` (Handoff, spec §3.13) only ranks local Quota and starts its pick exactly as `run` would. It starts nothing when nothing can be picked, nor when no signed-in Subscription Account of the Family has Quota data (`hasQuota: false`, the pick would be a guess), and never copies sessions between Accounts.

**Plugins**

- A plugin is local code with the user's full permissions. Docs, `sideby plugins` output and errors must keep saying so.
- Plugins may only `import type` from `sideby`. Never add an API that requires a plugin to import a value from sideby; pass it through `PluginApi`.
- Loader trust checks (owner is the current user, not group or other writable) stay on for plugin directories, `plugin.json`, entry files and `sideby-before-launch`.
- Hook errors carry the plugin name. A failing plugin affects only itself, except that a failing `launch.before` stops the launch and a failing `account.create.before` stops `new` before anything is written.

**Panel**

- The Panel's CSP (`frame-ancestors 'self'` included) and its Host, Origin (`http://<Host>`) and token checks are never loosened, also not to suit a Portal (ADR-0006).

**Output contract**

- Every `--json` output has `schemaVersion: 1`. A `--json` error is `{ schemaVersion, error, code }`; `error` stays a string. Adding a field keeps the version; removing, renaming or changing meaning bumps it and needs an ADR.
- Every user-facing error says what to do next.
- Exit code 10 means a change was shown and waits for `--yes` (only `quota setup` today). Doctor never uses it: it exits 1 only for `fail` Findings.

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
4. Run `pnpm check` and `pnpm build`.

### Adding a family

1. Confirm the Host supports an isolated config directory through an environment variable, and record the tested version. Write the family row in spec §3.4 (Hijack Variables, Shared Items with Share Modes, sign-in command, login-state rule that reads no credential values).
2. Create `src/families/<id>/index.ts` exporting a `Plugin` that calls `api.family(def)` with a `FamilyDef` from `src/types.ts`. Add its mark to `src/families/logos.ts` (one 24x24 SVG path with its source and license) and set it as `logo`.
3. Add it to `BUILTIN_PLUGINS` in `src/families/index.ts`.
4. Add `src/families/<id>/index.test.ts` with a fake HOME and a fake Host binary: discovery, launch env, every Shared Item's check and fix.
5. Quota or usage only from local files or official CLI output (ADR-0003); otherwise leave `readQuota` and `readUsage` out so the panel shows "no public source". sideby reads usage itself; do not add a dependency such as ccusage.
6. Update the supported hosts tables in both READMEs, the Host notes and the "What each account shares" table in `docs/guide/usage*.md` (check it against `sideby families <id>`), the shared-items line in `llms.txt`, and `skills/sideby/SKILL.md`.

## Commits and releases

- Commit messages: emoji + Conventional Commits, for example `✨ feat(codex): read quota from rollout files`. `changelogithub` builds release notes from them.
- Never run `npm publish` by hand. The only exception is the one-time first publish described in `docs/release.md`.
- Releases go through tags only: `npm version <patch|minor> -m "🔖 chore(release): v%s"`, then `git push --follow-tags`. `.github/workflows/release.yml` publishes with npm trusted publishing and provenance.
- Never add a long-lived npm token, never use `pull_request_target`, and keep every action pinned to a full commit SHA with the version in a trailing comment.
- Roll back with `npm deprecate`, never `npm unpublish`.
- Do not push, tag or create releases unless the maintainer asks.
