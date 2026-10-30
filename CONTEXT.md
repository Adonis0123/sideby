# CONTEXT

Glossary for sideby. Defines words only. Decisions live in `docs/adr/`, designs in `docs/specs/`.

## Hosts and accounts

- **Host**: an AI coding CLI that sideby launches but never modifies: Claude Code, Codex, Grok Build, pi.
- **Family**: one Host plus its convention for where an Account lives and how it is selected (an environment variable such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). A Family is provided by a Family Plugin.
- **Account**: one isolated configuration directory of a Family. The directory is the identity: its own login, sessions and history. Accounts are discovered from disk, never listed by hand.
- **Main Account**: the Host's default directory (for example `~/.claude`). It is the source every Shared Item points back to.
- **Main-only Family**: a Family whose Host offers no way to run a second Account apart from the first (no variable that moves its configuration directory, or a login kept in one fixed place), so sideby knows only its Main Account and refuses to create others. Antigravity CLI is one (ADR-0047).
- **Subscription Account**: an Account that logs in with the Host's own sign-in (OAuth). Its credentials stay where the Host puts them.
- **Identity**: who a Subscription Account is signed in as (email, and for Claude Code the organization), read from identity fields of the Host's login file only, never from a token (ADR-0003). The Panel can mask it.
- **Same Login**: two or more Subscription Accounts of one Family that are signed in as the same Identity (the same email and organization; for Codex also the same ChatGPT workspace, for Grok the same x.ai user and team, compared through a Login Key). They are separate directories with separate sessions, but the vendor counts one Quota for all of them. The Panel shows them as one row, with the quota once, and says *same login*.
- **API Account**: an Account whose directory holds a Secret File. It talks to an API endpoint instead of a subscription. Exception: a Family may keep a Secret File in every Account only to provide keys (pi does); there the file does not make an Account an API Account.
- **Secret File**: `proxy.env` inside an API Account, readable only by its owner. Its variables exist only in the launched Host process.

- **Login Key**: an opaque hash a Family derives from an Account's login file (for Codex, its ChatGPT workspace and user ids) only to tell whether two Accounts share one login. It is never shown or stored (ADR-0028).

- **Desktop App**: a Family's desktop application (Claude Desktop, the Codex app), which sideby starts for one Account but never modifies. Optional per Family. Not a Host.
- **App Data**: the data directory a Desktop App keeps for one Account.
- **App Profile**: one named window of a desktop app that signs in apart from every Account (Grok Bot), with its own App Data; ref `grok-bot:<name>`, `grok-bot:main` being the app's default data. Not an Account.

- **Browser Profile** (the Panel says *browser user*): one person's own space in a web browser, such as a Chrome profile named "Work", with its own sign-ins to vendor websites. Not an Account and not an App Profile.
- **Browser Sign-in**: a trace in a Browser Profile's local data that it signed in to the vendor's website as the same vendor account as one Account. It may be out of date; sideby says the Browser Profile *signed in to* the Account, never that it is signed in now.

Avoid: *profile* on its own (Codex already uses it for a config layer that does not change the login), *provider* (an endpoint plus key, which does not cover subscriptions), *switch* (sideby never changes which Account is globally active).

## Sharing

- **Shared Item**: an entry in an Account directory that should match the Main Account, such as skills, hooks or the rules file.
- **Share Mode**: how one Shared Item must look in an Account for that Family to start and stay consistent: a link, a copy, a local file, or information only.
- **Drift**: a Shared Item that does not match its Share Mode.

## Launching

- **Launch**: starting a Host for one Account, with only that Account's identity in the environment.
- **Hijack Variable**: an environment variable that would override an Account's identity if inherited (for example a global `ANTHROPIC_API_KEY`). Cleared before every Launch.
- **Egress**: the network address a vendor sees a Host's requests come from, and the country it places that address in. It follows the Host's own route (its proxy settings), not the machine's.
- **Network Guard** (the Panel says *network check*): an opt-in check that a Host's Egress is in a country the user allows. It refuses a Launch, and stops a prompt or tool call inside a session sideby started, when the Egress is outside that list or cannot be told. Sessions started without sideby are not covered.
- **Side by side**: two or more Accounts launched at the same time, from any Family, without affecting each other.
- **Alias** (the Panel says *short command*): a name in the config `aliases`, such as `cc008`, that starts one Account, optionally with fixed Host arguments (`pi-kimi` starts the same Account as `pi001` with another model). It never changes which Account starts, so two Aliases of one Account share its login and sessions. `sideby shell-init` turns each into a shell function; commands that take an Account accept it too.
- **Pick Command** (the Panel says *start the one with most room*): a name in the config `pickCommands`, such as `cc`, bound to one Family. Each time it runs it starts the Account of that Family a Handoff would pick, with the lowest Limit Use; when no Account of the Family has Quota data it starts the Main Account and says so. Unlike an Alias, which Account it starts can change from one run to the next. `sideby shell-init` turns each into a shell function. Off until the user adds one.
- **Shell-init file**: a file named in the config `shellInitFile` that sideby keeps equal to the `sideby shell-init` output, for shells that source it instead of running `eval`.
- **Resume Routing**: with config `resumeRouting`, a shell function with the Host's own name sends a bare resume by session id (`claude --resume <id>`, as terminal managers type it) to the Account that holds the session, through `sideby resume`. A Claude session that was started but never saved opens as a new session in the Account that started it (ADR-0009). It never copies sessions (ADR-0007).

## Sessions

- **Session**: one conversation of a Host in one Account, known by the Host's session id. It stays in the Account that started it.
- **Live Session**: a Session whose Host process is still running. sideby finds it from the Host's own files; where it can only guess (the newest Session of an Account), it says so.
- **Session Label**: how a Session is shown wherever the user looks (tab title, status line, lists): the Account name, the Host's own title for the Session, and a short id, as in `cc002 · knip cleanup · 61230c3d`. sideby never invents the title.
- **Session Reference**: one sentence that points another AI at a Session (its Account, Label and where its record is), ready to paste. It is what a copy button copies first.
- **Run**: a piece of work a local orchestrator (such as the `agent-dispatch` skill) splits across several Sessions, with a Run Board: a static HTML report file in the orchestrator's state folder. sideby never starts or changes one; it only shows which Run a Live Session works for.
- **Session Index**: the optional file an orchestrator publishes (`agent-dispatch/session-index.json` in its state folder) that maps Session ids to Runs. sideby reads it to show a Run Link: a chip on a Session's row that opens the Run Board (ADR-0041).
- **Message**: text, and optionally screenshots, that one Session (or the user) sends to a Live Session with `sideby send`. It is kept as a file in sideby's state folder before any delivery, so it is never lost; it is then delivered through the Host's own channel (Claude Code's messages between sessions), read once its id shows in the target's record, or handed to the user as one line to paste.

- **Session History** (the Panel says *History*): every Session of every Account that its Host still keeps on disk, live or not, listed and searched in one place. Its rows are Sessions; a past Session is not a different thing.
- **Project**: the git repository a Session worked in. A worktree or a subfolder counts as its main repository; a Session outside any repository belongs to its working directory. A Project whose folder is gone still has its Sessions.
- **Command List** (the Panel says *Commands*): every `sideby` command a person or their AI runs, grouped by task with the common ones first, each with a one-line description and an example. `sideby --help`, `sideby commands` with no words and the Panel's Commands dialog (button or `?`) all show it. It names commands; the Command Palette finds features.
- **Command Palette** (the Panel says *Search*): the box opened by the search button or Cmd/Ctrl+K that finds a page, a setting or an action of sideby by name, in either language, and takes the user there. It finds features, never Sessions: for those it hands the words to Session History.
- **Session Title**: what a row of Session History shows first: the name the user gave the Session, else the Host's own title, else the first prompt the user typed (sideby still never invents one).
- **Script Session**: a Session no person typed into, started by a script, an SDK or another agent (`claude -p`, `codex exec`, a headless Grok run, a subagent). Session History hides them unless asked; a subagent's Session is folded under the Session that started it.
- **History Index**: sideby's own local copy of each Session's title, Project, prompts and replies (never tool output, never a credential), kept in sideby's state folder so Session History opens and searches at once. It can be turned off and deleted, and is rebuilt from the Hosts' files (ADR-0042).

Avoid: *tab* for a Session (one tab can run several Sessions over time), *inbox* (Claude Code's own word for its native delivery), *workspace* for a Project (Orca and editors use it for an open window), *Session Index* for the History Index (that is the orchestrator's file).

## Health

- **Doctor**: the check that reads every Account and reports Findings.
- **Finding**: one result of Doctor: a level (ok, warn, fail), the Account and item it is about, and how to fix it.
- **Fix**: the safe, repeatable repair Doctor can apply for a Finding. A Fix never replaces a real file where a link is expected, and never touches credentials.

## Limits

- **Quota**: a limit the Host's vendor sets on a Subscription Account for a time window (for example 5 hours or 7 days), with the time it resets. Some limits cover only one group of models (Cursor's *other models*) and are named after it; the Account can still work with the other models when one is used up.
- **Usage**: what an Account has consumed (tokens, estimated cost), counted from the Host's own local records.
- **Quota Pressure**: how full an Account's fullest Quota window is, ignoring windows whose reset time has passed and limits that cover only one group of models. Unknown when the Account has no Quota yet.
- **Short Window**: a Quota window of one day or less, such as Claude Code's or Codex's 5 hours. It warns at 60% used and turns red at 85%.
- **Long Window**: a Quota window longer than one day, such as a week or a billing period. One full Short Window costs only a small share of it (about a fifth of a Claude Code week), so it warns later: at 85% used, red at 95%. No Host has a daily Quota.
- **Limit Use**: how close an Account is to its Takeover Limits: the percent of its own Takeover Limit that its closest window has used. A Long Window at 87% under a limit of 95 is 91.6. A Handoff picks the Account with the lowest Limit Use.
- **Handoff**: moving on to another Account when one Account's Quota runs low. The next Account starts a new session; the old session stays in the old Account. Started by a person (`sideby next`) or by sideby itself (Auto Handoff).
- **Handoff Order**: which Accounts a Handoff may move on to, and in what order: either the Family's Accounts by lowest Limit Use, or a list the user writes, which may name Accounts of other Families.
- **Handoff Brief**: the note the next Account starts from: what the task is, what is done, what is left. Written by the old session while it still has Quota, or put together by sideby from the old session's local records when it could not.
- **Handoff Threshold**: the Quota Pressure at which an Auto Handoff begins. One value for every Quota window of an Account, short or long.
- **Takeover Limit**: the used percent at which one Quota window keeps its Account from taking over a Handoff, so the next Account starts with room to work. A Short Window's sits 10 points below the Handoff Threshold (85% by default); a Long Window's is the Handoff Threshold itself (95% by default). Both move with it.
- **Last Resort**: the pick of a start the user asks for (`sideby next`, a Pick Command, the Panel's Next tag) when every Subscription Account has a window past its Takeover Limit: the one with the lowest Limit Use that has no window used up. Auto Handoff never makes one.
- **Handoff Rules**: the plain-language list of every rule that decides when a Handoff happens and which Account takes over, as it applies right now, each shown next to the setting that changes it.
- **Hand-over Level**: the used percent at which one Quota window of a running session starts an Auto Handoff. It follows how fast that window has been used in the session's recent turns, so a window used slowly hands over later than the Handoff Threshold and one used fast earlier; before any turn is measured it is the Handoff Threshold.
- **Auto Handoff**: a Handoff sideby carries out by itself when a window of a running session reaches its Hand-over Level: the old session writes the Handoff Brief and ends, and the next Account in the Handoff Order starts from it in the same terminal.
- **Compaction Threshold**: how large a session's context may grow before the Host compacts it by itself. Not the Handoff Threshold, which is about Quota.
- **Tuning Suggestion**: a Compaction Threshold that sideby estimates would spend fewer tokens for one model in one Account, replaying that Account's recent local session records. An estimate, never applied by sideby.

Avoid: *rotation* (cycling through Accounts per request or on a timer; a Handoff moves on only when Quota runs low and never goes back to a full Account), *failover* (say Auto Handoff), *relay* (people use it for a third-party API endpoint).

## Unattended Mode

- **Unattended Mode**: a state of the whole computer in which nobody is there to answer, so sessions sideby starts never stop to wait for a person: the model is not allowed to ask questions (with the ask tool or as text at the end of its turn) and takes the recommended option where it can be undone, and a permission prompt Claude Code is about to show is answered with "no" and how to do the step without one. On during a Slot, when the user turns it on by hand, or for one session started with it.
- **Schedule**: the user's list of Slots that turn Unattended Mode on and off by themselves. Empty unless the user adds one.
- **Slot**: one entry of the Schedule: the days of the week, a start time and an end time, in the computer's own time zone. An end before the start runs past midnight and belongs to the start day.
- **Pending Decision**: a question the model was not allowed to ask, a permission request nobody was there to answer, or an action it left undone, during Unattended Mode, kept for the user to look at once someone is back.

Avoid: *window* (a Quota window), *quiet hours* (sounds like muting alerts only), *away* (sideby does not watch the keyboard).

## Updates

- **Update Check**: asking the npm registry, at most once a day, which sideby version is the newest. The only question sideby sends over the network on its own; it carries no Account, path or identity. On unless the user turns it off.
- **Update Notice**: the one line, in the terminal or the Panel, that says a newer sideby exists and how to get it.
- **Install Method**: how this copy of sideby was installed (a global npm, pnpm or bun package, the npx cache, a project dependency, a source checkout, a Local Build). It decides whether sideby can update itself or only names the command.
- **Local Build**: the checkout's working tree compiled by `pnpm local` and put behind the global `sideby` command (ADR-0024). It never checks for updates; `pnpm local --off` goes back to the npm package.
- **Update**: replacing the installed sideby with a newer version through its Install Method, after the user confirms (`sideby update`, the Panel's button). Programs already running keep the old version until they start again.
- **Auto Update**: an Update sideby carries out by itself after an Update Check. Off unless the user turns it on.

Avoid: *upgrade* (say Update), *self-update* in user-facing text.

## Extending

- **Plugin**: a local directory that sideby loads to add a Family or Hooks. Built-in Families are Plugins too.
- **Family Plugin**: a Plugin that describes one Family.
- **Hook**: a function a Plugin runs at a lifecycle event: before a Launch, after an Account is created, or during Doctor.
- **Panel**: the local web page that shows every Account, its health, Quota and Usage.
- **Menu Bar Item** (the Panel says *show quota in the menu bar*; 中文「状态栏图标」): the sideby icon in the macOS menu bar; next to it, once the Account a Handoff would pick in the tightest Family reaches its warning level (60% of a Short Window, 85% of a Long Window), that Family and percent. Its menu lists every Account with its Quota; clicking an Account starts it in the Preferred Terminal. Off until the user turns it on.
- **Display Order** (the Panel says *my order*): the order the user gives the Families, and the Accounts within each Family, for showing them in the Panel and `sideby list`. Families always appear in it; the Panel's other sorts (by Quota, name, recent use) reorder only the Accounts and leave it as it is. A new Family or Account goes last. It never changes which Account a Handoff picks; that is the Handoff Order.
- **Pinned Account** (the Panel says *pinned*): an Account the user put at the top of its Family. Pinned Accounts lead their Family in every sort, at most three per Family, and the Accounts of one Same Login are pinned together. Resetting the Display Order keeps them. Like the Display Order, it never changes which Account a Handoff picks.
- **Hidden** (the Panel says *hidden*): a Family or an Account the user chose not to see in the lists. It is still there: it can still be started, searched in Session History and picked by a Handoff; only the lists leave it out. The Accounts of one Same Login are hidden together. A new Family or Account is shown until the user hides it. Not the same as turning a Plugin off, which stops sideby loading the Family at all.
- **Portal**: another local server that shows the Panel next to other tools' pages, for example under its own `*.localhost` host with a shared top bar. It mounts `createPanelHandler` under a path of its own origin and shows that path in an iframe on a page of the same host and port. It configures the Panel only through the handler's options and never injects markup into it (ADR-0006).
- **Theme** (中文「主题」): a named set of Panel colors, with one version for light and one for dark. The user picks one; a Portal Theme still wins for the colors it sets.
- **Built-in Theme** (中文「内置主题」): a Theme that ships with sideby. Sky (中文「晴空」) is the default.
- **Theme File** (中文「主题文件」): a Theme the user, or their AI, made: a data file in the themes folder that starts from a Built-in Theme and changes only what it names. It holds colors, never code.
- **Portal Theme**: the colors and type a Portal passes to the Panel for its own pages (`PanelTheme`). It decides only the colors it names; the user's Theme fills the rest.

## Asking AI

- **AI Task** (the Panel says *let AI do it*): a task the user hands to one of their own Accounts, from the Panel, the CLI or a Portal. sideby opens the Preferred Terminal and starts that Account's Host with a Task Prompt; the Host then does the work with a Skill: the sideby skill for sideby's own tasks, or another Tool's Skill for a task a Portal hands over for that Tool. Not a new assistant: the AI is the user's own Host. It starts as `sideby run` would, except never with the Host's permission checks switched off (ADR-0031).
- **Task Spec**: the JSON object a Portal sends `sideby ask --spec -` on stdin to start an AI Task (ADR-0030): either a Task Prompt the Portal wrote for another Tool, with the folder it starts in, or one of sideby's own tasks (`native`), whose Task Prompt sideby writes. It carries a `specVersion`.
- **Task Prompt**: the prompt sideby writes for one AI Task: what to do and the context it starts from (which Account, which Finding, the Panel's language), ending with an invitation to contribute the result to sideby. How to do the task lives in the skill, not in the prompt.
- **Preferred Terminal**: the terminal app sideby opens for an AI Task or a sign-in, chosen by the user or guessed from the terminal the Panel was started in.

Avoid: *assistant* or *agent* for the AI of an AI Task (it is a Host running an Account).
