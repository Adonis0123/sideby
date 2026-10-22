# Panel

English | [中文](panel.zh-CN.md)

← [README](../../README.md)

```sh
sideby ui              # http://127.0.0.1:17420, opens your browser
sideby ui --port 8080
sideby ui --no-open    # print the address only
```

The panel listens on `127.0.0.1` only. If another sideby panel already runs on the port, sideby opens that one; if another program holds the port, it tries the next ones and prints the address it used. The page shows each account's sign-in email, quota windows in aligned columns and last use; click an account to see how it runs, its token usage and its health. When a tool's local records have sessions but no token counts, that cell shows how many sessions and says the records have no token counts; last use is the newest of those sessions. After a name come its short command and at most one label, the most important first: "Needs a fix", "Almost full", another thing to look at (not signed in, tool missing, "Take a look"), then "Suggested"; hover it for why. When an account's website is signed in in Chrome, the opened account names that browser user and opens it. The page refreshes itself every 20 seconds while it is open (every 5 seconds for a few minutes after you turn on quota, so the first numbers appear soon after a status line reports them). "Hide emails" under **Display** masks addresses as `a•••@example.com` for screen sharing. Accounts of one tool signed in as the same login (Claude Code, Codex, Grok Build) sit together in the list: one line with a link mark after the name (hover it to see which directories share the login), the email and that quota, shown once (hover it to see which account it was read from, and its warning dot is there), then a row for each directory with its own name, model, last use and menu (click the head to fold them away) (see [Two directories, one login](usage.md#two-directories-one-login)). When a search leaves only one of them, or in cards, each account shows the quota itself and says "Same login as …". **Display** also switches between used and left quota and between the list and cards. The panel remembers which accounts you opened, in your browser. An opened Claude Code or Codex account shows the model and effort it runs with; click it, or "Model and effort…" in the account's menu, to set them for that account alone (see [Model and effort](usage.md#model-and-effort)). On macOS, a Claude Code or Codex subscription account with the desktop app installed has a screen button at the end of its row, next to the terminal button, and "Open desktop app" in its menu (on a shared login it opens the one already running, or the directory the row is named after); which opens Claude Desktop or the Codex app as that account (see [Desktop apps](usage.md#desktop-apps)). When Grok Bot is installed, a **Grok Bot** group after the accounts lists its windows, each with its own sign-in, and opens another one (see [Grok Bot windows](usage.md#grok-bot-windows)). Each account's menu has "Context tuning", the same estimate as `sideby tune`; its "Use" button writes the suggested size after showing the change, and "Undo" puts the old value back (see [Context tuning](usage.md#context-tuning)). It runs Doctor with one-click fixes, creates accounts (with an optional short command), and can turn on Claude quota after showing the diff. One quota setup covers every Claude Code account, so the "Turn on quota" button sits in the Claude Code group header, not on each account. For an account that is not signed in, **Sign in** opens your terminal and runs `sideby login <account>` there (no AI involved); signing in always happens in your terminal, and if the terminal cannot be opened the panel copies the command for you to paste. When the browser user shown in an account's details is wrong, **Change** next to it lets you pick the right one (see [Which browser you signed in with](usage.md#which-browser-you-signed-in-with)). A signed-in account has **Sign in again or switch account** in its menu, and each directory of a shared login has **Use another account**; both run the same command.

**Pins and the account menu.** A pinned account shows a small pin before its name; click it to unpin. Hover over any other account (or move to it with the keyboard) and a fainter pin shows in the same place; click it to pin that account to the top of its group (at most 3 per tool). Right-click an account row or card to open the same menu as its **…** button, right where you clicked; on the keyboard, the menu key or Shift+F10 opens it for the focused row. Right-clicking text boxes, links and buttons still gives your browser's own menu.

**Settings** groups what you set once: Appearance (light or dark, the Theme and language), Startup, Accounts and quota, and Let AI help. Light or dark and language are saved in sideby's config, so `sideby config set panel.theme dark` changes them too. Under Startup, **Start sideby in the background at login** (macOS) starts the panel without opening a window each time you log in, so it is up to date when you open it. Turning it on or off first shows the file it writes or removes and the command it runs; nothing changes until you confirm. `sideby autostart on|off` does the same in a terminal. On macOS, **Show quota in the menu bar** puts the sideby icon in the menu bar with the same preview first; the panel suggests it once when quota shows. `sideby menubar on|off` does the same. While it is on, the row says when it is not running and offers **Start it again**, and **Menu bar icon ›** below it opens its own dialog: the shortcut that opens the menu (pick ⌥X, ⌥Z, ⌥⌘S, ⌃⌥S or Off from the list, or Custom… to press your own; `sideby menubar hotkey` does the same), and **Can’t see the icon?**, three things that hide it (macOS put it behind « in a full menu bar, System Settings › Menu Bar, a menu bar organizer such as Ice or Bartender). When the icon is behind «, the switch says so by itself with **Let AI check it**, which opens an AI Task that finds the cause for you.

## Themes

**Settings › Theme** picks the Panel's colors. Two Themes are built in: **Sky** (the default: light blue) and **New Leaf** (light green with green quota bars, also from Radix Colors). Click a card to switch; the colors ease over without reloading, and the message at the bottom offers **Undo**. Under the cards, **Your own color** makes buttons, links and quota bars any color you pick, and **Let AI pick my colors** hands a sentence such as "quiet like Notion" to your own AI: it writes a Theme, shows it to you in the Panel, and switches only after you agree.

Amber and red appear only when quota runs out, so they stand out. Text keeps WCAG contrast (4.5:1, and 3:1 for the bold main button); when a Theme of your own has a color too faint to read, the Panel makes it darker or lighter and says so. The sideby mark keeps its own blue whatever the Theme.

A Theme of your own is a JSON file in `~/.config/sideby/themes/` and holds colors only, never code:

```json
{ "schemaVersion": 1, "name": "Calm green", "base": "leaf", "accent": "#4f9d69", "light": {}, "dark": {} }
```

`base` and `accent` are usually enough; `light` and `dark` take the same tokens as an embedding page's `theme` (below). In a terminal: `sideby theme` lists them, `sideby theme use <name>` switches (`--undo` goes back), `sideby theme check <file>` reports contrast, `sideby theme preview <file>` shows one in the running Panel without switching, and `sideby theme import <file>` saves one.

## Sessions

The **Sessions** tab lists what every account is running right now, one row per running session: the tool's mark, the session's label (the account's short name, the title the tool gave the session, the first 8 characters of its id), whether it needs you, is working or is idle, its folder and when it was last active. Sessions that need you come first. When sideby cannot tell which session an account is running, it shows that account's newest one and says "newest session (guessed)". The list refreshes every 5 seconds while the tab is open, and the **Refresh** button at the top reads it at once.

**Copy for AI** copies a short note another AI can follow: which account, where the session works and where its record is (only paths, never the conversation). The button turns into a check mark for a moment. Its **…** menu copies the session id or the command that resumes the session in its account (for a Claude Code session, `sideby resume claude -- --resume <id>`). When the session runs in an Orca terminal, the same menu has **Go to its Orca tab**, which brings that tab to the front. If the browser does not allow copying, the text shows selected, ready for ⌘C or Ctrl+C. `sideby sessions` lists the same sessions in a terminal, and you can ask your AI, for example "Copy cc002's current session for another AI."

When you split work across sessions with a local orchestrator such as the `agent-dispatch` skill, a session that works for one of its Runs shows a chip **Run: <title>**. Click it to open that Run's board in your browser; hover to see which part of the Run the session does and, after **+N**, the other Runs it also works for. sideby shows it only when the orchestrator lists the session and its board file is in the orchestrator's own folder. A read-only panel leaves it out. You can also ask your AI "Which run is cc002 working on?"

### Send to a session

**Send to it** on a row opens a small box titled with that session's label. Write what it should do, and add screenshots if they help: paste one with ⌘V or Ctrl+V, drop it on the box, or pick it with **Add screenshot** (images only, up to 5, 20 MB each). ⌘Enter or Ctrl+Enter sends. sideby saves the message as a file first, so it is never lost, then hands it to the session:

- **Delivered**: the session got it. When it has read it, the row shows **Read**.
- **Needs you to paste**: the tool cannot receive messages by itself. The box shows one line to paste into that session's tab, with **Copy this line**, and **Go to its Orca tab** when the session runs in Orca.
- **Waits for approval**: a Claude Code session got it but holds it until you approve it in its terminal, and drops it after about 5 minutes (a session started with permission checks skipped does this unless its account says otherwise). The box and the row offer **Receive directly**. If nobody approves it in time, the row turns to **Needs you to paste**.

**Receiving messages**, at the bottom of the Sessions page (and a yellow banner at the top while an account holds messages), lists each Claude settings file, the accounts that use it and whether it receives directly or waits for approval. **Receive directly** sets `crossSessionInbound` to `"accept"` in the files that are not set or hold, and changes nothing else; the notice after it has **Undo**. A file set to `"refuse"` is left alone. Running sessions pick it up when restarted. `sideby messages inbound accept` does the same in a terminal.

Each row shows where your last message to it is: **Delivered**, **Waits for approval**, **Read** or **Needs you to paste**. Whichever page you are on, a short notice in the corner says when a session gets a message (also one another AI sent with `sideby send`), when it reads one, or when one waits for you to paste it; **Show** takes you to that session's row. When a message waits for you, the notice has **Copy this line**, the Sessions tab shows how many are waiting, and clicking **Needs you to paste** on a row shows the line and why. A read-only panel hides **Send to it**. `sideby send <account> "<text>" --image <path>` does the same in a terminal, and you can ask your AI, for example "Tell cc002 to run the tests again and send me the result."

### History

The switch at the top of the **Sessions** tab, **History / Running**, opens on **History**: every session you had before, in every account of every tool (Session History); **Running** lists the sessions running now. sideby reads them only the first time you open it; the first time it also builds its local search index, and the page says how far it is.

- **Projects** on the left: each git repository your sessions ran in, worktrees and subfolders folded in, with how many sessions it has. **All projects** is at the top.
- **Search** above the list: type what you remember, in any language. Every word must match the title, project, branch, account, your prompts or the replies; put words in quotes ("fix login") to find them together. Next to it: the tool, the account, and the time (**Today**, **7 days**, **30 days**, **All**). **Also search commands and their output** reads the session files in view for command output and error messages too; it is slower, and sideby keeps nothing of it. When a search finds nothing in the project you picked, **Search all projects** looks everywhere. A reload keeps the search, filters and picked project; a new tab starts clean.
- Each row shows the Session Title (your own name for it, else the tool's title, else your first prompt), where the words matched or your first prompt, the tool, the account, the branch, how many messages and how long ago; a running session is marked. Subagent sessions are folded into the session that started them. Sessions started by a script, an SDK or another agent are hidden until you turn on **Show sessions started by programs**. Scrolling to the end loads more.
- **Display**, above the list, groups the sessions: by **Project** (the default), **Date**, **Account**, **Tool**, or not at all, and by **Category** when one of your plugins sorts projects into categories (see [Plugins](plugins.md)); then the projects on the left are nested under them too, a click on a category's heading folds it, and dragging the heading (or Alt+arrow keys) moves the category, in this browser only. Click a group's header to fold it; sideby remembers the grouping and the folded groups in this browser. **Open N folded groups** in the same menu opens them all again.
- **Where these come from**, under the list: how many sessions sideby read from each account, and why an account has none or could not be read. A tool added by a plugin shows its history only when the plugin gives a session reader; otherwise picking it says so. While the index is built, the line above the list says how far it is.

**Read** and **Continue** sit on each row; right-click a row (or press Shift+F10) for the same menu as **···**. Click a row to read the session in a dialog, read-only: the newest 200 messages first, **Show earlier messages** at the top for older ones, tool calls folded into one line each, and the replies' Markdown (tables, code, lists) shown formatted. **Continue** (in the menu, **Copy command to continue**) copies `cd <its folder> && <the command that resumes it in its account>`, to paste into a terminal. When its folder is gone, the button says the tool may not find the session there and **Copy for AI** is the way that always works. **Copy for AI** copies its Session Reference, as on a running session.

The search index holds titles, projects, your prompts and the replies, never tool output, in sideby's state folder where only you can read it. Config `history.index: false` turns it off and deletes it; then only titles and folders are searched. `sideby history` does the same in a terminal, and you can ask your AI, for example "Find the session where I fixed the login page last week."

## Who can reach the panel

The panel answers only on `127.0.0.1`, so other computers cannot reach it. A web page from another site cannot read it or act through it either: the panel checks where each request comes from, and every change needs a key that only its own page gets. What it does not do is tell the users of one computer apart. A program run by another user of the same Mac can read what the panel shows (account names, emails, quota and usage, never a credential) and press its buttons. On a computer that is yours alone this changes nothing. On a shared Mac, start the panel with `sideby ui` when you need it, and leave start at login and `sideby ui --background` off.

## Let AI do it

When you would rather not work something out yourself, the panel can hand it to your own AI. It opens your terminal, starts one of your own accounts (Claude Code, Codex or Grok Build) and gives it a short note saying what to do. The AI then does the work with the sideby skill, and you watch and answer its questions in that terminal.

| Where | What the AI is asked to do |
|---|---|
| **Let AI do it** at the top, and in Settings | Anything you type |
| Next to a Doctor finding that has no one-click fix | Fix those findings |
| A quota cell that shows no data or an error | Find out why and make the quota show |
| **Let AI set it up** at the bottom of the new-account dialog | Add an account: a subscription, or one from an API address or docs link you have |
| **Other tool…**, the last choice in the new-account dialog's tool list | Make sideby support a tool it does not list yet, first as a plugin on your computer |
| **Let AI write a plugin** in Settings | Write a plugin or hook |
| **Not sure how? Let AI set it up** next to the custom command in **Preferred terminal** | Write and save a custom terminal command for the terminal you use |
| **Let AI tune it** on the **Auto Handoff** page | Recommend a handoff threshold and order for your accounts, and change them after your yes |

Each entry's dialog has its own title and a few examples for that task; click one to put it in the text box. Where the entry already says what is wrong (a finding, a quota cell), you can leave the box empty.

Before anything opens, a dialog says which terminal and which account will be used, for example "Opens Orca and starts claude:work there"; you can change both. sideby picks the signed-in subscription account with the most quota left and remembers your change for next time. API accounts are never picked by themselves, but you can choose one. When no account can be used, the dialog offers **Copy prompt** instead, for any AI you like.

The rules the AI follows: it shows you a change before making it and waits for your yes; it never signs in for you; and it never asks for your API key. Keys go in through **Enter key** in the panel or `sideby key <account>` in your terminal, which never shows the key or sends it to the AI. If you paste something that looks like a key into the text box, the panel removes it and says so. When the work is done, the AI asks whether you want to share the improvement with sideby; it opens a pull request only if you say yes, after removing your own account names, paths and emails.

**Screenshots and videos.** Paste a screenshot into the dialog, drop files onto it, or click **Add image or video**. Images (PNG, JPEG, GIF, WebP) can be up to 20 MB and videos (MP4, MOV, WebM) up to 200 MB, five files at most; sideby checks what a file really is, not its name. Each one shows as a small picture you can remove. The AI gets the files' paths with your words (Codex also gets the images directly), so check they show no keys or passwords. sideby keeps them in its own folder and deletes them after 7 days. A read-only panel cannot add files.

**Which terminal opens.** Choose it under **Preferred terminal** in Settings; the list shows the terminals installed on this computer. Without a choice, sideby uses the terminal the panel was started from, and otherwise Terminal. On macOS it supports Terminal, iTerm2, Ghostty, Orca, WezTerm, kitty and Alacritty; Warp, VS Code and Cursor cannot run a command this way yet. On WSL it opens a new Windows Terminal tab that returns to the same Linux distribution and folder (and is the default there); a task folder or command with `;` or `"` in it falls back to copying the command. Orca installed on Windows also works from WSL: the terminal opens as a WSL shell in the WSL project you used last in Orca. Orca opens the new terminal in the worktree that is active in Orca. A panel started from the panel app or with `sideby ui --background` may not know your terminal, so pick one in Settings. `sideby terminal` shows the same list and `sideby terminal --set <id>` saves your choice. **Custom terminal command** in Settings takes a template for any other terminal, with `{cmd}` and `{cwd}` filled in by sideby.

**When the terminal cannot open.** The panel copies one command, `sideby ask --run <id>`, and tells you to paste it into any terminal and press Return. It starts the same task. The first time sideby opens Terminal, iTerm2 or Ghostty, macOS asks whether sideby may control it; if you said no, turn it on in System Settings → Privacy & Security → Automation. The task waits for one hour; after that, click again.

The terminal starts in a folder of sideby's own, so the AI does not read one of your projects along the way.

**The AI keeps its permission checks on.** An AI Task starts the account as `sideby run` would, except that it leaves out any argument in your account settings that skips the Host's permission checks. Claude Code starts in its auto mode: no routine questions, but risky actions such as running downloaded code, force pushes or deleting files you already had are checked first. Codex drops `--dangerously-bypass-approvals-and-sandbox` (`--yolo`) and follows your own Codex settings. Other tools start unchanged. Your own `sideby run` sessions keep every argument. Everything here also works without the panel: `sideby ask "add a DeepSeek API account"` (see [Commands](commands.md)).

## Panel app

```sh
sideby app install       # macOS: ~/Applications/sideby.app; Linux: a "sideby" entry in the app menu
sideby app uninstall
sideby ui --background   # what the app runs: start the panel without a terminal, then open it
sideby ui --stop         # stop the background panel
```

Double-click the app to open the panel. It starts the panel in the background when none is running (`sideby ui --background`), reuses it when one is, and opens your browser. The background panel keeps running after you close the tab and logs to `${XDG_STATE_HOME:-~/.local/state}/sideby/panel.log`. Apps started from Finder or a desktop menu get a minimal PATH, so the background panel asks your login shell (`$SHELL -ilc`) for its PATH to find hosts in places like `~/.local/bin`.

The app runs the Node and sideby it was installed with. `sideby update` (and the panel's Update button, and Auto Update) installs the app again from the new version, with its new icon. Run `sideby app install` yourself after upgrading Node or installing sideby another way. If your own page embeds the panel (see below), `sideby app install --url http://localhost:3000/` makes the app open that address instead; installing again keeps that address. To make the app start the panel again, run `sideby app uninstall`, then `sideby app install`. Install and uninstall only touch files that `sideby app install` created. The app is a local, unsigned launcher script; it is not meant to be copied to other machines.

## Embed the panel

Another local Node page can mount the panel under its own path. The handler keeps its own Host, Origin and token checks; you list the hosts your page answers on.

```ts
import { createServer } from 'node:http'
import { createPanelHandler, createRuntime } from 'sideby'

const panel = createPanelHandler({
  runtime: () => createRuntime(), // a factory: every request sees the disk as it is now
  basePath: '/accounts',
  allowedHosts: ['tools.localhost:8080'],
  theme: {
    colorScheme: 'light', // 'auto' (default) follows the system
    header: 'bar', // a full-width header strip instead of a title on the page background
    light: { font: '-apple-system, "PingFang SC", sans-serif', bg: '#f2f8fc', primary: '#e1f0fb', onPrimary: '#1f6396', radius: '10px', shadow: 'none' },
  },
  lang: 'en', // 'auto' (default) uses the language picked in the panel, then the browser's
})
createServer(async (req, res) => {
  if (!(await panel(req, res))) res.writeHead(404).end()
}).listen(8080, '127.0.0.1')
```

`theme` makes the page match yours. Its tokens become CSS custom properties inside the page's own nonce'd `<style>`, so the panel's strict CSP stays as it is. An iframe cannot read its parent's CSS variables, so pass concrete values.

- **Tokens** (all optional): type `font`, `monoFont`, `fontSize`, `smallSize`, `controlSize`, `headingSize`, `largeSize`, `titleSize`, `titleWeight`, `headingWeight`, `strongWeight`, `buttonWeight`, `primaryWeight`; colors `bg`, `surface`, `surfaceMuted`, `border`, `borderStrong`, `text`, `muted`, `faint`, `hover`, `active`, `accent`, `accentSoft`, `focus`, `primary`, `primaryHover`, `primaryActive`, `onPrimary`, `primaryBorder`, `primaryHoverBorder`, `buttonText`, `buttonHoverBorder`, `buttonHoverText`, `checkColor`, `ok`, `okSoft`, `warn`, `warnSoft`, `fail`, `failSoft`, `okBar`, `warnBar`, `failBar`, `track`, `logoBg`, `logoColor`, `logoBorder`, `shadow`, `focusOutline`, `focusRing`; shape and layout `radius`, `controlRadius`, `chipRadius`, `controlHeight`, `controlHeightSmall`, `fieldHeight`, `contentWidth`, `gutter`. [`src/panel/theme.ts`](../../src/panel/theme.ts) documents each one.
- **Light and dark**: colors in `light` apply in light mode only; type, shape and layout tokens apply in both. Give `dark` for dark-mode colors, or set `colorScheme: 'light'` when your page has no dark mode.
- **Checked when the handler is created**: an unknown token, or a value with anything but letters, digits, spaces and `# % ( ) , . + - / ' " _` (so no `;`, `{`, `}`, `<`, `\`, `*` or `:`), with `url(`, unbalanced parentheses or quotes, or over 200 characters, throws a `TypeError` that names the token.
- Without `theme`, the page looks the same as `sideby ui`. Colors you set are the Panel's colors on your page until the user picks a Theme in the Panel's **Settings › Theme**, where yours show as "This page's colors"; a Theme the user picks wins over your colors, and the other tokens (font, sizes) stay yours.

`updates` (default `true`) shows the running version and, when there is one, a "new version" label in the panel's header, and the update dialog with **Check for updates**, the **Update** button and the Auto Update switch (see [Updates](configuration.md#updates)). An update started there installs the new package; a page that loads sideby from the installed package picks it up by itself, as long as it looks up the package of the `sideby` command again when it checks for new code, and the panel says to reload. When your page switches to the new code, let the old handler finish the requests it is answering before you stop it (minutes, not a few seconds): the update request itself is one of them. Pass `updates: false` when your page manages sideby's version: the panel then shows nothing about updates and refuses `/api/update*`.

`ask: { bridge: 'postMessage' }` is for a page that offers AI Tasks itself. When the panel sits in a frame on your page, it then hides its own **Let AI do it** button, and each place that starts an AI Task (**Ask AI why**, **Let AI fix it**, setting up an account or a terminal, and the rest) posts `{ type: 'local-tools:ask', version: 1, preset, native: { task, text, context }, text }` to `window.parent`, addressed to the panel's own origin, instead of opening the panel's dialog. Your page shows its dialog and starts the task with `sideby ask --spec -`, passing the `native` part on unchanged (see [Commands](commands.md)); `sideby ask --choices --json` gives the accounts and terminals to show. The package's `ai-tasks.json` lists sideby's tasks with their titles, placeholders and examples in English and Chinese. Without `ask`, or when the panel is not in a frame, the panel opens its own dialog. Any other value throws a `TypeError` when the handler is created.

`<basePath>/icon.svg` serves the sideby mark (the panel uses `<basePath>/favicon.svg`, the small cut with the blue buddy alone, as its favicon). Show it in your own tab or menu instead of keeping a copy, so a new mark reaches your page with the next sideby.

`lang` (`'auto'`, `'en'` or `'zh'`) keeps the panel's language in step with your page. `'en'` or `'zh'` wins over the language picked in the panel and hides the language choice in the panel's Settings; the choice picked there stays saved and applies again under `'auto'`. `'auto'` (the default) uses the language picked in the panel, then the browser language. Any other value throws a `TypeError` when the handler is created. The handler reads `lang` once: to switch language, create the handler again.
