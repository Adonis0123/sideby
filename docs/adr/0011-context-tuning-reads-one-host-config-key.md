# ADR 0011: Context tuning is read-only and reads one key of a Host's config

Date: 2026-10-13 · Status: proposed (accepted once the checks in spec §3.18 and acceptance item 16 pass)

Extends ADR-0003 (local sources only). Its "only reads" part is amended by ADR-0012, which lets the user apply a suggestion. Amends the Credentials and Host directories wording in AGENTS.md: besides Doctor's `json-key` read, sideby may read one named key of a Host's config file for this feature.

## Context

Every Host compacts a session by itself once its context grows past a Compaction Threshold. A threshold that is too low compacts (and re-reads what it dropped) more often than needed; one that is too high keeps paying to re-read a large context on every turn. The best value depends on how a person works, and the Host's records of the person's own recent sessions are enough to estimate it.

Ways to offer this:

- Send the records to a model or a hosted service for advice. Needs the content of the sessions to leave the machine. Rejected (ADR-0001, ADR-0003).
- Apply the best value for the person. Needs sideby to write into a Host's config, a third exception to "sideby writes nothing into a Host directory", for a value that is only an estimate. Rejected for now.
- Estimate locally and show the value as a snippet the person copies. No Host directory is written; the cost of being wrong is one setting the person chose to change.

## Decision

- `sideby tune` and the Panel's per-Account block replay the Account's last `USAGE_DAYS` of local session records per model and show a Tuning Suggestion, labelled as an estimate. Nothing is sent anywhere and nothing is written to a Host directory.
- Claude gets a suggestion. Codex only gets observations, because the default threshold and its scope have no first-hand source yet. Grok and pi have no public source (ADR-0003).
- To show "current value", sideby reads exactly one key from the Account's own config: `autoCompactWindow` in Claude's `settings.json`, `model_auto_compact_token_limit` in Codex's `config.toml`. It follows the `json-key` rule: no other value is read, returned, logged or cached; a missing, unparsable or key-less file means "Host default". Environment variables and `proxy.env` are not read.
- Costs are relative weights (input 1, cache read 0.1, cache write 5m 1.25 and 1h 2, output 5), not prices, so the table does not go stale with a price change and sideby needs no network. A model whose id does not start with `claude-` (for example a third-party model behind a gateway) gets no suggestion, because the weights are Anthropic's.
- `FamilyDef.readTuning` is an optional member of the public plugin contract, added without changing any existing member.

## Consequences

- This is the first time sideby reads a value from an Account's Host config for a usage-style feature. It sits next to two existing reads: `quota setup` reads and wraps `statusLine.command` in the Main Account's `settings.json`, and Doctor reads the one key a `json-key` item names. This ADR limits it to a single named key per Family, and a test asserts that no other key appears in any output or cache.
- The estimate cannot be exact: a different threshold changes the summary and what is left after compaction, which the records cannot show. The UI says "estimate" and never "will save".
- What `autoCompactWindow` means exactly is not verified: the name says "window", and third-party notes say Claude Code compacts as the context nears it, possibly with a margin. The replay treats it as the threshold, so the current value, the saving and the suggestion may all sit a little high. The Panel says so next to the suggestion, and acceptance item 16 includes a manual check of how close later compactions come to a value that was set. This ADR stays proposed until that check is recorded.
- If a Host renames its key, "current value" falls back to "Host default" and the rest keeps working.
- Writing the suggestion for the person ("use 160K") can be added later. It needs its own ADR: a preview, `--yes`, a byte-for-byte undo and a third Host-directory exception.
