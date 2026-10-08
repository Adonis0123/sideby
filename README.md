<p align="center">
  <img alt="sideby: work, personal and API-key accounts, one terminal each, one shared config" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/banner.jpg" width="880">
</p>

<p align="center">
  <b>Run work, personal and API-key accounts at the same time, without their configs drifting apart.</b><br>
  Each account is its own directory and its own terminal. Skills, hooks and settings stay linked to your main account. Claude Code, Codex, Grok Build and pi.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sideby"><img alt="npm" src="https://img.shields.io/npm/v/sideby"></a>
  <a href="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">English | <a href="README.zh-CN.md">中文</a></p>

## Why not just an alias?

`CLAUDE_CONFIG_DIR` plus a shell alias already starts a second account. It does not keep skills and settings in one place, and it does not show quota for every account. [Does this break a provider's terms?](docs/guide/faq.md#terms)

| | At the same time | Skills, hooks, settings | Quota and usage | Setup |
|---|---|---|---|---|
| `CLAUDE_CONFIG_DIR` and an alias | Yes. Each terminal exports the variable. | Each directory is its own copy. They drift unless you symlink by hand. | That session's status line | One alias per account |
| [cc-switch](https://github.com/farion1231/cc-switch) | Enabling a provider writes the host's live config, so open sessions share that switch. | Plugin settings are copied across providers as a separate step. | The active provider, from its quota endpoint | Install the desktop app |
| sideby | Yes. `sideby run` selects the directory for that process and leaves your shell alone. | Linked to the main account. `sideby doctor --fix` repairs copies. Sign-in and sessions stay separate. | Every account, from local files. Claude needs `quota setup`. | `npm i -g sideby`, then `sideby new` and sign in |

cc-switch's docs describe that switch: it writes the live settings file ([README](https://github.com/farion1231/cc-switch#readme)). [#1105](https://github.com/farion1231/cc-switch/issues/1105) and [#2908](https://github.com/farion1231/cc-switch/issues/2908) ask for several sessions at once. [#1106](https://github.com/farion1231/cc-switch/issues/1106) is closed; the maintainer says Claude Code's "open terminal" can start one provider without changing the global config.

## Quick start

Requires Node 22.18+ and at least one Host CLI (Claude Code, Codex, Grok Build or pi) installed. AI agents: follow the setup steps in [`llms.txt`](llms.txt) ("Set up sideby for a user") instead.

```sh
npm i -g sideby
sideby new claude work        # create ~/.claude-work, sharing ~/.claude's skills and hooks
sideby login claude:work      # sign in once
sideby run work               # Claude Code on the work account
sideby ui                     # every account's quota at http://127.0.0.1:17420
```

`sideby run claude:main` keeps using `~/.claude` in another terminal at the same time. Arguments after `--` go to the Host: `sideby run work -- --resume`. To try it without installing, run `npx sideby`.

## Set up with your AI agent

Paste this into Claude Code, Codex or any coding agent:

```text
Install the sideby CLI (npm package `sideby`) and its agent skill, then set up a second Claude Code account for me.
Follow "Set up sideby for a user" in https://raw.githubusercontent.com/Adonis0123/sideby/main/llms.txt
```

The agent checks Node and your Host CLIs, installs sideby and the skill, creates the account, tells you what it shares with your main one and makes its short command work. You sign in once in your browser; the agent gives you that one command. Once the skill is installed, short requests work too: "add another Claude account, cc008", "what do my Codex accounts share?", "which account still has quota?".

## What it looks like

<img alt="Two terminals: the personal account and the work account running at the same time, then the local quota panel" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/demo.gif" width="1280">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png">
  <img alt="sideby panel: every account's 5h and 7d quota, 7-day token usage and health in one page" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png" width="1280">
</picture>

## What else it does

| You want to | Run | Guide |
|---|---|---|
| Add an API key account (DeepSeek, a gateway, …) | `sideby new claude deepseek --api` | [API accounts](docs/guide/usage.md#api-accounts) |
| Find and fix config drift between accounts | `sideby doctor --fix` | [Doctor](docs/guide/usage.md#doctor) |
| See Claude quota (Codex needs no setup) | `sideby quota setup claude --yes` | [Claude quota](docs/guide/usage.md#claude-quota) |
| Move on when an account hits its limit | `sideby next claude` | [Handoff](docs/guide/usage.md#when-an-account-hits-its-limit) |
| Short commands such as `ccw` | `sideby alias add ccw claude:work` | [Shell functions](docs/guide/configuration.md#shell-functions) |
| Reopen a session from Orca and the like in the account that holds it | `"resumeRouting": true` in config | [Resuming from other tools](docs/guide/configuration.md#resuming-from-other-tools) |
| Open the panel from the Dock or app menu | `sideby app install` | [Desktop app](docs/guide/panel.md#desktop-app) |
| Show the panel inside your own local page | `createPanelHandler()` | [Embed the panel](docs/guide/panel.md#embed-the-panel) |
| Add a Host or a pre-launch check | a local plugin | [Plugins](docs/guide/plugins.md) |

## Supported hosts

| Host | Account directories | Sign-in | Quota | Usage (7 days) |
|---|---|---|---|---|
| Claude Code | `~/.claude`, `~/.claude-<name>` | `claude auth login` | ✓ after `quota setup claude` | ✓ |
| Codex CLI | `~/.codex`, `~/.codex-<name>` | `codex login` | ✓ | ✓ |
| Grok Build | `~/.grok`, `~/.grok-<name>` | `grok login` | no public source | no public source |
| pi | `~/.pi/agent`, `~/.pi-<name>/agent` | `/login` inside pi | no public source | no public source |

sideby starts the official binary on your `PATH` and never patches it. Tested versions and per-Host notes are in the [guide](docs/guide/usage.md#host-notes).

## Platforms

macOS and Linux. CI runs the suite on `ubuntu-latest` and `macos-latest`, Node 22 and 24. **Windows is untested.** `sideby app` only installs a launcher on macOS and Linux. Linked items are symlinks, `sideby shell-init` prints bash and zsh functions, and the Claude quota wrapper runs `/bin/sh`.

## Roadmap

**Gemini CLI.** Gemini can point at another config directory with `GEMINI_CONFIG_DIR`. Older docs use `GEMINI_CLI_HOME`; current builds treat that name as deprecated, and exit on startup if it is set together with an exact directory override. A sideby family still needs a tested Gemini version, a login check that does not read tokens, and a list of which files to link or copy. That is more than a small patch, so it is not in this version.

## Safe by design

- It never edits a Host's global config to switch accounts, and never rotates accounts by itself.
- It never reads, prints or sends a credential value. Nothing leaves your machine: sideby calls no remote service.
- `doctor --fix` never replaces a real file and never changes where a link points.

Details and the terms-of-service question are in the [FAQ](docs/guide/faq.md).

Usage questions and ideas go in [Discussions](https://github.com/Adonis0123/sideby/discussions).

## Docs

- [Using sideby](docs/guide/usage.md): accounts, API accounts, Doctor, quota, Handoff, Host notes
- [Commands](docs/guide/commands.md): every command, exit codes and `--json`
- [Configuration](docs/guide/configuration.md): `config.json`, aliases, shell functions
- [Panel](docs/guide/panel.md): the panel, desktop app and embedding
- [Plugins](docs/guide/plugins.md): write your own Family or launch hook
- [FAQ](docs/guide/faq.md): terms of service, data locations, alternatives, uninstall

## For AI agents

- [`llms.txt`](llms.txt): setup steps, commands, JSON contract and plugin API in one index. `sideby families --json` states what each Host's accounts share.
- [`skills/sideby/SKILL.md`](skills/sideby/SKILL.md): one Agent Skill for seeing, repairing and creating accounts and for moving on when one hits its limit. Install with `npx skills add Adonis0123/sideby -g`; `sideby doctor` warns when the installed copy is for another sideby version.
- [`AGENTS.md`](AGENTS.md): rules for agents working on this repository.

## License

[MIT](LICENSE)
