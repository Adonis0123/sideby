# ADR 0012: Tuning can apply its suggestion, writing one key, with a preview and an undo

Date: 2026-10-13 · Status: proposed (accepted once the checks in spec §3.18 and acceptance item 16 pass)

Amends ADR-0011: its "sideby only reads" decision is replaced by "the analysis only reads; applying the suggestion is a separate step the user takes". The rest of ADR-0011 stands.

## Context

ADR-0011 showed the suggestion as a snippet to copy into `settings.json`. That asks a beginner to know where the file is, what JSON is and which Account it belongs to, and most will not do it. The design principle in AGENTS.md says sideby does the work for the user and never asks them to hand-edit a config file.

Ways to apply a suggestion:

- Keep the copy-by-hand snippet. Rejected: it is the problem.
- Set an environment variable at Launch (an Alias carrying `env`). Rejected: ADR-0005 keeps Aliases to Host arguments, and it would hide the setting from the Host's own files.
- Write the key into the Account's `settings.json`, with a preview and an undo. Chosen.

## Decision

- Applying is a separate action: `sideby tune apply` (preview and exit 10 without `--yes`) and a "Use 80K" button in the Panel that first shows what will change. Analysis stays read-only.
- It writes one key, `autoCompactWindow`, of the Account's `settings.json`, through `writeIfUnchanged`, keeping every other key, the indentation and the file mode. A missing file is created (mode 600). Where the file is a symlink (settings shared with the Main Account) it writes the real file it points to and says which Accounts that also changes; it never creates, replaces or retargets a link.
- It records the previous value and the written value under the state directory. `undo` restores the previous value only while the key still holds what was written.
- This is the third exception to "sideby writes nothing into a Host directory", after `quota setup claude --yes` and `handoff setup grok --yes`. Unlike them it is a single value the user picks, not a standing hook.
- Still never: write any other key, read or print any other value of the file, write through a link it did not resolve to a regular file, or apply without the user's confirmation.

## Consequences

- With shared settings, one Account's suggestion changes every Account that shares the file. The preview says so, and an Account that wants its own value needs its own `settings.json` (a user decision sideby does not make for them).
- Running sessions keep the old value; a new session picks it up. The UI says so.
- The estimate behind the number is unchanged (ADR-0011): it can be wrong, which is why the preview, the undo and the "estimate" wording stay.
- `autoCompactWindow` semantics are still unverified (ADR-0011), so applying it is reversible by design and the acceptance check measures the effect.
