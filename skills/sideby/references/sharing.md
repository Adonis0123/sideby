# What accounts share

Answer from `sideby families [family] --json`, not from memory: it covers plugin families and the user's own `extraSharedItems`. Each `shared[]` entry has `path`, `mode` and `meaning`, a sentence you can quote.

- **Shared** (one copy, from the Main Account): `link` items. A change in the Main Account reaches every account at once.
- **Kept equal**: `copy` and `link-or-copy` items, a subscription account's `local-if-api` item, and the one key of a `json-key` item (Claude's MCP servers in `.claude.json`). `sideby doctor --fix` brings them back in line after the Main Account changes.
- **The account's own**: `local` items (copied once, then theirs), an API account's `local-if-api` item (it starts as a copy, so its endpoint and model never change the Main Account's), and `info` items such as `auth.json` (sign-in; never shared, never read).
- **Not in the list at all**: sessions, history and everything else in the account directory belong to that account. That is why two accounts can run at the same time.

An item the Main Account does not have is skipped: nothing to share, no Finding.

To share one more file or directory (a `scripts` folder, a status line script), add it to config `extraSharedItems`, for example `{ "extraSharedItems": { "claude": [{ "path": "scripts", "mode": "link" }] } }` in `~/.config/sideby/config.json`, then run `sideby doctor claude --fix` to link it into every account. Keep the user's other config keys; never add a path with `..` or an absolute path.

Two answers people often need:

- "Will my new account have my MCP servers?" Claude Code: yes, `new` copies the `mcpServers` entry and `doctor --fix` keeps it equal later; OAuth servers (GitHub, Figma) still need each account to authorize once. Codex: yes for subscription accounts, through the linked `config.toml`.
- "Will it see my old sessions?" No. Sessions stay in the account that made them; `sideby run <old-account> -- --resume` reopens them there.
