# ADR-0093: Read Antigravity CLI local usage from conversation databases

Status: accepted
Date: 2026-11-28

Amends ADR-0048 ("No `readUsage`") and ADR-0082 ("`conversations/<id>.db`, which sideby never opens").

## Context

Under ADR-0048, Antigravity CLI (`agy`) left `readUsage` unset because no verified local token records were known. As a result, `sideby list`, `sideby quota`, and the Panel showed no 7-day token totals, daily usage bars, `lastActivityAt`, or recent model/effort for `agy` accounts, and `quotaIsStale` could not tell whether an older quota reading had gone quiet.

Verified with Antigravity CLI `1.5.19` on macOS on `2026-11-28`:

- Each Account stores per-conversation SQLite databases at `<account.dir>/conversations/<id>.db`.
- Table `gen_metadata` (`idx`, `data` BLOB) holds one protobuf record per model generation. Outer field `1` wraps generation metadata whose field `4` holds token counts (`2`: uncached input tokens, `3`: total output tokens, `4`: cache creation tokens when present, `5`: cache read tokens), field `19` holds the canonical model id (e.g. `gemini-4-neon`), and field `21` holds the display label (e.g. `Gemini 4 Neon (High)`). Zero-token bookkeeping rows carry no positive token counts.
- Table `steps` (`idx`, `step_type`, `metadata` BLOB) stores generation steps at `step_type = 15`, ordered by `idx` to align with `gen_metadata`; `metadata` field `1` holds a `google.protobuf.Timestamp` (`field 1`: Unix seconds). Occasional trailing auxiliary `gen_metadata` rows beyond the last `step_type = 15` row share the conversation's final step timestamp.
- Opening closed databases with `?immutable=1` and active WAL databases (`-wal` and `-shm` both present) with `{ readOnly: true }` reads all token records without creating files in the Host directory, reading conversation text, touching credentials, or making network requests.

## Decision

1. **Add read-only `readAgyUsage` (`src/families/agy/usage.ts`) and wire `agyFamily.readUsage`**:
   - List only regular `*.db` files inside a real non-symlink `<account.dir>/conversations/` directory.
   - Combine `.db` and optional `.db-wal` stats (`size`, `mtimeMs`, `ctimeMs`, `ino`) so active WAL writes both pass the `USAGE_DAYS` (7-day) mtime filter and invalidate `FileMemo`.
   - Open each database read-only using ADR-0082's WAL/immutable rule; cap `steps.metadata` at 64 KiB and `gen_metadata.data` at 64 MiB.
   - Decode only token counts, model id/label (extracting known effort words from trailing parentheses), and step timestamps. Never read or store conversation text, prompts, replies, or credentials.
   - Persist per-file parsed turns in `agyUsageMemo` (`FileMemo` `agy-usage`, version 1) under `<stateDir>/cache/file-memo-2.json`.
   - Export the low-level turn decoders and `readAgyConversationDb` so future read-only history or tuning analyses can reuse the same parser.

2. **Keep `agyQuotaFetch.lastActivityAt` unchanged (ADR-0092)**:
   - Automatic quota checks continue using the zero-cost 3-`stat()` `agyLastActivityAt` check rather than scanning conversation SQLite databases.

## Consequences

- `agy` accounts now report 7-day token totals, daily usage buckets, session counts, `lastActivityAt`, `lastModel`, and `lastEffort` across `sideby list`, `sideby quota`, and the Panel, matching Claude Code and Codex.
- `quotaIsStale` now recognizes quiet `agy` accounts whose quota reading is older than an hour with no newer local turns.
- Revisit if a future Antigravity CLI version changes the `gen_metadata` or `steps` protobuf schema or removes local SQLite storage.
