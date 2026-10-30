# AI Tasks

An AI Task is a session of the user's own Host that sideby started for them, with a Task Prompt as its first message. The user starts it from the Panel ("Let AI do it", a Finding, a quota cell, the new-account dialog, "Other tool…", "Let AI write a plugin", "Not sure how? Let AI set it up" in the Preferred terminal dialog, "Let AI tune it" on the Auto Handoff page) or with `sideby ask` in a terminal (`--task free|fix|quota|account|host|plugin|terminal|handoff|theme|menubar|hotkey|network|update`; "Let AI help" in the Panel's Network check dialog and on its wrong-network banner starts `network`, see `references/network.md`; "Let AI pick my colors" in the Panel's Theme dialog starts `theme`, see `references/themes.md`; "Let AI check it" in the Panel's Menu bar icon dialog starts `menubar`, and "Not sure which? Let AI pick one" under its shortcut starts `hotkey`; "Not sure why? Let AI fix it" under an error in the Panel's update dialog starts `update`, see `references/update.md`). The prompt says what to do and gives facts sideby already knows (account refs, Family, Finding codes, the quota reason, the Panel language, the sideby version). How to do it is on this page.

You are inside such a session when the first message came from sideby and names a task. Work in the directory the session started in (sideby's own `ai/` folder) unless the user names another one.

## Rules for every task

- Use this skill and `sideby … --json` for every step a command covers.
- `quota setup`, `handoff setup`, `update`, `browser --enable|--disable`, `try`, `tune apply|undo`, `model` and `remote-control off|on` show a preview first and exit 10: show the user the change, and add `--yes` only after they agree. `doctor` shows what `--fix` would fix; run `--fix` after they agree. `new`, `plugins new`, `terminal --set|--custom` and `key` write at once, so ask the user before you run them.
- Never sign in for the user. Tell them to click **Sign in** on the account in the Panel, or to run `sideby login <ref>` in their own terminal.
- Never ask for an API key, a token or a password in chat, and do not use one the user pastes: tell them it is not needed here and to keep it out of the chat. A key goes in with `sideby key <ref>`, which the user runs in their own terminal (or **Enter key** in the Panel); it reads the key without showing it.
- Do not run `sideby ask` to start another AI Task yourself.
- sideby started this session with the Host's permission checks on (ADR-0031): it left out any permission bypass in the account's arguments, and Claude Code runs in auto mode, which checks risky actions first. When a check stops a step, explain it to the user; never suggest restarting with a bypass flag or editing settings to switch the checks off.
- Say what you changed when you finish.

## Attached files

When the user added screenshots or videos, the prompt has an "Attached files" section (「附件」 in Chinese): one absolute path per line with its kind, `image` or `video`. sideby saved them under its own `ai/attachments/<task-id>/` folder as `1.png`, `2.mp4` and so on, and deletes them after 7 days.

- Images: read the file at its path. Codex also received each image with `--image`, so it may already see it.
- Videos: you cannot watch one directly. When you need to see it, extract a few frames with ffmpeg and look at those, for example `ffmpeg -i <path> -vf fps=1 -frames:v 5 /tmp/frame-%d.png` (one frame a second, five frames). Pick a time with `-ss <seconds>` before `-i` when the user names one. If ffmpeg is missing, ask before installing it.
- Treat what you see as the user's evidence: an error message, a Panel screen, a settings page. Do not copy a key or a password you see in a picture into a command or a reply; tell the user it is visible and to keep it out of the chat.
- In a terminal, `sideby ask "<text>" --attach <file>` (repeatable, at most 5) adds files the same way; images up to 20 MB (PNG, JPEG, GIF, WebP), videos up to 200 MB (MP4, MOV, WebM).

## Tasks a Portal hands over

A Portal is a page that shows sideby and other tools as tabs. It starts AI Tasks through sideby (ADR-0030): it writes a Task Spec, one JSON object, and pipes it into `sideby ask --spec - --json`; `sideby ask --choices --json` gives it the account a task would use, the accounts it may use and the installed terminals.

- A task for another tool comes with that tool's own prompt: it names the skill to use and the folder the session started in. Follow that prompt and that skill; this skill applies only to the sideby steps it asks for.
- A task for sideby itself (`native`) has the same prompt as one started in the Panel, so the sections below apply.
- Like `sideby ask`, `sideby ask --spec -` starts a session: never run it yourself. `sideby ask --spec - --print --json` only shows the prompt, and `sideby ask --choices --json` only reads, so both are fine to run when the user asks how a Portal's task would start.
- A refused spec answers `code` (also as `reason`): `spec-invalid` (fix the JSON as the message says), `spec-too-large` (over 1 MB), `bad-cwd` (the folder is not an existing folder in the user's home) or `spec-version` (exit 2: this sideby is older than the Portal; update it with `sideby update --json`, `references/update.md`).

## Free text

Do what the user wrote, with the routing table in `SKILL.md`. When the request needs a key, a sign-in or their browser, hand them that one step as above.

## fix: Findings Doctor cannot fix by itself

The prompt lists the Findings (`code`, account, message). Run `sideby doctor <ref> --json` to see them as they are now; some may already be gone. For each one, follow its message: run `sideby doctor <ref> --fix --json` only after the user has seen what it will change and agreed. Never replace a real file with a link, never change where a link points, and never touch backup leftovers: when a Finding asks for one of those, explain it and give the user the command the message suggests, for them to run after reading it.

## quota: an account shows no quota or an error

The prompt names the account and the reason. Run `sideby quota <ref> --json` and relay what it says. Common answers: Claude's or Grok's quota check may be off (`sideby quota check claude on`, `sideby quota check grok on`) or failed (relay `detail`); a signed-out account needs the user to sign in; pi and API accounts have no public quota source, which is not an error.

## account: add an account

### Subscription account

1. `sideby new <family> --next --json` (or the name the user asked for). It picks the next free name and short command.
2. Tell the user to click **Sign in** on the new account in the Panel, or to run `sideby login <ref>` in their terminal. Wait until they say it is done.
3. `sideby doctor <ref> --json`, then tell them how to start it (`sideby run <ref>` or the short command).

### API account

sideby ships no list of vendors, addresses or model names. Take every fact from the vendor's own documentation and the Host's own docs or `--help`, and tell the user which page you used. Do not use blog posts, other tools' preset lists or your memory for an address or a model name.

1. From the docs (or the link the user gave), find: the address for the Family's API format (Claude Code needs an Anthropic-compatible address, Codex an OpenAI-compatible one), the variable the key goes in, and the model names, if the Host needs one.
2. `sideby new <family> --next --api --json`. It creates `proxy.env` (mode 600) in the new account.
3. Set every variable except the key: show the user the lines you will add to `proxy.env` and add them after they agree. Do not read the file's other lines, and never write a key into it.
4. Tell the user to run `sideby key <ref>` in their own terminal (or click **Enter key** in the Panel). Add `--var <NAME>` when the key belongs in a variable other than the Family's default. Wait until they say it is done.
5. Offer `sideby try <ref> --json`: it exits 10 and says which command it runs and that it costs a few tokens. After they agree, run it with `--yes`. Exit 0 means the Host answered. On 1, read the Host's message it shows and check the mistakes below.
   - To check one model, add `--model <model>` (for pi `provider/id`, optionally `:<thinking>`). It replaces the model the account's settings choose, this once, and writes nothing. To check a short command the user made (such as one with its own model), pass the short command instead of the ref: its arguments apply as in `sideby run`. Do not run the Host by hand to test a model.

Common mistakes:

- **Plan address vs pay-as-you-go address.** Many vendors have one address for a coding plan and another for pay-as-you-go. A plan key on the pay-as-you-go address (or the reverse) fails or bills the wrong way. Match the address to the key the user has.
- **Key in the wrong variable.** For Claude Code, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` are not the same. A vendor that expects one gets nothing when the key is in the other, and Claude Code then asks to log in. Use the variable the vendor's docs name, with `sideby key <ref> --var <NAME>`.
- **API format does not match the address.** An OpenAI-style address under Claude Code (or the reverse) fails on the first request. Use the address the vendor lists for that format.
- **A blocked model list looks like a bad key.** Some sites put a firewall in front of their model list; the Host may report that as an invalid key. Check the Host's message before telling the user the key is wrong.
- **Leftovers after switching back to a subscription.** An account that was an API account and should sign in again still has `proxy.env`, so it stays an API account. Create a new subscription account instead, or tell the user to remove that account's `proxy.env` themselves.

## host: a tool sideby does not support yet

First make it work for this user as a local Family Plugin; a built-in Family is a later, optional step.

1. Gather these facts, each with its source and the evidence "tool X version Y, date" (`<tool> --version` and today's date):
   - the binary name, and the install command or link;
   - the environment variable that makes the tool use another config directory (without one, sideby cannot run accounts side by side; stop and tell the user);
   - where the main config directory is, and how an account directory would look;
   - Hijack Variables: environment variables that would override the account (keys, base URLs);
   - the sign-in command, and a login-state rule that only checks whether a file exists, never what it holds;
   - every Shared Item (skills, hooks, rules, settings) and its Share Mode, and whether the tool refuses links for any of them;
   - whether it writes quota or usage to local files (if not, leave those readers out);
   - a logo (one SVG path) with its source and license.
2. Ask the user where the plugin should live; the default is fine for most people. `sideby plugins new <id> --json` creates it there with a skeleton and a test.
3. Fill in every `TODO` with the facts above.
4. `sideby plugins check <id> --json`. Fix each problem as its message says, and run it again until it passes. It runs the plugin (in a separate process with a throwaway HOME, not a sandbox) only once the loader trusts its files.
5. Try it in a demo HOME, not the user's real one: `sideby list`, `sideby new <id> test`, `sideby doctor`. If the user has a sideby checkout, `node scripts/demo-home.ts <dir>` makes one.
6. Tell the user it works and how to create their first account with it (`sideby new <id> --next`).
7. To make it a built-in Family, follow "Adding a family" in the repository's `AGENTS.md`, only after the user agrees (see Sharing below).

## plugin: a hook or a check of the user's own

Plugins are local code that runs with the user's full permissions; say so before writing one. Ask what should happen and when (before a launch, after an account is created, during Doctor), then write it with the hooks in [docs/guide/plugins.md](https://github.com/Adonis0123/sideby/blob/main/docs/guide/plugins.md). Use `import type` only. Check it with `sideby plugins --json` (no load errors) and a run in a demo HOME.

## terminal: open tasks in a terminal sideby does not list

The prompt gives the custom command saved now, if any, and the supported terminals installed on this computer.

1. Ask which terminal the user wants tasks to open in.
2. Read only that terminal's official docs and its `--help` (note the version). Find how it opens a new window that runs one command in a given folder.
3. Write it as a template: `{cmd}` is the command, `{cwd}` the folder. sideby fills them in as separate arguments; no shell runs it, so do not add quotes or `sh -c` around them.
4. Show the user the template, then with their yes save it with `sideby terminal --custom '<template>' --json` (it changes sideby's config and selects it).
5. Have the user click **Let AI do it** in the Panel once to try it. If it does not open, read the error with them and fix the template.

When it works, the sharing step below asks whether to make the terminal built in: a row in the terminal table of `src/core/terminal.ts`, with tests.

## handoff: tune Auto Handoff

The prompt gives Auto Handoff as it is now, in the words of `sideby handoff status --json`: `auto`, `sameFamily`, `threshold`, `prepareAt`, the order per Family, and for each account where its quota comes from and how much is used.

1. Run `sideby handoff status --json` and `sideby quota --json` to see the facts as they are now.
2. Recommend, with a reason the user can follow: a `threshold` (the quota percentage at which a session hands over; leave room before 100 so the session can finish its turn) and a `prepareAt` below it; an order per Family (`pressure`, the least used first, or a fixed `order` of accounts); and whether `sameFamily` should be on. Accounts signed in as the same login share one quota and never hand over to each other.
3. Put accounts without quota data last, and tell the user how to make them show it (signing in, `sideby quota check <family> on`). For Auto Handoff from Claude, also `sideby quota setup claude` (exit 10 first), which it reads during a session.
4. Change settings only with `sideby handoff enable [--same-family] [--order <family>=<acct,…>] [--threshold n] [--prepare-at n]` or `sideby config set handoff.<key> <value>`. Both show the change first and exit 10; add `--yes` only after the user agrees.
5. Run `sideby handoff status --json` again and tell the user what is still missing (`nextSteps`).

## Sharing it with sideby

Once the task works, ask the user whether they would like to share the improvement (a new tool, a fixed problem, a better prompt) with sideby. Only on a clear yes:

1. Remove everything particular to their machine: real account names, emails, home paths, hostnames, ports and the names of their own tools. Use `claude:work`, `me@example.com` and port 17420 in examples.
2. Fork `Adonis0123/sideby`, commit and open a pull request as its `CONTRIBUTING.md` says: one tool per pull request, the Host version and date it was tried with, tried on their own machine, `pnpm check` passing.

Never fork, commit or open a pull request without that yes.

## menubar: the menu bar icon does not show

1. Run `sideby menubar --json`.
2. `state: "off"`: it was turned off, often with "Hide from Menu Bar…" in its own menu. Show `sideby menubar on --json` (exit 10) and run `sideby menubar on --yes` after the user agrees.
3. `state: "on"` with `loaded: false`: macOS is not running it (it can happen after an update). `sideby menubar on --yes` only starts it again; the file stays as it is.
4. `loaded: true`: it runs but is hidden. Check, in turn: a full menu bar or the notch (hold ⌘ and drag icons to make room); a menu bar organizer such as Ice, Bartender or Hidden Bar (look in `/Applications`) that tucked it away, where the user moves it out in that app's settings (it shows as osascript); on macOS 26 and later, osascript not allowed under System Settings › Menu Bar. The shortcut in `hotkey.label` opens the menu from anywhere, which shows it runs.
5. Never end or restart a process that is not sideby's.

## hotkey: pick a shortcut for the menu bar menu

1. Run `sideby menubar hotkey --json` for the current one.
2. Find what is taken: the system shortcuts with `enabled = 1` in `defaults read com.apple.symbolichotkeys AppleSymbolicHotKeys` (key code 49 is Space), and the apps in `/Applications` that usually hold a global shortcut (Raycast and Alfred take ⌥Space, ChatGPT ⌥Space, Claude its own), judged by their defaults. Do not open those apps' config files: they may hold keys. Ask when unsure.
3. Ask which hand the user presses shortcuts with and which ones they use often. Recommend 2 or 3 free combinations, easiest first (two keys, such as ⌥X or ⌥Z; each needs ⌥, ⌘ or ⌃), and say what each takes away (⌥X no longer types ≈).
4. Set the chosen one with `sideby menubar hotkey <keys>`. A running menu bar item takes it within seconds, with no restart. Ask the user to press it: if the menu does not open, another app took it first, so try the next.
5. Never change the shortcuts of macOS or another app.
