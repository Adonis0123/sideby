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
| `api.family(def)` | when the plugin loads | Add a Family: directory layout, selection variable, Hijack Variables, default arguments, Shared Items, sign-in command, login check, model, optional `logo`, `website` and `history` (see below), `readQuota`, `readUsage`, `quotaSetup`, `keepTitle` (Host arguments that keep the title config `accountTitle` sets) `probe` (the Host arguments for one short non-interactive request, which `sideby try` runs; its optional `model` names the Host options that choose a model and the arguments for `sideby try --model`) and `aiTaskArgs` (removes the arguments that switch the Host's permission checks off before an AI Task starts, and may add the Host's safe mode) | — |
| `api.projectCategories(def)` | when the plugin loads | Sort Projects into categories the Sessions page can group by (see below); only the first plugin that registers one is used | 3 s per answer |
| `launch.before` | before every `run` and `login` | Change `ctx.env` and `ctx.args`, or stop the launch with `throw api.abort(msg)` | 30 s |
| `account.create.before` | before `new` (CLI or panel) writes anything | Refuse the new account with `throw api.abort(msg)`; `ctx` has `family`, `name`, `api`, the family's existing `accounts` and `config`. The CLI exits 1 and the panel shows `msg`, so say what to do instead | 10 s |
| `account.created` | after `new` succeeds | Add files, print next steps with `ctx.log()` | 30 s |
| `doctor.check` | for each account during Doctor | Return Findings, each optionally with a `fix()` | 10 s |
| `unattended.ended` | when a stretch of Unattended Mode ends (a Slot or a manual `on`), seen by the background panel within 30 s or by the next sideby command; stretches that ended while sideby did not run come oldest first, at most 50 a look | Pass it on to your own notifier. Delivery is at least once: an event whose handlers did not finish (sideby was ended meanwhile) comes again, with the same `ctx.id`, so skip an id you have seen. `ctx` also has `startedAt`, `endedAt`, `reason` (`slot` or `manual`), `late: true` when it was noticed more than 12 hours after it ended, and `pending`, the Pending Decisions kept during it that are still open. It belongs to no Family: register it without a `family` filter. sideby itself sends nothing | 30 s |

A Family's `logo` is the mark the panel shows on its cards and in the Tool select: one SVG path in a 24×24 view box, for example from [Simple Icons](https://simpleicons.org).

```ts
logo: { path: 'M11.503.131 1.891 5.678…', title: 'Cursor', color: '#000000' } // color is optional
```

`path` may hold only SVG path data (commands, numbers, spaces, commas, dots, `+`, `-`; up to 20000 characters), `color` must be a hex color and `fillRule` is `nonzero` or `evenodd`. A multicoloured mark adds `gradients`: up to 4 washes `{ from: [x, y], to: [x, y], color }`, each fading from its hex `color` at `from` to clear at `to` over the base `color` (points are numbers from -24 to 48). An invalid logo is dropped with a plugin error in `sideby plugins`; the Family still loads and the panel shows its initials. Leave out `color` for a black mark so it follows the text color in dark mode.

A Family's `website` gives its subscription accounts **Open in browser** and **Choose** under the panel's sign-in cell, like Claude, Codex and Grok (ADR-0043):

```ts
website: {
  url: 'https://cursor.com/dashboard',
  // Optional: lets sideby find the Chrome browser user signed in to each account by itself.
  match: {
    origin: 'https://cursor.com',
    // An id the website also puts in its Local Storage key names; read it from the Host's own login file.
    async signInId(account) {
      const cfg = JSON.parse(await readFile(join(account.dir, 'cli-config.json'), 'utf8'))
      return String(cfg.authInfo?.authId ?? '').split('|').pop() || undefined
    },
  },
}
```

`url` must be an `https://` address with no query or fragment (letters, digits and `._~/-` in the path). `origin` is the website's origin, with no path. Return an id, never a token: sideby compares it with the key names in memory and never shows, logs or keeps it; ids shorter than 8 characters are ignored, and a reader that throws only adds a problem naming the account. Without `match`, the user picks the browser user, and an account whose login email is a browser user's Google account is still found. An invalid `website` is dropped with a plugin error (`website.invalid` in `sideby plugins check`); the Family still loads.

A Family's `history` lets the **Sessions** page and `sideby history` list, search and open its past sessions, like the built-in tools (ADR-0044). Without it, that AI's accounts are listed as having no history sideby can read.

```ts
history: {
  // One entry per session: the record file or folder, and a signature that changes when it changes.
  async list(account, problems) { /* … */ return [{ path, sig, mtimeMs }] },
  // The session in one entry: id, folder, title, times, and the text the person typed and the model replied.
  async parse(file, account) { /* … */ return { sessionId, cwd, title, titleFrom: 'host', messages, script: false, prompts, replies } },
  async *messages(path) { yield { role: 'user', text: '…' } },
  resumeArgs: (id) => ['--resume', id], // the Host arguments that continue a session
}
```

Read only the Host's own session records, never its login file. Put in `prompts` only what the person typed and in `replies` only the model's text: no tool calls or tool output, no context the Host injected. sideby keeps those two in the History Index on this machine. `toolText(path)` is optional and is read only while someone searches tool output; `titles(account)` is optional for titles the Host keeps apart. A `history` whose members are not functions is dropped with a plugin error; the Family still loads.

`api.projectCategories({ label, categoriesOf })` sorts Projects into your own groups, for example by client or workspace. sideby passes many Project paths at once; return `{ [path]: categoryName }` and leave out paths without one. `label` is what the groups are called on screen ("Workspace"; "Category" when left out). Answers are kept for about a minute; one that takes longer than 3 s or throws adds one problem naming your plugin, and the list is shown without categories. The Sessions page then offers **Display → Group by → Category** and nests Projects under them in the side list; `sideby history --group category` and `--category <name>` do the same.

Errors always name the plugin. A plugin that fails to load affects only itself; a failing `doctor.check` becomes a fail Finding for that account; a failing `launch.before` stops the launch; a family reader that throws (for example `model`) shows up as one of that account's `problems` in `list`. A `fix()` may write only inside the current account directory, through `api.fs.writeFileAtomic`.


`FamilyDef.fetchQuota.localFallbackOnly` is optional (default `false`). Set it when the Host replays cached quota in newer local events: once a successful fetch exists, sideby prefers it over local readings, including across directories of the same login. Failed queries retain the previous reading with `fetchError` and its original observation time.
## Add a tool sideby does not support

A Host that sideby does not list can work today as a local Family Plugin. The easiest way is to let your AI do it: choose **Other tool…** in the panel's new-account dialog, or run `sideby ask --task host`. To do it by hand:

```sh
sideby plugins new mytool      # ~/.config/sideby/plugins/mytool/: plugin.json, index.ts, index.test.ts
$EDITOR ~/.config/sideby/plugins/mytool/index.ts
sideby plugins check mytool    # repeat until it passes
```

`plugins new` writes into your first plugin directory, with the modes the loader's trust checks require, and refuses a directory that already exists. `index.ts` is an `api.family(def)` skeleton with a `TODO` at each field you must fill in. What to find out, each from the tool's own docs or `--help`, with the version and date you checked:

- the binary name and how to install it;
- the environment variable that points the tool at another config directory (without one, sideby cannot run its accounts side by side);
- where the main directory is and how an account directory looks;
- Hijack Variables: environment variables that would override an account;
- the sign-in command, and a login check that only looks at whether a file exists, never at what it holds;
- each Shared Item and its Share Mode, and whether the tool refuses links;
- local quota or usage files, if any (otherwise leave the readers out);
- a logo, with its source and license.

`plugins check` runs the same checks CI runs on the built-in families: required fields, Shared Item paths (relative, no `..`), the logo, type-only imports from sideby, a discover, launch and Doctor round, and a scan for personal data such as real home paths, emails and token-shaped strings. Each problem says how to fix it. It runs the plugin only when sideby would load it (you own every file and nobody else can write them); otherwise it only reads the files and reports that first. The round runs in a separate Node process whose HOME points at a throwaway folder, and stops after 20 seconds. That keeps the check's own files out of your accounts, but it is not a sandbox: the plugin runs with your full permissions, just as it does in sideby. When it works for you and you would like everyone to have it, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

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
