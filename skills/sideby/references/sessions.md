# Live Sessions: which session each account runs, and handing one to another AI

For "which session is cc002 running", "cc002 现在在干嘛", "哪个会话在等我", "copy cc002's session id for another AI", "复制 cc002 的会话给另一个 AI".

## See them

Run `sideby sessions --json` (or `sideby sessions <account|family> --json` for one account or host). Each entry of `sessions` is one running session:

- `label` is the Session Label, `<account> · <the host's own title> · <first 8 of the id>`, as in `cc002 · knip cleanup · 61230c3d`. Use it when you name a session to the user; sideby never invents the title.
- `status`: `needs-you` (it waits for a permission or an answer: tell the user first), `busy`, `idle`, or `unknown` where the host does not say. Sessions that need the user come first.
- `cwd`, `startedAt`, `updatedAt`, `transcript` (the path of its record), `resumeCommand`.
- `guessed: true` means sideby could not tie a running Codex or pi program to a session and shows that account's newest session instead. Say "probably" when you report it.

`problems` lists accounts sideby could not read and what to do; the rest of the list is still right. An empty list means nothing is running: the user starts an account with `sideby run <account>`.

It is read-only: sideby reads the hosts' own session files and the running programs, never a credential, and never changes or ends a session.

## Copy one for another AI

Run `sideby sessions copy <account|session-id> --json` yourself. It puts the text on the clipboard and returns it in `text`:

- default `--as reference`: the Session Reference, one sentence such as "cc002's session 61230c3d (knip cleanup), working directory /work/repo, record at …. Read its record for the context." It points at the record by path and never copies the conversation itself. It follows the user's locale; `--lang zh` or `--lang en` chooses.
- `--as id`: the bare session id. `--as resume`: the command that resumes it (`sideby resume claude -- --resume <id>`), which starts the account that holds it.

When `copied` is false there is no clipboard program (pbcopy on macOS, wl-copy or xclip on Linux): give the user `text` to paste. When an account runs several sessions, the command exits 1 with code `several-sessions` and lists them: ask which one, or pick by what the user said, then run it again with that id.

When you are the other AI and get a Session Reference, read the record it names for the context; do not copy files between accounts.

## Tab titles

With config `accountTitle` on (`references/badge.md`), the title of a tab sideby started grows from `[cc002]` to `[cc002 · knip cleanup · 61230c3d]` once the session shows up, and follows a rename within about 10 seconds.
