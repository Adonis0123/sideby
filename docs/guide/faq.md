# FAQ

English | [中文](faq.zh-CN.md)

← [README](../../README.md)

<a id="terms"></a>

## Does this break any terms of service?

sideby is built to stay inside what each Host already supports (see [ADR-0001](../../docs/adr/0001-side-by-side-not-switching.md) and [ADR-0003](../../docs/adr/0003-quota-from-local-and-official-sources.md)):

- It does not switch: it never edits a Host's global config to change the active account. Each account is a separate config directory, the mechanism every Host documents (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`).
- It does not rotate on its own: by default it never moves to another subscription when a quota runs out. `sideby next` recommends the account with the most room from data already on your machine; starting it is your call. If you turn on [Auto Handoff](usage.md#auto-handoff) (off by default), a session sideby started hands its task to the next account in your order when its quota runs low. Vendors may treat moving between your own subscriptions of one vendor to get past a limit as against their terms; that kind needs a second switch, `sameFamily`, and the risk is yours.
- It does not proxy credentials: it never reads a subscription token to call a model, and never pools logins.
- It does not call private endpoints: quota comes from local files and from data Claude Code hands to your status line command.

This is the maintainers' own reading of the rules, not legal advice. Check your provider's terms for your situation.

## Why Node 22.18?

From 22.18, Node strips TypeScript types by default, so sideby can `import()` your `.ts` plugins straight from disk. The published program is plain JavaScript. `package.json` sets `"engines": { "node": ">=22.18.0" }`. npm prints an `EBADENGINE` warning and still starts the program; that warning is not a stop.

sideby then checks the version itself. Below 22.18, `--help`, `--version` and every other command print an upgrade hint and exit with 1. `statusline-tap` is the exception: Claude Code runs it on every status-line refresh, and it still runs your original command, so that refresh is not dropped.

## Where does sideby keep its data?

| What | Where |
|---|---|
| Config (sideby only writes `aliases`, from `new --alias`, `sideby alias` or the panel, `handoff`, from `sideby handoff enable`, `sideby handoff disable` or the panel, an account's model and effort arguments in `accounts.<ref>.args`, from `sideby model` or the panel, and `update.auto`, from the panel's update dialog) | `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json` |
| Your plugins | `${XDG_CONFIG_HOME:-~/.config}/sideby/plugins/` |
| State: quota cache, last Doctor result, original `settings.json` bytes, background panel pid and logs, the last update check (`update.json`) and the sessions running now (`running/`) | `${XDG_STATE_HOME:-~/.local/state}/sideby/` |
| Desktop app data per account (`sideby desktop`) | macOS `~/Library/Application Support/sideby/<family>/<name>/` |
| Grok Bot windows (`sideby desktop grok-bot:<name>`) | macOS `~/Library/Application Support/sideby/grok-bot/<name>/` |
| Panel app (`sideby app install`) | macOS `~/Applications/sideby.app`; Linux `~/.local/share/applications/sideby.desktop`, `~/.local/share/sideby/`, `~/.local/share/icons/hicolor/*/apps/sideby.*` |

sideby writes nothing of its own into Host account directories, except in these commands. Each shows the change first and writes only after you confirm:

- `sideby quota setup claude --yes` wraps the status line in `~/.claude/settings.json` ([Claude quota](usage.md#claude-quota)).
- `sideby handoff setup grok --yes` adds `~/.grok/hooks/sideby-handoff.json` ([Auto Handoff](usage.md#auto-handoff)).
- `sideby tune apply` sets `autoCompactWindow` in an account's `settings.json` ([Context tuning](usage.md#context-tuning)).
- `sideby remote-control off` sets `remoteControlAtStartup` to `false` in Claude's `settings.json` ([Remote Control](usage.md#remote-control)).
- `sideby advisor <model>` sets `advisorModel` in Claude's `settings.json`, and `off` removes it; choosing a model also removes `env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` where it is on, after showing it in the preview, and when API accounts share that file it turns on config `claude.apiBetasOff` so sideby gives them the variable at launch instead ([Advisor](usage.md#advisor)).

Each has a way back: `quota teardown claude`, `handoff teardown grok`, `tune undo`, `remote-control undo`, `advisor undo`. Account directories you create with `sideby new` belong to the Host.

## Why does sideby add `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` to my API account?

That variable stops Claude Code from sending `anthropic-beta` headers, which some API gateways reject, but it also hides `/advisor`. When you pick an Advisor model and the settings file that sets it is shared with an API account such as `claude:deepseek`, sideby removes it from the file and, in the same confirmed change, turns on config `claude.apiBetasOff`: from then on it adds `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` whenever it starts a Claude API account, so the gateway keeps working. It never does this for subscription accounts, and a value in the account's `proxy.env` or your environment wins. If your API account's gateway broke after an Advisor change, check `sideby advisor`; `sideby advisor undo` puts the variable back in the file, and `sideby config set claude.apiBetasOff false` turns the launch variable off.

## How is it different from aimux, agenv, cc-switch or magpie?

They solve related problems with different trade-offs; pick the one that fits how you work.

| | sideby | [aimux](https://github.com/Digital-Threads/aimux) | [agenv](https://github.com/combinatrix-ai/agenv) | [cc-switch](https://github.com/farion1231/cc-switch) | [magpie](https://github.com/yetone/magpie) |
|---|---|---|---|---|---|
| Model | one directory per account, run side by side | one directory per profile, run side by side | isolated profile with its own Host binary | switch the active provider in the Host's config | set each agent's model and provider from the menu bar |
| Hosts | Claude Code, Codex, Grok Build, pi | Claude Code, Codex, Gemini CLI | Claude Code, Codex, Gemini CLI | many, including Grok Build and pi | several agents |
| Quota | local records and status line data only | live limit probe; `run --auto` picks the subscription with the most headroom | — | remaining quota and balance on provider cards and the tray (some providers need "Configure usage query") | — |
| Shape | CLI, local web panel, local plugins | CLI with TUI | CLI with TUI | desktop app | menu bar app |

## How do I uninstall?

```sh
sideby quota teardown claude                  # first, if you ran quota setup; the status line calls sideby
sideby handoff teardown grok                  # if you ran handoff setup grok; the hook calls sideby
sideby ui --stop && sideby app uninstall       # if you use the panel app
npm rm -g sideby
rm -rf ~/.config/sideby ~/.local/state/sideby  # or your XDG_CONFIG_HOME / XDG_STATE_HOME paths
```

Remove the `eval "$(sideby shell-init …)"` line from your shell rc file. Account directories such as `~/.claude-work` stay; delete them yourself if you no longer need them.
