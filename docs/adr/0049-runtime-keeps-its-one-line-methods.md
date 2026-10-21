# ADR-0049: The Runtime keeps its one-line methods; settings writes and Panel writes share one module each

Status: accepted
Date: 2026-10-21

## Context

An architecture review found that many `Runtime` methods (`remoteControl`, `remoteControlOff`, `remoteControlOn`, `remoteControlUndo`, `tuneApply`, `tuneUndo` and others) only call a `core/` function with `accounts()` and `readContext()`. By the deletion test they hold no behaviour of their own, and the review proposed deprecating them so callers use the `core/` modules directly.

The same review found the behaviour they forward to was spread out: Remote Control, Messages inbound and context tuning each kept their own undo record format and their own "still what sideby wrote" check for one key of Claude's `settings.json`, and the Panel's Remote Control and inbound routes wrote without checking that the files the user saw in the preview were still the files to change.

## Decision

- **The one-line methods stay, without deprecation.** `createRuntime` is the package's public entry (`src/index.ts`), and `core/` is not exported, so the `Runtime` method is the only way a tool built on sideby can reach these features. Deprecating them would leave those tools nothing to move to. A new feature that a tool could want gets one `Runtime` method; its behaviour lives in a `core/` module, and the method only passes the Runtime's Accounts and context.
- **One module for one key of a Claude settings file.** `settingsKey(key, records)` in `core/claude-settings-file.ts` owns reading the groups, writing the key through `writeIfUnchanged`, the undo record and undo. Remote Control and Messages inbound use it; tuning shares its record reading and writing. Record files keep their paths and fields, so undo still works for changes made before.
- **One adapter for Panel writes that follow a preview.** The Remote Control and inbound routes return the files they would change without `confirm`; with `confirm` they write only when the files the page sends equal the ones the server would change now, else they answer `changedSince` and write nothing. The page shows that as "changed since you looked" and the user looks again.
- **Reasons as codes.** The groups these modules return carry a `why` code beside the English `reason`, so the Panel shows the reason in the user's language.

## Consequences

- Reviews should not propose removing these methods again unless `core/` modules become part of the public contract, which would need its own ADR.
- The Panel's write routes for Remote Control and inbound need `confirm: true`; a page from an older version that posts without it gets the preview back and writes nothing. The page and the server ship together, so this only affects a page left open across an update, which then asks the user to look again.
- JSON outputs gain the optional `why` field only, so `schemaVersion` stays 1.
