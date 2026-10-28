# Panel settings from the CLI

Use these commands for the same persistent settings as the Panel. Prefer account refs from `sideby list --json`; commands taking an account also accept its short command. Every JSON response has `schemaVersion: 1`.

## Find where something is

When the user asks where a setting or feature is ("语言在哪改", "where do I turn off Remote Control"), run
`sideby commands <words> --json`. It searches the same list as the Panel's Search (Cmd/Ctrl+K), in English or Chinese,
and returns `{ results: [{ id, kind, title, panel, cliCommand }] }`, best match first. `kind` is `page`, `setting` or
`action` (tolerate others). Offer to do it with `cliCommand` (keep its preview step; never add `--yes` before the user
agrees), or tell the user the `panel` place, such as `Settings → General → Language`. An empty `results` exits 0:
try other words. It finds features only; to find a past session use `sideby history <words> --json`
(`references/sessions.md`).

## Pinned Accounts and Display Order

- `sideby order --json` returns `display` (saved `families`, `accounts`, `pinned`) and `families` in their effective order. Each family has `accounts` with `name`, `ref`, `pinned`; a family with no accounts has an empty array.
- `sideby pin claude:work --json` and `sideby unpin claude:work --json` return `ref`, `pinned`, `changed`, `message`, `display`. They save immediately. Repeating a pin or unpin is a no-op. A Same Login is pinned/unpinned together and counts once; at most three per Family. If full, ask which one to unpin first. A new pin goes last among pins.
- `sideby order claude work main --json` sets that Family's account order using names, not refs or short commands. Unlisted accounts follow in the default order; pins still lead. Unknown or repeated names fail without saving.
- `sideby order --families codex claude --json` sets the Family order; unlisted Families follow.
- `sideby order --reset --json` forgets Family and account order, keeping pins. Save the old `display` from `order --json` before rearranging if the user may want to undo; restore Family/account lists with `order`, and pins with `unpin` then `pin` in their old order.

- Same Login row name: the Panel shows two directories of one login as one row, named after the one that comes first in the order. To show `001` instead of `main`, run `sideby order claude 001` (the rest follows). `order --reset` brings back the main directory's name.
- Desktop app windows (Grok Bot, id `grok-bot`) are a group in the same order: `sideby order --families claude grok-bot codex` places the group, `sideby order grok-bot 001 main` orders its windows. They cannot be pinned.

## Hidden Families and Accounts

When the user says the Panel or the menu bar shows too many tools or accounts ("hide pi", "别显示 Antigravity", "把旧账号藏起来"):

- `sideby hide pi --json` hides a whole Family; `sideby hide claude:old --json` (an account or short command) hides one account with the other directories of its Same Login. `sideby unhide <same> --json` shows it again. Both return `target`, `kind` (`family` or `account`), `hidden`, `changed`, `message`, `display`, save immediately, and repeating one is a no-op. An account of a hidden Family cannot be shown alone: `unhide` says to unhide the Family.
- Hidden is display only: the account still starts with `sideby run`, still shows in Session History, and can still be picked by `sideby next` or Auto Handoff. To stop it taking over, change the Handoff Rules instead. Turning a plugin off (`plugins.<plugin>.enabled: false`) is different: it stops sideby loading the Family at all, so only suggest it when the user asks for that.
- The Panel's account list, the menu bar and the text of `sideby list` leave hidden ones out; `sideby list --all` shows them marked `(hidden)`. `sideby list --json` keeps every account and marks hidden ones `hidden: true` (Families too), so read that field before telling the user an account is missing. `sideby order --json` marks `hidden` per Family and account, and `order --reset` keeps what is hidden.
- In the Panel: the row's … menu has "Hide this account" and "Hide all of <tool>"; the arrange mode has an eye per group and row; the line "N hidden · Show" under the list brings them back for this page.

These affect display only, never Handoff Order. Saving removes names that no longer exist. The existing Same Login rules apply (Claude groups by email and organization; Codex also by ChatGPT workspace; Grok also by x.ai user and team).

## Model and effort

`sideby model claude:work --json` shows `account`, `family`, `settable`, optional `reason`, available `models` and `efforts`, and `sideby`, `host`, `last` choices. Effective `model` and `effort` have `{ value, from }`.

To change them, run `sideby model claude:work opus --effort high --json`; `default` removes a sideby override. Read `change.diff`, `change.args` and `change.applied`. Exit 10 is a preview waiting for `--yes`: show it to the user and confirm before applying the same command with `--yes`. Only sideby's account arguments change, never the Host config. If `settable` is false, relay `reason`.

## Remote Control

`sideby remote-control --json` returns `action` and `groups`: each has `file`, `accounts`, `state`, `undo` and optional `reason`. `state` is `on`, `default`, `off`, `missing` or `blocked`.

Use `sideby remote-control off --json`, `on --json` or `undo --json`. Exit 10 shows the affected groups and waits for `--yes`; confirm before applying. Exit 1 with `applied: false` and a message such as "already off, nothing changed" means no file needed it: tell the user, do not retry. A result has `applied`, optional `results` (`file`, `accounts`, `ok`, `message`) and optional `message`. Only turn it on when asked. Changes affect new sessions; running sessions remain connected until restarted. Undo restores the earlier value only while the key still holds what sideby wrote.

## Theme, language and any other setting

Every setting in sideby's config has a command. `sideby config get --json` returns `file` and `keys`: each has `key` (a dot path; `<…>` marks a part you fill in, such as `accounts.<family>:<name>.args`), `meaning`, `takes`, and the current `value` or, for a key with `<…>`, the `entries` set now. `sideby config get panel.theme --json` returns `key`, `set`, optional `value`, `meaning`, `takes`.

Prefer the dedicated command where one exists (`model`, `order`, `pin`, `quota check`, `handoff enable`, `terminal`, `update --auto`); `config` covers the rest, such as the Panel's theme and language: `sideby config set panel.theme dark --json` (`system`, `light`, `dark`) or `sideby config set panel.language zh --json` (`auto`, `en`, `zh`). A value is JSON when it parses (`90`, `true`, `["cc002","codex001"]`), else text. Exit 10 returns `action`, `key`, `before`, `after`, `changed`, `applied: false`: show the change, and run the same command with `--yes` after the user agrees. `sideby config unset <key>` goes back to the default the same way. The Panel picks a change up on its next refresh.

A value the key does not take fails with code `bad-value` and changes nothing; an unknown key `bad-key`. A plugin's own settings are never read or changed through `config` (code `plugin-config`, they may hold secrets); only `plugins.<plugin>.enabled`. `accounts.<ref>.args` takes only model and effort arguments; other Host arguments belong in a short command (`sideby alias add <short> <ref> -- <args>`).

## Start at login

`sideby autostart --json` returns `supported`, `state` and `path`. `state` is `off`, `on`, `stale` (the Node or sideby it starts was moved; `missing` names it) or `foreign` (a file at that path sideby did not write: leave it, and tell the user). `current` is false when it starts another sideby than this one.

To turn it on ("start sideby at login", "开机启动"), run `sideby autostart on --json`: exit 10 returns the `content` of the file, the `programArguments` and the `commands` it will run. Show that, and run `sideby autostart on --yes --json` after the user agrees; `stale` or `current: false` is fixed the same way. `sideby autostart off` turns it off the same way. At login the Panel starts in the background without opening a window. macOS only for now; elsewhere `supported` is false and `on` fails with code `unsupported`. Running from the npx cache or a temporary folder fails with `npx-cache` or `temp-dir`: hand the user `npm i -g sideby` first. `sideby update` keeps an existing login item pointing at the new version.

## Quota in the menu bar

`sideby menubar --json` returns the same fields as `autostart` (`supported`, `state`, `path`, `current`, `missing?`), plus `loaded` and `hotkey`, for the Menu Bar Item, the sideby icon in the macOS menu bar. To turn it on ("show my quota in the menu bar", "状态栏显示额度"), run `sideby menubar on --json`: exit 10 shows the file (`~/Library/LaunchAgents/dev.sideby.menubar.plist`, which runs the system's `osascript` with the whole menu script and this sideby). Tell the user it adds a login item that shows quota in the menu bar from now on, and run `sideby menubar on --yes --json` after they agree; `sideby menubar off --yes` removes it. The same refusals as `autostart` apply (`unsupported`, `foreign`, `npx-cache`, `temp-dir`, `unsafe-path`), and `sideby update` keeps it pointing at the new version.

The icon stands alone while every tool has quota left. In each tool sideby takes how much the account `sideby next` would pick has used; when the highest of those reaches 60% (orange; red from 85%), the title shows that tool and percent, such as `Codex 61%`. The menu's first line (`headline`) names that account either way. `sideby menubar snapshot --json` prints what the menu shows (`title`, `level`, `headline`, `sections[].rows[]` with `bars`, `reset`, `note` and `recommended`, and `sections[].more` for API key and signed-out accounts); use it to answer "what does my menu bar say". Clicking an account runs `sideby menubar start <account>`, which opens it in the Preferred Terminal. ⌥X opens and closes the menu from anywhere; it needs no macOS permission. To change it ("换个快捷键", "change the menu bar shortcut"), run `sideby menubar hotkey <keys> --json`: `cmd` or `ctrl`, any of `opt` and `shift`, and one letter or digit, such as `ctrl+opt+s`; `off` turns it off, `default` goes back to ⌥X, and a running menu bar item takes it within seconds without a restart (`nudged`). A refusal says why in `code`: `hotkey.reserved` (macOS and most apps use it, such as ⌘Q), `hotkey.needs-modifier` (no opt, cmd or ctrl), `hotkey.invalid`. `sideby menubar hotkey --json` shows it: `registered: false` means macOS did not accept the key, so suggest another. macOS does not tell when another app uses the same keys (both may be accepted), so when the user says the shortcut does nothing, suggest another one too. The Panel has the same as a list (⌥X, ⌥Z, ⌥⌘S, ⌃⌥S, Off, Custom…) in **Menu bar icon ›** under the menu bar switch, with "Can't see the icon?" and "Let AI check it" (`sideby ask --task menubar`).

When the user cannot see the icon ("状态栏没有图标", "the menu bar icon is gone"), read `sideby menubar --json` first. `state: "off"`: it was turned off, often with the menu's "Hide from Menu Bar…"; offer `sideby menubar on --yes`. `state: "on"` with `loaded: false`: on but not running (macOS let it go, for example after an update); `sideby menubar on --yes --json` starts it again without changing the file. `loaded: true`: it runs but is hidden. `icon.visible: false` says so for certain: the menu bar is full and macOS put it behind « (click « to see it, or set it to always show in System Settings › Menu Bar). Otherwise check System Settings › Menu Bar (osascript turned off) and menu bar organizers such as Ice or Bartender.
