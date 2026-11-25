# ADR-0087: Removing an Account moves it to the trash

Status: proposed
Date: 2026-11-26

Architecture snapshot: [docs/architecture/2026-11-26-account-hide-and-remove.md](../architecture/2026-11-26-account-hide-and-remove.md)

## Context

Accounts in sideby are discovered from disk rather than kept in a registry (`CONTEXT.md`). Hiding an Account (`display.hidden`, spec §3.25) only leaves it out of lists while keeping its directory, sessions, short commands and Handoff eligibility intact. Users who retire an Account have no safe way in sideby to remove it and clean up the short commands, display order entries and Handoff references pointing to it.

Deleting an Account directory directly with `rm -rf` is irreversible: an Account directory holds the Host's session history, local settings and `proxy.env`. Removing a Main Account would also break every symlinked Shared Item in the Family's other Accounts.

## Decision

- Add `sideby remove <account|alias> [--yes] [--json]` (with `rm` as an alias), the Panel's `POST /api/accounts/remove` (`{ ref, confirm }`) and the matching row-menu action and confirmation dialog, and document the command in `skills/sideby/`.
- **Main Account protection**: a Main Account can never be removed; sideby refuses with a clear error directing the user to `sideby hide` instead.
- **Active-use guard**: sideby refuses to remove an Account that has a Live Session or a running Desktop App instance for its App Data folder.
- **Same Login scope**: removing one Account of a Same Login moves only that directory; the other directories of the login stay untouched, and the preview states this explicitly.
- **Trash, never hard delete**: extract the `systemTrash` / `keepInState` helper from `src/core/claude-memory.ts` into `src/core/trash.ts`. Removing an Account moves its directory (and its non-main Desktop App Data folder, if present) to the system trash when running in the user's real HOME with `trash` on PATH, or to `<state>/trash/` otherwise. Moving a directory does not follow symlinks inside it, so Shared Items in the Main Account stay intact.
- **Config and state cleanup**: after the directory is moved, remove short commands (`aliases`) pointing to that Account (rewriting `shellInitFile`), drop its names from `display.accounts`, `display.pinned`, `display.hidden`, and `handoff.order`, and remove its kept Quota cache file if present.
- **Confirmation contract**: `sideby remove` without `--yes` prints the removal plan (directory path, optional App Data path, short commands and config entries to clean, Same Login note) and exits 10; `--yes` performs it.

## Considered

- Permanent deletion (`rm -rf`): too risky for a directory that holds local session history and secrets, and unnecessary when the system trash or `<state>/trash/` makes recovery straightforward.
- Allowing Main Account removal: breaks Shared Item symlinks across all sibling Accounts of the same Family.
- Removing all directories of a Same Login together: surprising when the user created a duplicate directory by mistake and wants to keep the other one.

## Consequences

- A removed Account disappears immediately from `sideby list`, the Panel and the Menu Bar Item, and can be restored by moving its folder back from the trash.
- Short commands and Handoff Order entries no longer dangle after an Account is retired.
- The Menu Bar Item stays read-only with respect to Account hiding and removal: it simply omits hidden and removed Accounts.
