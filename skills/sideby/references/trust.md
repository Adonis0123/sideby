# Folder trust: stop Claude asking again in another account

Carried trust (spec §3.43, ADR-0078). Claude Code asks "Is this a project you created or one you trust?" (the *Quick safety check* on the *Accessing workspace* screen) in every account that has not trusted a folder yet, and keeps the answer per account in that account's `.claude.json`. When sideby starts another account in the same folder (`sideby run`, a short command, a pick command, `sideby next`, an Auto Handoff hop, an AI Task), that account asks again, and the question's default, "No, exit", ends the session when the user presses Enter: an Auto Handoff stops there. Claude Code has no launch option or setting that answers it.

With config `claude.carryTrust` on, before sideby starts an interactive Claude session, an account that does not trust the folder gets the trust another of the user's Claude accounts already gave it: sideby copies that one mark into the account's `.claude.json`. It only reuses trust the user gave; a folder no account trusted still asks.

## See it, turn it on or off

```sh
sideby trust --json                       # { on, carried[] }; while off nothing of .claude.json is read
sideby trust --dir ~/code/app --json      # while on: root, and each account's trusts (booleans), carryFrom
sideby trust on --json                    # exit 10: the change; run again with --yes after the user agrees
sideby trust off --yes --json             # keeps what was already copied
sideby trust undo --json                  # exit 10: what would be taken back; --yes takes it back
```

Before turning it on, tell the user in one line each:
- It copies only trust they already gave in another Claude account, and only the same folder key: in a git repository the main checkout's trust (a linked worktree uses it), elsewhere the folder's or a parent folder's (never the home folder or `/`). Where sideby cannot tell from the files (a submodule, a separate git folder), it copies nothing, and it never runs git in the folder.
- It writes one field, `projects["<folder>"].hasTrustDialogAccepted`, into the account's `.claude.json` (for the main account that file is `~/.claude.json`), and prints one line each time, such as `sideby: claude:work now trusts ~/code/app, as claude:main does (claude.carryTrust; undo: sideby trust undo)`.
- Sessions started with plain `claude`, a headless run (`-p`) and `sideby login` copy nothing.
- Turning it off does not remove what was copied; `sideby trust undo` does, each only while it still holds what sideby wrote.
- In the Panel it is **Settings › Folder trust**.

Never show other entries of a `.claude.json`: it holds the login. `sideby trust --json` gives only booleans for the folder asked about.

## When a copy was skipped

A launch line that starts `sideby: claude:work was not given claude:main's trust of …` names why (the file is a link, is not valid JSON, changed while sideby wrote it, or the account has not been started yet, so it has no `.claude.json`). Claude Code then asks as before. Read the reason to the user; a file that changed is usually fine on the next start.
