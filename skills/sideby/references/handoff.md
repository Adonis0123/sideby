# Handoff: keep working on another account

Use this when the user says an account hit its 5-hour or weekly limit ("usage limit reached", "rate limited", "resets at …") and wants to keep working, or asks which account has room. sideby recommends the account of the same family with the lowest Quota Pressure (the fullest window that has not reset yet), and the user starts it. Only Auto Handoff, which the user turns on in the config, moves a running task by itself (see below).

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

   Each entry's `observedAt` says when its quota was recorded (`quotaFrom` when it was read from another account of the same login). An entry with `sameLoginAs` is signed in as the same login as the account you run in: it shares that quota and is never picked. If `hasQuota` is `false`, no account has quota data: the pick is only a guess, so say so and suggest turning quota on (see the routing table in SKILL.md) or letting the user choose.
3. Give the user the command to run in their own terminal: `sideby next <family>` (starts the pick) or `sideby run <pick>`. Host arguments go after `--`. Do not run it yourself.
4. Offer a handoff note: the new session starts empty, because each account keeps its own sessions. Write a short note the user can paste into it: the goal, what is done, what is in progress, the files involved, and the next step.

## When nothing can be picked

`pick` is `null` and the exit code is 1:

- Every account `full`: tell the user `earliestReset.ref` comes back at `earliestReset.at`.
- Accounts `logged-out`: the user can sign in with `sideby login <ref>`.
- Only `api` left: ask whether they want to pay per use before suggesting `sideby next <family> --include-api`.

## Other answers

- Error `code: "no-quota-source"` (pi, or a plugin family without quota): the Host publishes no quota. The message lists the family's accounts; let the user choose one for `sideby run <ref>`.
- Error `code: "no-accounts"`: the family has no account yet; see creating accounts.
- Many `unknown` Claude accounts: Claude quota may be off. `sideby quota --json` shows `not-enabled`; the one-time setup turns it on.
- Host arguments the user wants (another model, say) go after `--`: `sideby next claude -- --model opus`.
- Quota is only as fresh as each account's last session. Do not promise an account has room; say what the data shows and when it was recorded.

## Auto Handoff (the user turns it on)

With config `"handoff": { "auto": true }`, a session sideby started hands its task to the next account when quota runs low; see the guide's Auto Handoff section for the settings. If you are in such a session (the environment has `SIDEBY_HANDOFF_RUN`):

- When sideby tells you the quota is at 80%, write the handoff brief at the path it names and keep it current (do not tell the user that another account will take over; sideby decides that and says so itself): the goal, what is done, the remaining steps, key decisions and why, the files that matter. Reference specs, ADRs, commits and diffs by path; list the skills the next agent should use; never include keys, passwords or personal data.
- When it says a window is about to run out (the message names it, such as "weekly (7d) quota is at 98%"; each window hands over at its own pace, ADR-0032), finish the current step, update the brief, and end your turn. sideby starts the next account from it.
- End the brief with the line `<!-- handoff brief complete -->` once it is complete. Without it sideby asks once more, then adds its own records under what you wrote.
- When a user asks why a session handed over "with 95% left": the 5-hour and weekly windows are separate, and the fullest one decides. Run `sideby quota` and read both windows.
- When the user asks to hand over now, update the brief, run `sideby handoff ready` (add `--brief <file>` when the user's own handoff tool wrote one), and end your turn. Tell the user the account it prints, not what `sideby next` says: the chain never goes back to an account it already used. When the user names an account ("go back to cc008"), run `sideby handoff ready --to <account>`; it works for an account this chain already used. When the quota is about to run out and sideby says the session will wait for the reset, the user can move on at once by typing `! sideby handoff ready` in the session (the model cannot answer at the limit); tell them so if they ask why nothing moved.

### Turning it on for the user

1. Run `sideby handoff status --json`. Read `auto`, `sideby` (is the `sideby` on PATH able to run the hook), each family's `starts`, `ready`, `problems` and `notes`, and `nextSteps`.
2. Tell the user what Auto Handoff does, that it is off by default, and the risk: hand-over between two subscriptions of one vendor (`--same-family`, cc001 → cc002) is the kind vendors may act on. Add `--same-family` only when the user asks for it. Ask which accounts each family should hand over to if they care about the order (`--order claude=codex001,cc002`; accounts or short commands, any family).
3. Run `sideby handoff enable [flags] --json`. Exit 10 means the config change was shown: show the user `diff`, ask, and only after a clear yes run the same command with `--yes`. It writes only the `handoff` key of the config and returns `nextSteps`.
4. Work through `nextSteps` in order. `sideby quota setup claude` and `sideby handoff setup grok` also exit 10 first: ask before adding `--yes`. `npm i -g sideby` installs or upgrades sideby on PATH; ask first. Codex needs the user to trust sideby's hooks once per account (`/hooks` in Codex); you cannot do that for them.
5. Run `sideby handoff status --json` again and report which families are `ready`.

To turn it off: `sideby handoff disable --json`, then `--yes` after the user agrees; the other settings stay. The panel's **Auto Handoff** page does all of this in one click (turn on, with one confirmation; turn off) and shows where each account's work goes next; for a user who is not in a terminal, point them there instead of walking through the commands.

## Picking an account for a subtask

Before you delegate work to another account (for example a review in a headless run), run `sideby next <family> --json` and use its `pick`, so the subtask lands on the account with the most room. Prefer an account of the same family for speed; running two subscriptions of one vendor at once carries the same vendor risk as `sameFamily`, so say so. A headless run such as `sideby run <pick> -- -p "<task>"` is yours to start only when the user asked for the delegation.

## Never

- Switch accounts by editing config or environment, copy session files between account directories, or read any credential.
- Start an interactive session for the user.

## Settings and overview

`sideby handoff enable --threshold 95 --prepare-at 80 --wait-minutes 30 --countdown 10 --json` previews the settings. `--threshold` is the quota percentage to hand over, `--prepare-at` the percentage to prepare the Brief, `--wait-minutes` the longest reset wait, and `--countdown` the seconds before handing over. Read the validated `settings` and `diff`; on exit 10, show the change and confirm before repeating with `--yes`. Keep the user's chosen `--same-family` and `--order` options in the confirmed command.

`sideby handoff status --json` also includes `overview`: `settings`, `takeover` (each account's `ref`, `family`, `starts`, `decision`) and `recent` (the last hand-overs' `from`, `to`, `at`, `trigger`, `briefSource`). A decision is `pick` with `ref`, `wait` with `until`, or `none` with `reason`; optional `skipped` and `earliestReset` explain exclusions and resets. An empty takeover list while Auto Handoff is off is expected. No Brief text is returned.

`sideby handoff teardown grok --json` removes the hook installed by setup only while it still matches. It does not turn Auto Handoff off; use `handoff disable` for that. Relay any refusal instead of removing modified files manually.
