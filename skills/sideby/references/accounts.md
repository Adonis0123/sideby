# Create accounts and short commands

## Create an account

Check the name first: `^[a-z0-9][a-z0-9-]{0,31}$`, and not already taken (`sideby list --json`).

```sh
sideby new claude work               # subscription account: ~/.claude-work
sideby new claude deepseek --api     # API account: ~/.claude-deepseek with a proxy.env template (mode 600)
sideby new claude --next --api --vendor ds   # API account 009 with the short command cc-ds (cc001… exist)
sideby new claude 008 --alias cc008  # also adds the short command cc008 to config aliases
```

Only pass `--alias` when the user wants a short command. To continue their numbering (`cc001`…`cc007` for `claude:001`…`claude:007`), use `sideby new claude --next --json` instead of a name: it picks `008` and `cc008` the same way the panel does (see `setup.md`). An invalid, reserved or taken alias is refused before anything is created (error `code: "alias-invalid"`). If `alias.added` is false in `--json`, the account exists but the alias is missing: tell the user the message, do not edit the config by hand.

### API accounts: name the short command after the vendor

An API account's short command says which vendor it calls (`cc-ds`, `cc-kimi`), not a number: the user tells them apart by vendor, and the name stays right when the model changes. The account name stays numbered (`claude:009`).

- Find the Vendor: from the user's words or the docs link they gave; ask only when neither says.
- Pass it as `--vendor <slug>` with `--api`. Use these slugs: `ds` (DeepSeek), `glm` (Zhipu GLM / Z.ai), `kimi` (Moonshot Kimi), `qwen` (Alibaba Qwen / Bailian), `api` (the Host's own official API, such as Anthropic's for Claude Code), `relay` (a gateway or relay in front of several vendors). Another vendor: a short lowercase name the user would recognise (`minimax`, `doubao`).
- Name by vendor, not model: `cc-kimi`, not `cc-k3`. Several models of one vendor are one account with extra short commands that pass `--model` (below, `pi-kimi`), not more accounts.
- `sideby new` builds the short command from the prefix of the user's numbered ones (`cc` from `cc001`) and the slug. Read `suggestion`: `alias` is what it added; `aliasProblem` means it was taken or invalid (a second DeepSeek account: offer `cc-ds2` with `sideby alias add`); `aliasHint` means none was added (no `--vendor`, or no prefix to build from) and says how to add one. Never invent a prefix.

Then:

- **Subscription account**: tell the user to run `sideby login claude:work` in their own terminal (for pi, `sideby login pi:<name>` starts pi; then they type `/login`). Do not run it for them.
- **API account**: tell the user to run `sideby key <ref>` in their own terminal (or click **Enter key** in the Panel), which writes the key without showing it, or to open the `proxy.env` path printed by `new` in their editor. Never ask for the key or read the file yourself. It then shows `login: "not-needed"`.
- **pi**: a `proxy.env` in a pi account only loads provider keys; the account stays a subscription account and still needs `/login`.
- **agy** (Antigravity CLI): main account only. `sideby new agy …` (also `--api`) fails with `code: "family-main-only"` and writes nothing: agy keeps one Google sign-in per computer and cannot move its config. Do not work around it by changing `HOME`; tell the user to use `agy:main`.
- Afterwards: `sideby doctor <ref> --json` to confirm the new account is healthy, then the user starts it with `sideby run <ref>`.

## Switch an account to another login

Two directories signed in as the same login share one quota (`sameLogin` in `sideby list --json`). To give one its own login:

1. Say which directory is signed in as which email (`identity.email`), and which one they want to change.
2. Give the user one line to run in their own terminal: `sideby login <ref>` (Claude Code: `! sideby login <ref>`), or tell them to click **Use another account** on that directory in the Panel. It cannot be done inside the tool: Codex has no `/login`, and its `/logout` is blocked while a task runs.
3. Tell them the browser usually signs in as the login it already has: sign out of it there first, or open the sign-in link in a private window. sideby signs nothing out first, so giving up keeps the old login.
4. sideby prints the result at the end. Afterwards check `sideby list --json`: the account's `sameLogin` is gone and its `identity.email` is the new one. If it is still the same login, repeat step 3.

A running session of that account keeps its old login until it is restarted.

## Sign in again after an expired login

An account with `loginProblem.kind: "expired"` in `sideby list --json` (an Expired Login) still has its login file, but its Host said the login expired. sideby never picks it for `sideby next`, Auto Handoff or a pick command until it works again.

1. Name the account and when it expired (`loginProblem.since`).
2. Give the user one line to run in their own terminal: `sideby login <ref>` (Claude Code: `! sideby login <ref>`), or tell them to click **Sign in again** on that account in the Panel (it opens the same command in their terminal).
3. When the sign-in ends well and quota checks are on, sideby asks that account's quota once; a good answer clears the state and sideby prints `<ref> is signed in again`. Otherwise it clears after the account's next successful session or quota check, and the Panel shows "Sign-in finished, waiting for confirmation" meanwhile.
4. Check `sideby list --json` afterwards: `loginProblem` is gone.

## Short commands (aliases)

For an account that already exists: `sideby alias add <short> <ref> --json`.

To start one account with fixed Host arguments, such as another model, put them after `--`: `sideby alias add pi-kimi pi:main --json -- --model kimi-coding/k3`. It is the same account (same login, same sessions), not a new one; do not create an account per model. Only `sideby run <short>` adds the arguments.

- `status: "exists"` means it was already there.
- A refusal names the next step (`sideby alias rm <short>` first).
- To give a short command another name ("把 cc-relay 改成 relay"): `sideby alias rename <old> <new> --json`; it keeps the account and its arguments. In the Panel it is the account menu, "Set short command…".
- Changes take effect in terminals that are already open: a shell that loads `sideby shell-init` reloads its short commands at its next prompt, so tell the user to press Enter once and type the new name. Only a terminal started before sideby had this needs to be reopened.
- Entry points that need environment variables are not aliases: leave them in the user's shell rc.
- Do not edit `aliases` in the config by hand.

## Pick commands (start the account with the most room)

A pick command is a short command bound to a tool (Family), not to one account: each run starts the account of that tool `sideby next` would pick, the one furthest from its limits, and prints which (`cc → claude:work (5h 12% used, the most room)`). When no account of the tool has quota data yet it starts the main account and says so. When every account is past its Takeover Limit (by default 85% of a 5-hour window, 95% of a weekly one) it still starts the one with the most left under 100% and says so (`cc → claude:008 (every claude account is past its limit, 85% of a 5-hour window or 95% of a weekly one; this one has the most left, 5h 88% used)`); only when every account has a window used up or is signed out does it start nothing and say which comes back first. API accounts are never picked.

- Add: `sideby alias add <short> --pick <family> --json` exits 10 with `status: "confirm"` and writes nothing; tell the user what it adds, then run it again with `--yes`. Then make sure new terminals load it: `sideby shell-init setup --json` (see `setup.md` step 7). Offer `cc` for Claude, `cx` for Codex, `gk` for Grok, or the letters the user's numbered short commands share (`cc001`, `cc008` → `cc`); pi gets none, since `pi` is the tool itself. `sideby new` offers one (`pickCommandOffer`) when a tool gets its second subscription account.
- With `shadows` in that answer, the name hides a command on PATH (for example `/usr/bin/cc`, the C compiler on macOS). Tell the user that typing the name would start the tool instead, and run again with `--yes` only after they agree to that, or pick another name.
- `sideby alias list --json` lists both kinds (`kind: "pick"` or `"account"`); `sideby alias rm <short>` removes either. Pick commands and short commands share one set of names.
- The user types the name in a new terminal; you never run it (it starts an interactive session). A shell alias of the same name in their rc (`alias cc=…`) still wins: when the name does not start sideby, tell them to remove that alias.
- Do not edit `pickCommands` in the config by hand.
