# ADR-0042: Keep a local History Index of every Session's prompts and replies

Status: accepted
Date: 2026-10-20

## Context

A user who runs several Accounts of several Hosts cannot find a past Session: each Host lists only its own Sessions of one Account, and a person remembers what they asked, not which Account or folder they were in. Session History (spec §3.33) lists every Session of every Account by Project and searches them.

The Hosts' records are large. Tried on 2026-10-20 with one user's machine as the sample: about 2,950 Claude transcripts (7.7 GB), 430 Codex rollouts (8.6 GB), 1,370 Grok sessions (5.8 GB) and 40 pi sessions. Most of the size is tool output: of 5.3 GB of Claude transcripts, the prompts the user typed and the replies of the model come to 29 MB. Reading all records for each search takes tens of seconds; parsing them once took 34 s for those 5.3 GB.

Other session browsers (2026-10-20): Orca keeps a SQLite FTS5 index but has it off by default, searches with different rules when it is off, and fails on Chinese words inside longer text; agentsview and cass copy whole transcripts, tool output included, into their own database; claude-history caches lowercased text per file; Atuin keeps a contentless index for command output.

Until now sideby kept no conversation text: its caches hold counts, ids and paths (`memo-store.ts`).

## Decision

sideby keeps a History Index in `<state>/history/index.sqlite`, through `node:sqlite` (no new dependency), on by default.

- What it holds, per Session: Account, Family, Session id, record path, working directory, Project, Session Title and where it came from, branch, model, start and last activity time, message count, whether it is a Script Session and its parent, and the text of the prompts the user typed and of the model's replies. Never tool calls or tool output, injected context (environment blocks, instruction files, system reminders), reasoning, or anything from a credential file.
- Per record file it keeps the size, mtime and inode it was read at, so only changed files are read again. Building runs in the background in batches, newest files first, and what is built is searchable at once; an interrupted build continues where it stopped.
- Search uses an FTS5 table with the `trigram` tokenizer, so a word inside longer text matches in any language, Chinese included. Words of one or two characters, which a trigram cannot hold, are matched with `LIKE` over the same text. Every word must match. The same rules apply whether the index is complete or still building.
- Tool output is searched only when the user asks for it (`--tools`, "Also search tool output"): sideby reads the record files of the Sessions in scope at that moment and keeps nothing of them.
- The database and its folder are the user's, mode 600 and 700. Config `history.index: false` stops building it and searching it, and deletes it; the Panel's History page and `sideby history index --clear` delete it at any time. Deleting it loses nothing: it is rebuilt from the Hosts' own files.
- sideby writes nothing into a Host account directory for it, and reads the Host files only to build it.

## Consequences

The History page opens and searches in well under a second after the first build, and finds a Session by what the user asked even when it never had a title.

sideby now keeps a second copy of the user's prompts and the model's replies, readable by the user's own account only. A user who does not want that turns the index off; Session History then lists Sessions from the Hosts' own titles and folders and searches only those.

`node:sqlite` is marked experimental in Node 22. sideby turns off its experimental warning for this module only; if the index file cannot be opened (a damaged file, a folder sideby cannot write), Session History uses an in-memory index for that run, searching titles and folders only, and shows the reason; if this Node has no `node:sqlite` (or no FTS5), Session History explains why and asks the user to upgrade Node.

## Amendment 2026-10-20: plugin Families and grouping

A plugin Family can give its own session reader (`FamilyDef.history`), and a Plugin can sort Projects into categories for grouping; see ADR-0044. A plugin reader's prompts and replies go into the same index under the same rules.
