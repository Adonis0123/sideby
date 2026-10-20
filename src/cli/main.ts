#!/usr/bin/env node
// Entry point. Keeps imports lazy so `statusline-tap` (run on every status line refresh) and `handoff-hook` (run on
// every tool call while Auto Handoff is on) start fast.
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MIN_NODE = [22, 18]

const HELP = `sideby — run every AI coding account side by side

Usage:
  sideby ask [<text>] [--print]       let your AI handle a sideby task
  sideby terminal [--set <id>|--custom <t>|--unset] choose your terminal
  sideby key <account> [--var <NAME>] enter an API key without echo
  sideby try <account> [--yes]        try the Host with a short paid request
  sideby                              list accounts (same as \`sideby list\`)
  sideby run <account> [-- args]      start the host CLI for one account
  sideby new <family> <name>|--next [--api] [--alias <short>]
                                      create an account (families: claude, codex, grok, pi);
                                      --next picks the next name and short command (cc008);
                                      --alias also adds a short command such as cc008
  sideby pin|unpin <account|short command> [--json]
                                      pin or unpin a Same Login (at most 3 per family)
  sideby order [--json]               show display order, with pinned accounts marked
  sideby order <family> <name>...     set account order within a family
  sideby order --families <id>...     set family order
  sideby order --reset               restore default order, keeping pins
  sideby quota check <family> on|off  turn quota fetching on or off
  sideby update --auto on|off         set Auto Update without running an update
  sideby update --skill [--yes]       update only the installed sideby skill to this version
  sideby families [family]            what each host's accounts share with the main account,
                                      where they live and how they sign in
  sideby alias add <short> <account> [-- args]
                                      add a short command, optionally with host arguments
                                      (sideby alias add pi-kimi pi:main -- --model kimi-coding/k3)
  sideby alias add <short> --pick <family> [--yes]
                                      add a pick command: each run starts the account with the
                                      most quota left (sideby alias add cc --pick claude)
  sideby alias rm <short>             remove a short command
  sideby alias list                   list short commands and pick commands
  sideby login <account>              sign in to an account
  sideby resume <family> [-- args]    run the host; a session resumed by id (claude --resume <id>,
                                      codex resume <id>) starts in the account that holds it
  sideby next <family> [--dry-run] [--include-api] [-- args]
                                      recommend the account with the most quota left (claude, codex, grok)
                                      and start it; --dry-run only recommends
  sideby doctor [target] [--fix] [--force]
                                      check shared items and permissions; --fix repairs safe issues
  sideby quota [account|family] [--refresh]
                                      quota and 7-day token usage; --refresh asks every fetching family again now
  sideby quota setup claude [--yes]   turn on Claude quota (shows the change first)
  sideby quota teardown claude        undo it, restoring the original file
  sideby tune [account|family]        estimate the cheapest auto-compact threshold per model
                                      from your last 7 days of sessions (read-only)
  sideby model <account> [<model>|default] [--effort <level>|default] [--yes]
                                      show or set the model and effort sideby starts this account with
  sideby remote-control [on|off|undo] [--yes]
                                      whether Claude sessions connect to claude.ai by themselves;
                                      off stops that for every account (shows the change first)
  sideby handoff status               what Auto Handoff still needs on this machine
  sideby handoff enable [--yes]       turn it on (shows the config change first); --same-family,
                                      --order claude=codex001,cc002, --threshold n, --prepare-at n
  sideby handoff disable [--yes]      turn it off, keeping the other settings
  sideby handoff ready [--brief <f>]  inside a session sideby started with Auto Handoff: hand over to
                                      the next account when this turn ends (config \`handoff\`);
                                      --to <account> names it, also one this chain already used
  sideby handoff setup grok [--yes]   add sideby's hook file so Grok can hand over at its limit
  sideby handoff teardown grok        remove it
  sideby ui [--port n] [--no-open]    open the local panel
  sideby ui --background              same, without a terminal: keeps running after this command exits
  sideby ui --stop                    stop the background panel
  sideby desktop <account>            open the desktop app (Claude Desktop, the Codex app) as this
                                      account, next to the others (macOS)
  sideby desktop grok-bot:<name>      open a Grok Bot window, a new one for a new name (macOS)
  sideby sessions [<account>|<family>] which session each account runs now, needing you first
  sideby sessions copy <account|session-id> [--as reference|id|resume]
                                      copy one for another AI: a reference to its record (default),
                                      its id or its resume command
  sideby sessions open-run <account|session-id>
                                      open the run report of the dispatched task that session works for
  sideby send <account|session> "<text>" [--image <path>]...
                                      tell another session something (a screenshot too): Claude
                                      sessions get it at once, others through a line you paste
  sideby messages [--to <account|session>]
                                      the messages you sent and whether each was delivered or read
  sideby messages inbound [accept|undo] [--yes]
                                      whether Claude sessions show messages from other sessions at once
  sideby edit <account> [--path]      open the account's own settings file (settings.json,
                                      config.toml) in your editor
  sideby browser [--enable [--yes]]   which Chrome browser user signed in to each account's website
                                      (read on this computer only; off until you enable it)
  sideby browser open <account> [--profile <name>]
                                      open claude.ai, chatgpt.com or grok.com in that browser user
  sideby browser set <account> <name> | --auto
                                      choose that browser user yourself, or let sideby find it again
  sideby app install [--url <url>]    add a sideby app that opens the panel (macOS, Linux)
  sideby app uninstall                remove that app
  sideby shell-init zsh|bash          print shell functions, e.g. eval "$(sideby shell-init zsh)"
  sideby shell-init [zsh|bash] --write
                                      rewrite the config's shellInitFile with them
  sideby shell-init setup [zsh|bash] [--yes|--undo]
                                      make new terminals load your short commands: adds one line to
                                      ~/.zshrc (or ~/.bashrc), shown first; --undo takes it out
  sideby plugins                      list loaded plugins and load errors
  sideby plugins new <id>             create a local Family Plugin skeleton
  sideby plugins check <id|path>      check a plugin and show fixes
  sideby update [--yes]               update sideby to the newest version (shows the command first)
  sideby autostart [on|off] [--yes]   start the panel in the background at login (macOS; shows the
                                      file first)
  sideby menubar [on|off] [--yes]     show quota in the macOS menu bar; click an account to start it
  sideby menubar hotkey [<keys>|off]  show or change the shortcut that opens that menu (⌥X)
  sideby config get [<key>]           every setting with its value and meaning, or one setting
  sideby config set <key> <value> [--yes]
                                      change any setting (sideby config set panel.theme dark)
  sideby config unset <key> [--yes]   back to the default
  sideby local [on|off] [--yes]       for sideby developers: switch the global sideby between the
                                      last local build (pnpm local) and the npm package

Options:
  --json        machine-readable output (list, new, next, alias, doctor, quota, tune, model, remote-control, handoff,
                families, plugins, app, desktop, sessions, send, messages, edit, browser, update, local, ask,
                terminal, key, try, autostart, menubar, config)
  -h, --help    show this help; \`sideby <command> --help\` for new, alias, login, doctor, families, desktop, edit, browser,
                autostart, menubar, config, sessions, send, messages
  -v, --version show the version

An <account> is <family>:<name> (claude:work) or just <name> when it is unique.

For AI agents:
  Add --json and read the result; JSON Schemas ship in the package under schemas/.
  Install the skill: npx skills add Adonis0123/sideby -g
  Setup steps and the full contract: https://github.com/Adonis0123/sideby/blob/main/llms.txt
  Run everything else yourself, but hand the user these as one line each: \`sideby login <account>\`
  (browser sign-in), filling in proxy.env, and \`sideby run\` or \`sideby next\` (interactive sessions).
  Exit 10 means a change was shown: ask the user, then run it again with --yes.

Updates: once a day sideby asks the npm registry for its newest version and says so after a command.
  Turn it off with NO_UPDATE_NOTIFIER=1 or config "update": { "check": false }; "auto": true installs by itself.`

/** `sideby <command> --help` for the commands agents use to set up and repair accounts (spec §3.16). */
const COMMAND_HELP: Record<string, string> = {
  ask: 'sideby ask [<text>] [--task free|fix|quota|account|host|plugin|terminal|handoff|menubar|hotkey] [--account <ref>] [--terminal <id>] [--attach <file>]... [--print] [--json]\nsideby ask --run <id> [--state-dir <dir>]\nsideby ask --spec - [--print] --json\nsideby ask --choices --json\nOpen a task in your terminal. --spec reads a Task Spec (one JSON object, at most 1 MB) from stdin, as a Portal sends it; --choices lists the accounts and terminals a task can use. --attach adds an image (PNG, JPEG, GIF, WebP; up to 20 MB) or a video (MP4, MOV, WebM; up to 200 MB), at most 5. --print prints only the prompt. If opening fails, paste the command into a terminal.',
  terminal:
    "sideby terminal [--set <id>|--custom '<program> … {cwd} … {cmd}'|--unset] [--json]\nList terminals or save your preference; --custom saves and selects your own launch command.",
  key: 'sideby key <account> [--var <NAME>] [--json]\nEnter an API key without echo. Run in a terminal or use the Panel key box.',
  try: 'sideby try <account> [--yes] [--json]\nSend a short request through the Host. This spends a few tokens. Exit 10 waits for --yes.',
  plugins:
    'sideby plugins [--json]\nsideby plugins new <id> [--json]\nsideby plugins check <id|path> [--json]\nPlugins run as you, with your permissions. Only load plugins you trust.',
  new: `sideby new <family> <name> [--api] [--alias <short>] [--json]
sideby new <family> --next [--api] [--alias <short>] [--json]

Create an account directory (~/.claude-<name>, ~/.codex-<name>, ~/.grok-<name>, ~/.pi-<name>/agent) and link or
copy the main account's shared items into it. \`sideby families <family>\` lists them.

  --next          pick the name: the next number after the highest numbered account (001…007 → 008), else work;
                  without --alias, also add a short command that follows your existing ones (cc007 → cc008)
  --api           API account: also writes an empty proxy.env template (mode 600) for the user to fill in
  --alias <short> add a short command for it to the config (it becomes a shell function)

Examples:
  sideby new claude --next --json        # ~/.claude-008 plus cc008 when cc001…cc007 exist
  sideby new claude work                 # ~/.claude-work
  sideby new claude deepseek --api       # then the user fills in ~/.claude-deepseek/proxy.env

Writes: the account directory; the config \`aliases\` and every \`shellInitFile\` when a short command is added.
Next: the user signs in with \`sideby login <account>\` (subscription) or fills in proxy.env (API).
Exit: 0 done; 1 invalid name or alias, directory exists, or partly failed; 2 malformed command line.`,
  alias: `sideby alias add <short> <account> [-- host args] [--json]
sideby alias add <short> --pick <family> [--yes] [--json]
sideby alias rm <short> [--json]
sideby alias list [--json]

A short command starts one account: \`sideby run <short>\`, or just \`<short>\` once your shell loads
\`sideby shell-init\`. Host arguments after -- are added only when it starts through the short command; it is
the same account (same sign-in, same sessions), so do not create an account per model.

A pick command (--pick) starts, each time, the account of that family with the most quota left, the one
\`sideby next\` would pick; when no account has quota data yet it starts the main account. It prints which
account it started. A name that hides a command on PATH (cc is the C compiler on macOS) needs --yes.

Examples:
  sideby alias add cc008 claude:008
  sideby alias add pi-kimi pi:main -- --model kimi-coding/k3
  sideby alias add cc --pick claude      # says first if cc hides a command (exit 10)
  sideby alias rm cc008

Writes: the config \`aliases\` or \`pickCommands\` and every \`shellInitFile\`. New shell functions work in a
new shell, or after eval "$(sideby shell-init zsh)" (put that line in ~/.zshrc once).
Exit: 0 done (also when it already exists or is absent); 1 invalid, reserved or taken; 2 malformed;
10 a pick command would hide a command on PATH, run again with --yes.`,
  login: `sideby login <account>

Run the host's own sign-in for one account: claude auth login, codex login, grok login. For pi it starts pi;
then type /login. It opens a browser and needs the person who owns the account, so an agent hands this
line to the user instead of running it (in Claude Code: ! sideby login claude:008).

sideby never reads, copies or stores the credentials the host writes.
Exit: the host's exit code.`,
  doctor: `sideby doctor [account|family] [--fix] [--force] [--json]

Check every account's shared items against the main account, credential file modes (600), backup leftovers,
and whether the installed sideby skill matches this version.

  --fix     repair what is safe: add missing links, refresh copies, chmod 600, sync MCP servers
  --force   with --fix, also let a synced MCP list (json-key) drop entries the account has

--fix never replaces a real file with a link and never changes where an existing link points; those are
reported with the command to run.

Examples:
  sideby doctor --json
  sideby doctor claude:008 --fix
Exit: 0 when nothing fails (warnings allowed); 1 when a check fails.`,
  desktop: `sideby desktop <account> [--json]
       sideby desktop grok-bot:<name> [--remove [--yes]] [--json]

Open the host's desktop app as one account: Claude Desktop for claude accounts, the Codex app (ChatGPT.app) for codex
accounts. Each account gets its own window, side by side with the others; macOS only for now.

The main account opens the app as usual. Any other subscription account opens a new window with that account's
directory (CLAUDE_CONFIG_DIR, CODEX_HOME) and its own app data folder,
~/Library/Application Support/sideby/<family>/<name>/. When that account's window is already open, sideby brings it
to the front instead of starting another one. API accounts are refused: the apps sign in with a subscription only.

Grok Bot signs in with a Cursor account, apart from every account above, so its windows have names of their own:
grok-bot:<name> opens that window, and makes it first when the name is new (a new window, signed out). grok-bot or
grok-bot:main is Grok Bot's own default window. --remove deletes a window you made, which signs it out and deletes
its data on this Mac; it asks for --yes first (exit 10) and refuses while that window is open. \`sideby list\` shows
the Grok Bot windows.

sideby never copies or changes the app, and never closes a window. The first time, sign in inside the new window;
close the app's other windows while you do, because the sign-in may come back to one of them.

Examples:
  sideby desktop claude:work
  sideby desktop cc008 --json
  sideby desktop grok-bot:002
  sideby desktop grok-bot:002 --remove --yes
Exit: 0 opened, brought to the front or removed; 1 not macOS, no desktop app for that host, API account, app not
installed, a bad window name, or the app did not open; 10 --remove without --yes; 2 malformed command line.`,
  sessions: `sideby sessions [<account>|<family>] [--json]
       sideby sessions copy <account|session-id> [--as reference|id|resume] [--lang en|zh] [--json]
       sideby sessions open-run <account|session-id> [--json]

List the sessions every account runs now (Claude Code, Codex, Grok Build, pi): each row shows the Session Label
(account · the host's own title · first 8 of the id), whether it needs you, its directory and when it started.
Sessions that need you come first. Codex and pi sessions sideby cannot tie to a running program show the account's
newest session, marked "guessed". Read-only: sideby reads the hosts' session files, never a credential.

copy puts one session on the clipboard (pbcopy on macOS, wl-copy or xclip on Linux; without one it prints the text):
by default a Session Reference, one sentence that points another AI at the session's record; --as id copies the bare
id, --as resume the command that resumes it. The reference follows your locale; --lang chooses.
When an account runs several sessions, copy lists them: copy one by its id.

open-run opens the run report (Run Board) of the task a session works for, when a local orchestrator such as the
agent-dispatch skill says so, with the default program. It picks the session the way copy does.

Examples:
  sideby sessions
  sideby sessions cc002 --json
  sideby sessions copy cc002
  sideby sessions copy 61230c3d --as resume
  sideby sessions open-run cc002
Exit: 0 listed, copied or opened; 1 no such account or running session, several to choose from, or the session is
in no run (or its report changed or did not open); 2 malformed command line.`,
  send: `sideby send <account|session> "<text>" [--image <path>]... [--lang en|zh] [--json]

Tell another running session something, with screenshots if you like. <account> is a short command or ref whose
account runs one session now; <session> is a session id or its first 8 characters (see \`sideby sessions\`).
sideby first keeps the message as a file in its state folder (mode 600), with each screenshot copied next to it.
Then a Claude Code session gets it at once through Claude Code's own messages between sessions, with a first line
naming who sent it and one line per screenshot path. Codex, Grok Build and pi have no channel sideby can deliver to
yet: sideby copies one line to the clipboard ("Read the message sideby kept for you at <file> ...") and says which
tab to paste it into. A Claude session in bypass permission mode holds the message until you approve it in its
terminal (about 5 minutes); \`sideby messages inbound accept\` makes it show them at once.
Screenshots: PNG, JPEG, GIF or WebP, up to 20 MB each. Run it inside a session and the message names that session as
the sender. --lang chooses the language of the line to paste (default: your locale).

Examples:
  sideby send cc002 "the tests pass now, go ahead and release"
  sideby send 61230c3d "this is the error I see" --image ~/Desktop/shot.png
  sideby send codex:team "read the plan in docs/plan.md" --json
Exit: 0 delivered or kept for pasting; 1 no such running session, several to choose from, or a screenshot sideby
refuses; 2 malformed command line.`,
  messages: `sideby messages [--to <account|session>] [--limit <n>] [--json]
       sideby messages inbound [accept|undo] [--yes] [--json]

List the messages you sent with \`sideby send\`, newest first: to which session, and how far each got (delivered,
read once it shows in the target's record, or needs paste).

inbound shows, for each Claude account, its crossSessionInbound setting: accept shows a message from another session
at once; hold, or no setting in a session in bypass permission mode, waits for you to approve it and drops it after
about 5 minutes; refuse drops it. accept shows the change to each settings.json (only that key) and writes it with
--yes; a file shared by several accounts is written once, a "refuse" or any other value is left alone and named. undo puts
back exactly what was there, while the key still holds what sideby wrote.

Examples:
  sideby messages
  sideby messages --to cc002 --json
  sideby messages inbound accept --yes
Exit: 0 listed or changed; 1 a file could not be changed or nothing was changed; 10 a change was shown and waits for --yes; 2 malformed
command line.`,
  edit: `sideby edit <account> [--path] [--json]

Open the account's own settings file in your editor: settings.json for claude and pi accounts, config.toml for codex
and grok accounts. It opens with the system's default program (the default text editor on macOS, the Windows default
program on WSL, xdg-open on other Linux). --path only prints where the file is.

sideby reads nothing of the file and never changes it; your editor does. When the file is a link (accounts that
share their settings with the main account), it says where the real file is and which accounts the change affects.
A missing file is not created: the message says how to get one.

Examples:
  sideby edit claude:work
  sideby edit cc008 --path
Exit: 0 opened (or printed with --path); 1 no settings file, the family names none, or it could not be opened; 2
malformed command line.`,
  autostart: `sideby autostart [on|off] [--yes] [--json]

Start the panel in the background when you log in, so it already shows fresh quota when you open it. It never
opens a window or a browser and never starts a host. macOS only for now (a LaunchAgent,
~/Library/LaunchAgents/dev.sideby.panel.plist, that starts this Node and this sideby with ui --background).

Without on or off it says whether it is on, off, out of date (the Node or sideby it starts was moved) or blocked
by a file that is not sideby's. on and off show the file and the launchctl command first; --yes does it.
\`sideby update\` and \`pnpm local\` keep an existing login item pointing at the sideby in use.

Examples:
  sideby autostart --json
  sideby autostart on --yes
  sideby autostart off --yes
Exit: 0 shown, done or nothing to change; 10 a change was shown and waits for --yes; 1 refused (not macOS, sideby
in the npx cache or a temporary folder, a file that is not sideby's) or failed; 2 malformed command line.`,
  menubar: `sideby menubar [on|off] [--yes] [--json]
sideby menubar snapshot [--refresh] [--lang en|zh] [--json]
sideby menubar start <account> [--json]
sideby menubar hotkey [<keys>|off|default] [--json]

Show quota in the macOS menu bar: a gauge with one percent, how much the account sideby would pick next has used
in your tightest tool (orange from 60%, red from 85%). Click it for every account's 5-hour and 7-day quota; click
an account to start it in your preferred terminal. It runs the system's osascript, starts at login and has no Dock
icon. macOS only for now (a LaunchAgent, ~/Library/LaunchAgents/dev.sideby.menubar.plist).

Without on or off it says whether it is on, off, out of date or blocked by a file that is not sideby's. on and off
show the file first; --yes does it. snapshot prints what the menu shows (the menu bar item runs it every 2 minutes).
start opens an account in your preferred terminal, as clicking it does. hotkey shows or changes the shortcut that
opens the menu from anywhere (⌥X by default): opt, cmd or ctrl, any of shift, and one letter or digit; off turns
it off. A running menu bar item takes the new one within seconds, without a restart.

Examples:
  sideby menubar on --yes
  sideby menubar snapshot --json
  sideby menubar start claude:work
  sideby menubar hotkey ctrl+opt+s
  sideby menubar off --yes
Exit: 0 shown, done or nothing to change; 10 a change was shown and waits for --yes; 1 refused (not macOS, sideby
in the npx cache or a temporary folder, a file that is not sideby's), failed, or the terminal did not open; 2
malformed command line.`,
  config: `sideby config get [<key>] [--json]
sideby config set <key> <value> [--yes] [--json]
sideby config unset <key> [--yes] [--json]

Read or change any setting in sideby's config file. <key> is a dot path such as handoff.threshold or panel.theme;
\`sideby config get\` lists every key with its value, what it does and the values it takes. A value is read as
JSON when it parses (90, true, ["cc002","codex001"]), otherwise as text (dark).

set and unset show the change first; --yes saves it. The whole file must still be a valid config, and other keys
and their order are kept. A plugin's own settings are not read or changed here (they may hold secrets), only
plugins.<plugin>.enabled. accounts.<family>:<name>.args takes only the model and effort arguments, as
\`sideby model\` does.

Examples:
  sideby config get --json
  sideby config set panel.theme dark --yes
  sideby config set handoff.threshold 90 --yes
  sideby config unset panel.language --yes
Exit: 0 shown, saved or nothing to change; 10 a change was shown and waits for --yes; 1 not a key, a value the key
does not take, or the file changed meanwhile; 2 malformed command line.`,
  browser: `sideby browser [--enable|--disable] [--yes] [--json]
       sideby browser open <account> [--profile <folder|name>] [--json]
       sideby browser set <account> <folder|name> [--json]
       sideby browser set <account> --auto [--json]

Find which Google Chrome browser user signed in to each account's website (claude.ai for claude accounts,
chatgpt.com for codex accounts), and open the website in that browser user. macOS only for now.

Everything is read on this computer and sent nowhere. sideby reads each browser user's name, the key names (never
the values) claude.ai and chatgpt.com keep in that browser user's Local Storage, and the account id in each Claude and
Codex login file, only to compare. It never opens cookies, saved passwords or the Keychain, and never changes Chrome.
It is off until you turn it on: --enable shows what it reads and changes config browser.signIns after --yes.

"Signed in to" means that browser user's data shows a sign-in as that account; it may be left over from before a
sign-out. When several browser users show one account, sideby keeps those whose Google account in Chrome is the
account's login email. grok.com keeps no id to match, so grok accounts are found only by that email or --profile.

When sideby picks the wrong browser user, set chooses one for the account (saved in config browser.choices; it
replaces what sideby finds, and open uses it). --auto forgets the choice. Only sideby's config is written.

open uses the one browser user that signed in to the account, or the one --profile names (folder such as
"Profile 7", or the name Chrome shows). It runs: open -na "Google Chrome" --args --profile-directory=<folder> <url>.

Examples:
  sideby browser --enable --yes
  sideby browser
  sideby browser open cc008
  sideby browser open grok:main --profile Work
  sideby browser set codex:main "Profile 7"
Exit: 0 shown, changed, chosen or opened; 1 not macOS, Chrome not installed, no or several browser users to choose from, or
Chrome did not open; 10 --enable/--disable without --yes; 2 malformed command line.`,
  families: `sideby families [family] [--json]

For each host (built in or from a plugin): where its accounts live, the variable that selects one, how to sign
in, whether quota and usage can be read, and every shared item with what it looks like in each account
(a link to the main account's, a copy, or the account's own file). Everything else in an account directory
(sign-in, sessions, history) belongs to that account.

Examples:
  sideby families
  sideby families claude --json
Exit: 0; 1 unknown family; 2 malformed command line.`,
}

/**
 * True below Node 22.18. npm's `engines` field only warns (`EBADENGINE`); this is the check that exits.
 * `version` defaults to the running Node so tests can pass a string.
 */
export function nodeTooOld(version = process.versions.node): boolean {
  const [maj = 0, min = 0] = version.split('.').map(Number)
  return maj < MIN_NODE[0]! || (maj === MIN_NODE[0] && min < MIN_NODE[1]!)
}

const COMMANDS: Record<string, { flags: string[]; valued?: string[] }> = {
  ask: {
    flags: ['json', 'print', 'choices'],
    valued: ['task', 'account', 'terminal', 'run', 'state-dir', 'attach', 'spec'],
  },
  terminal: { flags: ['json', 'unset'], valued: ['set', 'custom'] },
  key: { flags: ['json'], valued: ['var'] },
  try: { flags: ['json', 'yes'] },
  autostart: { flags: ['json', 'yes', 'refresh'] },
  menubar: { flags: ['json', 'yes', 'refresh'], valued: ['lang', 'hotkey', 'hotkey-label', 'icon'] },
  config: { flags: ['json', 'yes'] },
  list: { flags: ['json'] },
  pin: { flags: ['json'] },
  unpin: { flags: ['json'] },
  order: { flags: ['json', 'families', 'reset'] },
  run: { flags: [] },
  resume: { flags: [] },
  login: { flags: [] },
  next: { flags: ['dry-run', 'include-api', 'json'] },
  new: { flags: ['api', 'json', 'next'], valued: ['alias'] },
  alias: { flags: ['json', 'yes'], valued: ['pick'] },
  doctor: { flags: ['fix', 'force', 'json'] },
  quota: { flags: ['json', 'yes', 'refresh'] },
  tune: { flags: ['json', 'yes'] },
  model: { flags: ['json', 'yes'], valued: ['effort'] },
  'remote-control': { flags: ['json', 'yes'] },
  handoff: {
    flags: ['json', 'yes', 'same-family', 'no-same-family'],
    valued: ['brief', 'to', 'order', 'prepare-at', 'threshold', 'wait-minutes', 'countdown'],
  },
  ui: { flags: ['no-open', 'background', 'stop', 'serve-detached'], valued: ['port'] },
  app: { flags: ['json'], valued: ['url'] },
  desktop: { flags: ['json', 'remove', 'yes'] },
  sessions: { flags: ['json'], valued: ['as', 'lang'] },
  send: { flags: ['json'], valued: ['image', 'lang'] },
  messages: { flags: ['json', 'yes'], valued: ['to', 'limit'] },
  edit: { flags: ['json', 'path'] },
  browser: { flags: ['json', 'enable', 'disable', 'yes', 'auto'], valued: ['profile'] },
  'shell-init': { flags: ['write', 'yes', 'undo', 'json'] },
  plugins: { flags: ['json'] },
  families: { flags: ['json'] },
  update: { flags: ['json', 'yes', 'skill'], valued: ['auto'] },
  local: { flags: ['json', 'yes'] },
  'update-check': { flags: [] },
}

/** Every value of a repeatable option (`--attach a --attach=b`), in order. */
function repeatedValues(args: readonly string[], name: string): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === `--${name}` && args[i + 1] !== undefined) out.push(args[++i]!)
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3))
  }
  return out
}

/** Commands that never print an Update Notice: their output is read by a shell or an agent, or they are internal. */
function noticeAllowed(cmd: string, parsed: import('./args.ts').ParsedArgs): boolean {
  if (
    (cmd === 'shell-init' && parsed.positionals[0] !== 'setup') ||
    cmd === 'update' ||
    cmd === 'update-check'
  )
    return false
  if (cmd === 'ask' && (parsed.flags.has('print') || parsed.flags.has('run'))) return false
  if (cmd === 'ui' && parsed.flags.has('serve-detached')) return false
  if (cmd === 'handoff' && parsed.positionals[0] === 'ready') return false
  return true
}

/**
 * Before a `--json` command (spec §3.23): the `_notice` its output carries, from the cached Update Check and the
 * installed sideby skills, so an agent that reads JSON learns of a newer version too. Starts the next check detached
 * when the last one is a day old, as afterCommand does on a terminal. Never fails the command.
 */
async function jsonNoticeFor(): Promise<object | null> {
  try {
    const u = await import('../core/update.ts')
    const { resolvePaths } = await import('../core/paths.ts')
    const { loadConfig } = await import('../core/config.ts')
    const { packageVersion } = await import('../core/version.ts')
    const { installedSkillVersions } = await import('../core/skill-check.ts')
    const paths = resolvePaths(process.env)
    const config = await loadConfig(paths.configFile).catch(() => ({}))
    const cache = await u.readUpdateCache(paths)
    const skills = await installedSkillVersions(paths.home)
    // `sideby update` brings the skill along, so it is the one command for both (spec §3.23).
    const n = u.jsonNotice(cache, packageVersion(), config, process.env, skills, 'sideby update')
    if (!u.checksOff(process.env, config) && u.checkDue(cache, new Date())) {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'update-check'], {
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', () => {})
      child.unref()
    }
    return n
  } catch {
    return null
  }
}

/**
 * After a command (spec §3.23): print the Update Notice and the result of an Auto Update, each at most once, and
 * start the next Update Check detached when the last one is a day old. Only on a terminal; never fails the command.
 */
async function afterCommand(): Promise<void> {
  if (!process.stderr.isTTY) return
  try {
    const u = await import('../core/update.ts')
    const { resolvePaths } = await import('../core/paths.ts')
    const { loadConfig } = await import('../core/config.ts')
    const { packageVersion } = await import('../core/version.ts')
    const paths = resolvePaths(process.env)
    const config = await loadConfig(paths.configFile).catch(() => ({}))
    const cache = await u.readUpdateCache(paths)
    const current = packageVersion()
    const skill = u.skillBehind(await u.skillUpdatePlan(paths.home, current).catch(() => null), current)
    const plan = u.afterCommandPlan(cache, current, config, process.env, new Date(), skill)
    const dim = process.env.NO_COLOR ? (t: string) => t : (t: string) => `\x1b[2m${t}\x1b[22m`
    for (const l of plan.lines) console.error(dim(l))
    if (plan.record) await u.updateUpdateCache(paths, plan.record)
    if (plan.startCheck) {
      const { spawn } = await import('node:child_process')
      const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'update-check'], {
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', () => {})
      child.unref()
    }
  } catch {
    // an Update Notice is never worth failing a command
  }
}

export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv
  // Claude Code runs this on every status-line refresh. It must still launch the original command when Node is
  // older than 22.18, so the check below does not apply here (spec §3.1).
  if (first === 'statusline-tap') {
    const { runStatuslineTap } = await import('../quota/statusline-tap.ts')
    return runStatuslineTap(rest, process.env, process.stdin, process.stdout)
  }
  // The handoff hook runs on every tool call while Auto Handoff is on; like the tap it comes before the Node check,
  // so a Host never gets a version error from its own hook (spec §3.17).
  if (first === 'handoff-hook') {
    const { runHandoffHook } = await import('../handoff/hook.ts')
    return runHandoffHook(rest, process.env, process.stdin, process.stdout)
  }
  if (nodeTooOld()) {
    console.error(
      `sideby needs Node ${MIN_NODE.join('.')} or newer (you have ${process.versions.node}). Upgrade: https://nodejs.org, or with nvm: \`nvm install 22 && nvm alias default 22\`, then \`npm i -g sideby\` again (each Node version has its own global packages).`,
    )
    return 1
  }
  if (first === '-v' || first === '--version' || first === 'version') {
    const { packageVersion } = await import('../core/version.ts')
    console.log(packageVersion())
    return 0
  }
  if (first === '-h' || first === '--help' || first === 'help') {
    console.log((rest[0] !== undefined && first === 'help' && COMMAND_HELP[rest[0]]) || HELP)
    return 0
  }
  const cmd = first === undefined || first.startsWith('--') ? 'list' : first
  const args = first === undefined || first.startsWith('--') ? argv : rest
  const spec = COMMANDS[cmd]
  const io = { out: (s: string) => console.log(s), err: (s: string) => console.error(s) }
  const { parseArgs, UsageError } = await import('./args.ts')
  // Only sideby's own options count: arguments after `--` belong to the host.
  const own = args.includes('--') ? args.slice(0, args.indexOf('--')) : args
  const wantsJson = Boolean(spec?.flags.includes('json')) && own.includes('--json')
  let notice: object | null = null
  try {
    if (!spec) throw new UsageError(`unknown command "${cmd}"; run \`sideby --help\``)
    // `run` and `resume` pass everything after the account or family through to the host, with or without `--`.
    let parsed: import('./args.ts').ParsedArgs
    if (cmd === 'run' || cmd === 'resume') {
      const sep = args.indexOf('--')
      const head = sep === -1 ? args : args.slice(0, sep)
      const [ref, ...more] = head
      parsed = {
        positionals: ref ? [ref] : [],
        flags: new Map(),
        rest: [...more, ...(sep === -1 ? [] : args.slice(sep + 1))],
      }
      if (ref === '-h' || ref === '--help') parsed.flags.set('help', true)
    } else {
      try {
        parsed = parseArgs(args, [...spec.flags, 'help'], spec.valued ?? [])
      } catch (err) {
        // `alias add` takes Host arguments too; the usual mistake is leaving out the `--` before them.
        if (cmd === 'alias' && err instanceof UsageError && err.message.startsWith('unknown option'))
          throw new UsageError(
            `${err.message}; put Host arguments after \`--\`, for example: sideby alias add pi-kimi pi:main -- --model kimi-coding/k3`,
          )
        if (cmd === 'next' && err instanceof UsageError && err.message.startsWith('unknown option'))
          throw new UsageError(
            `${err.message}; put Host arguments after \`--\`, for example: sideby next claude -- --model opus`,
          )
        throw err
      }
    }
    if (parsed.flags.has('help')) {
      console.log(COMMAND_HELP[cmd] ?? HELP)
      return 0
    }
    // parseArgs keeps the last value of an option; `ask --attach` may be given several times.
    if (cmd === 'ask') (parsed as import('./commands.ts').AskArgs).attach = repeatedValues(own, 'attach')
    if (cmd === 'send') (parsed as import('./commands.ts').SendArgs).images = repeatedValues(own, 'image')
    const cmds = await import('./commands.ts')
    if (wantsJson && noticeAllowed(cmd, parsed)) {
      notice = await jsonNoticeFor()
      cmds.setJsonNotice(notice)
    }
    const code = await dispatch(cmd, parsed, io, cmds)
    if (!wantsJson && noticeAllowed(cmd, parsed)) await afterCommand()
    return code
  } catch (err) {
    const usage = err instanceof UsageError
    const message = err instanceof Error ? err.message : String(err)
    if (wantsJson) {
      const { UserError } = await import('../core/errors.ts')
      const code = usage ? 'usage' : err instanceof UserError && err.code ? err.code : 'error'
      console.log(
        JSON.stringify(
          { schemaVersion: 1, error: message, code, ...(notice ? { _notice: notice } : {}) },
          null,
          2,
        ),
      )
    } else console.error(`sideby: ${message}`)
    if (!usage && process.env.SIDEBY_DEBUG && err instanceof Error) console.error(err.stack)
    return usage ? 2 : 1
  }
}

async function dispatch(
  cmd: string,
  parsed: import('./args.ts').ParsedArgs,
  io: import('./commands.ts').Io,
  cmds: typeof import('./commands.ts'),
): Promise<number> {
  switch (cmd) {
    case 'ask':
      return cmds.cmdAsk(parsed, io)
    case 'terminal':
      return cmds.cmdTerminal(parsed, io)
    case 'key':
      return cmds.cmdKey(parsed, io)
    case 'try':
      return cmds.cmdTry(parsed, io)
    case 'pin':
    case 'unpin':
      return await cmds.cmdPin(parsed, io, cmd === 'pin')
    case 'order':
      return await cmds.cmdOrder(parsed, io)
    case 'list':
      return await cmds.cmdList(parsed, io)
    case 'run':
      return await cmds.cmdRun(parsed, io, 'run')
    case 'login':
      return await cmds.cmdRun(parsed, io, 'login')
    case 'resume':
      return await cmds.cmdResume(parsed, io)
    case 'next':
      return await cmds.cmdNext(parsed, io)
    case 'new':
      return await cmds.cmdNew(parsed, io)
    case 'alias':
      return await cmds.cmdAlias(parsed, io)
    case 'doctor':
      return await cmds.cmdDoctor(parsed, io)
    case 'quota':
      return await cmds.cmdQuota(parsed, io)
    case 'tune':
      return await cmds.cmdTune(parsed, io)
    case 'model':
      return await cmds.cmdModel(parsed, io)
    case 'remote-control':
      return await cmds.cmdRemoteControl(parsed, io)
    case 'handoff':
      return await cmds.cmdHandoff(parsed, io)
    case 'ui':
      return await cmds.cmdUi(parsed, io)
    case 'app':
      return await cmds.cmdApp(parsed, io)
    case 'desktop':
      return await cmds.cmdDesktop(parsed, io)
    case 'sessions':
      return await cmds.cmdSessions(parsed, io)
    case 'send':
      return await cmds.cmdSend(parsed, io)
    case 'messages':
      return await cmds.cmdMessages(parsed, io)
    case 'edit':
      return await cmds.cmdEdit(parsed, io)
    case 'browser':
      return await cmds.cmdBrowser(parsed, io)
    case 'shell-init':
      return await cmds.cmdShellInit(parsed, io)
    case 'plugins':
      return await cmds.cmdPlugins(parsed, io)
    case 'families':
      return await cmds.cmdFamilies(parsed, io)
    case 'update':
      return await cmds.cmdUpdate(parsed, io)
    case 'update-check':
      return await cmds.cmdUpdateCheck(parsed, io)
    case 'local':
      return await cmds.cmdLocal(parsed, io)
    case 'autostart':
      return await cmds.cmdAutostart(parsed, io)
    case 'menubar':
      return await cmds.cmdMenubar(parsed, io)
    case 'config':
      return await cmds.cmdConfig(parsed, io)
  }
  return 2
}

// Run when executed directly, also through symlinks (npm's bin shim, a user alias like `sb`).
function isEntry(): boolean {
  const arg = process.argv[1]
  if (!arg) return false
  try {
    return (
      pathToFileURL(realpathSync(arg)).href ===
      pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
    )
  } catch {
    return false
  }
}
if (isEntry()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (err: unknown) => {
      console.error(`sideby: ${err instanceof Error ? err.message : String(err)}`)
      process.exitCode = 1
    },
  )
}
