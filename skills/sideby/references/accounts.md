# Create accounts and short commands

## Create an account

Check the name first: `^[a-z0-9][a-z0-9-]{0,31}$`, and not already taken (`sideby list --json`).

```sh
sideby new claude work               # subscription account: ~/.claude-work
sideby new claude deepseek --api     # API account: ~/.claude-deepseek with a proxy.env template (mode 600)
sideby new claude 008 --alias cc008  # also adds the short command cc008 to config aliases
```

Only pass `--alias` when the user wants a short command; follow their existing pattern (`cc001`…`cc007` for `claude:001`…`claude:007` suggests `cc008`). An invalid, reserved or taken alias is refused before anything is created (error `code: "alias-invalid"`). If `alias.added` is false in `--json`, the account exists but the alias is missing: tell the user the message, do not edit the config by hand.

Then:

- **Subscription account**: tell the user to run `sideby login claude:work` in their own terminal (for pi, `sideby login pi:<name>` starts pi; then they type `/login`). Do not run it for them.
- **API account**: tell the user to open the `proxy.env` path printed by `new` in their editor and fill in the values. Do not read or write it yourself. It then shows `login: "not-needed"`.
- **pi**: a `proxy.env` in a pi account only loads provider keys; the account stays a subscription account and still needs `/login`.
- Afterwards: `sideby doctor <ref> --json` to confirm the new account is healthy, then the user starts it with `sideby run <ref>`.

## Short commands (aliases)

For an account that already exists: `sideby alias add <short> <ref> --json`.

To start one account with fixed Host arguments, such as another model, put them after `--`: `sideby alias add pi-kimi pi:main --json -- --model kimi-coding/k3`. It is the same account (same login, same sessions), not a new one; do not create an account per model. Only `sideby run <short>` adds the arguments.

- `status: "exists"` means it was already there.
- A refusal names the next step (`sideby alias rm <short>` first).
- Entry points that need environment variables are not aliases: leave them in the user's shell rc.
- Do not edit `aliases` in the config by hand.
