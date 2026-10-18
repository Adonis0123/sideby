# CONTEXT

Glossary for sideby. Defines words only. Decisions live in `docs/adr/`, designs in `docs/specs/`.

## Hosts and accounts

- **Host**: an AI coding CLI that sideby launches but never modifies: Claude Code, Codex, Grok Build, pi.
- **Family**: one Host plus its convention for where an Account lives and how it is selected (an environment variable such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). A Family is provided by a Family Plugin.
- **Account**: one isolated configuration directory of a Family. The directory is the identity: its own login, sessions and history. Accounts are discovered from disk, never listed by hand.
- **Main Account**: the Host's default directory (for example `~/.claude`). It is the source every Shared Item points back to.
- **Subscription Account**: an Account that logs in with the Host's own sign-in (OAuth). Its credentials stay where the Host puts them.
- **Identity**: who a Subscription Account is signed in as (email, and for Claude Code the organization), read from identity fields of the Host's login file only, never from a token (ADR-0003). The Panel can mask it.
- **Same Login**: two or more Subscription Accounts of one Family that are signed in as the same Identity (the same email and organization; for Codex also the same ChatGPT workspace, compared through a Login Key). They are separate directories with separate sessions, but the vendor counts one Quota for all of them. The Panel shows them as one row, with the quota once, and says *same login*.
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
- **Side by side**: two or more Accounts launched at the same time, from any Family, without affecting each other.
- **Alias** (the Panel says *short command*): a name in the config `aliases`, such as `cc008`, that starts one Account, optionally with fixed Host arguments (`pi-kimi` starts the same Account as `pi001` with another model). It never changes which Account starts, so two Aliases of one Account share its login and sessions. `sideby shell-init` turns each into a shell function; commands that take an Account accept it too.
- **Shell-init file**: a file named in the config `shellInitFile` that sideby keeps equal to the `sideby shell-init` output, for shells that source it instead of running `eval`.
- **Resume Routing**: with config `resumeRouting`, a shell function with the Host's own name sends a bare resume by session id (`claude --resume <id>`, as terminal managers type it) to the Account that holds the session, through `sideby resume`. A Claude session that was started but never saved opens as a new session in the Account that started it (ADR-0009). It never copies sessions (ADR-0007).

## Health

- **Doctor**: the check that reads every Account and reports Findings.
- **Finding**: one result of Doctor: a level (ok, warn, fail), the Account and item it is about, and how to fix it.
- **Fix**: the safe, repeatable repair Doctor can apply for a Finding. A Fix never replaces a real file where a link is expected, and never touches credentials.

## Limits

- **Quota**: a limit the Host's vendor sets on a Subscription Account for a time window (for example 5 hours or 7 days), with the time it resets. Some limits cover only one group of models (Cursor's *other models*) and are named after it; the Account can still work with the other models when one is used up.
- **Usage**: what an Account has consumed (tokens, estimated cost), counted from the Host's own local records.
- **Quota Pressure**: how full an Account's fullest Quota window is, ignoring windows whose reset time has passed and limits that cover only one group of models. Unknown when the Account has no Quota yet.
- **Handoff**: moving on to another Account when one Account's Quota runs low. The next Account starts a new session; the old session stays in the old Account. Started by a person (`sideby next`) or by sideby itself (Auto Handoff).
- **Handoff Order**: which Accounts a Handoff may move on to, and in what order: either the Family's Accounts by lowest Quota Pressure, or a list the user writes, which may name Accounts of other Families.
- **Handoff Brief**: the note the next Account starts from: what the task is, what is done, what is left. Written by the old session while it still has Quota, or put together by sideby from the old session's local records when it could not.
- **Handoff Threshold**: the Quota Pressure at which an Auto Handoff begins, and at which an Account counts as full for taking over.
- **Hand-over Level**: the used percent at which one Quota window of a running session starts an Auto Handoff. It follows how fast that window has been used in the session's recent turns, so a window used slowly hands over later than the Handoff Threshold and one used fast earlier; before any turn is measured it is the Handoff Threshold.
- **Auto Handoff**: a Handoff sideby carries out by itself when a window of a running session reaches its Hand-over Level: the old session writes the Handoff Brief and ends, and the next Account in the Handoff Order starts from it in the same terminal.
- **Compaction Threshold**: how large a session's context may grow before the Host compacts it by itself. Not the Handoff Threshold, which is about Quota.
- **Tuning Suggestion**: a Compaction Threshold that sideby estimates would spend fewer tokens for one model in one Account, replaying that Account's recent local session records. An estimate, never applied by sideby.

Avoid: *rotation* (cycling through Accounts per request or on a timer; a Handoff moves on only when Quota runs low and never goes back to a full Account), *failover* (say Auto Handoff), *relay* (people use it for a third-party API endpoint).

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
- **Display Order** (the Panel says *my order*): the order the user gives the Families, and the Accounts within each Family, for showing them in the Panel and `sideby list`. Families always appear in it; the Panel's other sorts (by Quota, name, recent use) reorder only the Accounts and leave it as it is. A new Family or Account goes last. It never changes which Account a Handoff picks; that is the Handoff Order.
- **Pinned Account** (the Panel says *pinned*): an Account the user put at the top of its Family. Pinned Accounts lead their Family in every sort, at most three per Family, and the Accounts of one Same Login are pinned together. Resetting the Display Order keeps them. Like the Display Order, it never changes which Account a Handoff picks.
- **Portal**: another local server that shows the Panel next to other tools' pages, for example under its own `*.localhost` host with a shared top bar. It mounts `createPanelHandler` under a path of its own origin and shows that path in an iframe on a page of the same host and port. It configures the Panel only through the handler's options and never injects markup into it (ADR-0006).

## Asking AI

- **AI Task** (the Panel says *let AI do it*): a task the user hands to one of their own Accounts, from the Panel, the CLI or a Portal. sideby opens the Preferred Terminal and starts that Account's Host with a Task Prompt; the Host then does the work with a Skill: the sideby skill for sideby's own tasks, or another Tool's Skill for a task a Portal hands over for that Tool. Not a new assistant: the AI is the user's own Host. It starts as `sideby run` would, except never with the Host's permission checks switched off (ADR-0031).
- **Task Spec**: the JSON object a Portal sends `sideby ask --spec -` on stdin to start an AI Task (ADR-0030): either a Task Prompt the Portal wrote for another Tool, with the folder it starts in, or one of sideby's own tasks (`native`), whose Task Prompt sideby writes. It carries a `specVersion`.
- **Task Prompt**: the prompt sideby writes for one AI Task: what to do and the context it starts from (which Account, which Finding, the Panel's language), ending with an invitation to contribute the result to sideby. How to do the task lives in the skill, not in the prompt.
- **Preferred Terminal**: the terminal app sideby opens for an AI Task or a sign-in, chosen by the user or guessed from the terminal the Panel was started in.

Avoid: *assistant* or *agent* for the AI of an AI Task (it is a Host running an Account).
