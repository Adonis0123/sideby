<p align="center">
  <img alt="sideby: one shared config, every account in its own terminal" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/banner.jpg" width="880">
</p>

<p align="center">
  <b>Run every AI coding account side by side.</b><br>
  Claude Code, Codex, Grok Build and pi: one directory per account, one shared set of skills, hooks and rules, one panel for every quota.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sideby"><img alt="npm" src="https://img.shields.io/npm/v/sideby"></a>
  <a href="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center">English | <a href="README.zh-CN.md">中文</a></p>

## Why

You have a work subscription, a personal one and maybe an API key. Switching tools rewrite the Host's global config, so only one account is live at a time, and your skills and hooks slowly drift apart between accounts.

- **Side by side, not switching.** Each account lives in its own directory, and sideby starts the official CLI with that directory selected. Run three accounts in three terminals; your shell is never changed.
- **One copy of skills, hooks and rules.** Your Main Account (for example `~/.claude`) is the source. Other accounts link or copy its Shared Items ([what is shared](docs/guide/usage.md#what-each-account-shares)), and `sideby doctor --fix` repairs drift without touching real files or credentials.
- **Every quota on one screen.** 5-hour and 7-day quota, reset times and 7-day token usage for every account. Out of room? `sideby next` starts the account with the most left. All from local files: no network calls, no token reads.

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

<img alt="sideby in a terminal: list accounts, check quota, pick the next account, find and fix drift" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/demo.gif" width="1320">

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

## Safe by design

- It never edits a Host's global config to switch accounts, and never rotates accounts by itself.
- It never reads, prints or sends a credential value. Nothing leaves your machine: sideby calls no remote service.
- `doctor --fix` never replaces a real file and never changes where a link points.

Details and the terms-of-service question are in the [FAQ](docs/guide/faq.md).

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
