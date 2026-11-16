# Unattended Mode: sessions that do not stop to wait for a person

Unattended Mode (spec §3.37, ADR-0058) is one state for the whole computer: nobody is there to answer, so the Claude and Codex sessions sideby starts never stop to wait. While it is on, sideby's hook refuses the Host's question tool (Claude `AskUserQuestion`, Codex `request_user_input`) and tells the model to take the recommended option where the choice can be undone and to skip anything hard to undo; each refused question is kept as a **Pending Decision**. When the model ends its turn on a question written as text instead, the hook sends the session on once with the same instructions and keeps that question too. In Claude sessions it also answers "no" to every permission prompt Claude Code is about to show (even in bypass mode, and in subagents), with how to do the step without one; each refused request is kept as a Pending Decision too; and it declines MCP server forms, keeping what the server asked; and a Claude turn that failed for a passing reason (an overloaded or failing server, a dropped connection, a rate limit that is not a used-up quota) is started again after 1, 2, then 4 minutes, and after a fourth failure in a row the session is left with a Pending Decision saying why (Turn Retry, ADR-0067). Codex's own approval prompts still wait.

## Turn it on when the user is leaving

When the user says they are leaving the computer ("挂机", "无人值守", "今晚自己跑完", "I'm off to bed, keep going"), run it yourself first:

```sh
sideby unattended on --json                 # until the current or next Slot ends, else 12 hours
sideby unattended on --until 08:00 --json   # or --for 4h; at most 72 hours
```

Tell the user, in one line each:
- It covers Claude and Codex sessions sideby starts (`sideby run`, short commands, pick commands, `sideby next`, Auto Handoff, AI Tasks). Running `claude` or `codex` directly, Grok, pi and desktop apps are not covered. A terminal manager that starts the Host itself (Orca, for example) is covered once its Claude command is `sideby resume claude --` (configuration guide, "Resuming from other tools"); in Orca that is Settings → Agents → Claude → the command field.
- Sessions started before the feature was first used have no hook. If `configured` was `false` before this command, the sessions already running are not covered: suggest restarting long tasks with `sideby run <account> --unattended`.
- A Codex account runs the hooks only after the user trusts them once: in that account type `/hooks` and trust both `unattended-hook` entries, before a question and at the end of a turn (`coverage.codex` is `needs-trust`).
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

While Unattended Mode is on, do not end your turn on a question either: a turn that ends on one (a `需要你拍板` line, a last line ending in `?`, "Want me to …", "要不要 …") is sent back to you once with the same instructions. End with a final report instead.

The refusal tells you what to do: go on with the recommended option where it can be undone, and list the question and your choice in your final report. A refused permission means Claude Code wanted a person to confirm that step: rewrite it so it needs none (literal paths, `"${VAR:?}"` for a variable in an `rm` target, plain bash syntax, `rm` as a command of its own), or skip it. For anything hard to undo (deleting, sending or posting outside, publishing, deploying, paying), skip it and record it:

```sh
sideby unattended defer "deleting the old release branch is left for the user" --json
```

Then go on with the rest. Do not retry the question, and do not work around the refusal.

When a note from sideby says your last turn failed for a passing reason, the session was woken to go on: check what is already done (files, commits, background work), do not redo it, and continue where the turn stopped.

## When the user is back early: they just type

A Claude session the user types into asks as usual again for 30 minutes after each message they send (an **Attended Session**, ADR-0075): its questions, permission prompts and forms reach the user, and nothing of it is refused or kept. Every other session stays unattended, and the global state does not change. The first time it applies, the session shows the user one line saying so. So when the user says they are back but only wants to work in one session ("我回来了，这个会话怎么还不问我", "why is this session asking me again"), tell them to just type in it; no command is needed.

- See which sessions it covers now: `sideby unattended --json`, field `attended` (each `sessionId`, `account`, `cwd`, `since`, `until`).
- Only a prompt the user typed counts: not a background task's notification, not a Message from `sideby send` or another session, not the prompt sideby put on the command line, and not your own tool calls. There is no command to set it, and you must not try to make your own session count: if the user wants questions everywhere, run `sideby unattended off --json`.
- Typing into a terminal by automation (tmux `send-keys`) looks like a person to Claude Code and counts for that one session. Sessions started before this sideby version, and Codex sessions, do not have it.

## If nobody answers: questions go on after a wait

A question or a permission prompt that a Claude session shows while someone is there (an Attended Session, or Unattended Mode off) waits for the user. Once it has waited the **Answer Wait** (10 minutes unless the user set another; ADR-0077) with nobody answering, and Unattended Mode is on, the session goes on as Unattended Mode would: the question is refused with the instruction to take the recommended option where it can be undone, and the permission prompt is answered "no", never "yes". A turn that ended on a question written as text is woken with the same instructions after the same wait. Each is kept as a Pending Decision with `waited` (minutes). While Unattended Mode is off it keeps waiting, and goes on once the mode comes on (a Slot that begins later, say). So "ask me while I'm here, don't get stuck when I'm not" needs only Unattended Mode on, or a Schedule.

```sh
sideby unattended wait --json        # field answerWait: minutes, or null when it waits however long
sideby unattended wait 30 --json     # 1 to 120 minutes
sideby unattended wait off --json    # questions wait for the user however long
```

Set it when the user asks ("问题没人回就自动按推荐继续", "问题等我 30 分钟再继续", "别自动继续，一直等我", "how long does a question wait for me"); each change prints its `undo`. It reaches sessions already running at their next look. Not covered: a background subagent's permission prompt (Claude Code shows it only after the hooks, so it waits for the user), Codex, Grok, pi, and sessions started before this sideby version (restart them).

When a refusal or a note in your session starts "No answer after 10 minutes", "Not allowed: nobody confirmed this action in 10 minutes" or "Nobody replied to your question for 10 minutes", that is this: nobody is answering, so do what the note says and do not ask the same thing again.

## When the user is back

```sh
sideby unattended --json            # on or off and why, until when, the next Slot, open decisions, coverage, attended sessions
sideby unattended pending --json    # each question, refused permission or skipped action, with account, session and folder
sideby unattended pending done <id> --json   # or --all, once the user has dealt with them
```

Go through the open ones with the user (one with `waited` was on screen that many minutes before the session went on without an answer; a `deferred` one that starts "The session stopped" is a session whose turn kept failing after three retries; a `permission` one names the tool, for Bash only the program and the model's description of the step, and `agentType` when a subagent asked; the whole command is in the session itself). A decision with a `sessionId` can be continued in its session: `sideby sessions copy <sessionId> --as resume` copies the command. Done ones are deleted 30 days later. A plugin can be told when a stretch ends through the `unattended.ended` event (`docs/guide/plugins.md`); sideby itself sends no notification.

The same is on the Panel's **Unattended** tab (`sideby ui`): the status with **Turn on now**, the Schedule, **If nobody answers** (the Answer Wait), and the Pending Decisions with **Done** (one that went on after a wait says "No answer for 10 min"). Point the user there when they prefer clicking.
