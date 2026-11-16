# Progress updates: a waiting session says what it waits for

Progress Reminders (spec §3.42, ADR-0076): while a Claude session sideby started waits on background work (subagents, background commands), the session is idle and the model cannot say anything, so the user sees silence. With progress updates on, sideby wakes such a session every few minutes, and the model tells the user in one or two sentences what it waits for, how long it has waited and whether there is new output, then ends its turn.

## Turn it on or off

```sh
sideby progress --json                  # { on, every?, defaultEvery, choices, families }
sideby progress on --json               # every 10 minutes (or keeps the interval it had)
sideby progress on --every 15 --json    # 1 to 240 minutes
sideby progress off --json
```

It writes only sideby's config (`progress.every`), so there is no preview and no `--yes`; each change returns `undo`. Before turning it on for the user, tell them, in one line each:
- Each update is one model turn, which reads the whole conversation: it uses quota. That is why it is off by default.
- Claude sessions sideby starts from now on get it; a session already running needs a restart. Turning it off, or a new interval, reaches running sessions too.
- There are no updates while the session is unattended (Unattended Mode, unless the user typed there in the last 30 minutes), while a turn is running, or once the background work is done.
- Codex is not covered: no Codex hook can wake a waiting session. Grok, pi and sessions started without sideby are not covered either.
- In the Panel it is **Settings › Progress updates**.

## Inside a session that gets one

The reminder arrives as a message that starts `sideby progress reminder:` and names the background tasks, when the wait began and for how long. Answer it as it asks: one or two sentences for the user (what you wait for, how long, any new output if it is quick to look), then end your turn. Do not start new work or stop the tasks because of it. If the user asks how to stop these, the command is `sideby progress off`.

With Auto Handoff on, a reminder's turn does not change when or how the session hands over.
