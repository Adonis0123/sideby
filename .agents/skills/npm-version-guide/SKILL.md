---
name: npm-version-guide
description: Pick the exact next version of an npm package before a release, including beta and other pre-release numbers. A read-only script reads commits and package.json changes since the last release tag and proposes the version; the Agent judges only what the script cannot classify and asks one yes/no question. Keeps per-project settings in .agents/release.json. Use when the user asks which version the next release should be, patch or minor or major, what version after removing or renaming a command, option or export, semver, 0.x, when to go 1.0, the next beta or rc number, a version released by mistake, what ^ or ~ ranges give users, or what the version script said. Chinese - 下个版本该升哪个号, patch 还是 minor, 删了命令该发什么版本, 语义化版本, semver, 0.x, 什么时候发 1.0, beta 版本号, 预发布, 发错版本. Not for npm login, EOTP, two-factor or Trusted Publishing problems (use npm-publish-guide), nor npm install or dependency errors.
---

# npm Version Guide

You are the Agent. The Publisher owns the package and may not write code. The script decides the Version Bump wherever it can; you judge only the items it lists as `needs_ai`; the Publisher answers one yes/no question. Terms (Version Bump, Breaking Change, Public Interface, Pre-release, Release Tag, Bump Suggestion) and the rules behind them: [versioning.md](references/versioning.md). Settings file: [config.md](references/config.md). `F-xx` cites the guide's `docs/facts.md`.

Stay in the package folder. Call the script by full path: `node <skill-dir>/scripts/suggest-version.mjs`.

## Hard rules

1. **Never publish and never push.** No `git push`, no tag push. This skill ends with a version set locally.
2. **Never run a command that needs a Second Factor**: `npm publish`, `npm unpublish`, `npm deprecate`, `npm dist-tag add|rm`, `npm access`, `npm trust`, `npm login`, `npm token`, `npm owner`. When one is needed, use npm-publish-guide if it is installed; otherwise show the Publisher the one line to paste into their own Terminal app, say what it does, and never ask for a one-time code in chat.
3. **One yes before anything changes.** One plain sentence with the exact version, the release type and what `npm version` (or the repository's own release command) will do, plus the settings file if one would be written; then yes or no. If the Publisher only asked for advice, give the result and change nothing.
4. **Never run a project script you have not read.** Before `npm version`, read the `preversion`, `version` and `postversion` scripts; before the repository's own release command, read it and what it calls. Never run one that publishes or pushes.
5. **Never change a released version** (F-75). A mistake is fixed by a new version, never by moving or deleting a pushed tag.

## Step 1: what does the Publisher want?

| Intent | Do |
|---|---|
| Explain (semver, `0.x`, `1.0`, `^`/`~`, Pre-release, Release Tag) | Answer from [versioning.md](references/versioning.md). Run nothing. |
| "Which version would this be?" (advice only) | Steps 2 to 4, then give the result. No settings file, no `npm version`. |
| "Set the version for the release", or a beta | Steps 2 to 7. |
| A version went out wrong | [versioning.md](references/versioning.md) "If you released the wrong version": a new minor version that restores compatibility, and tell users which version is affected (F-80). A deprecation warning on the bad version (`npm deprecate`, F-92) needs a Second Factor: rule 2. |
| Several packages of a monorepo released together | This skill sets one package at a time. For coordinated releases, point to changesets; do not set it up unasked. |

## Step 2: run the script

```sh
node <skill-dir>/scripts/suggest-version.mjs                       # package in the current folder
node <skill-dir>/scripts/suggest-version.mjs --package packages/a  # one package of a monorepo
node <skill-dir>/scripts/suggest-version.mjs --since <ref>         # last released commit, when tags cannot tell
```

It only reads: no files written, no git changes, no project scripts. `--json` gives every commit. Act on `next:`:

| `next:` | Do |
|---|---|
| `confirm-bump` | Step 4 with `next_version` (or `prerelease_version`). |
| `ai-review` | Step 3, then step 4. |
| `nothing-to-release` | Nothing since `last_release` changes what users get (docs, chores, CI, release commits). Release only if the Publisher insists; then use `patch`. |
| `first-release` | No release tag yet. Run `npm view <pkg> version`: if the package is already on npm, find the commit of that version and rerun with `--since <ref>`. Otherwise see "First release" below. |
| `need-since` | Monorepo with only `v*` tags that may belong to another package. Find the commit of this package's last release (`git log -- <dir>` around its version change), confirm it with the Publisher, rerun with `--since <ref>`; to avoid this next time, set `tagPrefix` in that package's settings entry. |
| `fix-config` | `.agents/release.json` is broken: show the `config_error:` lines, propose the fix, write it after a yes, rerun. Never continue on a broken file. |
| `no-git` / `no-package-json` / `fix-package-json` | Find the package folder, or help fix `name`/`version`. Without Git, ask what changed since the last release and judge it as in step 3. |

Key lines: `last_release`, `commit:` (level per change; `(review)` marks a lower bound), `signal:` (package.json changes such as a removed `bin` command or a narrowed `engines.node`), `raw_level`, `suggested_level` (after the `0.x` rule in `level_rule`), `next_version`, `prerelease_version`, `working_tree_clean`, `publish_workflow_found`, `release_script` (the repository's own `release` script, if any), `release_commit_format` (the message for `npm version -m`, taken from the last release commit; `release_commit_format_from` says where it came from).

## Step 3: judge only the needs_ai items

Each `needs_ai:` line names a commit, `package.json` or `version`, and why the script stopped. `(at least patch)` means the change keeps that level unless you raise it. Read only that change (`git show <sha>`) and decide. Do not open commits the script already classified:

- **major** (Breaking Change): an existing user must change their code, commands, options or settings: a removed or renamed export or command, a changed default or output format, a dropped Node.js version (F-73).
- **minor**: something new users can rely on, or a deprecation (F-79).
- **patch**: a bug fix that keeps the Public Interface working as documented.
- **none**: nothing users can see.

Take the highest of `raw_level` and your judgements, then apply the `0.x` rule from `level_rule` once: with `zeroMajor: "minor"`, a Breaking Change on `0.x` is `minor` and a feature or fix is `patch` (F-94, F-102). Do not start from `suggested_level`, which already has the rule applied. If your level differs from the script's, rerun nothing; compute the version from `current_version` the same way (`0.4.2` + patch = `0.4.3`), and keep it above `last_release`.

If you still cannot decide, ask the Publisher one concrete question ("After this change, does `--out` still accept a folder?"), not "is this breaking?".

## Step 4: settings and the one confirmation

`config_source:` is a file path, or `inferred` with `config_proposal:` (the file the script would suggest, built from `config_inferred_from:`). Fields and monorepo entries: [config.md](references/config.md).

Before asking, run `npm pack --dry-run --ignore-scripts` and check the file list (no secrets, no agent folders such as `.claude/` or `.agents/`); any `files` change goes into the same question. Ask once, in the Publisher's language: one short paragraph, no bullet list, ending in a single yes/no; never a second numbered question, never a separate question about the settings file. Example: "Since v0.4.2 there are 2 fixes and 1 new option, nothing breaks for current users, so the next version is 0.4.3, a normal release. I will run `npm version`, which creates a local commit and the tag v0.4.3; nothing is published or pushed. Shall I go ahead?" When `config_source: inferred` and this is the first run in the project, add "and save these release settings to `.agents/release.json`" and show the proposal as a JSON block in the same message. Without that file, a yes still covers the version; on no, change nothing.

- `0.x`: mention once that `^0.4.2` users get `0.4.3` automatically but not `0.5.0` (F-94, F-98).
- Pre-release: give `prerelease_version` and say it goes out under the Release Tag `prerelease_tag` (default `next`), so plain installs keep the current version (F-88, F-97). Never offer `next_version` when the Publisher asked for a beta.
- The current version is already a Pre-release: offer the two exact versions in the one question, the next Pre-release (`prerelease_version`) or the final release (`next_version`, `release_mode`).
- The repository has its own release command (`release_script:`, or one named in `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md`): read it (rule 4) and say in the same question what happens to it. It only sets the version locally and can make the confirmed version (it takes that version, or a level that gives it, F-85): you run it instead of `npm version`. It also pushes (a commit or a tag for a release workflow), without publishing from this machine: you change nothing now, because running `npm version` first would make it bump twice; the release goes through that command (npm-publish-guide runs it when the Publisher wants to publish). When npm-publish-guide runs these steps for a release now, say instead that it will release with that command. It publishes from this machine, or cannot make the confirmed version (a Pre-release or an exact number it does not take): you use `npm version` and say why in one clause.

## Step 5: write the settings (only if part of the yes)

Write exactly what was shown, before `npm version`, apply any `files` change that was part of the yes, and remind the Publisher to commit the settings file.

## Step 6: set the version

If step 4 left the release to the repository's own command, skip this step. Check `working_tree_clean: yes` (`npm version` refuses otherwise, F-86) and that this is the default branch. Read the hooks (rule 4). If step 4 chose the repository's command, run it with the confirmed version or level, then do the checks below. Otherwise use the exact version (F-85), with the message the repository already uses for releases (`release_commit_format:`; `%s` becomes the version, F-119):

```sh
npm version <exact version> -m "<release_commit_format>"
```

`npm version` makes a commit and a tag in a Git repository (F-86). The tag name is npm's `tag-version-prefix` setting plus the version, `v` by default (F-87); `tagPrefix` in the settings only tells the script which existing tags mark releases. If the repository's release workflow listens for another prefix, add `--tag-version-prefix=<prefix>` to the command.

Then check: `node -p "require('./package.json').version"` equals the confirmed version, and `git tag -l <prefix><version>` prints the tag. If the tag is missing (for example a package in a subfolder), commit `package.json` with the same message if no commit was made, then `git tag <prefix><version>` on that commit, and check again.

## Step 7: close and hand over

Report four facts and stop: package name, exact version, release type (normal release under `latest`, or Pre-release under `prerelease_tag`), and local state (commit, tag name, nothing pushed or published; or nothing changed yet because the repository's own release command, named here, will set the version).

- Only if the Publisher explicitly asks to publish now: if npm-publish-guide is installed, continue with its "Everyday release", giving it those four facts; it publishes this exact version, and passes a level only to the repository's own command when that level gives this version.
- Otherwise end with one sentence. Release left to the repository's own command: "Your release command `<command>` sets `<version>` and starts the release; tell me when you want that." `publish_workflow_found: yes`: "Pushing this commit and the tag `<tag>` starts your release workflow `<workflow>`, which publishes it; tell me when you want that." `publish_workflow_found: no`: "Publishing is a step in your own Terminal app that needs your Second Factor (`npm publish`, plus `--tag <prerelease_tag>` for a Pre-release); npm-publish-guide can walk you through it."

### First release

Nothing was changed. Say: "This package has no release yet, so the first version is `<current_version>` as it is now. Publishing it needs your npm login and Second Factor in your own Terminal app." If npm-publish-guide is installed and the Publisher wants to publish, continue with its "First Release"; otherwise give the line `npm publish --access public` to paste after `npm login`, per rule 2.
