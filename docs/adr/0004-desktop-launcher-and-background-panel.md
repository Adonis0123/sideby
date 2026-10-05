# ADR 0004: A desktop launcher that starts a background Panel

Date: 2026-10-05 · Status: accepted

## Context

`sideby ui` needs a terminal that stays open, and people who do not live in a terminal do not know to open a local web page. They expect an app icon to double-click. Two things get in the way:

- An app started from Finder, a dock or launchd gets a minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). Hosts installed under `~/.local/bin`, `~/.grok/bin` or a Node version manager then look "not installed".
- A launcher must not start a second Panel each time it is clicked, and stopping the Panel must never signal an unrelated process.

## Decision

- `sideby ui --background` hands the Panel to a detached child (`sideby ui --serve-detached`, an internal option) and exits once the child listens. A pid file in the state directory finds it again; a running background Panel, or any sideby Panel on the requested port, is reused. Concurrent launches are serialised with a lock file.
- The background Panel builds its Runtime PATH from the user's login shell (`$SHELL -ilc`, PATH printed between markers, 5 s timeout), merged in front of the inherited PATH. Any failure falls back to the inherited PATH.
- `sideby ui --stop` signals the pid only when it is alive, started at the time the pid file records, runs `sideby ui --serve-detached`, and the Panel on the recorded port answers `/api/health` with the pid file's random instance id and that pid; otherwise it removes the stale pid file (or, when the process matches but the port does not answer, exits 1 without signalling).
- `sideby app install [--url <url>]` writes a launcher: `~/Applications/sideby.app` on macOS, a `.desktop` entry on Linux. The launcher records absolute paths of the Node binary and the sideby entry used at install time and runs `ui --background`; with `--url` it only opens that address, for a portal that embeds the Panel. If the recorded paths are gone it falls back to `sideby` from the login shell.
- The icon is drawn in pure Node (no image dependency) from the Panel's logo geometry.
- Every generated file carries a marker. Install updates its own files in place; install and uninstall refuse to touch an unmarked file at the same path.

## Consequences

- sideby now writes outside its config and state directories, but only to the launcher paths above and only on an explicit `sideby app install`.
- After upgrading Node or moving sideby, the recorded paths go stale; the launcher still works through the login shell, and `sideby app install` again restores the direct path.
- The launcher is an unsigned local script bundle; it is not notarised and is not meant to be copied to other machines.
- Windows has no launcher; `sideby app` says so.

## Revisit when

sideby ships a packaged desktop app, or a Host family needs environment beyond PATH from the login shell.
