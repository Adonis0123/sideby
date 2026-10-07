# sideby

**Run every AI coding account side by side.**

Claude Code, Codex, Grok Build and pi, each account in its own directory, all sharing one set of skills, hooks and rules, with a quota panel that shows every account at once.

```sh
npx sideby            # try it
npm i -g sideby       # install the `sideby` command
```

English | [中文](README.zh-CN.md)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png">
  <img alt="sideby panel: every account's 5h and 7d quota, 7-day token usage and health in one page" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png" width="1280">
</picture>

## Why

- **Side by side, not switching.** Tools such as cc-switch and magpie change a Host's global config, so one provider is active at a time; that suits people who move between providers. sideby keeps every account in its own directory and starts the official CLI with that directory selected. Your work subscription, personal subscription and a DeepSeek key can run in three terminals at the same time, and the parent shell is never changed.
- **One copy of skills, hooks and rules.** The Main Account (for example `~/.claude`) is the source. Other accounts link or copy its Shared Items, using the rule each Host needs. `sideby doctor` finds drift and `--fix` repairs what is safe. It never replaces a real file, never changes where a link points, and never reads credential values.
- **Every quota on one screen.** `sideby quota` and `sideby ui` show each account's 5-hour and 7-day quota, when it resets, how old the data is, and the last 7 days of tokens. sideby reads Claude Code and Codex local records itself (no ccusage needed) and takes Claude quota from the data Claude Code passes to your status line. No network calls, no token reads.

## Quick start

Requires Node 22.18 or later and at least one Host CLI installed and signed in.

```sh
sideby                        # list accounts; with only ~/.claude you see claude:main
sideby new claude work        # create ~/.claude-work, linked to your shared config
sideby login claude:work      # sign in once, in your own terminal
sideby run work               # start Claude Code with the work account
```

`sideby run claude:main` keeps using `~/.claude` at the same time. Arguments after `--` go to the Host: `sideby run work -- --resume`.

With a few accounts, `sideby list` looks like this:

```
ACCOUNT          TYPE  LOGIN         EMAIL             MODEL        DIR
claude:main      main  ✓             me@example.com    opus         ~/.claude
claude:deepseek  api   key           —                 deepseek-v4  ~/.claude-deepseek
claude:work      sub   ✓             work@example.com  opus         ~/.claude-work
codex:team       sub   ✓             team@example.com  gpt-5.5      ~/.codex-team
grok:lab         sub   login needed  —                 grok-code    ~/.grok-lab
```

EMAIL is who the account is signed in as, read from the host's login file (Claude Code, Codex, Grok Build). sideby reads only that identity field there, never a token (ADR-0003).

If a family plugin fails while reading an account (for example its settings file is not valid JSON), `list` still shows the account and prints the problem on stderr; `list --json` puts it in that account's `problems` array.

### API accounts

```sh
sideby new claude deepseek --api
$EDITOR ~/.claude-deepseek/proxy.env     # fill in the variables; the file stays mode 600
sideby run deepseek
```

`proxy.env` uses a small dotenv subset (`KEY=VALUE`, optional `export `, quotes, `#` comments, and `$NAME` / `${NAME}` referring to a key set earlier in the same file or to `HOME`, `USER`, `LOGNAME`, `TMPDIR` or an `XDG_*_HOME` location; no other shell variable is read and there is no command substitution). Its variables reach only the launched Host process. sideby refuses to start unless the file's mode is exactly 600 and tells you to run `chmod 600`.

An API account needs no sign-in: its login state is `not-needed`, shown as `key` in the LOGIN column of `sideby list`.

pi is the exception. pi can keep a `proxy.env` in any account to load provider keys, so sideby loads the file at launch but still treats the account as a subscription account that signs in with `/login`.

### Doctor

```sh
sideby doctor            # every account
sideby doctor work       # one account, or a family: sideby doctor grok
sideby doctor --fix      # apply the safe repairs
```

```
✓ claude:work subscription shared 4/4  ~/.claude-work
✗ grok:lab subscription shared 2/3  ~/.grok-lab
    fail hooks must be a real copy, not a link (host says: "Grok hooks directory has wrong type (expected real directory)")
         run `sideby doctor --fix` to replace the link with a copy

1 issue(s) can be fixed with `sideby doctor --fix`.
```

- `shared n/m` counts the Shared Items the Main Account actually has. An item the Main Account does not have (many people have no `commands` or `themes`) is skipped: no warning, not counted.
- A link whose target exists but is not the Main Account's item is a warning (`link.other-target`), since you may have set it up on purpose; where the Host needs a real file or copy, any link is a failure (`symlink-forbidden`). A dangling link is a failure (`link.dangling`). sideby never changes where a link points; it only reports.
- A real file or directory where a link belongs is reported with a command to keep it (`mv <x> <x>.local && ln -s …`). sideby never replaces it.
- Credential files (`proxy.env`, `auth.json`, `.claude.json`) are checked for type and mode 600; `--fix` sets the mode back to 600. The only content sideby reads from them is the `mcpServers` key of `.claude.json`, which it keeps in sync with the Main Account, and the identity fields shown as the account's email (`oauthAccount.emailAddress` and `organizationName` of `.claude.json`, the `email` of Grok's `auth.json` entry, the `email` claim of Codex's `id_token`); tokens are never read out, stored or shown. `--force` allows that sync to remove servers the account has and the Main Account does not.
- Backup leftovers (`*.bak*`, `*backup*`, `*.tmp*`) are counted, never touched.

Warnings alone exit 0; any failure exits 1.

### Panel

```sh
sideby ui              # http://127.0.0.1:17420, opens your browser
sideby ui --port 8080
sideby ui --no-open    # print the address only
```

The panel listens on `127.0.0.1` only. If another sideby panel already runs on the port, sideby opens that one; if another program holds the port, it tries the next ones and prints the address it used. The page shows each account's quota windows in aligned columns, usage, last use, sign-in email and health, and refreshes itself every 20 seconds while it is open (every 5 seconds for a few minutes after you turn on quota, so the first numbers appear soon after a status line reports them). A "Hide emails" switch masks addresses as `a•••@example.com` for screen sharing. It runs Doctor with one-click fixes, creates accounts (with an optional short command), and can turn on Claude quota after showing the diff. One quota setup covers every Claude Code account, so the "Turn on quota" button sits in the Claude Code group header, not on each account. For a new subscription account it gives you the `sideby login <account>` command to copy; signing in always happens in your terminal.

#### Desktop app

```sh
sideby app install       # macOS: ~/Applications/sideby.app; Linux: a "sideby" entry in the app menu
sideby app uninstall
sideby ui --background   # what the app runs: start the panel without a terminal, then open it
sideby ui --stop         # stop the background panel
```

Double-click the app to open the panel. It starts the panel in the background when none is running (`sideby ui --background`), reuses it when one is, and opens your browser. The background panel keeps running after you close the tab and logs to `${XDG_STATE_HOME:-~/.local/state}/sideby/panel.log`. Apps started from Finder or a desktop menu get a minimal PATH, so the background panel asks your login shell (`$SHELL -ilc`) for its PATH to find hosts in places like `~/.local/bin`.

The app runs the Node and sideby it was installed with: after upgrading either, run `sideby app install` again to update it in place. If your own page embeds the panel (see below), `sideby app install --url http://accounts.localhost:17333/` makes the app open that address instead. Install and uninstall only touch files that `sideby app install` created. The app is a local, unsigned launcher script; it is not meant to be copied to other machines.

#### Embed the panel

Another local Node page can mount the panel under its own path. The handler keeps its own Host, Origin and token checks; you list the hosts your page answers on.

```ts
import { createServer } from 'node:http'
import { createPanelHandler, createRuntime } from 'sideby'

const panel = createPanelHandler({
  runtime: () => createRuntime(), // a factory: every request sees the disk as it is now
  basePath: '/accounts',
  allowedHosts: ['tools.localhost:8080'],
  theme: {
    colorScheme: 'light', // 'auto' (default) follows the system
    header: 'bar', // a full-width header strip instead of a title on the page background
    light: { font: '-apple-system, "PingFang SC", sans-serif', bg: '#f2f8fc', primary: '#e1f0fb', onPrimary: '#1f6396', radius: '10px', shadow: 'none' },
  },
})
createServer(async (req, res) => {
  if (!(await panel(req, res))) res.writeHead(404).end()
}).listen(8080, '127.0.0.1')
```

`theme` makes the page match yours. Its tokens become CSS custom properties inside the page's own nonce'd `<style>`, so the panel's strict CSP stays as it is. An iframe cannot read its parent's CSS variables, so pass concrete values.

- **Tokens** (all optional): type `font`, `monoFont`, `fontSize`, `smallSize`, `controlSize`, `headingSize`, `largeSize`, `titleSize`, `titleWeight`, `headingWeight`, `strongWeight`, `buttonWeight`, `primaryWeight`; colors `bg`, `surface`, `surfaceMuted`, `border`, `borderStrong`, `text`, `muted`, `faint`, `hover`, `active`, `accent`, `accentSoft`, `focus`, `primary`, `primaryHover`, `primaryActive`, `onPrimary`, `primaryBorder`, `primaryHoverBorder`, `buttonText`, `buttonHoverBorder`, `buttonHoverText`, `checkColor`, `ok`, `okSoft`, `warn`, `warnSoft`, `fail`, `failSoft`, `logoBg`, `logoColor`, `logoBorder`, `shadow`, `focusOutline`, `focusRing`; shape and layout `radius`, `controlRadius`, `chipRadius`, `controlHeight`, `controlHeightSmall`, `fieldHeight`, `contentWidth`, `gutter`. [`src/panel/theme.ts`](src/panel/theme.ts) documents each one.
- **Light and dark**: colors in `light` apply in light mode only; type, shape and layout tokens apply in both. Give `dark` for dark-mode colors, or set `colorScheme: 'light'` when your page has no dark mode.
- **Checked when the handler is created**: an unknown token, or a value with anything but letters, digits, spaces and `# % ( ) , . + - / ' " _` (so no `;`, `{`, `}`, `<`, `\`, `*` or `:`), with `url(`, unbalanced parentheses or quotes, or over 200 characters, throws a `TypeError` that names the token.
- Without `theme`, the page looks the same as `sideby ui`.

### Claude quota

Claude Code passes quota data only to its status line command, so sideby needs a one-time, reversible change:

```sh
npm i -g sideby                   # the status line calls `sideby` on every refresh
sideby quota setup claude         # shows the diff, changes nothing
sideby quota setup claude --yes   # writes the change
sideby quota                      # 5h / 7d per account, with data age
sideby quota teardown claude      # restores the original file byte for byte
```

`setup` edits `~/.claude/settings.json`. It wraps your `statusLine.command` as `sideby statusline-tap --orig-b64 <base64 of your command>`; base64 keeps your command's quotes and spaces intact. If you have no status line, it sets `sideby statusline-tap`, which prints a short line such as `5h 72% · 7d 44%`. The original bytes go to sideby's state directory. Your status line output does not change; in our tests the extra cold start had a median of about 82 ms.

Because Claude Code runs the wrapper on every refresh, `setup` refuses when `sideby` is not on `PATH` or comes from the npx cache, and tells you to run `npm i -g sideby` first.

`teardown` writes the original back only if the file is still exactly what `setup` wrote. If you changed it since, `teardown` refuses and shows the diff; set `statusLine.command` back to your original command by hand (it is the base64 after `--orig-b64`), or delete `statusLine` if you had none.

Accounts that link `settings.json` to the Main Account (the default) get quota from the same setup. An account with its own `settings.json` shows quota as not enabled until that file's status line is wrapped the same way. Codex quota needs no setup: sideby reads it from local session files.

### When an account hits its limit

```sh
sideby next claude              # pick the account with the most quota left and start it
sideby next codex --dry-run     # only show the pick
sideby next claude -- --model opus  # Host arguments go after --
```

`next` ranks the family's accounts by their fullest quota window that has not reset yet, starts the lowest one, and lists the rest with why they were left out:

```
   ACCOUNT        STATE       NOTE
→  claude:work    ready       fullest window 23%
   claude:new     unknown     no quota data yet
   claude:key     api         left out; add --include-api to use it
   claude:main    full        back at 14:30
```

- Accounts with a window at 85% or more are full; a window whose reset time has passed counts as empty again.
- Accounts without quota data yet come after the ones with known room. API accounts cost money per request, so they join only with `--include-api`.
- When every account is full, nothing starts and sideby tells you which one comes back first. When no account has quota data yet, nothing starts either: the pick would only be a guess. Turn quota on (`sideby quota setup claude`) or choose with `sideby run`.
- The new account starts a new session: each account keeps its own sessions. Ask the old session for a short handoff note and paste it in.
- Claude and Codex only; Grok and pi publish no quota, so `next grok` lists the accounts for you to choose.

sideby recommends; you start the account. It never switches or rotates by itself (see the FAQ). The panel marks the same pick as **Next** in each family.

## Commands

| Command | What it does | Exit code |
|---|---|---|
| `sideby` | Same as `sideby list` | 0 |
| `sideby list` | Accounts, type (main, sub or api), login state, model, directory; reading problems go to stderr | 0 |
| `sideby run <acct> [-- args]` | Start the Host for one account | the Host's code; 128+n if killed by signal n |
| `sideby new <family> <name> [--api] [--alias <short>]` | Create an account and lay out its Shared Items; `--alias` also adds a short command such as `cc008` to `aliases` | 0; 1 if partly failed or the alias was not added |
| `sideby alias add <short> <acct> [-- args]` | Add a short command for an existing account, optionally with Host arguments that `sideby run` adds | 0, also when it already exists; 1 if the name is taken, invalid or the account does not exist |
| `sideby alias rm <short>` | Remove a short command | 0, also when it is not there |
| `sideby login <acct>` | Run the family's sign-in command for that account; for pi, start pi and tell you to type `/login` | the Host's code |
| `sideby next <family> [--dry-run] [--include-api] [-- args]` | Recommend the account with the most quota left (Claude, Codex) and start it; `--dry-run` only recommends | the Host's code; 0 for `--dry-run` or `--json` with a pick; 1 if no account can be used, none has quota data yet, the family has no quota source or no accounts |
| `sideby doctor [acct\|family] [--fix] [--force]` | Check Shared Items, credential file modes, leftovers; `--fix` repairs what is safe | 0 no failures (warnings allowed); 1 at least one failure |
| `sideby quota [acct]` | Quota and 7-day usage | 0 |
| `sideby quota setup claude [--yes]` | Show the change; with `--yes`, turn the Claude quota source on | 10 when it only showed the change; 0 once on; 1 if blocked or failed |
| `sideby quota teardown claude` | Turn it off and restore the original file | 0; 1 if refused or failed |
| `sideby ui [--port n] [--no-open]` | Local panel; runs until Ctrl+C | — |
| `sideby ui --background` / `--stop` | Start the panel detached from the terminal (reusing a running one, or replacing it after sideby was upgraded) and open it / stop it | 0; 1 if it could not start or stop |
| `sideby app install [--url <url>]` | Add a desktop app (macOS, Linux) that opens the panel, or `<url>` | 0; 1 on an unsupported platform or a file it did not create in the way |
| `sideby app uninstall` | Remove what `app install` created | 0; 1 if it left a file it did not create |
| `sideby shell-init zsh\|bash` | Print shell functions for every account and your aliases | 0 |
| `sideby shell-init [zsh\|bash] --write` | Rewrite the configured `shellInitFile` with that output | 0; 1 if a file could not be written or none is configured |
| `sideby plugins` | Loaded plugins and load errors | 0; 1 if any plugin failed to load |

- Every command exits 2 on a usage error (unknown option, missing argument) and 1 when sideby itself fails (unknown account, invalid name, unreadable config). Exit code 10 means a change was shown and waits for your yes: run the same command again with `--yes`.
- `<acct>` is `<family>:<name>`, or just `<name>` when it is unique across families. An ambiguous name is an error that lists the candidates.
- `list`, `new`, `next`, `alias`, `doctor`, `quota` (including `setup` and `teardown`), `plugins` and `app` accept `--json`. JSON output carries `schemaVersion: 1`, and the JSON Schemas ship in [`schemas/`](schemas/). With `--json`, an error prints `{ "schemaVersion": 1, "error": "…", "code": "…" }`, where `code` is `usage` for a malformed command line or a reason such as `no-quota-source`. Adding a field keeps the version; removing, renaming or changing the meaning of a field bumps it.
- No output, log or error message ever contains a credential value.

## Accounts

| Family | Main Account | Other accounts | Selected with |
|---|---|---|---|
| claude | `~/.claude` | `~/.claude-<name>` | `CLAUDE_CONFIG_DIR` |
| codex | `~/.codex` | `~/.codex-<name>` | `CODEX_HOME` |
| grok | `~/.grok` | `~/.grok-<name>` | `GROK_HOME` |
| pi | `~/.pi/agent` | `~/.pi-<name>/agent` | `PI_CODING_AGENT_DIR` |

Accounts are found on disk; you never list them by hand. A name matches `^[a-z0-9][a-z0-9-]{0,31}$`, so `004` and `work` are both fine. A directory counts as an account only if it holds a `proxy.env` or at least one of the family's Shared Items, so another tool's directory that happens to match the pattern, such as claude-code-router's `~/.claude-code-router`, is not picked up. The Main Account is always called `main` and runs without the selection variable. Before every launch sideby clears Hijack Variables (for example a global `ANTHROPIC_API_KEY`) so an inherited value cannot override the account's identity.

## Configuration

Optional. `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json`, schema in [`schemas/config.json`](schemas/config.json):

```json
{
  "accounts": {
    "claude:work": { "args": ["--model", "opus"] }
  },
  "aliases": {
    "cc": "claude:main",
    "ccw": "claude:work",
    "cx": "codex:main",
    "pi-kimi": { "account": "pi:main", "args": ["--model", "kimi-coding/k3"] }
  },
  "ignore": ["claude:backup"],
  "pluginDirs": ["~/code/sideby-plugins/litellm-gateway"],
  "plugins": {
    "account-script": { "enabled": true },
    "litellm-gateway": { "port": 4000 }
  },
  "extraSharedItems": {
    "claude": [
      { "path": "statusline-command.sh", "mode": "link" },
      { "path": "scripts", "mode": "link" }
    ]
  },
  "shellInitFile": { "zsh": "~/.config/sideby/shell-init.zsh" }
}
```

| Field | Meaning |
|---|---|
| `accounts.<ref>.args` | Arguments added for one account. Order: family defaults, then these, then an alias's `args`, then what you pass after `--`. sideby adds no dangerous flags by default; put them here per account if you want them. |
| `aliases` | Short names mapped to an account ref, or to `{ "account": "<ref>", "args": [...] }` for one account started with fixed Host arguments (another model, say). `shell-init` turns each into a shell function, and commands such as `sideby run` and `sideby doctor` accept them too; only `sideby run` adds the `args`. Two aliases of one account share its login and sessions. An alias cannot set environment variables. |
| `ignore` | Account refs (`<family>:<name>`) that look like accounts but are not. Doctor warns about names containing `bak`, `backup`, `old` or `tmp` and suggests adding them here. |
| `pluginDirs` | Extra plugin directories. Absolute paths or paths starting with `~/`. |
| `plugins.<name>` | Settings for one plugin; `enabled` turns it on or off, built-in families included. |
| `shellInitFile` | Optional `{ "zsh": …, "bash": … }`, absolute or `~/` paths. Whenever sideby adds an account or adds or removes an alias (`sideby new`, `sideby alias`, the panel), it rewrites each file with what `sideby shell-init <shell>` prints, so a shell that sources the file picks up new commands. It never overwrites a file that `shell-init` did not write. |
| `extraSharedItems.<family>` | Your own Shared Items on top of the built-in list, each with a Share Mode (`link`, `copy`, `link-or-copy`, `link-or-local`, `local`, `local-if-api`, `info`, `json-key`). `path` is relative to the account directory; absolute paths and `..` are rejected. |

### Shell functions

```sh
# ~/.zshrc (or ~/.bashrc with `bash`)
eval "$(sideby shell-init zsh)"
```

This defines one function per account, such as `sideby-claude-work`, plus one per alias. With the config above, `ccw --resume` is the same as `sideby run claude:work -- --resume`. Accounts created later need a new shell (or another `eval`) before their function exists.

To add a short command when you create an account, pass `--alias` (`sideby new claude 008 --alias cc008`) or fill in "Short command" in the panel's New account dialog. The panel suggests one from your other aliases of that family: `cc001` … `cc007` for `claude:001` … `claude:007` suggest `cc008`; aliases that do not end in their account's name, such as `codex001` for `codex:main`, are ignored. The alias goes into `aliases` in the config file, which sideby rewrites with every other key kept in order; it refuses a config that is not valid JSON and leaves it alone. If the account was created but the alias could not be written, it says so.

For an account that already exists, or to start one account with other Host arguments, use `sideby alias add`:

```sh
sideby alias add pi-kimi pi:main -- --model kimi-coding/k3   # pi-kimi = pi001 with another model
sideby alias rm pi-kimi
```

The panel shows every alias next to its account (hover one to see its arguments) and finds an account by them in search. Entry points that also change environment variables are not aliases; keep them in your shell rc.

If you prefer sourcing a file over `eval` (a new shell then does not start Node), set `shellInitFile` and source it:

```sh
sideby shell-init zsh --write                            # writes ~/.config/sideby/shell-init.zsh once
echo 'source ~/.config/sideby/shell-init.zsh' >> ~/.zshrc
```

sideby keeps that file up to date from then on. With `eval "$(sideby shell-init zsh)"` there is nothing to set up.

## Supported hosts

Tested on 2026-10-05 with the versions below. sideby starts the official binary found on `PATH`; it never patches or wraps it.

| Host | Family | Tested version | Sign-in | Quota | Usage (7 days) |
|---|---|---|---|---|---|
| Claude Code | `claude` | 2.1.289 | `claude auth login` | status line cache (after `quota setup claude`) | local session records |
| Codex CLI | `codex` | 0.160.0 | `codex login` | local session files | local session files |
| Grok Build | `grok` | 1.0.46 | `grok login` | no public source | no public source |
| pi | `pi` | 1.0.2 | `/login` inside pi | no public source | no public source |

sideby counts usage itself from Claude Code's `projects/**/*.jsonl` and Codex's `sessions/**/rollout-*.jsonl`; you do not need ccusage. Grok Build and pi have no quota or usage source. API accounts show usage but no quota. If a Host is not installed, `list` still shows its accounts and marks the Host as missing; `run` tells you where to install it.

Host-specific notes:

- **codex**: non-main accounts get `-c cli_auth_credentials_store="file"` unless your arguments already set that key, so each account keeps its login in its own `auth.json`.
- **grok**: Grok's sandbox rejects symlinks for some paths, so `hooks` and `hooks-paths` are copies, not links, and `trusted_folders.toml` and `config.toml` are the account's own files. Doctor quotes the Host's own message when it finds one.
- **pi**: accounts live one level deeper (`~/.pi-<name>/agent`). `proxy.env` only loads provider keys; it does not make a pi account an API account.

## Plugins

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
- Use `import type` only. sideby passes everything a plugin needs through `api`, which keeps plugins working if sideby ships as a single binary later. Install sideby as a dev dependency (`npm i -D sideby`) to get the types; [`src/types.ts`](src/types.ts) is the full contract.
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

### `account-script`

A built-in plugin, off by default, for "run this before the account starts" (for example, start a local gateway that an API account needs):

```json
{ "plugins": { "account-script": { "enabled": true } } }
```

```sh
$EDITOR ~/.claude-deepseek/sideby-before-launch
chmod 700 ~/.claude-deepseek/sideby-before-launch
```

Before each launch of that account, sideby runs `sideby-before-launch` with the account directory as working directory and the prepared launch environment. The file must be yours, executable, and not writable by group or others. If it fails or does not finish within 25 seconds, the Host is not started and sideby shows the last 20 lines of its stderr.

## FAQ

### Does this break any terms of service?

sideby is built to stay inside what each Host already supports (see [ADR-0001](docs/adr/0001-side-by-side-not-switching.md) and [ADR-0003](docs/adr/0003-quota-from-local-and-official-sources.md)):

- It does not switch: it never edits a Host's global config to change the active account. Each account is a separate config directory, the mechanism every Host documents (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`).
- It does not rotate: it never moves to another subscription when a quota runs out. `sideby next` recommends the account with the most room from data already on your machine; starting it is your call.
- It does not proxy credentials: it never reads a subscription token to call a model, and never pools logins.
- It does not call private endpoints: quota comes from local files and from data Claude Code hands to your status line command.

This is the maintainers' own reading of the rules, not legal advice. Check your provider's terms for your situation.

### Why Node 22.18?

From 22.18, Node strips TypeScript types by default, so sideby can `import()` your `.ts` plugins straight from disk. On older Node, sideby prints an upgrade hint and exits with 1.

### Where does sideby keep its data?

| What | Where |
|---|---|
| Config (sideby only writes `aliases` in it, from `new --alias`, `sideby alias` or the panel) | `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json` |
| Your plugins | `${XDG_CONFIG_HOME:-~/.config}/sideby/plugins/` |
| State: quota cache, last Doctor result, original `settings.json` bytes, background panel pid and logs | `${XDG_STATE_HOME:-~/.local/state}/sideby/` |
| Desktop app (`sideby app install`) | macOS `~/Applications/sideby.app`; Linux `~/.local/share/applications/sideby.desktop`, `~/.local/share/sideby/`, `~/.local/share/icons/hicolor/*/apps/sideby.*` |

sideby writes nothing of its own into Host account directories. The one exception is `quota setup claude --yes`, which changes `~/.claude/settings.json`. Account directories you create with `sideby new` belong to the Host.

### How is it different from aimux, agenv, cc-switch or magpie?

They solve related problems with different trade-offs; pick the one that fits how you work.

| | sideby | [aimux](https://github.com/Digital-Threads/aimux) | [agenv](https://github.com/combinatrix-ai/agenv) | [cc-switch](https://github.com/farion1231/cc-switch) | [magpie](https://github.com/yetone/magpie) |
|---|---|---|---|---|---|
| Model | one directory per account, run side by side | one directory per profile, run side by side | isolated profile with its own Host binary | switch the active provider in the Host's config | set each agent's model and provider from the menu bar |
| Hosts | Claude Code, Codex, Grok Build, pi | Claude Code, Codex, Gemini CLI | Claude Code, Codex, Gemini CLI | many, including Grok Build and pi | several agents |
| Quota | local records and status line data only | live limit probe; `run --auto` picks the subscription with the most headroom | — | — | — |
| Shape | CLI, local web panel, local plugins | CLI with TUI | CLI with TUI | desktop app | menu bar app |

### How do I uninstall?

```sh
sideby quota teardown claude                  # first, if you ran quota setup; the status line calls sideby
sideby ui --stop && sideby app uninstall       # if you use the desktop app
npm rm -g sideby
rm -rf ~/.config/sideby ~/.local/state/sideby  # or your XDG_CONFIG_HOME / XDG_STATE_HOME paths
```

Remove the `eval "$(sideby shell-init …)"` line from your shell rc file. Account directories such as `~/.claude-work` stay; delete them yourself if you no longer need them.

## For AI agents

- [`llms.txt`](llms.txt): commands, JSON contract and plugin API in one index.
- [`skills/sideby/SKILL.md`](skills/sideby/SKILL.md): one Agent Skill for seeing, repairing and creating accounts and for moving on when one hits its limit. It routes to short references, so an agent loads only what the task needs. Install with `npx skills add Adonis0123/sideby -g`; `sideby doctor` warns when the installed copy is for another sideby version.
- [`AGENTS.md`](AGENTS.md): rules for agents working on this repository.

## License

[MIT](LICENSE)
