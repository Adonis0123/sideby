# 0035. Pick Commands fall back to the Main Account

Date: 2026-10-19 · Status: accepted

## Context

Users with several Accounts of one Family want one short command (`cc`, `cx`, `gk`) that starts whichever Account has the most Quota left, instead of choosing between `cc001`…`cc008` each time. `sideby next <family>` already picks that Account, but it starts nothing when no signed-in Subscription Account of the Family has Quota data, because the pick would be a guess (spec §3.13).

An Alias cannot carry this: by definition it always starts the same Account.

Options considered for a Pick Command without Quota data:

- Refuse, as `sideby next` does. Rejected: a command typed many times a day would fail on a new machine, after a Quota cache expires, or for a Family whose Quota is off, and the user would learn to avoid it.
- Start the Account used most recently. Rejected: harder to predict, and it keeps sending work to the Account that is most likely full.
- Start the Main Account and say so. Chosen: always the same answer, and the printed line tells the user why.

## Decision

- A Pick Command is a name in the config `pickCommands`, bound to one Family, kept separate from `aliases`; the two share one namespace.
- It picks exactly as `sideby next <family>` does (lowest Quota Pressure, Subscription Accounts only) and starts that Account as `sideby run` would, passing its arguments to the Host.
- Without Quota data it starts the Main Account, when that is a Subscription Account that can start (not signed out); otherwise the Account Handoff would pick. API Accounts are never started, also not as the fallback. Before starting it prints one line to stderr naming the Account and why; an Account picked without Quota data of its own is never shown with a percentage.
- With Quota data but no Account that can start (all full, signed out or API), it starts nothing and says which comes back first or which to sign in.
- `sideby next` keeps refusing without Quota data; only Pick Commands fall back.
- Off until the user adds one, after a preview (CLI exit 10 until `--yes`; in the Panel the dialog is the preview); a name that shadows a command on PATH (`cc` is the C compiler on macOS) says so in that preview.
- The Panel's start button opens the Preferred Terminal running the Pick Command itself, so the terminal shows the same line.

## Consequences

- Two entry points to the same pick behave differently without Quota data; the spec and the skill say which does what.
- A Pick Command can start a full Main Account when Quota is unknown; the printed line is the user's cue to run `sideby quota`.
