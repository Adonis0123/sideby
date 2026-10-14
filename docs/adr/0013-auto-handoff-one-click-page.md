# ADR 0013: Auto Handoff has a page of its own and turns on in one step

Date: 2026-10-14 · Status: proposed (accepted once the checks in spec §3.17 "页面与一键开启" and acceptance item 17 pass)

Amends ADR-0010: the decision stays (off until the user turns it on, same-family hand-over needs its own switch); how a user turns it on changes.

## Context

ADR-0010 shipped Auto Handoff with a dialog behind a top-bar button: four numbers, a per-Family order, a risk checkbox and, at the bottom, a list of commands to copy into a terminal (`sideby quota setup claude`, `sideby handoff setup grok`, `sideby doctor grok --fix`). A beginner does not know what any of this means. A real chain on the author's machine (001 to 003 at the threshold, Brief written by the agent) worked, yet the only thing the user saw was the old session saying "another account will take over" at 80%, then nothing for a while, so it looked unfinished. The design principle in AGENTS.md says to give a feature a place of its own, do the work for the user, show the change first and keep an undo.

## Decision

- A page, "Auto Handoff", beside Accounts and Tuning (`#handoff`). Off: one sentence and one button, "Turn on". On: where each account's work would go next, the last hand-overs, and what is still missing, with a button that fixes it.
- "Turn on" is one action with one preview: it lists every change (the `handoff` key of `config.json`, the Claude quota tap, the Grok hook file and the copies of that one file into the other Grok accounts) and applies them together after one confirmation, the `config` key last so that "on" means "working"; it stops at the first step that fails. The first two are the existing, reversible setups (`quota setup`, `handoff setup`) through the same core functions as the CLI. The copy writes only the hook file into each account's own `hooks/` directory, never through a link, never replacing a file that is already there and never touching another file (Doctor's copy fix would replace the whole directory, so it is not used). `handoff teardown grok` removes the Main Account's file only; the copies stay and do nothing outside a sideby hand-over. No new kind of Host write.
- Hand-over between accounts of one Family (the risky kind, ADR-0010) is a separate line in the preview, off unless the user ticks it, with the risk in plain words. Turning on does not imply it.
- What cannot be done for the user (a Codex account trusting the hooks in `/hooks`, a `sideby` that is not on PATH) is said once, in words, with the one command only where nothing else can do it.
- "Turn off" sets `handoff.auto` to false and keeps every other setting; the quota tap and hook file stay (they are harmless and have their own teardown).
- The 80% message to the agent no longer says another account will take over. The agent writes the Brief and carries on; sideby itself tells the user when it switches (the countdown line).

## Consequences

- A beginner reaches a working Auto Handoff with one click and one confirmation, and can see afterwards that it worked.
- The Panel gains write routes for hook setup; they follow the rules of `quota setup` (preview without `confirm`, read-only Panels refuse).
- The old dialog stays as "Advanced" for the numbers and the order.
- The page only knows about sessions sideby started; a plain `claude` in a terminal never hands over. The page says so.

## Revisit when

A user turns it on and still sees no hand-over in the cases the page promises, or a Host starts to ship its own cross-account handoff.
