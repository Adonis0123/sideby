# ADR 0080: A config written by a newer sideby still loads in an older one

Date: 2026-11-20 · Status: accepted · Reverses the "unknown keys are an error" rule of spec §3.10 · Amends ADR-0024

## Context

Every object in `ConfigSchema` has `additionalProperties: false`, and `loadConfig` refused any file that did not match. So one key written by a newer sideby made an older one exit on every command, including the short commands a user starts sessions with. For example, `sideby trust on` (0.41) writes `claude.carryTrust: true`, and sideby 0.40 then fails with `/claude/carryTrust schema is false`. This happens when a user installs an older version, uses a Local Build cut from a branch older than `main` (`pnpm local`, `pnpm local --back`, `sideby local on`), or shares one config through dotfiles between machines on different versions. The rule was meant to catch typos. In practice it turned a harmless newer setting into a sideby that does not start.

## Decision

- **Reading.** A key the schema does not declare is ignored: at the top level, or inside an object whose schema lists its `properties`. Record keys (`aliases`, `pickCommands`, `accounts`, `handoff.families`, `quota.check`, …) are the user's own names and are never unknown. Values of a union stay strict: an alias object takes only `account` and `args` (ADR-0005 keeps `env` out). A known key with a wrong type or value still stops sideby and names the key and the fix.
- **No printing from `loadConfig`.** Hooks (`unattended-hook` stderr is fed to a model, `statusline-tap` stdout is a status line) and `--json` commands read the config too. `readConfig` returns the unknown keys as dot paths. Only `sideby list` (stderr) and `sideby doctor` (text output) print a line per key: the key, why it is there (this sideby is older than the one that wrote it, or a typo) and what to do (`sideby update`, or `sideby config unset <key> --yes`). The note is not a Doctor Finding: Findings belong to a Family and are kept in the Doctor history and shown in the Panel, and a config key belongs to neither.
- **Writing.** Every config change sees only the known keys, is checked strictly, and then gets the unknown keys put back with their values, each after the same sibling it followed. This includes unknown keys inside the very object being changed. An object a change empties keeps just its unknown keys. A record entry the change removes, or a list item it removes or alters (a list item has no name to match it by), takes its own unknown keys with it. `config unset <section>` removes the whole section. `config set` still refuses a key the schema does not have (typo protection), and `config unset` may remove an unknown key that the file holds, at that exact path.
- **`schemas/config.json` stays strict**, so editors keep flagging typos.
- **A Local Build must read the config before it goes live.** `pnpm local` runs the new build's `sideby config get --json`, which reads only the config file, with the caller's `HOME` and `XDG_CONFIG_HOME` and no Update Check. `pnpm local --back` checks the old build it would switch to, and `sideby local on` and the Panel check the Local Build. If it cannot read the config, the running build stays, and the message gives what the build said and what to do: rebase the checkout onto `main` when a newer sideby wrote the config, or fix the file when it is wrong.

## Consequences

- Versions already released (0.41.2 and older) still exit on an unknown key. The fix helps only from this version on, and the Local Build check covers older Local Builds.
- A typo in a hand-edited config no longer stops sideby. It is ignored until the user reads `sideby list` or `sideby doctor`, or their editor flags it from the schema.
- A user who switches back and forth between versions keeps the newer settings, and the older sideby neither drops nor rewrites them.
- No `--json` output changes. The `config unset` JSON for an unknown key has the same shape as for any other key.
