# ADR-0040: Deliver Messages through the Host's own channel

Status: accepted
Date: 2026-10-20

## Context

Step 2 of spec §3.32 lets one Session tell another something: text, and screenshots. Users run several Accounts at once and today copy text between terminal tabs by hand. A Message must never be lost, must reach a Session that is busy, and must not need a model call, a credential or a copy of the Session.

Claude Code 2.1.304 (tried on 2026-10-20) runs a cross-session channel of its own ([docs](https://code.claude.com/docs/en/cross-session-messaging)). Each running session names a Unix socket in its `<dir>/sessions/<pid>.json` (`messagingSocketPath`, in `cc-socks` inside the system temp folder, mode 700, the socket mode 600). One JSON line `{"type":"user","message":{"role":"user","content":"<text>"}}` written to it and closed reached a session of another config directory, which showed "Another Claude session sent a message" and answered. No token was sent; the docs call the auth line optional on macOS and Linux. A session in bypass permission mode holds such messages for approval for about five minutes, then drops them, unless its settings have `crossSessionInbound: "accept"` (`accept`, `hold` or `refuse`). Whether a message without a sender session is held the same way in bypass mode is UNVERIFIED.

`claude --resume <id> -p` against a live session starts a copy of it, so it cannot deliver. Codex, Grok Build and pi have no channel sideby can write to.

## Decision

Keep every Message first as a file in sideby's state folder, `<state>/messages/<target session id>/<time>-<id>.md` (mode 600, folders 700), with a small header and each screenshot copied next to it (PNG, JPEG, GIF or WebP by their first bytes, at most 20 MB). Each folder under `<state>/messages` is checked one at a time: a real folder of the user, not a link, not writable by others, and never named `.`, `..` or with a separator (a session id that is not a plain name becomes its hex). A screenshot is opened once without following a link, checked, and copied from that open file up to the limit, its type told again from the copied bytes, so a file swapped or grown meanwhile is not copied. Nothing is written when a screenshot is refused. A Message needs text, a screenshot, or both.

Deliver to a Claude Code session through its own socket, and only after these checks: the path comes from the session's own record, whose `sessionId` and `procStart` still match the running process; the socket sits in a folder named `cc-socks` right inside a system temp folder; that folder is a real folder of the current user that others cannot enter; the socket is a socket of the current user and not a link. Right before connecting, sideby reads the session record and the processes again, since screenshots may have been copied in between. After connecting and before writing, it checks that the socket and its folder are still the files it checked (device, inode and owner), so a swap after the check gets nothing. Node gives no way to ask a Unix socket for its peer's pid without a native module (macOS `LOCAL_PEERPID`, Linux `SO_PEERCRED`), so the peer itself is not compared. sideby connects with a 3 s timeout, writes one line and closes the connection once it is flushed, also when the peer keeps its end open. It sends no token and never opens the `<pid>.<hash>.key` files or reads `CLAUDE_CODE_MESSAGING_TOKEN`. The text starts `sideby message <id> from <sender>`, so the target knows who wrote and sideby can find it later, and lists each screenshot path so the target can read it.

Everywhere else (Codex, Grok Build, pi, a guessed session, an Account set to `refuse`, any failed check or connection) sideby hands the user one line to paste, "Read the message sideby kept for you at <file>", on the clipboard, and says why in plain words. Once the Message is kept, any failure before or during delivery (an unreadable settings file, a process that cannot be listed) ends the same way, never as an error.

A Message is `read` when its id shows in the last 256 KB of the target's transcript; only lines with the id are read, and the status lives in a receipt next to the Message, never in a Host file; a receipt is read only when every field has its type and its Message and screenshots are files of its own folder named after it, and an update is written where it was read. The sender is the Live Session among the command's parent processes.

When a Claude target holds messages (`hold`, or not `accept` while the session runs in bypass mode, from the transcript's last `permission-mode` record, else its arguments), the receipt says to approve it in that terminal within five minutes or run `sideby messages inbound accept`. That command writes only the top-level `crossSessionInbound: "accept"` of each Claude `settings.json` where it is not set or `hold`, and remembers whether the key was there and its exact old value, under the rules of `sideby remote-control off` (spec §3.22, ADR-0017): a preview first, `writeIfUnchanged`, every other key kept, a linked file written at its real target, no settings file created, and undo only while the key still holds what sideby wrote. A `refuse` the user chose, or any other value, is never changed: it is named with the reason and what to do, and a run that changes nothing says so and exits 1. Doctor warns, without a `--fix`, for an Account that starts in bypass mode while it holds messages, because the file may be shared with other Accounts.

## Consequences

A user or their AI can tell another Session something with one command, and the Message survives any failed delivery. Claude Code sessions get it at once; the others need one paste until their Hosts offer a channel (step 4). `accept` lets any of the user's own sessions on the machine put text into a bypass-mode session without a prompt; the preview says so, and it stays opt-in.

The Host-directory exceptions in AGENTS.md gain `crossSessionInbound` next to Remote Control, and the rule that sideby writes only to a Claude message socket that passes the checks above and never reads a messaging token.

Tests use fake Homes, fake processes and a socket server in the fake Home's temp folder, never a real session.
