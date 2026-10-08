# ADR 0009: Start a new session when the resumed session was never saved

Date: 2026-10-08 · Status: accepted

## Context

ADR-0007 routes a bare `claude --resume <id>` to the Account that holds the session file. Claude Code writes that file (`projects/*/<id>.jsonl`) only with the first message. A terminal manager such as Orca learns the id earlier, from the SessionStart hook, so when it restarts it also resumes sessions that never had a message. No Account holds them, sideby runs the Host unchanged in the Main Account, and the pane shows `No conversation found` instead of the agent it held. Seen with two panes on Claude Code 2.1.292: each had started `claude:001` or `claude:002` about 35 seconds before Orca restarted.

Claude Code still leaves a trace in the Account that started the session: the `session-env/<id>/` directory it creates for SessionStart hooks, even when no hook writes into it.

Options considered:

- Keep running the Host unchanged. Certain to fail, and the user retypes the command, possibly in the wrong Account.
- Read `lastSessionId` from the Account's `.claude.json`. It names only the last session per directory, and `.claude.json` holds credentials that sideby reads only for one Doctor key.
- Ask the terminal manager to skip sessions without a transcript. Right in the long run (Orca already checks for one on its structured launch path), but out of our hands.
- Use the `session-env/<id>/` trace: drop the by-id resume and start a new session in the Account that started it. That is the pane's intent, since there was nothing to resume.

## Decision

- When no Account holds the session file, `sideby resume` asks each Account whether it started the session (`sessionStartedAt`, local files only) and picks the newest. It drops the by-id resume from the Host arguments (`withoutResume`) and starts that Account as `run` would, or runs the Host with only those arguments removed when it is the Main Account. It says so on stderr.
- Without such a trace, or for a Family that offers neither member, nothing changes: the Host runs unchanged and reports the missing session itself.
- Only Claude offers the two members. Codex and Grok leave no trace we found.

## Consequences

- A session that was saved always wins over one that was only started, so a real conversation is never replaced by a new one.
- The trace is Claude Code's internal layout. If a later version stops creating it, sideby falls back to the ADR-0007 behaviour; it never guesses an Account.
- `FamilyDef` gains two more optional members.

## Revisit when

Claude Code saves a session before its first message, or terminal managers stop resuming sessions that have no transcript.
