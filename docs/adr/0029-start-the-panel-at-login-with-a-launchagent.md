# 0029. Start the Panel at login with a LaunchAgent

Date: 2026-10-18 · Status: accepted · Revises the Consequences of ADR-0004

## Context

Users asked for sideby to be running when they sit down, so the Panel shows fresh Quota without first typing `sideby ui`. The Panel can already run detached (`sideby ui --background`, ADR-0004), and `sideby app install` makes a macOS app bundle that opens it on click.

Three independent reviews (Claude, Grok Build, a Codex model through Cursor CLI; 2026-10-18) compared how apps start at login. cc-switch 4.0 uses the `auto-launch` 0.5 crate, which on macOS asks System Events through AppleScript to add a login item; the item must be an `.app`, or macOS opens a terminal window at login. SMAppService needs a signed app. Docker Desktop, Raycast and similar apps put "start at login" as one switch in their general settings.

Options considered:

- An AppleScript login item for the sideby app bundle. Rejected: it needs the Automation permission prompt, depends on `sideby app install`, and the bundle opens the browser when started, which a login should not do.
- SMAppService. Rejected: the app bundle is not signed.
- A LaunchAgent plist written by sideby. Chosen.

## Decision

- `sideby autostart [on|off] [--yes] [--json]`. Without an argument it reports the state. `on` and `off` show the file they will write or remove and exit 10; with `--yes` they act. The Panel's settings switch runs the same plan after showing it.
- macOS: `on` writes `~/Library/LaunchAgents/dev.sideby.panel.plist` (mode 644, as launchd requires) with `RunAtLoad` true, `KeepAlive` false and `AbandonProcessGroup` true (launchd may end the rest of a job's process group when its main process exits; the detached Panel must survive that); `ProgramArguments` are the absolute paths of the Node binary and the sideby entry that ran the command, then `ui --background --no-open`. It loads the agent with `launchctl bootstrap gui/<uid>`; `off` runs `launchctl bootout` and removes the file. The file carries a sideby marker comment; sideby replaces or removes only a file with its marker and reports any other file at that path without touching it.
- Refused, with what to do instead: the sideby entry in the npx cache or under a temporary directory (as `handoff setup` refuses), a path with control characters, and platforms other than macOS for now. Linux (XDG autostart `.desktop`) and Windows (the current user's Run key) follow the same plan later.
- When the recorded paths stop existing (Node or sideby moved, a Local Build switched back), `sideby autostart` and the Panel say so and offer to write the agent again; `sideby update` and `pnpm local` rewrite an existing agent so it keeps pointing at the sideby in use.
- It writes nothing into a Host account directory. Login starts the Panel only; it never starts a Host, opens a browser or makes a request beyond what the Panel already does.

## Consequences

- ADR-0004's background Panel can now start without the user; its login-shell PATH rule applies at login too.
- The LaunchAgent is a file outside sideby's own directories, so it gets an undo (`off`), a marker and a check like the status line wrapper of `quota setup`.
