# Contributing

Questions and ideas go in [Discussions](https://github.com/Adonis0123/sideby/discussions). Bugs and feature requests still belong in an [issue](https://github.com/Adonis0123/sideby/issues). Please do not paste tokens, API keys, `proxy.env`, `auth.json`, or `.claude.json`.

The rules for changing this repository are in [`AGENTS.md`](AGENTS.md). Terms are in [`CONTEXT.md`](CONTEXT.md). Specs and plans are in Chinese; everything public is in English.

## Setup

Requires Node 22.18+ and [pnpm](https://pnpm.io) 10.15.0 (`packageManager` in `package.json`).

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` is the gate: TypeScript, Biome, tests, and `scripts/leak-check.sh`. Tests run the `.ts` sources directly. A build is not required to test.

Other commands are listed in [`AGENTS.md`](AGENTS.md). To try the CLI or the panel without touching your real home directory, use `node scripts/demo-home.ts`. Do not run `sideby doctor --fix`, `new`, `login`, or `quota setup` against a real home.

## Pull requests

- Run `pnpm check` and make sure it passes.
- Keep `README.md` and `README.zh-CN.md` in sync, and each `docs/guide/<page>.md` with its `<page>.zh-CN.md`, when user-facing behavior or wording changes.
- Do not add secrets, real home paths, or credential-shaped files. Fixtures use fake values only.
- Do not bump the version, tag, or publish to npm unless the maintainer asks. Releases are described in [`docs/release.md`](docs/release.md).
- A behavior or contract change updates the spec in `docs/specs/` first. A new decision, or reversing one, gets an ADR in `docs/adr/`. See "Change process" in [`AGENTS.md`](AGENTS.md).
- Commit messages use an emoji and [Conventional Commits](https://www.conventionalcommits.org/), for example `✨ feat(codex): read quota from rollout files`.

## Adding a family

A new Host family is more than a plugin file. Follow **Adding a family** in [`AGENTS.md`](AGENTS.md#adding-a-family):

1. Confirm the Host can isolate its config directory with an environment variable, and record the tested version.
2. Write the family row in spec §3.4 (hijack variables, shared items and share modes, sign-in command, and a login-state rule that reads no credential values).
3. Add `src/families/<id>/index.ts`, a logo, and an entry in `BUILTIN_PLUGINS`.
4. Add a fake-home test for discovery, launch environment, and every shared item's check and fix.
5. Read quota or usage only from local files or official CLI output. Otherwise leave those readers out.
6. Update both READMEs, the guide's host notes and sharing table (English and Chinese), `llms.txt`, and `skills/sideby/SKILL.md`.
