# 0024. `pnpm local` puts the checkout's code behind the global `sideby`

Date: 2026-10-16 · Status: accepted

## Context

The maintainer changes sideby through coding agents and wants to see each change at once in the tools used every day: the Panel mounted in a Portal (it finds sideby through the `sideby` command on PATH) and the `sideby` command itself. Until now a change reached them only through a release and an Update, so the maintainer looked at the published version while the agent had already changed the code.

Facts that shape the answer:

- A Portal reads `dist/build.json` of the package it loaded on every request and starts a fresh worker when it changes (ADR-0006, Portal side). It keeps the folder it resolved at start, so new code must land in the same folder.
- An open Panel page reloads itself when `/api/state` reports another build (`buildId()`), and waits while the viewer is busy. A background Panel (`ui --background`) is replaced the next time it starts from another build.
- `statusline-tap` and `handoff-hook` run the global `sideby` on every status line refresh and tool call. A broken build there breaks every Claude session's status line.
- Several agent sessions often edit the checkout at the same time, so the working tree may hold another session's unfinished change.
- `pnpm build` starts with `rm -rf dist`, so the package has no code for the length of a build.

Options considered:

- `npm link` the checkout. Rejected: the global command then runs whatever `dist` holds, including a half-written build, and `pnpm build` empties it while it runs.
- Build on every save (watch mode). Rejected: it ships an agent's half-done edit.
- Build only committed code (a post-commit hook). Rejected by the maintainer: they want to see an agent's result before deciding to commit.
- A Stop hook of one Host. Rejected: Codex and Grok sessions would not trigger it.
- A script the agent runs before handing work back, which builds aside and switches only a build that compiles and starts. Chosen.

## Decision

- **Local Build** (`CONTEXT.md`): `pnpm local` in a checkout compiles the working tree into a new folder next to `$XDG_DATA_HOME/sideby-dev/pkg` (default `~/.local/share/sideby-dev`), with `package.json`, `schemas`, `skills`, the READMEs, `LICENSE` and a link to the checkout's `node_modules`. It writes `dist/build.json` with `local: true`, the commit, whether the working tree had changes (`dirty`) and the build time.
- It switches only when `tsc` succeeds and `node dist/src/cli/main.js --version` prints the package version. The switch is two renames: the running `pkg` moves to `old/<id>`, the new folder becomes `pkg`. The folder the global `sideby` resolves to never changes, so a Portal sees the new `build.json` and a running command never reads a half-written tree. The three newest old builds are kept; `pnpm local --back` swaps the newest one back.
- The first run replaces the global npm package `<prefix>/lib/node_modules/sideby` with a link to `pkg` (the npm package moves to `$XDG_DATA_HOME/sideby-dev/npm`) and makes sure `<prefix>/bin/sideby` points into it. `pnpm local --off` removes the link and puts the npm package back (or runs `npm install -g sideby` when there is none). Only an npm global install is handled; with pnpm, bun or Volta the script stops and says so.
- After a switch, a background Panel that runs is started again from the new code. Open pages and Portals reload by themselves, as after an Update (ADR-0021).
- **Install Method `local`**: a package whose `dist/build.json` says `local: true`. Update Checks are off for it (`checksOff` says "this is a local build"), so it never shows an Update Notice and Auto Update never replaces it. `sideby update` names `pnpm local --off`.
- The Panel's version pill reads `v<version>-dev · <commit>` with `+` when the working tree had changes; its popover adds the build time.
- `AGENTS.md`: after `pnpm check`, an agent runs `pnpm local` before handing work back, so the maintainer sees the result in the Panel they already have open.

## Consequences

- What the maintainer sees is the working tree, including another session's uncommitted edits when there are some. Compile errors never reach the global command; runtime bugs can, and `pnpm local --back` undoes the switch.
- The global `sideby` follows the checkout until `pnpm local --off`; releases installed with `npm i -g sideby` in the meantime replace the link, which is the same as `--off`.

## Amendment (2026-10-17): back on npm after a release

`pnpm local --off` put back the npm package kept aside at the first switch. After a release that copy is the version before it, so going back to npm meant going back to older code, and nothing switched back after a release unless someone remembered to.

- `--off` now compares the kept copy with the registry's `latest` (the same request as the Update Check, ADR-0021): it restores the copy only when it is not older, or when the registry cannot be asked; otherwise it installs `sideby@<latest>`.
- `pnpm release <patch|minor>` does the daily release (`npm version`, `git push --follow-tags`), waits until the registry serves the new version, and then runs `--off` when a Local Build is live. A release now ends on the published package, without a step to remember. It never publishes by itself; `release.yml` still does.
- A Portal that looks up the package of the `sideby` command only at start keeps serving the old folder after `--off` (or after `pnpm local`), because that folder's `dist/build.json` never changes again. A Portal should look the package up again whenever it checks for new code, and load it anew when the folder changes.
- Published packages are unchanged: `build.json` from `pnpm build` has no `local`, so every other install behaves as before.

## Amendment (2026-10-17): switch from the Panel and `sideby local`

Going between the Local Build and the published package meant a terminal in the checkout. The maintainer looks at the Panel and wants to compare the two there.

- The switching part moves into the package (`src/core/local-build.ts`); `scripts/local.ts` keeps building and imports it.
- `sideby local [on|off] [--yes] [--json]` shows what the global `sideby` runs, the kept Local Build and the kept npm version. `on` links the newest Local Build back without compiling (`pnpm local` builds); `off` is the switch of `pnpm local --off`. Both show the change first and exit 10 without `--yes`, like `sideby update`.
- The Panel's version popover offers the other side when there is one: "Switch to the release" while a Local Build runs, "Switch to the local build" (its commit and build time) while npm runs and a Local Build is kept. After the switch the page waits for the new build and reloads, as after an Update. A plain npm install with no Local Build sees nothing new.
- A switch takes the Update lock, and a failed `npm install` links the Local Build back, so the global `sideby` never goes missing.
- Back on npm, the switch runs `sideby update --yes` of the npm code by name, so the skill comes along as with `pnpm local --off` (`skillSynced`). The Panel starts it detached instead of waiting (`skillSyncStarted`): the fetch can take minutes, and a Portal answered 502 while the switch had already happened. A 5xx after a switch request makes the page read the state before it reports an error. While a Local Build runs and a newer version is out, the Panel offers "Switch to the release <v>" as the update itself, with `pnpm local --off` only under "Update by hand".

