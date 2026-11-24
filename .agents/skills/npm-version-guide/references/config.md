# Project settings: `.agents/release.json`

Last verified: 2026-11-24

Both skills of this guide read one small settings file in the project, so each project keeps its own choices: which workflow publishes, which GitHub environment it runs in, how `0.x` versions bump, and which Pre-release name to use. The file is optional. Without it, the skills infer the same values and ask before anything that leaves the machine.

## Where it lives

`.agents/release.json` at the Git root (or in a package folder; the nearest file from the package folder up to the Git root wins). Commit it, so every Agent and every teammate gets the same settings.

JSON Schema: `https://raw.githubusercontent.com/Adonis0123/npm-release-guide/main/schemas/release.v1.schema.json`. Put that URL in `$schema` and editors check the file as you type. The file name carries the format version (`v1`), so the URL does not change meaning later.

## Fields

```json
{
  "$schema": "https://raw.githubusercontent.com/Adonis0123/npm-release-guide/main/schemas/release.v1.schema.json",
  "version": 1,
  "publish": { "workflow": "release.yml", "environment": "npm", "prereleaseTag": "next" },
  "versioning": { "zeroMajor": "minor", "preid": "beta" }
}
```

| Field | Default | Meaning |
|---|---|---|
| `version` | required, `1` | Settings format. |
| `publish.workflow` | `release.yml` | File name of the GitHub workflow that publishes. Must equal `--file` in `npm trust github` [F-07]; npm compares it exactly (case-sensitive) [F-12]. |
| `publish.environment` | `npm` | GitHub environment of the publishing job. Must equal `--env` in `npm trust github` [F-07]. |
| `publish.prereleaseTag` | `next` | Release Tag for Pre-release versions. The `release.yml` template has `--tag next` written in; change both together. Not `latest` (plain installs would then get the Pre-release [F-88]), and not a name npm reads as a version range such as `v1.4` or `x` [F-89]. |
| `versioning.zeroMajor` | `minor` | `minor`: on `0.x`, a Breaking Change raises the minor number and features or fixes raise the patch number, matching how `^0.y.z` ranges work [F-94], [F-102]. `major`: same rules as `1.x`, so a Breaking Change goes to `1.0.0`. |
| `versioning.preid` | `beta` | Name of a new Pre-release line (the `beta` in `1.3.0-beta.0`). Letters, digits and `-`; a number must not start with `0`. An existing line keeps its name when switching would sort lower: after `1.2.0-rc.3` comes `1.2.0-rc.4`, never `1.2.0-beta.0`. The version script works out the exact version and `npm version` takes it as is [F-85]. |
| `versioning.tagPrefix` | `v` | Prefix of the existing tags that mark releases, so the script can find the last one. `<package name>@<version>` tags are always recognised. It does not change the tag `npm version` creates: that is npm's `tag-version-prefix` setting, `v` by default [F-87]. If your release workflow listens for another prefix, set this field and add `--tag-version-prefix=<prefix>` to `npm version`. |
| `versioning.publicInterface` | files behind `exports`, `main`, `module`, `types`, `bin` | Paths or globs, relative to the package folder. A `fix`, `perf` or `refactor` commit touching them goes to the Agent for review. Set this when the entry points are build output (`dist/`) and you want the sources checked, for example `["src/index.ts", "src/cli/**"]`. |
| `packages[]` | none | Monorepo overrides, see below. |

The schema rejects unknown fields, except `$schema`. The version script checks the same rules; if the file breaks one, it prints `config_error:` lines and `next: fix-config` and suggests nothing until the file is fixed.

## Monorepo: one entry per package

Top-level `publish` and `versioning` are defaults. Each `packages[]` entry is `{ "dir", "publish"?, "versioning"? }` and overrides them for that folder. Trusted Publishing is linked per package [F-07], so two packages can use different workflows or environments.

```json
{
  "version": 1,
  "publish": { "workflow": "release.yml", "environment": "npm" },
  "packages": [
    { "dir": "packages/core" },
    { "dir": "packages/cli", "publish": { "workflow": "release-cli.yml" }, "versioning": { "zeroMajor": "major" } }
  ]
}
```

`dir` is relative to the folder that holds `.agents/`. Run the version script with `--package <dir>`; it reads only the commits that touched that folder. One package is released at a time; for releases of several packages together, use Changesets instead (note that Changesets does not support Staged Release [F-107]).

In a monorepo a `v1.2.0` tag may belong to any package, so the script trusts `v*` tags for a package only when the settings name a `tagPrefix` (in its `packages[]` entry or at the top level). Otherwise it uses `<package name>@<version>` tags, or stops with `next: need-since`, and the Agent finds the last release commit for `--since`.

## What the Agent infers when there is no file

| Value | Inferred from |
|---|---|
| `publish.workflow` | The first file in `.github/workflows/` that runs `npm publish` (or the pnpm, yarn or bun equivalent) |
| `publish.environment` | The `environment:` line in that workflow |
| everything else | The defaults in the table above |
| `packages[]` | Only the folder given with `--package` |

The version script prints `config_source: inferred`, the source in `config_inferred_from:`, and the full proposed file in `config_proposal:`.

## First run: one question for settings and version

1. Run the version script first. It works without the file and prints `config_proposal:`.
2. If the Publisher only wants advice ("which version would this be?"), give the result. Write nothing.
3. If they want the version set, put both in the one confirmation: the exact version, and "save these release settings to `.agents/release.json`" with the proposed file as a JSON block and one sentence on what it stores ("which workflow publishes this package and how version numbers go up").
4. On yes, write exactly what was shown. On no, change nothing and do not ask about the file again in this conversation.
5. Check it is not published with the package: run `npm pack --dry-run --ignore-scripts` and look for `.agents/` in the file list. If it shows up, it means the package's file list does not exclude it; propose adding or updating `files` (or a `.npmignore` line) and make the change only after a yes.
6. Remind the Publisher to commit the file. Do not commit or push unasked.

Change the file the same way: show the new content, get a yes, write.

## Who reads what

| Skill | Reads |
|---|---|
| npm-version-guide | `versioning`, `publish.prereleaseTag`, `packages[]` |
| npm-publish-guide | `publish.workflow`, `publish.environment`, `packages[]` |

Either skill works without the other and without the file.

## Sources

- [F-07](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-12](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-85](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-87](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-88](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-89](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-94](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-102](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)
- [F-107](https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md)

[F-07]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-12]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-85]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-87]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-88]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-89]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-94]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-102]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
[F-107]: https://github.com/Adonis0123/npm-release-guide/blob/main/docs/facts.md
