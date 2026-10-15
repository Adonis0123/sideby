# ADR 0017: Turning Remote Control off writes one key, with a preview and an undo

Date: 2026-10-15 · Status: accepted

## Context

Claude Code's Remote Control connects a local session to claude.ai/code and the Claude mobile app, so every device signed in to that claude.ai account can read and continue the conversation. `/config` stores "Enable Remote Control for all sessions" as `remoteControlAtStartup` in the user `settings.json` (https://code.claude.com/docs/en/remote-control). Accounts usually link `settings.json` to the Main Account, so one `true` turns it on for all of them. A user who runs several Accounts wants it off everywhere, with one action.

Ways to turn it off:

- Pass a flag or an environment variable at Launch. Rejected: Claude Code has no flag to turn it off (only `--remote-control` to turn it on), and the environment variables that happen to disable it (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_GROWTHBOOK`) turn off other things too. It would also miss sessions not started by sideby.
- Write `disableRemoteControl: true`. Rejected for now: it also blocks starting Remote Control by hand, which the user wants to keep.
- Write `remoteControlAtStartup: false` into each Account's `settings.json`, with a preview and an undo. Chosen.

## Decision

- `sideby remote-control off` (preview and exit 10 without `--yes`) and a "Turn all off" button in the Panel, shown when some Account turns it on, after a confirmation that lists each file, the change and the Accounts it reaches.
- It writes one key, the top-level `remoteControlAtStartup`, to `false`, in every Claude settings file where it is `true` or missing, through `writeIfUnchanged`, keeping every other key, the indentation and the file mode. A symlinked file is written at its real target and the Accounts sharing it are named; a link is never created, replaced or retargeted. An Account without `settings.json` gets no new file (it is a linked Shared Item; a real file there would be Drift); sideby says to run `sideby doctor --fix` first.
- It records the previous value per file under the state directory; `undo` restores it only while the key is still `false`.
- This is the fourth exception to "sideby writes nothing into a Host directory", after `quota setup claude --yes`, `handoff setup grok --yes` and `tune apply` (ADR-0012), and follows the same rules as `tune apply`.
- Still never: read or print any other value of the file, write `disableRemoteControl`, touch `~/.claude.json`, or end a running session.

## Consequences

- Sessions already running keep their connection until they are restarted; the output says so.
- With shared settings one write covers every Account that links to the Main Account's file.
- If Claude Code moves or renames the setting, the Panel stops showing the banner and `off` writes a key nobody reads; the source link above is where to check.
