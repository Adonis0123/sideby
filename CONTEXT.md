# CONTEXT

Glossary for sideby. Defines words only. Decisions live in `docs/adr/`, designs in `docs/specs/`.

## Hosts and accounts

- **Host**: an AI coding CLI that sideby launches but never modifies: Claude Code, Codex, Grok Build, pi.
- **Family**: one Host plus its convention for where an Account lives and how it is selected (an environment variable such as `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`). A Family is provided by a Family Plugin.
- **Account**: one isolated configuration directory of a Family. The directory is the identity: its own login, sessions and history. Accounts are discovered from disk, never listed by hand.
- **Main Account**: the Host's default directory (for example `~/.claude`). It is the source every Shared Item points back to.
- **Subscription Account**: an Account that logs in with the Host's own sign-in (OAuth). Its credentials stay where the Host puts them.
- **Identity**: who a Subscription Account is signed in as (email, and for Claude Code the organization), read from identity fields of the Host's login file only, never from a token (ADR-0003). The Panel can mask it.
- **API Account**: an Account whose directory holds a Secret File. It talks to an API endpoint instead of a subscription. Exception: a Family may keep a Secret File in every Account only to provide keys (pi does); there the file does not make an Account an API Account.
- **Secret File**: `proxy.env` inside an API Account, readable only by its owner. Its variables exist only in the launched Host process.

Avoid: *profile* (Codex already uses it for a config layer that does not change the login), *provider* (an endpoint plus key, which does not cover subscriptions), *switch* (sideby never changes which Account is globally active).

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

## Health

- **Doctor**: the check that reads every Account and reports Findings.
- **Finding**: one result of Doctor: a level (ok, warn, fail), the Account and item it is about, and how to fix it.
- **Fix**: the safe, repeatable repair Doctor can apply for a Finding. A Fix never replaces a real file where a link is expected, and never touches credentials.

## Limits

- **Quota**: a limit the Host's vendor sets on a Subscription Account for a time window (for example 5 hours or 7 days), with the time it resets.
- **Usage**: what an Account has consumed (tokens, estimated cost), counted from the Host's own local records.
- **Quota Pressure**: how full an Account's fullest Quota window is, ignoring windows whose reset time has passed. Unknown when the Account has no Quota yet.
- **Handoff**: moving on to another Account of the same Family when one Account's Quota runs low. sideby recommends the Account with the lowest Quota Pressure; a person starts it. The old session stays in the old Account.

Avoid: *rotation* and *failover* (sideby never moves work between Accounts on its own), *relay* (people use it for a third-party API endpoint).

## Extending

- **Plugin**: a local directory that sideby loads to add a Family or Hooks. Built-in Families are Plugins too.
- **Family Plugin**: a Plugin that describes one Family.
- **Hook**: a function a Plugin runs at a lifecycle event: before a Launch, after an Account is created, or during Doctor.
- **Panel**: the local web page that shows every Account, its health, Quota and Usage.
- **Portal**: another local server that shows the Panel next to other tools' pages, for example under its own `*.localhost` host with a shared top bar. It mounts `createPanelHandler` under a path of its own origin and shows that path in an iframe on a page of the same host and port. It configures the Panel only through the handler's options and never injects markup into it (ADR-0006).
