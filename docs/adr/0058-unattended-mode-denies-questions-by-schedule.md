# 0058. Unattended Mode denies the Host's questions through a hook, on a Schedule

Date: 2026-10-29 · Status: accepted

## Context

Users leave several Accounts working overnight and find a session in the morning waiting on a question or a confirmation. In Claude Code 2.1.310 to 2.1.312 bypassPermissions sessions over one week (2026-10-22 to 10-29), the model asked the user 83 times and the sessions waited 8.6 hours in all; subagents waited up to 5.2 hours on the critical-path removal prompt, which in the main session is denied after two minutes but in a subagent waits for a person. Bypass permissions does not stop the model from asking.

What the Hosts offer (checked 2026-10-29 against Claude Code 2.1.312, codex-cli 0.165.0 and Grok Build 1.0.70):

- Claude Code: a `PreToolUse` hook can deny `AskUserQuestion`, and "Claude Code reads the JSON decision, blocks the tool call, and shows Claude the reason"; with exit 2 the stderr text reaches Claude as the tool's error (https://code.claude.com/docs/en/hooks). `--disallowedTools` removes the tool, and `--permission-prompts none` removes it in print mode, but both are fixed for the whole session at launch. A `PreToolUse` hook cannot approve a critical-path removal; only rewriting the command avoids the prompt (https://code.claude.com/docs/en/permission-modes). The `PermissionRequest` hook "Runs when Claude Code is about to ask you for permission", including for "background subagents", where "Claude Code still runs these hooks"; a decision's `message` "tells Claude why the permission was denied", and "Exit code 2 isn't honored for this event", so the denial is JSON on stdout (https://code.claude.com/docs/en/hooks#permissionrequest).
- Verified on 2026-10-29 with Claude Code 2.1.312 in an interactive bypassPermissions session (run in tmux, model haiku): a command flagged "Dangerous rm operation not ruled out" (`grep -n "^  [a-zA-Z$(]" a.ts`) fired `PermissionRequest` in the main session; the hook's denial showed no prompt, and the model read the message. The same held in a background general-purpose subagent, whose payload carried `agent_id` and `agent_type`.
- Codex: the tool is `request_user_input`, offered only in Plan mode by default and refused to subagents. `PreToolUse` hooks fire for it and a block reaches the model; hooks passed with `-c hooks.*` run only after the user trusts them in `/hooks` (https://developers.openai.com/codex/hooks).
- Grok Build: `ask_user_question` can be denied by a hook, but sideby can only add a Grok hook by writing a file under `~/.grok/hooks/`.

What others do with "not now" and schedules (2026-10-29): Android's Do Not Disturb, Apple's Focus and Slack's paused notifications all keep a weekly list of time ranges, offer a few durations plus a custom time for "on now", and treat "off" during a scheduled range as a pause until that range ends (Android: `OVERRIDE_DEACTIVATE`, cleared when the schedule's condition turns false, `ZenModeConfig`). Android states the reason and the end ("turned on by a schedule (Weeknights)", "Until 10:00 PM"). Autonomous agent tools such as Dreadnode's TUI cancel agent questions ("the agent either picks a default or abandons the subtask") and keep no list of what was skipped.

Options considered:

- A user's own hook in the Host's settings. Rejected: each user writes and maintains it, it covers no schedule, and nothing collects what was skipped.
- `--disallowedTools AskUserQuestion` at launch. Rejected: a session started at 22:30 must stop asking at 23:00 and ask again at 08:00 without a restart.
- Answer the question automatically with the first option (`updatedInput` with `answers`). Rejected: a wrong answer to a hard-to-undo question does harm; a denial with instructions lets the model choose the safe path and leaves a record.
- A hook injected into the sessions sideby starts that reads the Schedule and the manual state on every call and denies with a reason. Chosen.
- For the prompts Claude Code shows even in bypass mode: deny, before every Bash call, the command shapes Claude Code's critical-path check prompts for (zsh-only syntax, `rm` beside a multi-line `bash -c`, an unguarded variable in an `rm` target). Built first, then rejected: it guesses Claude Code's checks, so it both misses (a quoted `rm` is checked again by Claude Code and still prompts) and blocks what does not prompt (`D=/literal; rm -f $D/*.png` did not prompt in the test above), and it runs on every Bash call.
- Answer Claude Code's `PermissionRequest` itself with a denial while Unattended Mode is on. Chosen: it fires exactly when a prompt would appear, whatever the rule behind it, also in subagents.

## Decision

- **Unattended Mode** (`CONTEXT.md`) is one state for the whole computer, decided by the **Schedule** (config `unattended.schedule`, a list of **Slots**: days, start, end, local time; an end before the start runs past midnight; overlapping Slots merge), a manual "on until" (at most 72 hours), a manual pause that lasts only until the current Slot ends, and `--unattended` for one session. One pure function decides it for the CLI, the Panel and the hook.
- A new `unattended-hook` entry is injected the way Network Guard's is (ADR-0053): Claude `--settings` merged with Auto Handoff's and Network Guard's, `PreToolUse` matching `AskUserQuestion` and `PermissionRequest` matching `*`; Codex `-c hooks.PreToolUse`, matching `request_user_input` (Codex gets no permission hook: its own approval prompts still wait). It runs by absolute path, imports only leaf modules and reads the Schedule and the manual state on every call, so the state changes inside a running session. It is injected once the config has an `unattended` section, so turning it on later covers sessions already running. Nothing is written into a Host directory; sessions started without sideby, Grok, pi and Desktop Apps are not covered in v1, and sideby says so.
- While on, it denies the ask tool with exit 2 and a reason (take the recommended option where it can be undone; skip and record anything destructive or outward-facing with `sideby unattended defer`), and records the question as a **Pending Decision**. In Claude it answers every `PermissionRequest` with `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":…}}}`: the message says a person was needed and nobody is here, how to do the step without a prompt (literal paths, `"${VAR:?}"` for a variable in an `rm` target, plain bash, `rm` as its own command), or to skip it and record it with `defer`. The request is kept as a Pending Decision of kind `permission` (the tool name with, for Bash, only the program name and the model's own description, never an argument, since a credential can take any shape there and the whole command stays in the Host's session record; a file tool's path; WebFetch's host; plus `agent_id` and `agent_type` when a subagent asked). While off, it does nothing. When the hook itself fails before deciding, it does nothing: that is the behaviour without the feature (Claude Code shows its prompt), unlike Network Guard, which blocks when it cannot tell.
- Pending Decisions stay until the user marks them done. When a stretch of Unattended Mode ends, the first sideby process that notices (the background Panel checks every 30 seconds; other commands check at start) emits the plugin event `unattended.ended` once, with the stretch and its Pending Decisions. sideby sends no notification and makes no request itself.

## Consequences

- A new plugin event, `unattended.ended`, joins the public plugin contract in `src/types.ts`.
- The hook runs only when the model asks or Claude Code is about to prompt (about 40 ms each), not on every tool call.
- While on, a Claude session cannot get a permission it would have asked for, even one the user would have granted; the step is rewritten, skipped or left in the Pending Decision list.
- Codex questions are denied only after the user trusts the hooks once, and Codex asks only in Plan mode by default, so most of the benefit is in Claude sessions.
- The model, not sideby, decides what "recommended" and "hard to undo" mean; the Pending Decision list is where the user checks those choices.

## Amendment (2026-10-29): a turn that ends on a question written as text

Refusing the ask tool did not cover a model that asks in plain text. Models often skip the tool and end their turn on a written question ("需要你拍板 …", "Want me to …?", "pick one when you are back"), and then stop; nothing caught that, so the session sat idle until someone came back. Observed on 2026-10-29 with Claude Code and Unattended Mode on: four times in one night across sessions, once right after the ask tool was refused (the model asked the same thing as text).

What the Hosts offer (checked 2026-10-29):

- Claude Code: a `Stop` hook gets `stop_hook_active` ("`true` when Claude Code is already continuing as a result of a stop hook") and `last_assistant_message`; `{"decision":"block","reason":…}` on stdout, or exit 2 with stderr, keeps Claude going with the reason as its next instruction, and "after stop hooks have continued the turn eight times in a row, Claude Code overrides the next block and ends the turn" (https://code.claude.com/docs/en/hooks#stop). An `Elicitation` hook can answer an MCP server's form with `{"hookSpecificOutput":{"hookEventName":"Elicitation","action":"decline"}}`; the server receives `decline` and no dialog appears; Claude Code discards the hook's `reason` (https://code.claude.com/docs/en/hooks#elicitation).
- Codex (codex-cli 0.165.0, `codex-rs/hooks/src/events/stop.rs` and `engine/output_parser.rs` at tag `rust-v0.165.0`): `Stop` hooks get the same `stop_hook_active` and `last_assistant_message`; `"decision":"block"` with a non-empty `reason` (or exit 2 with stderr) blocks the stop and turns the reason into a continuation prompt. Hooks passed with `-c hooks.*` are trusted one by one in `/hooks`: the trusted hash covers the event, the matcher and the command (`engine/discovery.rs`). Codex has no `Elicitation` hook event.

Options considered:

- Block every stop while Unattended Mode is on until the model says it is done. Rejected: a finished report would be kept going for nothing, up to Claude Code's cap of eight.
- Ask a model whether the message is a question (a prompt-based `Stop` hook). Rejected: a model call on every turn end, with no fixed answer to test.
- Tell from the end of the message with a short list of patterns, block once, and let `stop_hook_active` end the turn the second time. Chosen.

Decision:

- `unattended-hook` is also injected on `Stop` (Claude `--settings`, no matcher; Codex `-c hooks.Stop`, no matcher) and, in Claude, on `Elicitation` (matcher `*`).
- On `Stop`, while on, with `stop_hook_active` exactly `false` and the last message ending on a question (`endingQuestion` in `src/unattended/hook.ts`: code blocks, inline code and `>` quotes removed, then the last 600 characters; a line that starts with the `需要你拍板` or `Needs your decision` marker (text may follow a colon, and other paragraphs may follow it), a last line ending in `?` or `？` (or a closing list of options right after such a line), or one of `QUESTION_PATTERNS` in the last paragraph, with the paragraph before it when the last is a list, and not right after a negation such as 无需 or "no need"), it answers `{"decision":"block","reason":…}` with exit 0. The reason, in English or Chinese like the ask tool's: nobody is here, do not wait or ask again; take the recommended option where the choice can be undone and carry on to the end; skip anything hard to undo and record it with `defer`; end with a final report listing the choices and the recorded items, without asking. The question is kept as a Pending Decision of kind `question` (deduplicated). The patterns only take asks that wait for an answer, so closings such as "Let me know if you have any questions" stop normally.
- On `Elicitation`, while on, it declines and keeps a `question` Pending Decision with the server's name and its `message` only, never the form's schema or defaults.
- Off, `stop_hook_active` true or missing, a message that is not a question, bad input or any error: exit 0, no output, the turn ends as it would without the hook.
- Codex accounts already told to trust the hook are told once more, since the `Stop` hook needs a trust of its own.

Consequences:

- A turn that ends on a question runs once more, so the model takes the recommended path and writes a report; it never loops, since the second stop has `stop_hook_active` set.
- A finished report that happens to end on a question or a listed pattern runs once more too; the model then writes its report again. The pattern list is kept short for that reason.
- The hook now runs at the end of every turn in a covered session (about 40 ms); with Unattended Mode off it reads two files and exits.
- In Codex, the text-question cover works only once the user trusts the new `Stop` hook in `/hooks`.
