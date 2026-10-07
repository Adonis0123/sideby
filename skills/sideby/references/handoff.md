# Handoff: keep working on another account

Use this when the user says an account hit its 5-hour or weekly limit ("usage limit reached", "rate limited", "resets at …") and wants to keep working, or asks which account has room. sideby recommends the account of the same family with the lowest Quota Pressure (the fullest window that has not reset yet). It never switches by itself; the user starts the next account.

## Steps

1. Run `sideby next <family> --json` (`claude` or `codex`). It only recommends; it starts nothing.
2. Tell the user the pick and why, from `pick` and `accounts`:

   | `state` | Meaning | Can be picked |
   |---|---|---|
   | `ready` | Subscription account with room; `pressure` is its fullest live window in percent | Yes, lowest `pressure` first |
   | `unknown` | No quota data yet (no session since quota was turned on, or Claude quota is off) | Yes, after `ready` |
   | `api` | API account, pay per use | Only with `--include-api` |
   | `full` | A live window is at 85% or more; `resetsAt` is when it is usable again | No |
   | `logged-out` | Needs `sideby login <ref>` | No |

   Each entry's `observedAt` says when its quota was recorded. If `hasQuota` is `false`, no account has quota data: the pick is only a guess, so say so and suggest turning quota on (see the routing table in SKILL.md) or letting the user choose.
3. Give the user the command to run in their own terminal: `sideby next <family>` (starts the pick) or `sideby run <pick>`. Host arguments go after `--`. Do not run it yourself.
4. Offer a handoff note: the new session starts empty, because each account keeps its own sessions. Write a short note the user can paste into it: the goal, what is done, what is in progress, the files involved, and the next step.

## When nothing can be picked

`pick` is `null` and the exit code is 1:

- Every account `full`: tell the user `earliestReset.ref` comes back at `earliestReset.at`.
- Accounts `logged-out`: the user can sign in with `sideby login <ref>`.
- Only `api` left: ask whether they want to pay per use before suggesting `sideby next <family> --include-api`.

## Other answers

- Error `code: "no-quota-source"` (Grok, pi): the Host publishes no quota. The message lists the family's accounts; let the user choose one for `sideby run <ref>`.
- Error `code: "no-accounts"`: the family has no account yet; see creating accounts.
- Many `unknown` Claude accounts: Claude quota may be off. `sideby quota --json` shows `not-enabled`; the one-time setup turns it on.
- Host arguments the user wants (another model, say) go after `--`: `sideby next claude -- --model opus`.
- Quota is only as fresh as each account's last session. Do not promise an account has room; say what the data shows and when it was recorded.

## Never

- Switch accounts by editing config or environment, copy session files between account directories, or read any credential.
- Start a session for the user.
