# ADR 0015: Start Desktop Apps per Account with launch flags; never copy or re-sign the app bundle

Date: 2026-10-14 · Status: accepted (real-app check in spec §5 item 19 passed on 2026-10-14)

## Context

Some Families have a Desktop App next to the Host: Claude Desktop and the Codex app (`ChatGPT.app`, bundle id `com.openai.codex`). Users with several Accounts want one window per Account, open at the same time, the way `sideby run` starts one terminal per Account. A Desktop App keeps its own App Data (login, window state, caches) in one default folder under `~/Library/Application Support`, so a second copy started normally only brings the first one to the front.

Both apps are Electron apps and accept a different data folder at launch: `--user-data-dir=<dir>`. Claude Desktop's Code tab also honours `CLAUDE_CONFIG_DIR`; the Codex app reads `CODEX_HOME` and needs `CODEX_ELECTRON_USER_DATA_PATH` as well, because its own code replaces the data path set by `--user-data-dir` (this is the app's own "Codex Demo" recipe). macOS's `/usr/bin/open -n` starts a new instance and passes `--env` variables and `--args` to it.

Options:

- Clone the `.app` per Account, change its bundle id and re-sign it, with a tinted Dock icon. Rejected: it modifies a signed vendor bundle, breaks notarisation and auto-update, needs a copy per Account per update, and some apps refuse to run re-signed.
- Override `HOME` for the app. Rejected: macOS apps resolve their folders through the system, not `HOME`, so it does not move App Data.
- Swap the default App Data folder (rename one Account's folder into place, start, rename back). Rejected: only one Account at a time, and a crash leaves the wrong data in place.
- Start the unchanged app with `open -n`, the Account's selecting variable and a per-Account `--user-data-dir`. Chosen.

## Decision

- macOS only, built-in claude and codex Families only. The definition stays internal, not in the public `FamilyDef`.
- The Main Account opens with `open -n -a <app>` and the app's default App Data (`-n` because a plain `open -a` brings forward whichever instance runs, often another Account's). Any other Subscription Account opens with `open -n`, its selecting variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and App Data at `~/Library/Application Support/sideby/<family>/<name>/` (mode 700). API Accounts are refused.
- The environment `open` gets has the Hijack Variables, the selecting variable and `SIDEBY_*` cleared, as a Launch does, and also the variables an agent session sets for its children (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_TOKEN`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_PLUGIN_DATA`, `CODEX_COMPANION_*`, `CODEX_THREAD_ID`, `CODEX_SANDBOX*`), so an app opened from inside a session does not inherit it.
- If that Account's instance already runs, sideby brings it to the front (`NSRunningApplication` through `osascript -l JavaScript`, which needs no Automation permission) instead of starting another, and otherwise says it is already running. sideby never ends an app process.
- sideby never copies, modifies or re-signs the app bundle, and writes nothing into a Host account directory.

## Consequences

- Several windows run side by side, each with its own login. The Dock shows identical icons for all of them.
- After an auto-update the app restarts on its default data folder, that is the Main Account; the user reopens the others from sideby. No watchdog in v1.
- The sign-in callback (`claude://`) may reach another running instance; sideby warns on a first sign-in while another instance runs, and never closes anything.
- `CODEX_ELECTRON_USER_DATA_PATH` and the Code tab's use of `CLAUDE_CONFIG_DIR` are internal behaviour of those apps and may change; the guide says so, and a real-app check is part of acceptance.
- Claude in Chrome's local pairing does not work for a non-default data folder.
- The Codex app's sign-in screen for a new Account can offer "Welcome back" with the main account's email (that state lives outside the App Data); picking it signs the Account in as the main one. sideby's notice and the guide say to choose another account, or to run `sideby login <account>` first.
- Claude Desktop writes its own `claude_desktop_config.json` when the main one does not exist yet, and may later replace the link. Doctor reports a real file there as a warning, not a failure, and never replaces it.

## Real-app check (2026-10-14)

On the maintainer's machine: Claude Desktop honours `--user-data-dir` and its Code tab `CLAUDE_CONFIG_DIR`; the Codex app honours `CODEX_HOME` and `CODEX_ELECTRON_USER_DATA_PATH` and keeps its sqlite in `CODEX_HOME` (no `CODEX_SQLITE_HOME` needed); bringing a window to the front through JXA asked for no permission.
