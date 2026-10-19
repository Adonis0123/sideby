# Using sideby

English | [中文](usage.zh-CN.md)

← [README](../../README.md)

## Accounts

| Family | Main Account | Other accounts | Selected with |
|---|---|---|---|
| claude | `~/.claude` | `~/.claude-<name>` | `CLAUDE_CONFIG_DIR` |
| codex | `~/.codex` | `~/.codex-<name>` | `CODEX_HOME` |
| grok | `~/.grok` | `~/.grok-<name>` | `GROK_HOME` |
| pi | `~/.pi/agent` | `~/.pi-<name>/agent` | `PI_CODING_AGENT_DIR` |

Accounts are found on disk; you never list them by hand. A name matches `^[a-z0-9][a-z0-9-]{0,31}$`, so `004` and `work` are both fine. A directory counts as an account only if it holds a `proxy.env` or at least one of the family's Shared Items, so another tool's directory that happens to match the pattern, such as claude-code-router's `~/.claude-code-router`, is not picked up. The Main Account is always called `main` and runs without the selection variable. Before every launch sideby clears Hijack Variables (for example a global `ANTHROPIC_API_KEY`) so an inherited value cannot override the account's identity.

EMAIL is who the account is signed in as, read from the host's login file (Claude Code, Codex, Grok Build). sideby reads only that identity field there, never a token (ADR-0003).

If a family plugin fails while reading an account (for example its settings file is not valid JSON), `list` still shows the account and prints the problem on stderr; `list --json` puts it in that account's `problems` array.

## What each account shares

A new account starts with the Main Account's skills, hooks, rules and settings. Its sign-in, sessions and history stay its own, which is what lets two accounts run at once. `sideby families <family>` prints this list for your machine, including plugin families and items you add with [`extraSharedItems`](configuration.md).

| Host | Linked to the Main Account | Copied or synced | The account's own |
|---|---|---|---|
| Claude Code | `settings.json`, `settings.local.json`, `skills`, `commands`, `plugins`, `hooks`, `themes`, `CLAUDE.md` | MCP servers: the `mcpServers` entry of the account's `.claude.json`, kept equal to `~/.claude.json` | sign-in, the rest of `.claude.json`, sessions (`projects/`), history |
| Codex | `AGENTS.md`, `hooks.json`, `plugins`, `rules`, `skills`; `config.toml` of a subscription account | — | sign-in (`auth.json`), sessions, history; `config.toml` of an API account |
| Grok Build | `skills`, `installed-plugins` | `hooks`, `hooks-paths`, and `config.toml` of a subscription account: Grok refuses links there | sign-in (`auth.json`), `trusted_folders.toml` (copied once, then yours), sessions; `config.toml` of an API account |
| pi | `AGENTS.md` | — | sign-in (`auth.json`), sessions, everything else |

- **Linked**: change it once in the Main Account and every account sees it.
- **Copied or synced**: `sideby doctor --fix` brings the copy back in line when the Main Account's changes.
- **An API account's `config.toml`** is its own, so changing its endpoint or model never changes the Main Account's.
- An item the Main Account does not have is skipped when an account is created, and Doctor does not report it.

## Show which account a session is

Every time sideby starts an account it sets two variables for the Host: `SIDEBY_ACCOUNT` (the ref, `claude:001`) and `SIDEBY_LABEL` (the short command it was started with or owns, `cc001`, else the ref). A status line or prompt can show them. Check the family prefix of `SIDEBY_ACCOUNT` first: a Host started inside another one inherits both.

| Host | Where the badge goes | How |
|---|---|---|
| Claude Code | status line | Add `case "${SIDEBY_ACCOUNT-}" in claude:*) printf '[%s] ' "$SIDEBY_LABEL" ;; esac` to the script in `settings.json`'s `statusLine.command`. `settings.json` is linked, so one edit covers every account. |
| Grok Build | status line | Save a script that prints the badge (for example `~/.grok/statusline.sh`), then add `[ui.status_line]` with `type = "command"` and `command = "~/.grok/statusline.sh"` to `~/.grok/config.toml`. Run `sideby doctor grok --fix` to copy it to subscription accounts; an API account's `config.toml` is its own, so edit that one too. The command replaces the built-in row, so print the directory, model and context yourself (the payload has `workspace.current_dir`, `model.display_name`, `context_window.used_percentage`). Grok hides the row on its welcome screen; it appears after the first message. |
| Codex | terminal tab title | Codex's status line and title take only built-in items. Set `"accountTitle": true` in the [config](configuration.md): sideby sets the title to `[codex002]` and starts Codex with `-c tui.terminal_title=[]` so Codex leaves it, losing its own spinner in the title. |

With `sideby quota setup claude` on, the status line command is `sideby statusline-tap --orig-b64 …`: edit the script it runs, not that command. To add a status line where there was none, run `sideby quota teardown claude`, set `statusLine`, then `sideby quota setup claude --yes` again.

## API accounts

```sh
sideby new claude deepseek --api
$EDITOR ~/.claude-deepseek/proxy.env     # fill in the variables; the file stays mode 600
sideby run deepseek
```

`sideby key deepseek` types the key into `proxy.env` for you without showing it on screen (`--var <NAME>` for another variable), and `sideby try deepseek` asks the Host for one very short reply to check the account works. Not sure which address or model to use? Let your AI set it up from the vendor's docs: **Let AI set it up** in the panel's new-account dialog, or `sideby ask --task account` (see [Let AI do it](panel.md#let-ai-do-it)).

`proxy.env` uses a small dotenv subset (`KEY=VALUE`, optional `export `, quotes, `#` comments, and `$NAME` / `${NAME}` referring to a key set earlier in the same file or to `HOME`, `USER`, `LOGNAME`, `TMPDIR` or an `XDG_*_HOME` location; no other shell variable is read and there is no command substitution). Its variables reach only the launched Host process. sideby refuses to start unless the file's mode is exactly 600 and tells you to run `chmod 600`.

An API account needs no sign-in: its login state is `not-needed`, shown as `key` in the LOGIN column of `sideby list`.

pi is the exception. pi can keep a `proxy.env` in any account to load provider keys, so sideby loads the file at launch but still treats the account as a subscription account that signs in with `/login`.

## Doctor

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

## Claude quota

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

### Two directories, one login

Sometimes two accounts of Claude Code are signed in as the same claude.ai login, for example `~/.claude` and `~/.claude-001` with the same email and organization. Claude counts one quota for that login, but each directory only records the numbers its own sessions saw, so one could look half full and the other almost empty. sideby notices this by itself (it compares the email and organization it already shows) and:

- shows the same, freshest quota on both, with where it was read: `sideby quota` says `read from claude:001 (same login)`, the panel says so when you hover the quota;
- marks them: `claude:001 = main` in `sideby list`; in the panel they are one row, marked **2 directories · shared quota**, with the quota and its warning shown once. Open the row to see each directory with its own short command, last use and tokens, and a **Copy start command** button; the row's **⋯** menu has a part for each directory;
- never hands over between them: `sideby next` run inside a session sideby started skips the other directory of that login, and Auto Handoff skips it too, also when your `order` lists it, and says why.

Usage (tokens) still counts per directory. Nothing is moved or deleted; keep both or remove one yourself. Codex accounts group the same way when they share the email and the ChatGPT workspace: one email can belong to several workspaces, each with its own quota, so sideby also compares which workspace each directory is signed in to. It reads this from the directory's `auth.json` only to compare, never shows or keeps it, and two directories in different workspaces stay apart.

## Grok quota

Grok Build shows each subscription's weekly credit use in its own `/usage` screen. sideby asks the `grok` CLI for the same numbers, so it needs no setup:

```sh
sideby quota grok             # 7d used and reset time per Grok account
sideby quota grok --refresh   # ask again now instead of using the last answer
```

- sideby starts `grok agent --no-leader stdio` with the account's `GROK_HOME` and asks it for the quota. Grok makes the request with its own login; sideby never reads `auth.json` and sends nothing itself. No session is started.
- It asks at most every 15 minutes per account. The panel asks in the background while it is open, and its **Refresh** button asks again at once.
- Between asks, sideby also reads the quota Grok writes to the account's `logs/unified.jsonl` at the start of each session and after each turn, and shows whichever is newer.
- Turn it off in the panel's **Settings** (**Grok Build quota: Off**), or with `"quota": { "check": { "grok": false } }` in the config. It is off in CI.
- A signed-out account, or one signed in with an API key, is not asked. When an ask fails (Grok too old to answer, network down), the panel says why and keeps the last numbers it had.

With quota, `sideby next grok` ranks Grok accounts too, and Auto Handoff starts from Grok before the limit (see below).

## Your own order

In the panel, open **Settings** and choose **Account order and pins** (or pick **Arrange order…** at the end of the sort menu). A bar appears over the list and the rows get short: drag a tool's group or an account by its grip (⋮⋮), or use the ↑ and ↓ buttons. Each move is saved at once; click **Done** (or press Escape) when you are finished, and **Undo** in the message puts back the order you started from. With the keyboard, tab to a grip and press `↑` / `↓` (`Home` / `End` for first and last).

- After arranging, the sort shows **My order**; the other sorts (by quota, name, last use) still work and keep your order for later. Tool groups stay in your order whatever the sort.
- Accounts move only within their tool. Two directories of one login are one row and move together.
- A new account goes last in its group, a new tool last of all. **Default order** in the arrange bar forgets your order.
- `sideby list` and `sideby quota` use the same order. It is stored in the config as `display`, and only changes what you see: `sideby next` and Auto Handoff still pick by quota.

### Pin an account

Open the row's **⋯** menu and choose **Pin to top**, or use **Settings › Account order and pins**, or run `sideby pin <account>`. A pinned account shows a small pin before its name and stays at the top of its tool in every sort; `sideby list` puts it first too. Up to three per tool; while arranging, pinned accounts move among themselves. **Default order** keeps your pins; choose **Unpin** in the same menu to take one off. Pins never change which account `sideby next` or Auto Handoff picks.


CLI settings (also accept `--json`):

- `sideby pin claude:work` / `sideby unpin claude:work`: pin or unpin a Same Login together, at most three per Family. Repeated operations do nothing; unpin one first when full.
- `sideby order`: show Display Order with pins marked. `sideby order claude work main` sets account names; `sideby order --families codex claude` sets Families. Unknown names fail. `sideby order --reset` restores default order and keeps pins.
- `sideby quota check grok on` / `sideby quota check grok off`: save the quota fetching switch. `sideby quota --refresh` refreshes every Family that fetches, respecting disabled checks and CI.
- `sideby update --auto on` / `sideby update --auto off`: save Auto Update immediately, without checking or installing an update.
- `sideby handoff status --json`: includes `overview.settings`, `overview.takeover` and `overview.recent` alongside readiness.

## Model and effort

Each account row shows the model and effort it runs with, for example `opus · high`; hover to see where each comes from: set by sideby for this account, the last session, or the tool's own settings (used only before the account's first session). Click it (or **Model and effort…** in the account menu) to pick a model and effort for that account alone. sideby saves the choice as that account's launch arguments in its own config (`--model` and `--effort` for Claude Code, `-m` and `-c model_reasoning_effort=…` for Codex), so accounts that share one `settings.json` can still differ, and the tool's own files stay as they are. It applies to new sessions started with sideby (a short command, `sideby run`, `sideby next`, Auto Handoff); a plain `claude` ignores it. `ANTHROPIC_MODEL` or `CLAUDE_CODE_EFFORT_LEVEL` in your shell and settings from your organization still win, and sideby cannot see them. From a terminal: `sideby model cc002 opus --effort high` (add `--yes`); `default` clears one.

## Desktop apps

On macOS, sideby can open Claude Desktop or the Codex app as one account, and keep several accounts' windows open side by side:

```sh
sideby desktop claude:work     # or a short command: sideby desktop ccw
```

In the panel, choose **Open desktop app** in the account's ⋯ menu (it says **Desktop app open** while that account's window runs; it then brings the window to the front). `sideby list` shows a DESKTOP column, and `--json` a `desktopApp` field per account.

- The main account opens the app as usual. Any other subscription account opens a new window that uses that account's directory (`CLAUDE_CONFIG_DIR`, so Claude Desktop's Code tab uses the account's Claude Code settings; `CODEX_HOME`, so the Codex app shares the account's terminal sign-in) and its own data folder, `~/Library/Application Support/sideby/<family>/<name>/`.
- When that account's window is already open, sideby brings it to the front instead of opening a second one. It never closes a window and never copies or changes the app.
- API accounts cannot open a desktop app: the apps sign in with a subscription only.
- The first time, sign in inside Claude Desktop. Close the other Claude Desktop windows while you do: the browser sends the sign-in back through a `claude://` link, and another window may catch it. Codex usually needs no sign-in in the app; run `sideby login <account>` first if the account is signed out.
- The sign-in screen may suggest your main account, for example the Codex app's "Welcome back" with your main email. Do not pick it for another account: that signs this account in as your main one. Choose to use another account, or for Codex sign in with `sideby login <account>` first.
- Claude Desktop's MCP settings, `claude_desktop_config.json`, link to the main account's when a new account's data folder is made. `sideby doctor` checks that link: it never replaces a file there. Claude Desktop often makes its own copy instead (when the main account had none yet, or when it saves its preferences); that is fine. Doctor then checks only the MCP servers in it: when they differ from the main account's, `sideby doctor --fix` (or "Fix all" in the Panel) copies the main account's servers in and keeps the rest of the file.

Known limits: every window has the same Dock icon. While another account's window runs and the main one does not, clicking the Dock icon brings that other window forward; open the main account from sideby then. After the app updates itself it restarts on the main account; open the others again from sideby. Claude in Chrome cannot pair with a window that uses another data folder. sideby opens the apps with settings they read today (`--user-data-dir`, and for Codex `CODEX_ELECTRON_USER_DATA_PATH`); a future app version may change them. An app opened from inside a Claude Code or Codex session does not inherit that session's variables. Other platforms and hosts are not supported yet.

### Grok Bot windows

Grok Bot signs in with a Cursor account. That sign-in has nothing to do with Grok Build (the `grok` command) or any account above. Grok Bot's own account menu can keep several accounts, but only one is signed in at a time. sideby gives each Grok Bot window a name, so several can be open at once, each signed in to a different account:

```sh
sideby desktop grok-bot:002    # a new name makes a new window; the same name opens it again
sideby desktop grok-bot        # Grok Bot's own default window (grok-bot:main)
```

In the panel, the **Grok Bot** group lists the windows after your accounts: whether each is open and signed in, a button to open it or bring it to the front, and **Open another Grok Bot** at the bottom (it suggests the next free name, such as `002`). `sideby list` shows the same list.

- A new window starts signed out. Sign in inside it with the account you want for that window, and close the other Grok Bot windows while you do: the browser may send the sign-in back to one of them.
- sideby shows whether a window is signed in, from what Grok Bot last wrote, but not which account: finding that out would mean reading sign-in files. Pick names that tell the windows apart.
- Each new window keeps its data in `~/Library/Application Support/sideby/grok-bot/<name>/`. `sideby desktop grok-bot:<name> --remove --yes` (or **Remove** in the panel) deletes that folder, which signs the window out and deletes its data on this Mac. Quit the window first. The main window is Grok Bot's own and cannot be removed.
- sideby opens Grok Bot with `--user-data-dir`, which Grok Bot reads today, and clears `SAND_DATA_ROOT` and `SAND_USER_DATA_DIR`, which would override it. A future Grok Bot version may change this.

## Which browser you signed in with

With many accounts it is easy to forget which Chrome browser user (the "Work" or "Personal" person in Chrome) you signed in to claude.ai or chatgpt.com with. sideby can find it and open the website right there. Everything is read on this computer and sent nowhere.

In the panel, choose **Open in browser** in the account's ⋯ menu. The first time, it says what it reads and offers **Turn on**. After that, an account whose browser user was found shows it after its email with a globe icon: the Google account that browser user uses in Chrome, such as **🌐 you@gmail.com** (its name when it has none), and a click opens it. From a terminal:

```sh
sideby browser --enable        # shows what it reads; add --yes to turn it on
sideby browser                 # each Chrome browser user and the accounts it signed in to
sideby browser open cc008      # open claude.ai in the browser user that signed in to it
sideby browser open grok:main --profile Work
```

- sideby reads each browser user's name and the Google account it uses in Chrome, the key names (never the values) claude.ai and chatgpt.com keep in Chrome's Local Storage, and the account id in each Claude and Codex login file, only to compare. It never opens cookies, saved passwords or the Keychain, and never changes Chrome.
- "Signed in to" means that browser user's data shows a sign-in as that account. It may be left over from before a sign-out, and one browser user can show several accounts.
- grok.com keeps nothing sideby can compare, so Grok accounts open in a browser user you pick.
- Only Google Chrome, on macOS and in WSL (where sideby uses the Chrome installed on Windows), for now. The websites can change how they store data; when they do, sideby finds nothing and says so.

## Context tuning

Every Host compacts a session by itself once its context grows past a threshold. `sideby tune` replays your last 7 days of local sessions against other thresholds and estimates which one spends the fewest tokens:

```sh
sideby tune                  # every account
sideby tune claude:work      # one account, or a family such as `claude`
```

It is an estimate, not a measurement: a different threshold changes what the summary keeps, which the records cannot show. Claude gets a suggested value per model (needs 200+ calls of that model in the window and at least one recorded compaction). Claude Code also compacts by itself when a conversation has sat idle for about an hour (just before its one-hour prompt cache runs out) and holds 200K tokens or more. That is separate from this size, which only controls compaction while you work; most of the compactions in a typical log are the idle kind, and the page says how many. Claude Code accepts sizes from 100K to 1M tokens, so sideby never suggests anything below 100K; when 100K is the cheapest, that is the answer ("as low as it allows"). Codex only shows how large the context was when it compacted, because its default threshold has no public source. Grok and pi have none.

Nothing changes until you say so. Open the panel's **Context tuning** tab (or an account's menu), and press **Use 80K**: sideby first shows the file and the change (and which other accounts share that file), and only writes after you confirm. It writes one key, `autoCompactWindow`, in that account's `settings.json`, keeps everything else, and one click on **Undo** puts it back. Sessions already running keep the old value; new ones use the new one. The same from a terminal:

```sh
sideby tune apply claude:work            # shows the change, exit 10
sideby tune apply claude:work 120k --yes # writes it (leave the size out to take the suggestion; `default` removes it)
sideby tune undo claude:work --yes       # puts the old value back
```

Under the suggestion each Claude account also has a **size menu** (Default, common sizes, the suggested one marked): pick one and press **Use this**; the same preview, confirmation and undo apply. Choosing Default removes the key.

Accounts that link `settings.json` to the Main Account share one file, so they share one setting: the panel shows one card for them (the suggestion follows the model used most among them), each account's own numbers sit under "Details for each account", and the confirmation names every account the change reaches. To show your current value, sideby reads exactly that key (Claude) or `model_auto_compact_token_limit` from `config.toml` (Codex), and nothing else in those files.

## Remote Control

Claude Code's Remote Control connects a session to claude.ai/code and the Claude mobile app, where every device signed in to that claude.ai account can read and continue it. Turning on "Enable Remote Control for all sessions" in `/config` saves `remoteControlAtStartup: true` in `settings.json`, and since accounts usually link that file to the main one, every account connects.

When that is on, the panel shows a banner with **Turn all off**. It first lists each settings file, the change (`remoteControlAtStartup true → false`) and the accounts that use it, and writes only after you confirm; the toast that follows has **Undo**. **Keep it on** hides the banner in that browser. Either way, **Settings** at the top right keeps a **Remote Control** row with the current state (On, Default or Off). It opens the list with a switch, **New sessions start it by themselves: On / Off**: moving it shows each file's change, and **Turn on** or **Turn off** writes it (turning it on first says that every device signed in to the account can read new sessions); **Undo last change** puts back what sideby replaced; the Settings button has an orange dot while it is on. The same from a terminal:

```sh
sideby remote-control            # each settings file: on, default (Claude Code decides), off
sideby remote-control off        # shows the change, exit 10
sideby remote-control off --yes  # writes it
sideby remote-control on --yes   # turns it back on for every account
sideby remote-control undo --yes # puts back what was there
```

It only stops sessions from connecting by themselves: you can still run `/remote-control` in a session when you want it. Sessions already running stay connected until you restart them. sideby writes that one key, keeps everything else in the file, writes a linked file at its real target, and never creates a `settings.json` (an account without one should share the main one first: `sideby doctor --fix`). API accounts never sign in to claude.ai, so the banner leaves them out.

## When an account hits its limit

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
- Claude, Codex and Grok; pi publishes no quota, so `next pi` lists the accounts for you to choose.
- Two directories signed in as the same login share one quota (see [Two directories, one login](#two-directories-one-login)); run inside a session sideby started, `next` never picks the other one.

sideby recommends; you start the account. It never switches or rotates by itself unless you turn on Auto Handoff below (see the FAQ). The panel marks the same pick as **Suggested** in each family; click it to see why and to copy the command.

## Auto Handoff

Off by default. The easiest way to turn it on is the panel's **Auto Handoff** page: press **Turn on**, read the list of what sideby will change (its settings, the Claude quota display, the Grok hook), and confirm once. The page then shows where each account's work goes next and the recent hand-overs, and finishes any step that is still missing. Accounts of the same tool only switch between each other if you tick that box (the risk is explained there). From a terminal, use `sideby handoff enable` (it shows the config change first; add `--yes`); `sideby handoff status` lists, family by family, what is still missing and the command for each. When it is off and an account passes the threshold, sideby says so once a day after the session ends, and the panel shows a hint with **Set up**.

With it on, a session that sideby started (`sideby run`, a short command or `sideby next`) hands its task to the next account when its quota runs low: the old session writes a handoff brief, sideby ends it, and the next account starts a new session from that brief in the same terminal.

```sh
sideby handoff status
sideby handoff enable --order claude=codex001,cc002 --yes
sideby handoff enable --same-family --yes   # cc001 → cc002 too; read the risk below first
sideby handoff disable --yes
```

The same settings live under `handoff` in the config file (see the [configuration](configuration.md) schema).

- **When.** At 80% of the fullest window (`prepareAt`) the session is asked to start a brief and keep it current; when a window is about to run out, it finishes the current step, updates the brief and ends its turn. "About to run out" is measured per window (`adaptive`, on by default): once the session has finished a turn, a window hands over when it has less room left than 1.5 times its largest recent turn, between `prepareAt` and 99%. Light work in the 5-hour window goes on to about 97–99%, heavy work hands over earlier, and the weekly window usually at 98–99%. Before a turn is measured, and with `adaptive: false`, every window hands over at 95% (`threshold`). The messages and the terminal name the window, for example "weekly (7d) quota is at 98%, back at Sun 20:00", so a weekly hand-over is not mistaken for the 5-hour one. The brief counts as finished only when it ends with the line `<!-- handoff brief complete -->`; otherwise the session is asked once more, and then sideby keeps what it wrote and adds what it finds in the session's records. If the window resets within 30 minutes (`waitIfResetWithinMinutes`), sideby waits instead: the session keeps its context and Claude Code continues it by itself at the reset. When the quota reaches 95%, the session shows a line saying so, and a desktop notification follows when the limit is hit (terminals that support OSC 9 or 777, such as iTerm2, WezTerm and Ghostty). To move on now instead, type `! sideby handoff ready` in the session: the `!` runs it without the model, which cannot answer at the limit. sideby waits only when the session will go on by itself: for Claude Code while "Continue automatically at usage limit" (`autoContinueAtUsageLimit` in the account's `settings.json`) is on, its default; sideby does not see the setting in managed or project settings. Codex and Grok never wait.
- **Where to.** `policy: "order"` follows your list (accounts or short commands, any family); without it sideby picks the family's account with the most room, then API accounts of other families. Each account is used once per chain, a full or signed-out account is skipped (so is one already at your `threshold`), and so is an account of another organization (compared by organization, else by email domain) unless it is listed in `crossOrganization`. An account signed in as the same login as the old one is always skipped, even when `order` lists it: it has the same quota.
- **Same family.** `auto` alone hands over to API accounts (of any family) and to accounts of other families that you list in `order`. Moving between two accounts of the same vendor (cc001 → cc002) also needs `"sameFamily": true`. Vendors may treat that as getting past a usage limit and act on the account; the risk is yours.
- **Before it moves.** A 10-second countdown (`countdownSeconds`); press Enter to stay, and sideby resumes the same session in the old account.
- **By hand.** Inside such a session, run `sideby handoff ready` (or ask the agent to), optionally with `--brief <file>` from your own handoff tool; the next account starts when the turn ends. An automatic handoff never goes back to an account this chain already used; to hand the task back (say, to the first account once its quota came back), run `sideby handoff ready --to <account>`.
- **The brief.** Kept under `~/.local/state/sideby/handoffs/<chain>/`, mode 600, never in your repository; sideby adds the branch, uncommitted files and diff stat, and never commits or stashes. The next session gets the brief's path, not its text. When the old session could not write one, sideby puts one together from the session's records, marked as possibly incomplete.

| Host | Starts a handoff | Needs |
|---|---|---|
| Claude Code | at 80% / 95%, or when a turn fails at the limit | `sideby quota setup claude` (the quota tap); sideby adds its hooks with `--settings` |
| Codex | at 80% / 95% | trust sideby's hooks once per account: type `/hooks` in Codex; sideby says so the first time |
| Grok Build | at the threshold, from the quota its CLI reports (see [Grok quota](#grok-quota)), and when a turn fails at the usage limit | `sideby handoff setup grok --yes`, then `sideby doctor grok --fix`; the default sandbox (`off` or `devbox`); `workspace` and `read-only` can only take over; `strict` and custom profiles take no part. A sandbox set by macOS device management is invisible to sideby |
| pi | never; it can take over | — |

A headless run (`claude -p`, `codex exec`, `grok -p`), Codex with `--remote`, or a session started without sideby never hands over. `sideby doctor` warns when Auto Handoff is on but the Claude quota tap or the Grok hook file is missing, or when `order` is empty or names an account sideby cannot find. Auto Handoff turns itself off for a run, and says so, when the `sideby` on your `PATH` is missing, comes from the npx cache, or is too old to have the hook.

## Start at login

`sideby autostart on` makes the panel start in the background when you log in, so it already shows fresh quota when you open it. It opens no window and starts no host. It first shows the file it writes (`~/Library/LaunchAgents/dev.sideby.panel.plist`) and the `launchctl` command; run it again with `--yes` to turn it on, and `sideby autostart off --yes` to undo it. `sideby autostart` says whether it is on, and whether it still points at the sideby you use; `sideby update` keeps it pointing at the new version. macOS only for now. The same switch is in the panel's settings, or ask your AI to do it.

## Quota in the menu bar

On macOS, run `sideby menubar on` (or turn on **Show quota in the menu bar** in the Panel's Settings) to put the sideby buddy in your menu bar. While every tool has quota left it shows just the icon; when even the best account of a tool has used 60% or more, the tool and its percent appear next to it (orange, red from 85%), so you can tell at a glance whether you can keep working. Click it to see every account's quota as small bars, with a first line that says which account is highest, start any account in your terminal, or open the panel; `sideby menubar off` hides it again. Press ⌥⌘S from anywhere to open the menu, and again to close it; `sideby config set menubar.hotkey cmd+shift+0` picks another shortcut and `off` turns it off. If you cannot see it, your menu bar is full or the icon sits under the notch: hold ⌘ and drag icons to make room, and macOS keeps the place. Turning it on first shows the file it writes (`~/Library/LaunchAgents/dev.sideby.menubar.plist`); add `--yes` to do it.

Every other setting has a command too: `sideby config get` lists them with their values, and `sideby config set panel.theme dark` changes one (it shows the change first).

## Host notes

Tested on 2026-10-05 with the versions below. sideby starts the official binary found on `PATH`; it never patches or wraps it.

| Host | Family | Tested version | Sign-in | Quota | Usage (7 days) |
|---|---|---|---|---|---|
| Claude Code | `claude` | 2.1.289 | `claude auth login` | status line cache (after `quota setup claude`) | local session records |
| Codex CLI | `codex` | 0.160.0 | `codex login` | local session files | local session files |
| Grok Build | `grok` | 1.0.60 | `grok login` | asked from the `grok` CLI | no public source |
| pi | `pi` | 1.0.2 | `/login` inside pi | no public source | no public source |

sideby counts usage itself from Claude Code's `projects/**/*.jsonl` and Codex's `sessions/**/rollout-*.jsonl`; you do not need ccusage. Grok Build's quota comes from its CLI; it has no usage source, and pi has neither. API accounts show usage but no quota. If a Host is not installed, `list` still shows its accounts and marks the Host as missing; `run` tells you where to install it.

Host-specific notes:

- **codex**: non-main accounts get `-c cli_auth_credentials_store="file"` unless your arguments already set that key, so each account keeps its login in its own `auth.json`.
- **grok**: Grok's sandbox rejects symlinks for some paths, so `hooks` and `hooks-paths` are copies, not links, and `trusted_folders.toml` and `config.toml` are the account's own files. Doctor quotes the Host's own message when it finds one.
- **pi**: accounts live one level deeper (`~/.pi-<name>/agent`). `proxy.env` only loads provider keys; it does not make a pi account an API account.
