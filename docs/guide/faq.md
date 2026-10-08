# FAQ

English | [中文](faq.zh-CN.md)

← [README](../../README.md)

<a id="terms"></a>

## Does this break any terms of service?

sideby is built to stay inside what each Host already supports (see [ADR-0001](../../docs/adr/0001-side-by-side-not-switching.md) and [ADR-0003](../../docs/adr/0003-quota-from-local-and-official-sources.md)):

- It does not switch: it never edits a Host's global config to change the active account. Each account is a separate config directory, the mechanism every Host documents (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`).
- It does not rotate: it never moves to another subscription when a quota runs out. `sideby next` recommends the account with the most room from data already on your machine; starting it is your call.
- It does not proxy credentials: it never reads a subscription token to call a model, and never pools logins.
- It does not call private endpoints: quota comes from local files and from data Claude Code hands to your status line command.

This is the maintainers' own reading of the rules, not legal advice. Check your provider's terms for your situation.

## Why Node 22.18?

From 22.18, Node strips TypeScript types by default, so sideby can `import()` your `.ts` plugins straight from disk. The published program is plain JavaScript. `package.json` sets `"engines": { "node": ">=22.18.0" }`. npm prints an `EBADENGINE` warning and still starts the program; that warning is not a stop.

sideby then checks the version itself. Below 22.18, `--help`, `--version` and every other command print an upgrade hint and exit with 1. `statusline-tap` is the exception: Claude Code runs it on every status-line refresh, and it still runs your original command, so that refresh is not dropped.

## Where does sideby keep its data?

| What | Where |
|---|---|
| Config (sideby only writes `aliases` in it, from `new --alias`, `sideby alias` or the panel) | `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json` |
| Your plugins | `${XDG_CONFIG_HOME:-~/.config}/sideby/plugins/` |
| State: quota cache, last Doctor result, original `settings.json` bytes, background panel pid and logs | `${XDG_STATE_HOME:-~/.local/state}/sideby/` |
| Desktop app (`sideby app install`) | macOS `~/Applications/sideby.app`; Linux `~/.local/share/applications/sideby.desktop`, `~/.local/share/sideby/`, `~/.local/share/icons/hicolor/*/apps/sideby.*` |

sideby writes nothing of its own into Host account directories. The one exception is `quota setup claude --yes`, which changes `~/.claude/settings.json`. Account directories you create with `sideby new` belong to the Host.

## How is it different from aimux, agenv, cc-switch or magpie?

They solve related problems with different trade-offs; pick the one that fits how you work.

| | sideby | [aimux](https://github.com/Digital-Threads/aimux) | [agenv](https://github.com/combinatrix-ai/agenv) | [cc-switch](https://github.com/farion1231/cc-switch) | [magpie](https://github.com/yetone/magpie) |
|---|---|---|---|---|---|
| Model | one directory per account, run side by side | one directory per profile, run side by side | isolated profile with its own Host binary | switch the active provider in the Host's config | set each agent's model and provider from the menu bar |
| Hosts | Claude Code, Codex, Grok Build, pi | Claude Code, Codex, Gemini CLI | Claude Code, Codex, Gemini CLI | many, including Grok Build and pi | several agents |
| Quota | local records and status line data only | live limit probe; `run --auto` picks the subscription with the most headroom | — | — | — |
| Shape | CLI, local web panel, local plugins | CLI with TUI | CLI with TUI | desktop app | menu bar app |

## How do I uninstall?

```sh
sideby quota teardown claude                  # first, if you ran quota setup; the status line calls sideby
sideby ui --stop && sideby app uninstall       # if you use the desktop app
npm rm -g sideby
rm -rf ~/.config/sideby ~/.local/state/sideby  # or your XDG_CONFIG_HOME / XDG_STATE_HOME paths
```

Remove the `eval "$(sideby shell-init …)"` line from your shell rc file. Account directories such as `~/.claude-work` stay; delete them yourself if you no longer need them.
