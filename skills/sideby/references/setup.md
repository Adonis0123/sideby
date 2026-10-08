# Install sideby and set up an account

For "install sideby", "set up another Claude account", "add cc008", "配置一个 cc00x". Do each step yourself unless it says **user**; give the user that step as exactly one line (in Claude Code: `! <command>`) and continue when they say it is done.

1. **Node and sideby.** `node --version` must be 22.18 or newer; otherwise tell the user to upgrade Node and stop. `sideby --version`; when it is missing, run `npm i -g sideby` (Claude quota and shell functions need the global install, not `npx`).
2. **This skill.** If it was not installed with `npx skills add Adonis0123/sideby -g`, install it that way so it stays current; `sideby doctor` warns when it is for another version.
3. **Hosts and accounts.** `sideby list --json`. `families[].installed: false` means that Host CLI is not on PATH: give the user its `installUrl` and stop; never install a Host unasked. No `<family>:main` in `accounts` means the Host has never run: ask the user to start it once (for example `claude`), because `new` builds on the Main Account.
4. **What it will share.** `sideby families <family> --json`, then tell the user in a sentence or two (see `sharing.md`): skills, hooks, rules and settings come from the Main Account; sign-in, sessions and history are the new account's own.
5. **Create.**
   - The user gave no name, or said "cc00x" / "the next one": `sideby new <family> --next --json`. It picks the next number (`008` after `001`…`007`) and, when existing short commands show a pattern (`cc007` for `claude:007`), adds the next one (`cc008`). Read `suggestion`: `aliasProblem` means that short command was taken and left out; tell the user.
   - The user gave a name: `sideby new <family> <name> --json`; a short command they named: add `--alias <short>`.
   - An API account (DeepSeek, a gateway, …): add `--api`.
   - A short command the user did not ask for and no pattern suggests: none. Do not invent a prefix.
6. **user: sign in or fill in the key.**
   - Subscription account: `sideby login <ref>`. It opens the Host's sign-in in their browser. For pi it starts pi; they type `/login`.
   - API account: they open the `proxy.env` path that `new` printed and fill in the values. Never read or write it, and never ask for the key in chat.
7. **Short command in new terminals.** If `~/.config/sideby/config.json` has no `shellInitFile`, and `~/.zshrc` (bash: `~/.bashrc`) has no line containing `sideby shell-init`, say so and append `eval "$(sideby shell-init zsh)"` (or `bash`). It takes effect in new terminals. Skip this when the user wanted no short command.
8. **Account badge.** Offer to show which account each session is (`[cc008]` in the status line or tab title); if they want it, follow `badge.md`.
9. **Verify.** `sideby doctor <ref> --json` should report no `fail`; fix only the new account with `sideby doctor <ref> --fix`. After the user signed in, `sideby list --json` shows `login: "logged-in"` for it.
10. **Optional, Claude Code:** for quota in `sideby quota` and the panel, follow `quota.md` (it needs the user's yes).

Finish with how to start it: the short command in a new terminal (`cc008`), or `sideby run <ref>`; and `sideby ui` to see every account's quota.

## When a step fails

| Result | Do |
|---|---|
| `new` exit 1, `code: "alias-invalid"` | Nothing was created. Pick another short command with the user, or leave `--alias` out. |
| `new` says the directory exists | The account is already there: `sideby list --json`, then continue from step 6. |
| `new` says the Main Account is missing | Step 3: the user starts the Host once. |
| `npm i -g` fails with `EACCES` | npm's global directory is not writable; tell the user to use a Node version manager (nvm, fnm) rather than `sudo`. |
| `doctor` reports `link.real-file` | The account already had its own file there; show the hint, do not move it without the user. |
