# Create accounts and short commands

## Create an account

Check the name first: `^[a-z0-9][a-z0-9-]{0,31}$`, and not already taken (`sideby list --json`).

```sh
sideby new claude work               # subscription account: ~/.claude-work
sideby new claude deepseek --api     # API account: ~/.claude-deepseek with a proxy.env template (mode 600)
sideby new claude 008 --alias cc008  # also adds the short command cc008 to config aliases
```

Only pass `--alias` when the user wants a short command. To continue their numbering (`cc001`…`cc007` for `claude:001`…`claude:007`), use `sideby new claude --next --json` instead of a name: it picks `008` and `cc008` the same way the panel does (see `setup.md`). An invalid, reserved or taken alias is refused before anything is created (error `code: "alias-invalid"`). If `alias.added` is false in `--json`, the account exists but the alias is missing: tell the user the message, do not edit the config by hand.

Then:

- **Subscription account**: tell the user to run `sideby login claude:work` in their own terminal (for pi, `sideby login pi:<name>` starts pi; then they type `/login`). Do not run it for them.
- **API account**: tell the user to run `sideby key <ref>` in their own terminal (or click **Enter key** in the Panel), which writes the key without showing it, or to open the `proxy.env` path printed by `new` in their editor. Never ask for the key or read the file yourself. It then shows `login: "not-needed"`.
- **pi**: a `proxy.env` in a pi account only loads provider keys; the account stays a subscription account and still needs `/login`.
- Afterwards: `sideby doctor <ref> --json` to confirm the new account is healthy, then the user starts it with `sideby run <ref>`.

## Switch an account to another login

Two directories signed in as the same login share one quota (`sameLogin` in `sideby list --json`). To give one its own login:

1. Say which directory is signed in as which email (`identity.email`), and which one they want to change.
2. Give the user one line to run in their own terminal: `sideby login <ref>` (Claude Code: `! sideby login <ref>`), or tell them to click **Use another account** on that directory in the Panel. It cannot be done inside the tool: Codex has no `/login`, and its `/logout` is blocked while a task runs.
3. Tell them the browser usually signs in as the login it already has: sign out of it there first, or open the sign-in link in a private window. sideby signs nothing out first, so giving up keeps the old login.
4. sideby prints the result at the end. Afterwards check `sideby list --json`: the account's `sameLogin` is gone and its `identity.email` is the new one. If it is still the same login, repeat step 3.

A running session of that account keeps its old login until it is restarted.

## Short commands (aliases)

For an account that already exists: `sideby alias add <short> <ref> --json`.

To start one account with fixed Host arguments, such as another model, put them after `--`: `sideby alias add pi-kimi pi:main --json -- --model kimi-coding/k3`. It is the same account (same login, same sessions), not a new one; do not create an account per model. Only `sideby run <short>` adds the arguments.

- `status: "exists"` means it was already there.
- A refusal names the next step (`sideby alias rm <short>` first).
- Entry points that need environment variables are not aliases: leave them in the user's shell rc.
- Do not edit `aliases` in the config by hand.

## Pick commands (start the account with the most room)

A pick command is a short command bound to a tool (Family), not to one account: each run starts the account of that tool `sideby next` would pick, the one with the lowest Quota Pressure, and prints which (`cc → claude:work (12% used, the most room)`). When no account of the tool has quota data yet it starts the main account and says so; when every account is full or signed out it starts nothing and says which comes back first. API accounts are never picked.

- Add: `sideby alias add <short> --pick <family> --json` exits 10 with `status: "confirm"` and writes nothing; tell the user what it adds, then run it again with `--yes`. Then make sure new terminals load it: `sideby shell-init setup --json` (see `setup.md` step 7). Offer `cc` for Claude, `cx` for Codex, `gk` for Grok, or the letters the user's numbered short commands share (`cc001`, `cc008` → `cc`); pi gets none, since `pi` is the tool itself. `sideby new` offers one (`pickCommandOffer`) when a tool gets its second subscription account.
- With `shadows` in that answer, the name hides a command on PATH (for example `/usr/bin/cc`, the C compiler on macOS). Tell the user that typing the name would start the tool instead, and run again with `--yes` only after they agree to that, or pick another name.
- `sideby alias list --json` lists both kinds (`kind: "pick"` or `"account"`); `sideby alias rm <short>` removes either. Pick commands and short commands share one set of names.
- The user types the name in a new terminal; you never run it (it starts an interactive session). A shell alias of the same name in their rc (`alias cc=…`) still wins: when the name does not start sideby, tell them to remove that alias.
- Do not edit `pickCommands` in the config by hand.
