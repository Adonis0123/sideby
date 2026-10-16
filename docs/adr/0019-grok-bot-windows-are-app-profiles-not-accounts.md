# ADR 0019: Grok Bot windows are App Profiles of their own, not tied to grok Accounts

Date: 2026-10-16 · Status: accepted (real-app check below)

## Context

Grok Bot (`Grok Bot.app`, bundle id `com.anysphere.sand`) is xAI's desktop app. It signs in with a Cursor account (https://docs.x.ai/grok-bot/get-started) and shares nothing with the grok Family, Grok Build: not the sign-in (`grok login`), not `GROK_HOME`, not the Quota. Its own account menu keeps several accounts but signs in to one at a time. Users want several Grok Bot windows open at once, each signed in to a different account.

In 0.71.2, `--user-data-dir=<dir>` is the app's own isolated mode: it moves Electron's userData there, puts its data root (sessions, the local exec daemon, `host.lock`) in `<dir>/sand-data`, and skips the migration of `~/.grokbot`. `SAND_DATA_ROOT` and `SAND_USER_DATA_DIR` take precedence over the flag.

Options:

- Treat Grok Bot as the grok Family's Desktop App (ADR-0015), one window per grok Account. Rejected: the row would show the Grok Build email next to a window signed in as someone else; a Grok Bot user would need a Grok Build account directory per window; API Accounts would be refused for a reason that does not apply; removing an Account would leave the window's data behind.
- Make Grok Bot a Family. Rejected: a Family is a Host with a CLI, Shared Items, a sign-in command and Launch; Grok Bot has none of them.
- Named App Profiles, independent of Accounts. Chosen.

## Decision

- An App Profile is one Grok Bot window: ref `grok-bot:<name>`, data in `~/Library/Application Support/sideby/grok-bot/<name>/` (mode 700); `grok-bot:main` is the app's default data. macOS only, internal definition (not in `FamilyDef`).
- `sideby desktop grok-bot:<name>` creates the folder when it is missing and opens `open -n -a <app> --args --user-data-dir=<folder>`, with `SAND_DATA_ROOT`, `SAND_USER_DATA_DIR`, `SIDEBY_*` and agent-session variables cleared. A running window is brought to the front, as in ADR-0015.
- `--remove --yes` deletes a non-main Profile's folder, only when its window is closed and the folder is a real directory inside sideby's folder. Without `--yes` it only says what would go (exit 10).
- The signed-in state comes from the app's own `desktop-status.json` (`signedIn`, a boolean next to a version, a pid and a start time). Which account is signed in is not shown: finding out would mean reading credentials.
- `sideby list` and the Panel show the Profiles in their own Grok Bot group, with a button to open another.

## Consequences

- Any number of Grok Bot windows, none tied to a grok Account; grok Accounts get no desktop button.
- Users tell Profiles apart by name, since sideby cannot show the signed-in email.
- The flag and the two variables are internal to the app and may change; the guide says so.
- The same known limits as ADR-0015: identical Dock icons, an auto-update restarts on the main data, a sign-in callback may reach another window.

## Real-app check (2026-10-16, Grok Bot 0.71.2)

With the main window running on `~/.grokbot`, a second instance started with `--user-data-dir` showed its own sign-in screen, kept its data root in `<folder>/sand-data`, wrote its own `desktop-status.json`, and left `~/.grokbot` unchanged. Opening it again brought that window to the front instead of starting a third.
