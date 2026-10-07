# Diagnose and repair

## Diagnose

Start read-only:

```sh
sideby list --json        # accounts: ref, family, kind (subscription|api), dir, login, identity.email, model, hostInstalled, problems
sideby doctor --json      # findings: level ok|warn|fail, account, item, code, message, hint, fixable
sideby quota --json       # per account: quota windows (5h, 7d, usedPercent, resetsAt, observedAt) and 7-day tokens
sideby plugins --json     # loaded plugins (setting names only, never values) and load errors
```

Narrow with an account or family: `sideby doctor claude:work --json`, `sideby doctor codex --json`, `sideby quota work --json`. On an ambiguity error, use the full ref from the candidates listed.

Shared Items the Main Account does not have are skipped: no Finding, not counted in `shared`. A directory such as `~/.claude-code-router` that holds neither `proxy.env` nor any Shared Item is not listed as an account.

| Signal | Meaning | What to do |
|---|---|---|
| `fail` / `warn` with `fixable: true` | Safe repair exists | Offer `doctor --fix` (see Repair) |
| `fixable: false` with a `hint` | sideby will not touch it on purpose (real file where a link belongs, API account item) | Show the hint; the user decides |
| `warn` `link.other-target` | The link resolves, but not to the Main Account's item; often deliberate | Mention it; change nothing unless the user asks |
| `fail` `link.dangling` | The link points at nothing | Show the hint (`ls -l <path>`); the user decides how to repair it |
| `fail` `symlink-forbidden` without `fixable` | The Host needs a real file here, but the link points somewhere other than the Main Account | Show the hint; sideby will not replace a link it did not create |
| credential item, mode not 600 | `proxy.env`, `auth.json`, `.claude.json` readable by others | `--fix` resets the mode to 600 |
| `warn` `skill.outdated` (in `general`) | The installed sideby skill is for another sideby version | Tell the user to run `npx skills add Adonis0123/sideby -g` |
| name looks like a backup (`bak`, `backup`, `old`, `tmp`) | A stray directory was picked up as an account | Suggest adding its ref to `ignore` in `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json` |
| `login: "not-needed"` (`key` in `sideby list`) | API account; it authenticates with `proxy.env` | Nothing to do |
| `problems` on an account in `list --json` | A plugin failed while reading it (for example a settings file that is not valid JSON) | Show the message; the account itself still works |
| quota `unavailable` / `not-enabled` | Claude quota source is off | Offer `sideby quota setup claude` |
| quota `unavailable` / `no-session` | No session since the source was enabled | Ask the user to start one session with that account |
| quota `unavailable` / `no-source` | Grok, pi: the Host has no public source | Nothing to fix |
| quota `unavailable` / `api-account` | API accounts have no quota | Nothing to fix |
| quota `unavailable` / `unrecognized` | Host changed its file format | Report it; suggest filing an issue with the Host version |
| host not installed | Accounts exist but the CLI is missing | Point to the Host's install docs; do not install it unasked |

Quota is only as fresh as each account's last session; `observedAt` says when it was recorded. A window whose `resetsAt` has passed has reset.

## Repair

1. Run `sideby doctor [ref] --json` and show the user every finding you plan to fix, grouped by account.
2. After the user agrees, run `sideby doctor [ref] --fix`, then `sideby doctor [ref] --json` again and report what is still open.
3. `--force` is only for `json-key` items (for example `.claude.json#mcpServers`) when a fix would remove entries the account already has. Never add `--force` without telling the user exactly which entries would disappear.

`--fix` never replaces a real file with a link, never re-points an existing symlink (wrong or dangling links are only reported), never writes through a link into the Main Account, and never changes credential contents. Findings it skips need a human decision; explain the hint, do not work around it with `rm` or `ln`.

`doctor` exits 1 only when a `fail` finding is left; warnings alone exit 0.
