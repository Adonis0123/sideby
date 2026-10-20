# Live Sessions: which session each account runs, handing one to another AI, and telling it something

For "which session is cc002 running", "cc002 现在在干嘛", "cc002 在哪个任务里", "哪个会话在等我", "copy cc002's session id for another AI", "复制 cc002 的会话给另一个 AI", "告诉 cc002 ……", "把这张截图发给 cc003", "send this to the codex session".

## See them

Run `sideby sessions --json` (or `sideby sessions <account|family> --json` for one account or host). Each entry of `sessions` is one running session:

- `label` is the Session Label, `<account> · <the host's own title> · <first 8 of the id>`, as in `cc002 · knip cleanup · 61230c3d`. Use it when you name a session to the user; sideby never invents the title.
- `status`: `needs-you` (it waits for a permission or an answer: tell the user first), `busy`, `idle`, or `unknown` where the host does not say. Sessions that need the user come first.
- `cwd`, `startedAt`, `updatedAt`, `transcript` (the path of its record), `resumeCommand`.
- `guessed: true` means sideby could not tie a running Codex or pi program to a session and shows that account's newest session instead. Say "probably" when you report it.

- `run` (only some sessions): the Run a local orchestrator such as the `agent-dispatch` skill gave this session, `{ title, laneTitle, role, board, url, others }`. For "cc002 在哪个任务里" / "which run is cc002 working on", answer with `title` (and `laneTitle`, the part it does; `others` lists further Runs it also works for) and give `board`, the Run Board's file on this computer; to open it for the user ("打开它的任务看板", "open cc002's run report"), run `sideby sessions open-run <account|session-id> --json` yourself: it opens the board with the default program, as the chip on the Panel's Sessions page does, and returns `{ opened, board, sessionId, label }`. It exits 1 with code `no-run` when the session is in no Run (or its board file is gone: ask the coordinating AI to show the board again), `board-changed` when the file changed while sideby checked it, and `several-sessions` like `copy` below. No `run` means no orchestrator claims the session, not an error.

`problems` lists accounts sideby could not read and what to do; the rest of the list is still right. An empty list means nothing is running: the user starts an account with `sideby run <account>`.

It is read-only: sideby reads the hosts' own session files and the running programs, never a credential, and never changes or ends a session.

## Copy one for another AI

Run `sideby sessions copy <account|session-id> --json` yourself. It puts the text on the clipboard and returns it in `text`:

- default `--as reference`: the Session Reference, one sentence such as "cc002's session 61230c3d (knip cleanup), working directory /work/repo, record at …. Read its record for the context." It points at the record by path and never copies the conversation itself. It follows the user's locale; `--lang zh` or `--lang en` chooses.
- `--as id`: the bare session id. `--as resume`: the command that resumes it (`sideby resume claude -- --resume <id>`), which starts the account that holds it.

When `copied` is false there is no clipboard program (pbcopy on macOS, wl-copy or xclip on Linux): give the user `text` to paste. When an account runs several sessions, the command exits 1 with code `several-sessions` and lists them: ask which one, or pick by what the user said, then run it again with that id.

When you are the other AI and get a Session Reference, read the record it names for the context; do not copy files between accounts.

## Tell a session something (Messages)

When the user asks you to tell another session something ("告诉 cc002 测试过了，可以发版", "send this screenshot to cc003"), run `sideby send <account|session> "<text>" --json` yourself; add `--image <path>` once per screenshot (PNG, JPEG, GIF or WebP, up to 20 MB); a screenshot alone, without text, is fine. `<account>` works when that account runs one session now; otherwise use the session id or its first 8 characters from `sideby sessions --json`. Write the text the way the user meant it, addressed to the other AI; do not paste your whole conversation, point at files by path.

sideby keeps the Message first as a file (`message.file`, mode 600, screenshots copied next to it), then:

- `status: "delivered"`: a Claude Code session got it at once through Claude Code's own messages between sessions. Its first line names the sender (the session you run in, found by sideby) or "the user via sideby", then the text, then one `Screenshot: <path>` line per screenshot. Tell the user it was delivered.
- `status: "paste-needed"`: Codex, Grok Build and pi have no channel sideby can deliver to yet (or the Claude session could not be reached; `note` says why in plain words). `pasteText` is one line telling the other AI to read the Message file; `copied: true` means it is on the clipboard. Tell the user to paste it into the tab of `message.to`.
- A `note` saying the session "holds messages from other sessions": that Claude session runs in bypass permission mode, so it waits for the user to approve the message in its terminal and drops it after about 5 minutes. Tell the user, and offer `sideby messages inbound accept` (below).

`sideby messages --json` lists what was sent, newest first; `status: "read"` means the Message id shows in the target's record (it took it in). `--to <account|session>` narrows it.

When you are the receiving AI and see "sideby message <id> from …" or "Read the message sideby kept for you at <file>", read that file and the screenshots it lists, then act on it as a request from the user.

### Let Claude sessions show messages at once

Run `sideby messages inbound --json`: per Claude settings file (accounts linked to one file share it), `state` is `accept`, `hold`, `refuse`, `default` (not set: a bypass-mode session holds messages), `other`, `missing` or `blocked`. `sideby messages inbound accept --json` shows the change (exit 10, `applied: false`): only the top-level `crossSessionInbound` becomes `"accept"` where it is not set or `hold`. Show it to the user; after they agree, run it again with `--yes`. A `refuse` or any other value the user set is left alone and named with the reason (if nothing changes, it exits 1 and says so): tell them, and change it only if they ask. `sideby messages inbound undo --yes` puts back what sideby replaced. Running sessions pick it up when restarted. `sideby doctor` warns (`messages.inbound-held`) for an account that starts in bypass mode while it holds messages.

## Tab titles

With config `accountTitle` on (`references/badge.md`), the title of a tab sideby started grows from `[cc002]` to `[cc002 · knip cleanup · 61230c3d]` once the session shows up, and follows a rename within about 10 seconds.
