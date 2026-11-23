# ADR-0084: The Panel hears of Quota changes through a held GET

Status: accepted
Date: 2026-11-23

Amends ADR-0006 (what a Portal forwards).

## Context

The Panel page reads `/api/state` every 20 seconds. Quota lands in local files well before that: the Claude status line cache after each reply (`statusline-tap`), the kept answers of a Host's own CLI (`<state>/quota/<family>/<name>.fetched.json`), Codex's `sessions/**/rollout-*.jsonl` and Grok's `logs/unified.jsonl`. A user who just finished a turn waited up to 20 seconds to see its numbers, and a shorter poll would read every Account again and again for nothing.

Tools of the same kind poll too; none watched these files (checked 2026-11-23). Asking a Host more often is not an option: it is bounded by `everyMinutes` (ADR-0025, ADR-0063) and private endpoints are never called (ADR-0003).

## Decision

- While a page is connected, the Panel's handler watches those files with `fs.watch` (recursive where a folder holds subfolders) and counts changes. It watches `<state>/quota` (only `*.json` outside `asking/`, `claude-run/` and `limit-reset/`, so sideby's own locks and runs never count), each Codex Account's `sessions` (only `rollout-*.jsonl`) and each Grok Account's `logs` (only `unified.jsonl`). It reads no file it watches; an event only bumps a counter.
- A change counts about 300 ms after the first event, so an atomic write (a temporary file, then a rename) counts once. Changes under `<state>/quota` count at most once a second; session records, which a running session appends to all the time, at most once every 5 seconds.
- `GET /api/changes?since=<n>` answers at once with `{ seq, changed: true, watching }` when the counter is not `n`, and otherwise holds the request until it moves or 25 seconds pass (`changed: false`). It goes through the same Host check as every other read (the token only guards writes). The page reads `/api/state` at once after `changed: true`; the 20-second poll stays as the fallback.
- A page asks only while it is visible. The watchers close 40 seconds after the last request, so a closed or hidden page leaves nothing open. A folder that is missing, a platform without recursive watching, or a watcher that fails is left out without a message; with nothing watched, `watching: false` tells the page to keep to the poll and ask again a minute later.
- A change drops the Account reads that finished, or began within the last 5 seconds, before it, so the next state reads the files again; a long first read (a cold cache) goes on.

What any Portal must do: forward a GET that the handler holds for up to 25 seconds without buffering or timing it out sooner, as it forwards every other request. A Portal that cuts it early only makes the page ask again; nothing breaks.

## Considered

- Server-Sent Events: one connection and no gap between answers, but a Portal that buffers responses (a worker relaying whole bodies) would hold the events back until the stream ends. A held GET is an ordinary request every Portal already forwards.
- A shorter poll (every 2 to 5 seconds): simple, but each poll reads every Account and lists running programs, most of the time for nothing.
- Watching from the Menu Bar Item: it is a separate `osascript` process that runs `sideby menubar snapshot` every 120 seconds; watching files there needs FSEvents callbacks in JXA. Nudging it from the Panel's feed would not help either: the feed runs only while a Panel page is in view, when the user is looking at the Panel. Left out.

## Consequences

A Quota change shows in the Panel about half a second after the file is written, as long as a page is open and visible. Each open, visible page holds one connection; browsers allow six per host, so the page stops asking while hidden. Linux watches recursively with one inotify watch per folder; where the system's limit is reached, the watcher fails and the page keeps to the 20-second poll.
