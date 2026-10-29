# Unattended Mode: sessions that do not stop to wait for a person

Unattended Mode (spec §3.37, ADR-0057) is one state for the whole computer: nobody is there to answer, so the Claude and Codex sessions sideby starts never stop to wait. While it is on, sideby's hook refuses the Host's question tool (Claude `AskUserQuestion`, Codex `request_user_input`) and tells the model to take the recommended option where the choice can be undone and to skip anything hard to undo; each refused question is kept as a **Pending Decision**. In Claude sessions it also answers "no" to every permission prompt Claude Code is about to show (even in bypass mode, and in subagents), with how to do the step without one; each refused request is kept as a Pending Decision too. Codex's own approval prompts still wait.

## Turn it on when the user is leaving

When the user says they are leaving the computer ("挂机", "无人值守", "今晚自己跑完", "I'm off to bed, keep going"), run it yourself first:

```sh
sideby unattended on --json                 # until the current or next Slot ends, else 12 hours
sideby unattended on --until 08:00 --json   # or --for 4h; at most 72 hours
```

Tell the user, in one line each:
- It covers Claude and Codex sessions sideby starts (`sideby run`, short commands, pick commands, `sideby next`, Auto Handoff, AI Tasks). Running `claude` or `codex` directly, Grok, pi and desktop apps are not covered.
- Sessions started before the feature was first used have no hook. If `configured` was `false` before this command, the sessions already running are not covered: suggest restarting long tasks with `sideby run <account> --unattended`.
- A Codex account runs the hook only after the user trusts it once: in that account type `/hooks` and trust `unattended-hook` (`coverage.codex` is `needs-trust`).
- `sideby unattended off --json` turns it off; inside a Slot it pauses until that Slot ends.

Every change prints `undo`, the command that puts back what was there.

## Every night: the Schedule

A Slot is days, a start and an end in the computer's own time zone; an end before the start is the next morning. Overlapping Slots join.

```sh
sideby unattended schedule preset weeknights --json   # Monday to Friday, 23:00 to 08:00
sideby unattended schedule add --days sat,sun --from 01:00 --to 09:00 --name "Weekend nights" --json
sideby unattended schedule remove 2 --json            # the number `sideby unattended` shows
```

`--days` takes `mon`…`sun`, ranges and lists (`mon-fri`, `fri-mon`, `sat,sun`, `weekdays`, `daily`). Ask the user for the times; do not invent a Slot they did not ask for.

## One session only

`sideby run <account> --unattended` (also `sideby next <family> --unattended`, `sideby resume`, short commands and pick commands) makes that one session unattended whatever the Schedule says. Give the user the command; do not start an interactive session yourself.

## When a session was refused a question or a permission

The refusal tells you what to do: go on with the recommended option where it can be undone, and list the question and your choice in your final report. A refused permission means Claude Code wanted a person to confirm that step: rewrite it so it needs none (literal paths, `"${VAR:?}"` for a variable in an `rm` target, plain bash syntax, `rm` as a command of its own), or skip it. For anything hard to undo (deleting, sending or posting outside, publishing, deploying, paying), skip it and record it:

```sh
sideby unattended defer "deleting the old release branch is left for the user" --json
```

Then go on with the rest. Do not retry the question, and do not work around the refusal.

## When the user is back

```sh
sideby unattended --json            # on or off and why, until when, the next Slot, open decisions, coverage
sideby unattended pending --json    # each question, refused permission or skipped action, with account, session and folder
sideby unattended pending done <id> --json   # or --all, once the user has dealt with them
```

Go through the open ones with the user (a `permission` one names the tool, for Bash only the program and the model's description of the step, and `agentType` when a subagent asked; the whole command is in the session itself). A decision with a `sessionId` can be continued in its session: `sideby sessions copy <sessionId> --as resume` copies the command. Done ones are deleted 30 days later. A plugin can be told when a stretch ends through the `unattended.ended` event (`docs/guide/plugins.md`); sideby itself sends no notification.

The same is on the Panel's **Unattended** tab (`sideby ui`): the status with **Turn on now**, the Schedule, and the Pending Decisions with **Done**. Point the user there when they prefer clicking.
