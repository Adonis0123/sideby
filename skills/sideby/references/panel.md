# Panel settings from the CLI

Use these commands for the same persistent settings as the Panel. Prefer account refs from `sideby list --json`; commands taking an account also accept its short command. Every JSON response has `schemaVersion: 1`.

## Pinned Accounts and Display Order

- `sideby order --json` returns `display` (saved `families`, `accounts`, `pinned`) and `families` in their effective order. Each family has `accounts` with `name`, `ref`, `pinned`; a family with no accounts has an empty array.
- `sideby pin claude:work --json` and `sideby unpin claude:work --json` return `ref`, `pinned`, `changed`, `message`, `display`. They save immediately. Repeating a pin or unpin is a no-op. A Same Login is pinned/unpinned together and counts once; at most three per Family. If full, ask which one to unpin first. A new pin goes last among pins.
- `sideby order claude work main --json` sets that Family's account order using names, not refs or short commands. Unlisted accounts follow in the default order; pins still lead. Unknown or repeated names fail without saving.
- `sideby order --families codex claude --json` sets the Family order; unlisted Families follow.
- `sideby order --reset --json` forgets Family and account order, keeping pins. Save the old `display` from `order --json` before rearranging if the user may want to undo; restore Family/account lists with `order`, and pins with `unpin` then `pin` in their old order.

- Same Login row name: the Panel shows two directories of one login as one row, named after the one that comes first in the order. To show `001` instead of `main`, run `sideby order claude 001` (the rest follows). `order --reset` brings back the main directory's name.
- Desktop app windows (Grok Bot, id `grok-bot`) are a group in the same order: `sideby order --families claude grok-bot codex` places the group, `sideby order grok-bot 001 main` orders its windows. They cannot be pinned.

These affect display only, never Handoff Order. Saving removes names that no longer exist. The existing Same Login rules apply (Claude groups by email and organization; Codex accounts remain separate).

## Model and effort

`sideby model claude:work --json` shows `account`, `family`, `settable`, optional `reason`, available `models` and `efforts`, and `sideby`, `host`, `last` choices. Effective `model` and `effort` have `{ value, from }`.

To change them, run `sideby model claude:work opus --effort high --json`; `default` removes a sideby override. Read `change.diff`, `change.args` and `change.applied`. Exit 10 is a preview waiting for `--yes`: show it to the user and confirm before applying the same command with `--yes`. Only sideby's account arguments change, never the Host config. If `settable` is false, relay `reason`.

## Remote Control

`sideby remote-control --json` returns `action` and `groups`: each has `file`, `accounts`, `state`, `undo` and optional `reason`. `state` is `on`, `default`, `off`, `missing` or `blocked`.

Use `sideby remote-control off --json`, `on --json` or `undo --json`. Exit 10 shows the affected groups and waits for `--yes`; confirm before applying. A result has `applied`, optional `results` (`file`, `accounts`, `ok`, `message`) and optional `message`. Only turn it on when asked. Changes affect new sessions; running sessions remain connected until restarted. Undo restores the earlier value only while the key still holds what sideby wrote.
