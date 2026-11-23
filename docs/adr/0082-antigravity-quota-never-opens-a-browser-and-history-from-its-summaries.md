# ADR-0082: Antigravity quota checks never open a browser; Session History from agy's summaries

Status: accepted
Date: 2026-11-23

Amends ADR-0047 ("no Session History in v1") and ADR-0048 (how the quota check runs agy).

## Context

Users of the Menu Bar Item saw agy's Google sign-in page open again and again. Tried with agy 1.5.14 on macOS on 2026-11-23, with a HOME where agy has no sign-in: `agy -p /usage --output-format json` prints a sign-in link on stderr, runs `open <link>` (looked up on PATH; `xdg-open` on Linux), and waits 60 seconds for the sign-in before it prints `{"status":"ERROR","error":"authentication failed or timed out"}`. sideby's background check (every 15 minutes) therefore opened the page each time agy could not refresh its sign-in on its own, and the check ended on sideby's 20-second limit without saying why.

- agy has no `BROWSER`, `NO_BROWSER` or similar variable (its binary names none). It skips the browser when `SSH_CONNECTION` or `SSH_TTY` is set, but then still waits silently, so the check cannot tell a missing sign-in from a slow answer.
- On SIGTERM agy prints its JSON error and exits at once: `authentication failed or timed out` while waiting for a sign-in, `context canceled` when it was signed in.

agy also lists its conversations in `<account>/conversation_summaries.db` (SQLite, table `conversation_summaries`: `conversation_id`, `title`, `step_count`, `last_modified_time`, `workspace_uris`, `parent_conversation_id`, `nesting_depth`, …). The conversations themselves are binary records in `conversations/<id>.db`. `agy --conversation <id>` resumes one (`agy --help`).

## Decision

Quota check (spec §3.26):

- sideby runs agy with a folder of its own (`<state>/quota/agy-run/bin`, mode 700) first on PATH. It holds `open`, `xdg-open` and `sensible-browser` scripts (agy 1.5.14's binary names `sensible-browser`, which Linux and WSL builds may try) that open nothing and only create the empty file `SIDEBY_AGY_SIGN_IN_MARK` names (a per-check path in `<state>/quota/agy-run`); they keep nothing of the address. When the mark appears, sideby stops agy and the answer is `loginExpired: true` (ADR-0071) with "Antigravity CLI needs a new sign-in; run `sideby login agy:main`". If the folder is not safe to use, agy is not asked.
- The check has its own limit of 15 seconds, under sideby's 20: SIGTERM, then SIGKILL 2 seconds later.
- An Account whose login state is `unknown` can now have an Expired Login. agy's `readLoginEvents` returns nothing, so only that quota answer marks it, and a later good answer clears it.

Session History (spec §3.33):

- agy's reader opens `conversation_summaries.db` read-only. While agy has its `-wal` and `-shm` files, they are read as they are, so the newest rows show; otherwise the database is opened as `immutable`, so the read creates no file in agy's folder. Known exception: if the last agy exits between that check and the open, SQLite leaves a `-shm` and an empty `-wal` beside the database; agy reuses them on its next write and removes them on a clean close, so sideby accepts this rather than copying the database.
- Each row is one Session, keyed by its `conversations/<id>.db` path, which sideby never opens. Rows with a `parent_conversation_id`, a `nesting_depth` above 0 or no title are left out. A Session keeps the id, agy's title, the first `file://` workspace as its folder and the last change time; it has no prompts or replies, so `history show` lists no messages.
- `resumeArgs` is `--conversation <id>`, started with `sideby run agy:main --`.

## Consequences

A signed-out agy no longer opens a browser from a background check; the Panel and the Menu Bar Item say the sign-in needs renewing. If agy one day opens the page without a PATH lookup, the 15-second limit still ends the check, and this ADR is revisited.

agy's conversations show in `sideby history` and the Panel's Session History, found by title and project but not by what was said in them. Handoff into agy stays out (ADR-0047).
