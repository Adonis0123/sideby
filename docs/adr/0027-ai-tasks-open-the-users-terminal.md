# 0027. AI Tasks open the user's own terminal and start one of their Accounts

Date: 2026-10-17 · Status: accepted

## Context

Every Panel feature already has a `sideby` command and a place in the shipped skill, and the Panel's "Ask your AI" dialog lists phrases to copy (spec §3.11). A beginner still has to know that the skill exists, open a terminal, start a Host and paste a phrase. Tools that manage several AI coding CLIs (cc-switch 4.0, read 2026-10-17) offer long forms instead: endpoints, model names, routing modes and usage scripts the user must fill in by hand. None of them hands the task to an AI.

sideby's Panel never starts a process in a terminal; for sign-in and run it only copies the command. Starting a terminal from a web page means a page can make the machine run a program, so the way the command is built matters: cc-switch v3.19.0 put a folder name inside double quotes in a shell command, and a `$(…)` in the name ran.

What the Hosts and terminals offer (tried 2026-10-17):

- Claude Code, Codex and Grok Build 1.0.60 all take an initial prompt as a positional argument and start an interactive session with it.
- macOS terminals: Terminal.app and iTerm2 through AppleScript, Ghostty through AppleScript or `open -na Ghostty --args`, WezTerm, kitty and Alacritty through their command line, Orca 1.4 through its `orca terminal create --command` CLI, which accepts only a folder Orca already knows (`--worktree active` works; a plain folder answers `selector_not_found`, tried with Orca 1.4.227) and types the command into its login shell. Warp's URL scheme opens a folder but cannot run a command. VS Code and Cursor open a folder from their CLI but cannot run a command in their terminal without an extension.
- WSL: Windows Terminal 1.24 opens a tab from WSL with `wt.exe -w 0 new-tab … wsl.exe -d <distribution> --cd <folder> -e /bin/sh -lc <command>`, also from a background service whose PATH has no Windows folders (`wt.exe` is then found in the Windows user's `AppData/Local/Microsoft/WindowsApps`) and which has no `WSL_DISTRO_NAME` (`wslpath -w /` names the distribution). `wt.exe` splits its command line at `;` and `\;` did not survive the trip, and a `"` is unquoted again by `wsl.exe`, so a command or folder with either is refused and copied instead (tried 2026-10-18).
- Each terminal sets `TERM_PROGRAM` (or its own variable) in the shells it starts: `Apple_Terminal`, `iTerm.app`, `ghostty`, `WezTerm`, `Orca`.
- VS Code, GitHub Desktop and cc-switch all offer a setting listing the installed terminals and fall back to a default.

Options considered:

- Keep copying phrases. Rejected: it leaves the beginner at the step where they get stuck.
- sideby calls a model itself. Rejected by ADR-0001: sideby never reads a credential to call a model.
- Open the user's terminal and start one of their own Accounts with a prompt. Chosen.

## Decision

- **An AI Task runs in the user's own Host.** sideby picks the Account as `sideby next` ranks Subscription Accounts (the one with the most Quota left that is signed in), lets the user change it, remembers the choice, and starts it exactly as `sideby run` would, so Auto Handoff applies when it is on. The work follows the shipped skill; the Task Prompt says only what to do and from which context.
- **The terminal is the Preferred Terminal.** Config `terminal.preferred` holds the user's choice from the installed terminals. Without one, sideby guesses from the `TERM_PROGRAM` the Panel was started under, then uses the system's default terminal. When a terminal cannot be opened (not supported, Automation permission refused), the Panel copies the command and says where to paste it.
- **No user text reaches a shell.** The Panel writes the Task Prompt to a file of its own state directory (mode 600) and the terminal runs a fixed command, `sideby ask --run <task-id>`, which reads the file and starts the Host with the prompt as one argument. Programs are started through `DesktopDeps.exec` with separate arguments; where a terminal takes one command string (AppleScript, Orca's `--command`), only that fixed command goes in, single-quoted. The Panel's token, Host and Origin checks stay as they are, and the Panel names the terminal and the Account before it opens anything.
- **Sign-in stays with the person** (ADR-0008). An AI Task never signs in. The Panel's new "Sign in" button uses the same terminal launch to run `sideby login <ref>`, without an AI.
- **API keys never enter the AI's conversation.** An AI Task that adds an API Account writes everything but the key; sideby asks for the key itself, in the Panel or a terminal prompt that does not echo it.
- **Contributing is offered, never done by itself.** Every Task Prompt ends by inviting the user to share the result with sideby. The AI forks, commits or opens a pull request only after the user agrees, and first removes what is particular to their machine (real account names, paths, emails). A new Host is first a local Family Plugin the user can use at once; turning it into a built-in Family is the optional second step.
- **Facts come from their owners.** sideby ships no catalog of vendors, endpoints or model names: such data changes weekly (cc-switch's preset files took 72 commits in 13 days, many of them sponsor entries) and goes stale in a release. The AI reads the vendor's or Host's own documentation and `--help`, and the skill says what to look for and which mistakes are common (a plan endpoint taken for a pay-as-you-go one, the key under the wrong variable, an API format that does not match the address). sideby keeps only data that is its own, such as Share Modes and its config.
- **A new API Account is tried by its Host.** After the user enters the key, sideby offers to run one short non-interactive request through the Host under that Account (`claude -p` and the like), asking first. The Host sends it; sideby reads no key and keeps only whether it worked and the Host's message for the AI to explain. Text the user types for an AI Task is checked for key-shaped strings, which are removed with a pointer to the key box; sideby offers no import link.
- **A new Host is scaffolded and checked by sideby.** `sideby plugins new <id>` writes a local Family Plugin skeleton that passes the loader's trust checks; `sideby plugins check <id>` validates it (fields, Shared Item paths, logo, a discover, launch and doctor round in a fake HOME, and the leak check) and says how to fix each problem. CI runs the same check on the built-in Families, so a plugin that passes locally passes CI. `CONTRIBUTING.md` and the issue and pull request templates hold the rules a contribution follows (one Host per pull request, the Host version and date it was tried with, tried on the author's machine, personal details removed); no issue is required first.
- **`sideby ask`** is the CLI form: it writes the Task Prompt and opens the Preferred Terminal, `--print` only prints the prompt, `--json` reports what it did.

## Consequences

- The Panel can now start programs on the machine. Every new launch path goes through `DesktopDeps.exec` and the fixed `sideby ask --run` command, and tests replace `exec` as they do for Desktop Apps.
- macOS asks once for Automation permission for AppleScript terminals; the Panel explains it and falls back to copying.
- Supporting a terminal means one launch rule per app. Warp, VS Code and Cursor wait until they can run a command without writing files into the user's folders or needing an extension.
- Letting a plugin add parts to the Panel, so that an AI can customise it, is a separate decision: it changes the public plugin contract and keeps the Panel's CSP (ADR-0006).
