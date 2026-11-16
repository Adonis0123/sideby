# ADR-0075: A session someone types in asks as usual for 30 minutes

Status: accepted
Date: 2026-11-16

## Context

Unattended Mode (ADR-0058) is a state of the whole computer, set by the Schedule or by hand. It does not look at whether anyone is there. A user who comes back early and types into a session still has its questions refused and its permission prompts answered with "no", until they remember to run `sideby unattended off` or open the Panel. Turning the whole mode off for one person in one session also takes it away from every other session that is still running alone.

Telling a person apart from everything else that submits a prompt is the hard part. Claude Code submits many prompts by itself, and sideby starts sessions with a prompt on the command line, so "a prompt arrived" does not mean "someone is here". A night session that marked itself attended by its own first prompt would stop on its first question and wait until morning, which is worse than today.

What Claude Code 2.1.325 does (tried on 2026-11-16 with an isolated HOME, `ANTHROPIC_BASE_URL` pointed at a local fake server, interactive sessions in tmux and a `UserPromptSubmit` hook that only recorded its input):

- The `UserPromptSubmit` hook input holds `session_id`, `prompt_id`, `prompt`, `transcript_path`, `cwd` and `permission_mode`. No field says where the prompt came from.
- These all reach the hook as plain `prompt` text: a typed prompt, one typed while a turn runs (queued), a multi-line paste, the prompt given on the command line (`claude "…"`), a background task's notification and an `asyncRewake` wake-up (both start with `<task-notification>`), a `sideby send` Message (`sideby message <id> from …`), and any line another process writes into the session's message socket. The socket path is in the environment of the model's Bash tool, and writing to it needs no token.
- The session's transcript holds a `user` line with the same `promptId` and an `origin`: `{"kind":"human"}` for typed, queued and pasted prompts, `task-notification` for notifications and wake-ups, and `peer` for anything from the socket, `sideby send` included. A `claude -p` prompt has no `origin`. The line is written about 70 to 180 ms after the hook starts (queued prompts: before it), so a synchronous hook cannot read it. A command-line prompt is `human` too, identical to a typed one.
- A command hook with `async: true` runs in the background and does not hold the prompt back. `systemMessage` in the JSON output of a `Stop` or `PreToolUse` hook is shown in the session to the user and does not reach the model; from `PermissionRequest` it was not shown.
- The environment of a hook and of the model's Bash tool are nearly the same, so no variable can tell the hook from a command the model runs.

Reference practice: chat tools and phones treat "the user just interacted on this device" as presence for that device only, and let it lapse after a short idle time; Android's Do Not Disturb stays on for everything else.

## Decision

- A Claude session sideby started counts as an **Attended Session** for 30 minutes after each prompt a person typed into it. While it does, Unattended Mode leaves that session alone: no refused question, permission prompt, form or end-of-turn question, no Turn Retry and no Pending Decision. Every other session, the global state and `sideby unattended off` stay as they are.
- `unattended-hook` is also injected on Claude's `UserPromptSubmit`, with `async: true` and `timeout: 30`, so it never delays or blocks a prompt and prints nothing. It counts a prompt only when all of these hold, and anything it cannot tell does not count:
  1. it does not start with `<task-notification>` (the test `network-hook` uses, moved to the leaf `core/prompt-origin.ts`);
  2. it does not contain `sideby message <8 hex digits>`;
  3. it is not one of the launch's command-line arguments: sideby sets `SIDEBY_LAUNCH_PROMPTS` in the Host's environment, the SHA-256 (first 16 hex digits) of each argument that does not start with `-`, and of the value of each `--x=value`, after trimming and joining runs of spaces. The value is `?` from the moment the Launch is prepared and is filled in from the final arguments where the Host is started (`spawnHost`), because Auto Handoff adds a relay prompt after preparing; more than 64 such arguments leave it `?`. A session whose value is missing, `?` or malformed counts nothing;
  4. `transcript_path` is the session's own transcript: `<config dir>/projects/<folder>/<session id>.jsonl`, the config dir being `CLAUDE_CONFIG_DIR` or `~/.claude`, compared after resolving links;
  5. the transcript line with its `promptId` says `origin.kind` `human`, its text passes 1 to 3 as well, and it has a `timestamp`: the hook reads the transcript from the start of the line that holds the point 256 KB before where it ended when the hook started (a line up to 8 MB, as a prompt with a picture can be), then every 50 ms what was added, for at most 10 seconds, and looks only at lines holding the prompt id, and of those only `type`, `promptId`, `origin.kind`, `timestamp` and the message's text;
  6. it carries no `agent_id`.
- A counted prompt writes `<state>/unattended/attended/<hash of the session id>.json` (folders checked as `pending/`, file 600, atomic): `{ sessionId, family, account?, cwd?, at, since, toldAt? }`. `at` is the transcript line's `timestamp` (never later than now): a line 30 minutes old or older writes nothing, and one no later than the `at` already kept changes nothing. It is written whether Unattended Mode is on or not, so a person who typed just before a Slot began is still asked. No prompt text or prompt id is kept.
- Only that hook entry writes the file. No command, Panel button or other hook event sets it. The transcript line decides, not the hook's input, so input made by hand and piped to `sideby unattended-hook` marks nothing new: a transcript elsewhere is not read, the launch prompt's id is caught by its line's text, and an old prompt's id counts from when it was typed. `sideby unattended --json` lists the Attended Sessions (`attended`) and the Panel shows them, both read-only.
- The first `Stop` or ask-tool `PreToolUse` while Unattended Mode is on and the session is newly attended prints one `systemMessage` to the user: this session asks as usual for 30 minutes after the last message, other sessions stay unattended, and `sideby unattended off` turns it off everywhere. A renewal does not repeat it; a new stretch after one lapsed does.
- "Is this session unattended now" is one function, `sessionUnattended()` in the leaf `core/unattended-attended.ts`, for this hook and for later features that must stay quiet in an unattended session.

## Consequences

- A person who comes back types as they would anyway and gets their questions in that session. Other sessions keep running alone, and nothing has to be turned back on later.
- Automation that types into a terminal (tmux `send-keys`, key simulation) looks like a person to Claude Code and marks that one session for at most 30 minutes. A model that writes into its own message socket does not: that is `peer`.
- A model that writes a line into its own transcript, or a file into sideby's state directory, can still mark its session. That is the same reach as running `sideby unattended off`, which Unattended Mode has never stopped (ADR-0058): the mode keeps an unattended session from waiting on a person, and is not a sandbox against the model.
- The feature depends on Claude Code's transcript `origin` field, which is not documented. If a version drops or renames it, no prompt counts and Unattended Mode behaves as before this ADR; it never fails the other way.
- If Claude Code changes a command-line prompt before the hook sees it in a way that trimming and joining spaces do not undo, that prompt would count. Tried with 2.1.325, it reached the hook as given.
- A session counts only once the transcript line is there, about 0.1 to 0.2 s after the prompt plus the hook's start. A question asked faster than that is still refused, and the notice then comes at the turn's end; a model's first reply takes longer than that. Tried end to end with Claude Code 2.1.325 on 2026-11-16 through `sideby run` against a local fake server that answers at once: a typed prompt made its session ask as usual and showed the notice; a command-line prompt and a `sideby send` Message did not count. Tried again the same day with checks 4 and 5 in place, in the main Account (`~/.claude`) and in a second one (`CLAUDE_CONFIG_DIR` set): a typed prompt counted in each, from its line's time, and the command-line prompt did not.
- Each prompt in a covered session starts one short background process (about 0.1 to 0.2 s, at most 10 s). It holds nothing back.
- `unattended-hook` now reads one line of the session's transcript, writes `<state>/unattended/attended/`, and imports two more leaf modules; `docs/agents/host-directories.md` and the import walk in `src/unattended/hook.test.ts` say so.
- Codex is not covered: its `UserPromptSubmit` hook needs the user to trust it again in `/hooks`, and whether its session records tell a person apart was not tried. Sessions started before this change get the hook at their next start.
