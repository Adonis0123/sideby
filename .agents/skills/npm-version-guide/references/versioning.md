# Which version number to pick

Last verified: 2026-11-24

This page explains how to pick a Version Bump for an npm package and how your choice affects people who install it. You do not need to memorize the rules: ask your Agent to run `npm-version-guide`, and come back here when you want to check why it picked a level.

## What the three numbers mean

A normal version number has three non-negative integers with no leading zeroes, written `MAJOR.MINOR.PATCH` [F-73], [F-74]. Each number increases numerically (`1.9.0` becomes `1.10.0`) [F-74]. This specification is called Semantic Versioning 2.0.0 (SemVer) [F-73].

- **PATCH** (`1.2.3` → `1.2.4`): backward-compatible bug fixes [F-73].
- **MINOR** (`1.2.3` → `1.3.0`): backward-compatible new features [F-73], or marking part of the Public Interface as deprecated [F-79].
- **MAJOR** (`1.2.3` → `2.0.0`): a Breaking Change to the Public Interface [F-73].

Your **Public Interface** is everything a user of `your-package` can rely on: entry points, commands, options, defaults, output formats, and supported Node.js versions. A **Breaking Change** means some existing user has to change their own code or settings to keep working.

Once a version is published, its contents must never change; any fix goes out as a new version [F-75].

## From change to Version Bump

Use this table for `1.0.0` and above (for `0.x`, see the next section). If a release has more than one change, pick the highest level.

| What changed | Level | Why |
| --- | --- | --- |
| Remove an option or command | MAJOR | Existing users calling it will fail [F-73] |
| Change a default value | MAJOR | Existing users relying on the old default get different behavior [F-73] |
| Change an output format | MAJOR | Existing scripts or code reading the output can break [F-73] |
| Raise the minimum Node.js version | MAJOR | By this guide's definition of Public Interface, users on older Node.js versions can no longer run `your-package` |
| Fix a bug in a way that changes behavior users relied on | MAJOR | By this guide's definition of Public Interface, breaking callers is a Breaking Change even if the old behavior was a bug |
| Add a new feature or option (old ones still work) | MINOR | Backward-compatible new functionality [F-73] |
| Deprecate an option before removing it later | MINOR | SemVer requires a MINOR bump for deprecations; remove it in a later MAJOR [F-79] |
| Fix a bug without breaking callers | PATCH | Backward-compatible bug fix [F-73] |
| Update internal dependencies without changing the Public Interface | PATCH or MINOR | Compatible change; PATCH if it fixes a bug, MINOR if it adds functionality [F-81] |
| Docs, comments, or tests only | None | Does not affect the version unless paired with a Breaking Change [F-100], [F-103] |

## How `0.x` versions work

SemVer says `0.y.z` is for initial development and anything may change at any time [F-76]. Its MINOR and PATCH rules are written only for `1.0.0` and above; SemVer itself has no rule saying "Breaking Change in `0.x` bumps MINOR" [F-76].

npm's version library (`node-semver`) follows that convention: its caret rule treats `0.x` MINOR bumps as the Breaking Change signal and assumes `0.2.4` → `0.2.5` is safe [F-96]. Because `^0.2.3` accepts `0.2.4` but stops before `0.3.0` [F-94], `node-semver` notes that using MINOR for Breaking Changes is common in `0.x` [F-96]; the `conventionalcommits` preset can optionally lower features to PATCH [F-102].

## When to release `1.0.0`

SemVer and npm disagree on the starting number:

- The SemVer FAQ suggests starting at `0.1.0` and bumping MINOR for each early release [F-77].
- npm's own semantic versioning guide recommends starting at `1.0.0` [F-84].

If you started in `0.x`, the SemVer FAQ says to move to `1.0.0` once people use `your-package` in production, depend on a stable Public Interface, or care about backward compatibility [F-78].

## Pre-release versions and Release Tags

A **Pre-release** adds a hyphen and dot-separated labels after the patch number, such as `1.2.0-beta.1` or `1.2.0-rc.1` [F-82]. It sorts below the normal version (`1.2.0-rc.1 < 1.2.0`) and may not keep the normal compatibility promise [F-82].

By default, `npm publish` moves the `latest` **Release Tag** to the new version, and `npm install your-package` installs `latest` [F-88]. Because you do not want ordinary installs to land on a Pre-release, publish it under another Release Tag such as `next`:

- On **npm 11 and later**, `npm publish` refuses a Pre-release unless you pass `--tag` (or set `publishConfig.tag` or `--force`) [F-90].
- On **npm 10**, there is no such check, so publishing a Pre-release without `--tag` would move `latest` to that Pre-release [F-88] (inferred from npm 10 source, not run [F-90]).
- The same `--tag` requirement applies to a Staged Release, where the tag is fixed at staging time [F-53].

Any plain word like `next` or `beta` works as a Release Tag; no tag other than `latest` has special meaning to npm [F-88]. Do not pick a tag name that looks like a version range (such as `v1.4`), because npm rejects it [F-89].

When you are ready to graduate a Pre-release with `npm version`, `npm version patch` on `1.2.0-5` drops the suffix to `1.2.0` rather than jumping to `1.2.1` [F-85].

## If you released the wrong version

You cannot overwrite a published version [F-75]. Pick one of three responses:

1. **Ship a new fix version (usually best).** If a Breaking Change went out as a MINOR release by mistake, SemVer says to ship a new MINOR version that restores compatibility and tell users which version was broken [F-80]. If you need to ship a fix on an older major line (such as `1.4.1` after `2.0.0` is already out), npm 11 requires `--tag` so you do not overwrite `latest` [F-91].
2. **Warn installers with `npm deprecate`.** `npm deprecate your-package@1.2.0 "Use 1.2.1 instead"` shows a warning to anyone who installs that version [F-92]. It works on a single version or a range (ranges include Pre-releases), requires package owner access, and can be cleared later with an empty message `""` [F-92].
3. **Unpublish only as a last resort.** On the public registry, unpublishing is allowed within 72 hours only if no other public package depends on `your-package`; after 72 hours it also requires fewer than 300 downloads in the past week and a single owner [F-93]. A used `your-package@version` can never be published again, unpublish cannot be undone, and removing all versions blocks publishing any new version for 24 hours [F-93]. In most cases npm recommends `npm deprecate` instead [F-93].

## How `^` and `~` decide what users get

When someone runs `npm install your-package`, npm writes a caret (`^`) range into their `package.json` by default [F-98]. That symbol decides which future releases they receive automatically:

| Range in user's `package.json` | Versions it accepts | Gets automatically |
| --- | --- | --- |
| `^1.2.3` | `>=1.2.3 <2.0.0-0` [F-94] | PATCH and MINOR (`1.2.4`, `1.3.0`), not `2.0.0` |
| `^0.2.3` | `>=0.2.3 <0.3.0-0` [F-94] | PATCH only (`0.2.4`), not `0.3.0` [F-94] (npm 10.9.9 also behaved this way in a test [F-110]) |
| `^0.0.3` | `>=0.0.3 <0.0.4-0` [F-94] | None |
| `~1.2.3` | `>=1.2.3 <1.3.0-0` [F-95] | PATCH only (`1.2.4`), not `1.3.0` |
| `~0.2.3` | `>=0.2.3 <0.3.0-0` [F-95] | PATCH only (`0.2.4`), not `0.3.0` |

Notice the `-0` at the upper end: `^1.2.3` also excludes `2.0.0-alpha.1` [F-94]. Ordinary ranges only match a Pre-release if the range itself names a Pre-release on the exact same `MAJOR.MINOR.PATCH`, so `^1.2.3` never pulls in `1.3.0-beta.1` [F-97] (npm 10.9.9 also behaved this way in a test [F-110]).

## Why this guide uses `npm version` + git tags

Tools such as Changesets and `release-please` exist and are helpful when you maintain many linked packages in one repository. This guide keeps `npm version` and a `v*` git tag [F-86], [F-87] because it stays simple: in GitHub Actions, tags pushed with the built-in `GITHUB_TOKEN` do not start other workflows [F-104] (`release-please-action` requires a separate personal access token for that reason [F-105]; `changesets/action` uses the GitHub-provided token unless you configure `github-token`, though whether its tags also fail to trigger workflows is unconfirmed and only inferred from [F-104] [F-106]), and Changesets does not support Staged Releases [F-107].

If your repository already has its own release command (for example a `release` script in `package.json`, or one your `CONTRIBUTING.md` names), your Agent reads it first and uses it instead, as long as it makes the exact version you agreed to and does not publish from your computer. It tells you which command it will use when it asks for your yes, and says why if it falls back to `npm version` (for example for a Pre-release). When it runs `npm version` itself, the commit message copies the style of your last release commit, or `chore(release): v<version>` if there is none [F-119].

## A note on Calendar Versioning (CalVer)

Calendar Versioning puts the release date in the version and deliberately does not signal Breaking Changes [F-108]; zero-padded dates like `2026.01.05` are not valid SemVer [F-109] (npm 10.9.9 also behaved this way in a test [F-110]), and npm's default `^` ranges would still read moving date parts as MAJOR or MINOR changes [F-109].

If you're stuck: ask your Agent "Which version should the next release be? Use npm-version-guide."

## Sources

- [F-53](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-73](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-74](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-75](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-76](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-77](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-78](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-79](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-80](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-81](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-82](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-84](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-85](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-86](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-87](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-88](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-89](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-90](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-91](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-92](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-93](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-94](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-95](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-96](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-97](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-98](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-100](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-102](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-103](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-104](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-105](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-106](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-107](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-108](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-109](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-110](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-119](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-53]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-73]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-74]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-75]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-76]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-77]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-78]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-79]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-80]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-81]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-82]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-84]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-85]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-86]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-87]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-88]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-89]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-90]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-91]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-92]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-93]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-94]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-95]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-96]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-97]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-98]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-100]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-102]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-103]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-104]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-105]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-106]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-107]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-108]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-109]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-110]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-119]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
