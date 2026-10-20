# ADR-0041: Show the Run a Session works for, from an orchestrator's optional Session Index

Status: accepted
Date: 2026-10-20

## Context

Users who hand work to several Sessions at once often do it through a local orchestrator (for example the `agent-dispatch` skill), which groups the Sessions of one piece of work into a Run and writes its Run Board, a static HTML report, into its own state folder. On the Sessions page (spec §3.32) a row says which Account and Session it is, but not which Run it belongs to, so the user has to find the board by hand.

The orchestrator can publish which Session works for which Run in a small file it already owns. sideby must not depend on it, must make no request for it, must read nothing private from it, and must never open a file the page or the index points at outside the orchestrator's boards folder.

## Decision

sideby reads an optional Session Index and, for a Live Session it lists, adds the Run it works for.

- Where: `AGENT_DISPATCH_STATE_DIR/session-index.json`, else `$XDG_STATE_HOME/agent-dispatch/session-index.json`, else `~/.local/state/agent-dispatch/session-index.json` (only absolute folders count); boards in `<that folder>/boards/`. No file means nothing changes.
- What: `{ schemaVersion: 1, revision, generatedAt, sessions: { <session id>: { entries: [{ run, runTitle, board, lane, laneTitle, role, url }] } } }`. `revision`, `generatedAt` and unknown fields are ignored. Another `schemaVersion`, a file over 256 KB, a link at the file, or one that does not parse is ignored as a whole. The index holds no token.
- Checks, for each entry: `board` is an absolute path to a regular `.html` file of the current user, not a link, right inside the boards folder (compared by real path; the boards folder itself must be a real folder of the user, not a link); `url` is exactly `file://<board>`, with nothing but an optional `#lane-<id>`. An entry that fails is left out. Titles are cut to one line of at most 120 characters.
- Several entries: the first by role (coordinator, write, review, research, then any other role, keeping the index's order within one role) is shown; the others are listed after it, each with its `board`.
- Shown: `run: { title, laneTitle?, role?, board, url, others? }` in `sideby sessions --json` and the Panel's `/api/sessions`; a `RUN` column (with `+N` for others) and one `Run: <title>  <board path>` line per checked board in `sideby sessions` (each board once, the others' too); a chip "Run: <title>" / 「任务：<title>」 (with `+N`, the others in its tooltip) on the Sessions page.
- Opening: a web page cannot open a `file://` URL, so the chip is a button. The page sends only the Session id to `/api/sessions/run`; the server reads the index again, checks the entry again, and opens the board with the system's default program (`/usr/bin/open <board>` on macOS, `xdg-open` on Linux, `cmd.exe /c start` under WSL) through the same code as "Edit settings" (ADR-0033). Right before the program starts, sideby checks the board and its boards folder once more: neither is a link, both belong to the user, their device and inode are the ones it checked, and the board's real path is still right inside the folder; otherwise it refuses (`board-changed`). It never takes a path from the page. A swap in the moment between that last check and the system opener reading the path cannot be closed from outside the opener (it takes a path, not an open file); it needs the user's own account to write in the boards folder, which is the user's own. It starts a program, so a read-only Panel hides the chip and refuses the request. `sideby sessions open-run <account|session-id>` does the same from the command line: it picks the Session as `sideby sessions copy` does and then goes through the same `openRunBoard`.

## Consequences

A user sees at a glance which Run a Session belongs to, and opens its board in one click. sideby still makes no request of its own besides the Update Check (ADR-0021).

Any orchestrator can publish the same file and folder; the field names are the contract, and a new version of it needs a new `schemaVersion`, which sideby ignores until it learns it.
