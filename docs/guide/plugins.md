# Plugins

English | [中文](plugins.zh-CN.md)

← [README](../../README.md)

> [!WARNING]
> **A plugin is local code with your full permissions.** sideby imports it into its own process; it can read and write anything you can. Only load plugins you wrote or have read. sideby refuses a plugin whose directory, `plugin.json` or entry file is owned by another user or writable by group or others.

sideby loads built-in plugins first, then every directory in `${XDG_CONFIG_HOME:-~/.config}/sideby/plugins/`, then `pluginDirs`. Built-in families are plugins too.

```
my-plugin/
├── plugin.json      # name, version, description, optional main and userConfig
├── index.ts         # export default { name, register(api) } satisfies Plugin
└── index.test.ts    # optional; test with sideby/testing
```

```json
{ "name": "litellm-gateway", "version": "0.1.0", "description": "Check the local gateway before launch" }
```

```ts
import type { Plugin } from 'sideby' // type imports only

export default {
  name: 'litellm-gateway',
  register(api) {
    api.on('launch.before', { family: 'claude' }, async (ctx) => {
      if (ctx.account.kind !== 'api') return
      const port = Number(ctx.config.port ?? 4000)
      const up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)
      if (!up) throw api.abort(`gateway on port ${port} is not running; start it first`)
    })
  },
} satisfies Plugin
```

- Write plugins in `.ts` or `.js`. Node 22.18+ loads `.ts` from disk without a build step. The entry file is `index.ts` unless `plugin.json` sets `main`.
- Use `import type` only. sideby passes everything a plugin needs through `api`, which keeps plugins working if sideby ships as a single binary later. Install sideby as a dev dependency (`npm i -D sideby`) to get the types; [`src/types.ts`](../../src/types.ts) is the full contract.
- The `name` in `plugin.json` must match the exported `name`. A second plugin with the same name is reported as a conflict and not loaded.
- `ctx.config` holds this plugin's settings from `config.plugins.<name>`, with `userConfig` defaults filled in.

| Extension point | When | What it can do | Timeout |
|---|---|---|---|
| `api.family(def)` | when the plugin loads | Add a Family: directory layout, selection variable, Hijack Variables, default arguments, Shared Items, sign-in command, login check, model, optional `logo`, `readQuota`, `readUsage` and `quotaSetup` | — |
| `launch.before` | before every `run` and `login` | Change `ctx.env` and `ctx.args`, or stop the launch with `throw api.abort(msg)` | 30 s |
| `account.create.before` | before `new` (CLI or panel) writes anything | Refuse the new account with `throw api.abort(msg)`; `ctx` has `family`, `name`, `api`, the family's existing `accounts` and `config`. The CLI exits 1 and the panel shows `msg`, so say what to do instead | 10 s |
| `account.created` | after `new` succeeds | Add files, print next steps with `ctx.log()` | 30 s |
| `doctor.check` | for each account during Doctor | Return Findings, each optionally with a `fix()` | 10 s |

A Family's `logo` is the mark the panel shows on its cards and in the Tool select: one SVG path in a 24×24 view box, for example from [Simple Icons](https://simpleicons.org).

```ts
logo: { path: 'M11.503.131 1.891 5.678…', title: 'Cursor', color: '#000000' } // color is optional
```

`path` may hold only SVG path data (commands, numbers, spaces, commas, dots, `+`, `-`; up to 20000 characters), `color` must be a hex color and `fillRule` is `nonzero` or `evenodd`. An invalid logo is dropped with a plugin error in `sideby plugins`; the Family still loads and the panel shows its initials. Leave out `color` for a black mark so it follows the text color in dark mode.

Errors always name the plugin. A plugin that fails to load affects only itself; a failing `doctor.check` becomes a fail Finding for that account; a failing `launch.before` stops the launch; a family reader that throws (for example `model`) shows up as one of that account's `problems` in `list`. A `fix()` may write only inside the current account directory, through `api.fs.writeFileAtomic`.

## `account-script`

A built-in plugin, off by default, for "run this before the account starts" (for example, start a local gateway that an API account needs):

```json
{ "plugins": { "account-script": { "enabled": true } } }
```

```sh
$EDITOR ~/.claude-deepseek/sideby-before-launch
chmod 700 ~/.claude-deepseek/sideby-before-launch
```

Before each launch of that account, sideby runs `sideby-before-launch` with the account directory as working directory and the prepared launch environment. The file must be yours, executable, and not writable by group or others. If it fails or does not finish within 25 seconds, the Host is not started and sideby shows the last 20 lines of its stderr.
