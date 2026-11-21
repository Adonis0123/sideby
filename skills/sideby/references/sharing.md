# What accounts share

Answer from `sideby families [family] --json`, not from memory: it covers plugin families and the user's own `extraSharedItems`. Each `shared[]` entry has `path`, `mode` and `meaning`, a sentence you can quote.

- **Shared** (one copy, from the Main Account): `link` items. A change in the Main Account reaches every account at once.
- **Kept equal**: `copy` and `link-or-copy` items, a subscription account's `local-if-api` item, and the one key of a `json-key` item (Claude's MCP servers in `.claude.json`). `sideby doctor --fix` brings them back in line after the Main Account changes.
- **The account's own**: `local` items (copied once, then theirs), an API account's `local-if-api` item (it starts as a copy, so its endpoint and model never change the Main Account's), and `info` items such as `auth.json` (sign-in; never shared, never read).
- **Not in the list at all**: sessions, history and everything else in the account directory belong to that account. That is why two accounts can run at the same time. Claude's project memory (auto memory) is the account's own too, unless the user turns on shared memory (below).

An item the Main Account does not have is skipped: nothing to share, no Finding.

To share one more file or directory (a `scripts` folder, a status line script), add it to config `extraSharedItems`, for example `{ "extraSharedItems": { "claude": [{ "path": "scripts", "mode": "link" }] } }` in `~/.config/sideby/config.json`, then run `sideby doctor claude --fix` to link it into every account. Keep the user's other config keys; never add a path with `..` or an absolute path.

Two answers people often need:

- "Will my new account have my MCP servers?" Claude Code: yes, `new` copies the `mcpServers` entry and `doctor --fix` keeps it equal later; OAuth servers (GitHub, Figma) still need each account to authorize once. Codex: yes for subscription accounts, through the linked `config.toml`.
- "Will it see my old sessions?" No. Sessions stay in the account that made them; `sideby run <old-account> -- --resume` reopens them there.

## Shared project memory (Claude)

Claude Code keeps what it learns about a project (auto memory, `projects/<project>/memory/` with a `MEMORY.md` index) per account, so a second account starts a project without it. Shared Project Memory (spec §3.44, ADR-0081), off by default, makes every Claude account sideby starts use the main account's memory of that project.

```sh
sideby memory --json                     # { on, main, folded[] }; while off no account folder is read
sideby memory --dir ~/code/app --json    # while on: dir.memory (where it goes), projects[] with pending per account
sideby memory on --json                  # exit 10: the change; run again with --yes after the user agrees
sideby doctor claude --json              # memory.unfolded per account: memory written outside sideby
sideby doctor claude --fix --json        # after the user agrees: moves it into the main account
sideby memory off --yes --json           # stops passing the folder; memory in the main account stays
```

Before turning it on, tell the user in one line each:
- Interactive Claude sessions sideby starts in an account other than the main one (`sideby run`, short commands, pick commands, `sideby next`, Auto Handoff, AI Tasks) get the main account's folder for the project (`~/.claude/projects/<project>/memory`) as `autoMemoryDirectory` in sideby's own `--settings` file. Nothing is linked: Claude Code refuses memory writes through a link.
- The project is the git repository's main checkout (worktrees and subfolders share it), elsewhere the folder itself, named the way Claude Code names it. Where sideby cannot tell (a submodule, a separate git folder), the session keeps the account's own memory and the launch says so.
- Sessions started with plain `claude`, by an app that picks the account itself, a headless run (`-p`) and a session given its own `--settings` keep writing the account's own memory. `sideby doctor --fix` moves that into the main account later: a project the main account lacks moves whole, a file that differs is kept as `<name>.<account>.md`, `MEMORY.md` gets the lines it lacks, and the moved files go to the trash in one folder (a file that changes meanwhile waits for the next fix). A project where a session of that account is running waits until it ends.
- Two accounts writing the same project at the same moment can overwrite `MEMORY.md`; Doctor's `memory.index` warning names the project. A `memory.name-mismatch` warning means Claude Code changed how it names project folders: suggest `sideby memory off --yes` and `sideby update`.
- In the Panel it is **Settings › Shared memory**.

Never read or quote the memory files' text to answer: `sideby memory --json` gives names and counts only.
