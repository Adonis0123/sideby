# Contributing

Thank you for helping. Fixes, docs, support for a new tool and better prompts for the AI are all welcome, and you do not need to open an issue first. A pull request made with an AI assistant is welcome too, as long as you understand the change and have tried it yourself. If an AI Task from the panel asked whether you want to share what it did, this page is what it follows.

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
- Keep one change per pull request: one tool, one fix or one feature.
- Say how you tried it: the Host and its version, and the date (for example "tried with Grok Build 1.0.60 on 2026-10-17"), on your own machine.
- Remove what is particular to your machine, as "Write for every user" in [`AGENTS.md`](AGENTS.md#write-for-every-user) asks: real account names, emails, home paths, hostnames, ports and the names of your own tools. Examples use `claude:work`, `me@example.com` and port 17420.
- Keep `README.md` and `README.zh-CN.md` in sync, and each `docs/guide/<page>.md` with its `<page>.zh-CN.md`, when user-facing behavior or wording changes.
- Do not add secrets, real home paths, or credential-shaped files. Fixtures use fake values only.
- Do not bump the version, tag, or publish to npm unless the maintainer asks. Releases are described in [`docs/release.md`](docs/release.md).
- A behavior or contract change updates the spec in `docs/specs/` first. A new decision, or reversing one, gets an ADR in `docs/adr/`. See "Change process" in [`AGENTS.md`](AGENTS.md).
- Commit messages use an emoji and [Conventional Commits](https://www.conventionalcommits.org/), for example `✨ feat(codex): read quota from rollout files`.

## Adding a tool

Start with a local plugin, so the tool works for you before it is built in:

```sh
sideby plugins new <id>      # a Family Plugin skeleton with a TODO at each required field
sideby plugins check <id>    # the same checks CI runs on built-in families; each problem says how to fix it
```

Fill in every `TODO` from the tool's own docs or `--help`, and run `sideby plugins check <id>` until it passes. [Plugins](docs/guide/plugins.md#add-a-tool-sideby-does-not-support) lists the facts to find out. Your AI can do this for you: choose **Other tool…** in the panel's new-account dialog.

To make it a built-in family, follow **Adding a family** in [`AGENTS.md`](AGENTS.md#adding-a-family), one tool per pull request:

1. Confirm the Host can isolate its config directory with an environment variable, and record the tested version. A Host that cannot may still join as a Main-only Family (main account only, ADR-0047).
2. Write the family row in spec §3.4 (hijack variables, shared items and share modes, sign-in command, and a login-state rule that reads no credential values).
3. Add `src/families/<id>/index.ts`, a logo, and an entry in `BUILTIN_PLUGINS`.
4. Add a fake-home test for discovery, launch environment, and every shared item's check and fix.
5. Read quota or usage only from local files or official CLI output. Otherwise leave those readers out.
6. Update both READMEs, the guide's host notes and sharing table (English and Chinese), `llms.txt`, and `skills/sideby/SKILL.md`.
