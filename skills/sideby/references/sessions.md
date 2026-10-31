# Sessions: which session each account runs, finding one from before, handing one to another AI, and telling it something

For "which session is cc002 running", "cc002 现在在干嘛", "cc002 在哪个任务里", "哪个会话在等我", "copy cc002's session id for another AI", "复制 cc002 的会话给另一个 AI", "告诉 cc002 ……", "把这张截图发给 cc003", "send this to the codex session"; for past sessions, "find a session I had before", "找一下我上周改登录页的那个会话", "sideby 项目最近的会话".

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

When the user asks you to tell another session something ("告诉 cc002 测试过了，可以发版", "send this screenshot to cc003"), run `sideby send <account|session> "<text>" --json` yourself; add `--image <path>` once per screenshot (PNG, JPEG, GIF or WebP, up to 20 MB); a screenshot alone, without text, is fine. `<account>` works when that account runs one session now; otherwise use the session id or its first 8 characters from `sideby sessions --json`. Use `sideby send` also when Claude Code's own `ListAgents` / `SendMessage` do not list the session: they see only sessions of the same account, `sideby send` reaches every account. A session id recorded before an Auto Handoff (in a Run ledger or a Brief) still works: sideby follows the handoff to the session that carries the task now and says so (`handedOverFrom` in `--json`). Never guess a recipient by its folder or repository name; when you cannot tell which session it is, list `sideby sessions --json` and ask. Write the text the way the user meant it, addressed to the other AI; do not paste your whole conversation, point at files by path.

sideby keeps the Message first as a file (`message.file`, mode 600, screenshots copied next to it), then:

- `status: "delivered"`: a Claude Code session got it at once through Claude Code's own messages between sessions. Its first line names the sender (the session you run in, found by sideby) or "the user via sideby", then the text, then one `Screenshot: <path>` line per screenshot, and, when sideby identified the sending session exactly, a last line `Reply: sideby send <sender session id> "<text>"` (also at the end of the Message file). Tell the user it was delivered.
- `status: "delivered"` for Codex means Codex queued it (`codex queue`, Codex 0.163 or later): the session reads it when its current turn ends, or within about 10 s when idle. `status: "paste-needed"`: Grok Build and pi have no channel sideby can deliver to yet (or the Claude session could not be reached; `note` says why in plain words). `pasteText` is one line telling the other AI to read the Message file; `copied: true` means it is on the clipboard. Tell the user to paste it into the tab of `message.to`.
- `status: "unknown"` (the user sees **Not confirmed** / 未确认送达): sideby handed it over but could not tell whether it arrived (`codex queue` started and did not finish within 20 s, or the Claude socket took the line but never confirmed it); `note` says why, and that the session has ended when it has. It may still show up, so `copied` is false and you must not paste or send it again right away: tell the user it is not confirmed and to look at that session first. `pasteText` is there for when it never shows up; say that pasting it too may deliver it twice. It turns to `read` once its id shows in the target's record, and never turns into anything else by itself.
- `needsApproval: true` (with a `note` saying the session "waits for your approval"): that Claude session holds Messages (`crossSessionInbound` is `hold`, or not set while it runs in bypass permission mode), so it waits for the user to approve the message in its terminal and drops it after about 5 minutes. Tell the user. If the target is a headless worker you or an orchestrator started (`claude -p`), the narrow fix is to start it with `--settings '{"crossSessionInbound":"accept"}'`, which applies to that one session only; for an interactive session the user cannot restart with a flag, offer `sideby messages inbound accept` (below), which changes the account's settings for every session.
- Delivery works on macOS, Linux and WSL 2: sideby accepts the socket under `$XDG_RUNTIME_DIR/cc-socks/` (Linux, WSL) and under the system temp folder's `cc-socks/` or per-user `cc-socks-<uid>/` (macOS). Native Windows has a named pipe sideby does not write to; those sessions get `paste-needed`.

`sideby messages --json` lists what was sent, newest first; `status: "read"` means the Message id shows in the target's record (it took it in). `needsApproval: true` stays until it is read; a held Message still unread after 6 minutes turns to `paste-needed`, because Claude Code dropped it. An `unknown` one stays `unknown` until its id shows (then `read`); the text table calls it `Not confirmed`. `--to <account|session>` narrows it.

When you are the receiving AI and see "sideby message <id> from …" or "Read the message sideby kept for you at <file>", read that file and the screenshots it lists, then act on it as a request from the user. To answer, run the `Reply:` line it ends with, putting your answer in place of `<text>` as one shell argument: wrap it in single quotes, and write each `'` inside it as `'\''` (for example `sideby send 61230c3d-… 'Done; it'\''s pushed'`). A Message without that line came from the user or from a sender sideby could only guess: answer the user instead.

To hear when another Claude Code session has finished before you tell it the next thing, sideby has nothing of its own: use Claude Code's own `SendMessage` with `notify_when_idle: true` (Claude Code's cross-session messaging, https://code.claude.com/docs/en/cross-session-messaging), which works from your main conversation for your Claude Code sessions on this machine (Claude Code 2.1.236 or later in both).

### Let Claude sessions show messages at once

Run `sideby messages inbound --json`: per Claude settings file (accounts linked to one file share it), `state` is `accept`, `hold`, `refuse`, `default` (not set: a bypass-mode session holds messages), `other`, `missing` or `blocked`. `sideby messages inbound accept --json` shows the change (exit 10, `applied: false`): only the top-level `crossSessionInbound` becomes `"accept"` where it is not set or `hold`. Show it to the user; after they agree, run it again with `--yes`. A `refuse` or any other value the user set is left alone and named with the reason (if nothing changes, it exits 1 and says so): tell them, and change it only if they ask. `sideby messages inbound undo --yes` puts back what sideby replaced. Running sessions pick it up when restarted. `sideby doctor` warns (`messages.inbound-held`) for an account that starts in bypass mode while it holds messages. In the Panel the same is **Receiving messages** at the bottom of the Sessions page (a banner at the top while an account holds messages), with a preview, **Receive directly** and **Undo**.

## Find a session from before (Session History)

For a session that is not running any more, in any account of any host, run `sideby history [<words>...] --json` yourself. Put what the user remembers as words ("改登录页的那个" becomes `登录页`); every word must match, in the title, project, branch, account, the user's prompts or the replies, and Chinese words or words of one or two characters work too. Quote words the user remembers together (`"fix login"`) to match them as one phrase. Narrow it with what they said:

- `--project <name|path>`: the Project, the git repository the session ran in (worktrees and subfolders fold into it); `sideby history projects --json` lists them with their counts. "sideby 项目最近的会话" is `sideby history --project sideby --json`; "这个项目" (the folder you are working in) is `--project .`.
- `--since today|7d|30d|all` ("上周" is `7d`), `--family <id>`, `--account <account>`, `--limit <n>` (default 30, at most 500); `total` counts every match, and `--offset <n>` gives the next page.
- `--group project|category|day|account|family|none` ("按日期列一下" is `--group day`) adds `groups` (each `key`, `label`, `sessions`) and a `group` on each session; it cannot be used with `--tools`. When one of the user's plugins sorts projects into categories, the result has `categories` (`label`, and `from`, the plugin), `sideby history projects --json` gives each project's `category`, and `--category <name>` keeps one ("客户 A 那组项目的会话"). Without such a plugin, `--category` fails and says to add one (docs/guide/plugins.md).
- `--scripts` also shows Script Sessions (started by a script, an SDK or another agent; hidden by default). `--tools` also reads the session files in scope for tool output (slower, keeps nothing): use it when nothing is found and the user remembers a command's output or an error message. Sessions found only there come last with `foundIn: "tools"`; `toolOutputMore: true` means a bigger `--limit` shows more of them.

Each entry of `sessions` has `title` (the Session Title: the user's own name, else the host's, else the first prompt), `projectName`, `branch`, `updatedAt`, `accountLabel`, `snippet` (where the words matched), `children` (subagent sessions folded into it), `live` (running now) and `cwdGone` (its folder was removed). Name a session to the user by its title, account and when it was last active; when several fit, show the top few and ask.

- To read it: `sideby history show <id> --json` (the id or its first 8 characters or more; add `--account <acct>` when the error says two accounts have that id) gives the newest 200 `messages`, oldest first; tool calls are one line each with the tool's name only. `before` in the result, passed as `--before <n>`, gives the ones before.
- To continue it where it was, hand the user its `continueCommand` as one line: it runs `cd <its folder>` and resumes the session in the account that holds it (`resumeCommand` alone when the folder is gone). Do not start it yourself.
- To give it to another AI, use its `reference`, the Session Reference (as in `sessions copy` above).

`index.state` is `building` while sideby's local search index (the History Index) is read for the first time: what is built already answers, and `progress` says how far it is; run it again for the rest. `sources` says how many sessions sideby read per account, with a `note` for an account it could not read (`reason: unsupported` means the tool comes from a plugin that gives no session reader: tell the user sideby cannot read that tool's past sessions until the plugin adds `history`); `problems` says what to do. `sideby history index --json` shows the index; `--clear` deletes it (it is rebuilt from the hosts' files). The index holds titles, projects, prompts and replies, never tool output, at mode 600 in sideby's state folder; config `history.index: false` turns it off and deletes it, and then only titles and folders are searched. It is read-only towards the hosts and never opens a credential file.

## Tab titles

With config `accountTitle` on (`references/badge.md`), the title of a tab sideby started grows from `[cc002]` to `[cc002 · knip cleanup · 61230c3d]` once the session shows up, and follows a rename within about 10 seconds.

## Inside Claude Code: the sideby mod

When sideby starts a Claude Code account (Claude Code 2.1.287 or later, not `-p`), it loads its own mod with `--plugin-dir`; nothing is written into the account. In that session:

- A dim line above the prompt shows this session's Session Label (`cc002 · knip cleanup · 61230c3d`), so the user can tell tabs apart.
- A Message sent with `sideby send` raises a toast ("Message from cc001 · …").
- `/sessions` opens a "Sessions" pane with every running session, refreshed every 5 seconds, each with "Copy for AI" (the Session Reference) and "Copy id". When the user asks to see all sessions while in Claude Code ("在这里看所有会话", "show my sessions in Claude Code"), tell them to type `/sessions`.

To turn it off ("关掉 sideby 的横带", "turn off the sideby mod"), run `sideby config set claudeMod false --json` yourself; sessions started after that load no mod. `sideby config set claudeMod true --json` turns it back on. When the line or `/sessions` is missing, check `claude --version` (2.1.287 or later) and that the session was started by sideby (`SIDEBY_ACCOUNT` is set in it).
