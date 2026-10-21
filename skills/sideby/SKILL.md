---
name: sideby
description: Use when the user runs, or wants to run, several AI coding accounts (Claude Code, Codex, Grok Build, pi) side by side. Covers installing sideby and setting up a new account ("install sideby", "set up another Claude account", "add cc008", "配置一个 cc00x", "再加一个 Codex 账号"), explaining what accounts share and what stays separate ("what do my accounts share?", "这些账号共享了什么"), showing which account a session is ("show [cc001] in the status line", "加上账号标识"), finding a past session of any account ("找一下我上周改登录页的那个会话"), seeing accounts, quota and usage, moving on when one hits its 5-hour or weekly limit, moving the current task to another account ("用 cc008 继续", "交回 cc008"), adding a short command (alias) or a pick command that starts whichever account has the most quota ("加个 cc"), adding an API account from a vendor's docs ("加一个 DeepSeek API 账号"), supporting a new tool, and repairing drifted account directories (skills, hooks, rules or settings not shared, wrong symlinks, credential file permissions). Drives the `sideby` CLI with `--json`; the agent does every step except browser sign-in, filling in secrets and starting interactive sessions, which it hands to the user as one command (inside an Auto Handoff session, `sideby handoff ready --to` moves the task itself).
metadata:
  version: "0.22.0"
  requires:
    bins: [sideby, node]
  cliHelp: sideby --help
---

# sideby

`sideby` runs each AI coding account from its own directory (`~/.claude-work`, `~/.codex-api`, ...) and keeps skills, hooks and rules shared with the Main Account (`~/.claude`, `~/.codex`, `~/.grok`, `~/.pi/agent`). Requires Node 22.18+. If `sideby` is not installed, follow `references/setup.md`; `sideby <command> --help` shows examples for `new`, `alias`, `login`, `doctor` and `families`.

Do every step you can yourself. Only browser sign-in, secrets and interactive sessions belong to the user: hand each to them as exactly one line to run (in Claude Code they can type `! <command>`), then continue once they say it is done.

## Hard rules

- **Never read credential files**: `proxy.env`, `auth.json`, `.claude.json`, or anything under an account directory that may hold a token. Do not `cat`, `grep`, `head`, open or summarize them. `sideby list --json` gives the signed-in email as `identity.email`; that is all you need.
- **Never sign in for the user.** Give them `sideby login <ref>` as one line to run in their own terminal (Claude Code: `! sideby login <ref>`). OAuth needs their browser and their decision.
- **Never put a secret on the command line or in chat.** Never ask for a key. For API accounts, the user runs `sideby key <ref>` in their own terminal (or **Enter key** in the Panel); it reads the key without showing it.
- **Never start a Host session from your shell.** `sideby run`, `sideby next` (without `--dry-run`), `sideby login` and `sideby ask` open an interactive session; give the user the command instead. An AI Task is started by the user, from the Panel or with `sideby ask`; never run `sideby ask` (or `sideby ask --spec -`) to start another session on your own (`sideby ask --print`, `sideby ask --spec - --print` and `sideby ask --choices` only read and are fine).
  The one exception: when the user has explicitly asked you to dispatch work to other accounts, you may start non-interactive worker runs with `sideby run <ref> -- <the Host's headless flags>` (Claude `-p`, Codex `exec`, Grok `--prompt-file`), with stdin closed and output redirected to a file. Never `login`, `ask`, `next` or an interactive `run` for this, and the next rule still holds: a worker never moves the user's own sessions. How such workers are sized and reviewed belongs to the `agent-dispatch` skill; which account to pick is in `references/handoff.md`.
- **Never switch, rotate or proxy accounts yourself.** Do not work around sideby by editing config, copying session files or moving credentials. `sideby next` only recommends. Moving a running task on its own is Auto Handoff, which the user turns on: use `sideby handoff enable` (exit 10, then their yes), never hand-edit `config.json`. Inside such a session (the environment has `SIDEBY_HANDOFF_RUN`), when the user wants the task to go on in another account ("用 cc008 继续", "交回 cc008"), do not hand them a command to start it: update the brief, run `sideby handoff ready --to <account>`, tell them the account it prints, and end your turn; sideby starts that account in the same terminal.
- **Say what you change.** Read-only commands first. What the user asked for (the account they asked to create, its short command, the shell line that makes it work) you do, saying what you do. Changes they did not ask for (`doctor --fix` on other accounts, `quota setup`, `app install`) wait until they have seen the change and agreed.
- Do not edit Host config files (`settings.json`, `config.toml`, symlinks in account directories) by hand when a `sideby` command does the job.

## Output and exit codes

- Every `--json` output has `schemaVersion: 1`. On an error it is `{ "schemaVersion": 1, "error": "<what to do next>", "code": "<reason>" }`; `code` is `usage` for a malformed command line.
- Exit codes: `0` done, `1` failed or found a `fail` problem, `2` malformed command line, `10` **needs the user's confirmation** (also `sideby try` before it spends tokens). `run`, `next` and `login` return the Host's own exit code once it starts.
- On `10`: show the user the change the command printed, ask, and only after a clear yes run the same command again with `--yes` added. Never add `--yes` on your own.
- `_notice` on any `--json` output: a newer sideby (`_notice.update`) or an installed sideby skill for another version (`_notice.skill`). It is not the answer to the task: finish the task first, then mention it in one line and offer to update, following `references/update.md`.

## What do you want to do

Account refs are `<family>:<name>`; a bare `<name>` works only when it is unique. Families: `claude`, `codex`, `grok`, `pi`, `agy` (Antigravity CLI). `agy` is main account only (`mainOnly: true` in `sideby families --json`): agy keeps one Google sign-in per computer, so never offer `sideby new agy`; tell the user sideby supports only `agy:main` for now. Its quota comes from `agy -p /usage` per model group and never picks an account.

| The user wants to | Run | Then read |
|---|---|---|
| Install sideby, or set up a new account ("add cc008") | `sideby --version`, `sideby list --json`, `sideby new <family> --next --json` | `references/setup.md` |
| Show which account a session is (`[cc001]` in the status line or tab title) | `sideby list --json` for the labels | `references/badge.md` |
| Find which session an account is running now ("cc002 现在在干嘛", "which session is cc002 running", "哪个会话在等我"), or copy one for another AI ("复制 cc002 的会话 id", "copy cc002's session for another AI", "把这个会话交给另一个 AI"); which Run (dispatched task) a session works for ("cc002 在哪个任务里", "which run is cc002 working on", "打开它的任务看板") | `sideby sessions [<account>\|<family>] --json`, `sideby sessions copy <account\|id> [--as reference\|id\|resume] --json`, `sideby sessions open-run <account\|id> --json` | `references/sessions.md` |
| Find a session from before, in any account ("find a session I had before", "找一下我上周改登录页的那个会话", "sideby 项目最近的会话", "按日期分组看看"), read it, or continue it where it was | `sideby history [<words>...] [--project <name>] [--since today\|7d\|30d] [--group project\|day\|category] --json`, `sideby history show <id> --json`, `sideby history projects --json`; `--tools` also searches tool output | `references/sessions.md` |
| Tell another running session something, or send it a screenshot ("告诉 cc002 ……", "把这张截图发给 cc003", "send this to the codex session", "tell cc002 the tests pass"); see what was sent and whether it was read ("cc002 看到我的消息了吗"); let Claude sessions show such messages at once instead of waiting for approval ("消息老要我批准", "让 cc002 直接收消息") | `sideby send <account\|session> "<text>" [--image <path>]... --json`, `sideby messages [--to <account\|session>] --json`, `sideby messages inbound --json`, then `sideby messages inbound accept` (exits 10 with the change; rerun with `--yes` after they agree) | `references/sessions.md` |
| See every session from inside Claude Code ("在这里看所有会话", "show my sessions in Claude Code"), or turn off the label line and `/sessions` pane sideby adds to Claude Code ("关掉 sideby 的横带", "turn off the sideby mod") | tell the user to type `/sessions`; `sideby config set claudeMod false --json` (or `true`) | `references/sessions.md` |
| Know what accounts share and what stays separate | `sideby families <family> --json` | `references/sharing.md` |
| See accounts, health, quota and usage | `sideby list --json`, `sideby doctor --json`, `sideby quota --json` | `references/diagnose.md` |
| Pin accounts or arrange their Display Order | `sideby order --json`, `sideby pin <ref> --json`, `sideby unpin <ref> --json` | `references/panel.md` |
| Turn quota checks on or off, or fix outdated Codex/Grok quota | `sideby quota check <family> on|off --json`, `sideby quota [family] --refresh --json` | `references/quota.md` |
| Set the model, effort or Remote Control | `sideby model <ref> --json`, `sideby remote-control --json` | `references/panel.md` |
| Start sideby at login ("开机启动", "start the panel when I log in") | `sideby autostart --json`, `sideby autostart on --json` (exit 10 first) | `references/panel.md` |
| Show quota in the macOS menu bar ("状态栏显示额度", "menu bar"), its icon is missing ("状态栏没有图标"), or change its shortcut ("换个快捷键", "帮我挑个顺手的快捷键") | `sideby menubar --json`, `sideby menubar on --json` (exit 10 first), `sideby menubar snapshot --json`, `sideby menubar hotkey [<keys>] --json` | `references/panel.md` |
| Change the Panel's theme or language, or any other setting ("改成深色", "change any setting") | `sideby config get --json`, `sideby config set <key> <value> --json` (exit 10 first) | `references/panel.md` |
| Turn Auto Update on or off | `sideby update --auto on|off --json` | `references/update.md` |
| Switch between a local build of sideby and the release ("切换到正式版", "切回 dev 版本") | `sideby local --json`, `sideby local on|off --json` (exits 10 first) | `references/update.md` |
| Repair drift or permissions | `sideby doctor [ref] --json`, then `--fix` after they agree | `references/diagnose.md` |
| Keep working because an account hit its limit | `sideby next <family> --json` | `references/handoff.md` |
| Turn on Auto Handoff ("自动接力", "自动交接", "hand over when quota runs low"), see what it still needs, hand this session over now, or pick an account with room for a subtask | `sideby handoff status --json`, `sideby handoff enable --json` (exit 10 first), `sideby handoff ready`, `sideby next <family> --json` | `references/handoff.md` |
| Explain or change the handoff rules ("接力规则", "什么时候换号", "让 Codex 接 Claude", "别用 API 账号接力") | `sideby handoff rules --json`, `sideby config set handoff.<key> <value>` or `sideby handoff enable --other-ai/--api --json` (exit 10 first) | `references/handoff.md` |
| Sign an account in again or switch it to another login ("换个账号登录", "两个目录登录的是同一个号", "sign claude:work in with another account") | `sideby list --json` (`identity`, `sameLogin`), then give the user `sideby login <ref>` | `references/accounts.md` |
| Create an account with a given name, an API account, or a short command | `sideby new`, `sideby alias add` | `references/accounts.md` |
| One command that always starts the account with the most quota left ("加个 cc", "自动挑额度最多的账号启动", "start whichever has room") | `sideby alias add <short> --pick <family> --json` (exit 10 first), `sideby alias list --json` | `references/accounts.md` |
| Short commands say "command not found" in a new terminal ("cc 用不了", "短命令不生效") | `sideby shell-init setup --json` (exit 10 first) | `references/setup.md` |
| Do something in sideby as an AI Task (the first message came from sideby or the Panel's "Let AI do it") | follow the task it names | `references/ai-tasks.md` |
| A Portal starts AI Tasks through sideby, or one of its tasks failed (`spec-version`, `bad-cwd`, "which account would it use?") | `sideby ask --choices --json`, `sideby ask --spec - --print --json` (read only) | `references/ai-tasks.md` |
| Add an API account from a vendor's address or docs link, enter its key, check it works | `sideby new <family> --next --api --json`, then the user runs `sideby key <ref>`; `sideby try <ref> --json` (exit 10 first) | `references/ai-tasks.md` |
| Support a tool sideby does not list yet, or write a plugin | `sideby plugins new <id> --json`, `sideby plugins check <id> --json` | `references/ai-tasks.md` |
| Choose the terminal the Panel opens for AI Tasks and sign-in | `sideby terminal --json`, `sideby terminal --set <id> --json` | — |
| Tune the auto-compact threshold ("which compaction setting costs the fewest tokens"), use the suggestion or undo it | `sideby tune --json`, `sideby tune apply` (exit 10 first), `sideby tune undo` | `references/diagnose.md` |
| See or set the model and effort an account starts with ("用哪个模型", "set effort to high for cc002") | `sideby model <acct> --json`; `sideby model <acct> <model\|default> --effort <level\|default>` (exit 10 first, then `--yes` after the user agrees) | — |
| Stop Claude sessions from connecting to claude.ai / the Claude app by themselves ("关闭 remote control", "别让别人远程看到对话") for every account | `sideby remote-control --json`, then `sideby remote-control off` (exits 10 with the change; rerun with `--yes` after they agree); `sideby remote-control undo` puts it back; `sideby remote-control on` turns it back on the same way (only when they ask for it) | — |
| See Claude quota (it shows `not-enabled`) | `sideby quota setup claude` (exits 10) | `references/quota.md` |
| Update sideby or its skill ("is there a new version", "更新 sideby"), or an output has `_notice` | `sideby update --json` (exits 10 first) | `references/update.md` |
| See everything at once | `sideby ui` (local panel on `127.0.0.1:17420`; `--no-open` prints the address) | — |
| Start an account | give them `sideby run <ref> [-- host args]` | — |

Read only the reference the task needs.

## Launching and the panel

`eval "$(sideby shell-init zsh)"` defines one function per account (`sideby-claude-work`) plus the config `aliases` and `pickCommands`. Users who source a file instead set config `shellInitFile` (for example `{ "zsh": "~/.config/sideby/shell-init.zsh" }`); `new` and `alias add|rm` keep it current, and `sideby shell-init zsh --write` rewrites it. New functions work in a new shell.

When a terminal manager such as Orca reopens a pane with a bare `claude --resume <id>` (or `codex resume <id>`, `grok --resume <id>`) and the Host says `No conversation found`, the session lives in another account. Suggest config `"resumeRouting": true` followed by `sideby shell-init --write` (or a new shell with `eval`): `shell-init` then defines Host-named functions that call `sideby resume <family>`, which starts the account holding that session. For a one-off, find it with `ls -d ~/.claude*/projects/*/<id>.jsonl` and run `sideby run <ref> -- --resume <id>`. When no account has that file, the session was opened but never got a message, so there is nothing to resume: `ls -d ~/.claude*/session-env/<id>` names the account that started it, and with routing on `sideby resume` starts a new session there by itself.

To open Claude Desktop or the Codex app as one account (macOS, subscription accounts), run `sideby desktop <ref> --json` yourself: it opens a new window for that account, or brings its open window to the front, and never closes anything. Relay its `notices`: the first Claude Desktop sign-in should happen while other Claude Desktop windows are closed, and a sign-in screen that suggests the main account ("Welcome back" in the Codex app) must not be used for another account.

Grok Bot is not a grok account's app: it signs in with a Cursor account, apart from Grok Build. For several Grok Bot windows at once, run `sideby desktop grok-bot:<name> --json` (a new name makes a new, signed-out window; `grok-bot` is its default one) and relay the notice: sign in inside the new window with the account meant for it, with the other Grok Bot windows closed. `sideby list --json` lists them under `appProfiles`. Removing one (`--remove --yes`) signs it out and deletes its data: do it only when the user asks, after they quit that window.

To let the user look at or change one account's own Host settings (`settings.json` for claude and pi, `config.toml` for codex and grok), run `sideby edit <ref> --json`: it opens the file in their default editor and reads none of it. Relay `sharedWith`: a linked file is the main account's, so a change applies to those accounts too. Use `--path` when you only need where the file is. Never print the file's content back: Claude's `settings.json` may hold API keys under `env`.

To find which Chrome browser user the user signed in to an account's website with, or to open claude.ai, chatgpt.com or grok.com there, run `sideby browser --json` and `sideby browser open <ref> --json`. Finding is off until the user agrees: run `sideby browser --enable` to show them what it reads (all on this computer), and add `--yes` only after they say yes. To stop reading Browser Sign-ins, use `sideby browser --disable --json`, show its preview, then add `--yes` after approval. A match may be left over from before a sign-out; say so. When the user says the browser user is wrong ("codex:main 应该是 Profile 7"), run `sideby browser set <ref> <folder|name> --json` (it writes only sideby's config, no confirmation needed); `sideby browser set <ref> --auto --json` lets sideby find it again. When nothing is found, use `set` or `--profile <name>`. A plugin tool has a website only when its plugin sets `website` in its FamilyDef (`docs/guide/plugins.md`); add it there, with `match` when the website keeps an id the tool's login file also has.

For someone who would rather double-click than use a terminal, `sideby app install` adds a panel app (macOS `~/Applications/sideby.app`, Linux app menu) that runs `sideby ui --background`; `sideby ui --stop` stops it and `sideby app uninstall` removes the app. Ask before `app install`: it writes outside sideby's own directories.

## Updating sideby

To update sideby, run `sideby update --json` yourself: it shows `current`, `latest`, the `command` and whether sideby can run it (`canRun`; exit 10). Ask the user, then run `sideby update --yes --json`. When `canRun` is false (npx, a project dependency, a source checkout, a global folder they cannot write), hand them the `command` as one line instead. Updating restarts a background panel by itself and reinstalls an installed panel app (`refreshedApp`), so do not run `app install` again after an update; a `sideby ui` in a terminal and running sessions keep the old version until restarted. sideby checks the registry once a day on its own and turns that off with `NO_UPDATE_NOTIFIER=1` or config `"update": { "check": false }`; `"update": { "auto": true }` (off by default) installs new non-major versions by itself. Use `sideby update --auto on|off --json` to save that switch without installing anything (`references/update.md`). Never turn Auto Update on without the user asking.

## Keeping this skill current

If `sideby doctor --json` reports `skill.outdated`, this skill was written for another sideby version. Offer `sideby update --json` (exit 10, then `--yes` after they agree): it updates the skill, together with sideby when a newer one is out (`references/update.md`).
