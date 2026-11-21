# Shared Project Memory (target design)

Target design snapshot, written 2026-11-20, not updated with the code; where it conflicts with the code, the code wins and the mismatch should be reported.

Context: Claude Code keeps auto memory per config directory at `<config dir>/projects/<project>/memory/`, so each Claude Account holds its own copy for the same Project. This design makes every Claude Account read and write the Main Account's copy. Opt-in through config `claude.shareMemory`.

## Components

| Name | Type | Responsibility | Code path |
|---|---|---|---|
| Launch | sideby process | Before starting a Claude session in a Project, derive the Project's memory directory name and pass the Main Account's real path as `autoMemoryDirectory` through `--settings` | `src/core/claude-memory.ts` (`memoryTarget`, `memoryHookPart`), wired in `src/runtime.ts` and `src/core/session-hooks.ts` |
| Project key derivation | sideby function | Reproduce Claude Code's directory name for a Project (git repository root, sanitized path) | `src/core/claude-memory.ts` (`memoryTarget`) |
| Main project memory | directory | The single source: `~/.claude/projects/<project>/memory/` | Host-owned |
| Account project memory | directory | Memory written by sessions not started through sideby: `<account dir>/projects/<project>/memory/` | Host-owned |
| Doctor memory Fix | sideby check + Fix | Move Account project memory into Main; keep conflicting files as `<name>.<account>.md`; merge `MEMORY.md` indexes; take each moved file out through a stage folder, check its hash there and put a changed one back, trash the stage, `rmdir` the emptied directory; skip the whole Account when its Live Sessions cannot be read, and Projects with a Live Session in that Account | `src/core/claude-memory.ts` (`foldAccount`, `foldProject`, `mergeIndex`) |
| Doctor memory checks | sideby check | Warn when the derived directory differs from the one Claude Code actually wrote; warn when `MEMORY.md` and files disagree | `src/core/claude-memory.ts` (`nameMismatches`, `indexProblems`, `mainMemoryFindings`) |
| Rules promotion | user's own skill (outside sideby) | Scan `feedback` / `user` memories, draft entries for the shared rules file, write only after the user approves | outside this repository |

## Relationships

| From | To | Action | Protocol or data |
|---|---|---|---|
| Launch | Project key derivation | asks for the memory directory name of the working directory's Project | function call |
| Launch | Claude session | starts the Host with `--settings {"autoMemoryDirectory": "<Main real path>"}` | process arguments |
| Claude session (started by sideby) | Main project memory | writes memory files and `MEMORY.md` at the real path, no symlink in the path | file writes |
| Claude session (started without sideby) | Account project memory | writes memory files as the Host does by default | file writes |
| Doctor memory Fix | Account project memory | reads files and indexes when no Live Session of that Account works in the Project | file reads |
| Doctor memory Fix | Main project memory | moves files in, renames conflicts, merges index | file moves |
| Doctor memory Fix | Trash | moves the stage folder of checked files | system trash |
| Doctor memory checks | Main project memory | compares the derived name with directories Claude Code created | directory listing |

## Rejected

- Symlinking `projects/` or `projects/<project>/memory`: Claude Code prompts for permission on writes through a symlinked memory path and background subagents hang (anthropics/claude-code#108770, open, Claude Code 2.1.322). Reproduced for a linked `projects/<project>/memory` with Claude Code 2.1.328 on 2026-11-20 in permission modes `default` and `auto`; `--settings autoMemoryDirectory` with the real path was not denied (ADR-0081).
- `autoMemoryDirectory` in the shared user `settings.json`: one directory for every Project, so Projects mix.
- Per-Project `extraSharedItems`: one entry per Project, real directories block `link`, new Projects need manual entries.
