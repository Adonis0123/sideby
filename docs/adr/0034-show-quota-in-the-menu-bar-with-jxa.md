# 0034. Show Quota in the macOS menu bar with JXA

Date: 2026-10-19 · Status: accepted

## Context

Users want to see, without opening the Panel, whether they can keep working. Apps that do this for one AI tool (CodexBar, Headroom, claude-meter, Claude Usage Tracker; surveyed 2026-10-19) agree on one menu bar item with one percentage, a menu with a row per window or account and its reset time, no Dock icon, and start at login.

A menu bar item needs AppKit's `NSStatusItem`, which Node cannot reach. Options considered:

- A SwiftBar or xbar plugin. Rejected: the user must install another app first.
- A Swift helper, compiled at install or shipped prebuilt. Rejected: not every Mac has `swiftc` (Xcode Command Line Tools), and a prebuilt binary must be built, signed and shipped per release.
- Tauri or Electron. Rejected: a large dependency for one menu.
- JXA (`osascript -l JavaScript` with the Objective-C bridge), which ships with macOS. Chosen: no compiler, no dependency, about 63 MB and under 1% CPU when idle (measured on macOS 27, 2026-10-19).

## Decision

- `sideby menubar on|off` writes or removes the LaunchAgent `dev.sideby.menubar`, under the rules of ADR-0029 (marker, preview and `--yes`, refusals, rewrite after `update` and `pnpm local`). The agent runs `/usr/bin/osascript -l JavaScript -e <script> <node> <entry>`, with the whole script inside the plist, so there is no other file to keep in step.
- The script only draws. Every few seconds it checks a background `sideby menubar snapshot --json` it started, and starts one every 2 minutes; what to show, its words and its language come from Node, where they are tested. The script reads no file and no credential.
- What it shows: for each Family the account `sideby next` would pick, and as the title the highest of those Quota Pressures. Clicking an account opens it in the Preferred Terminal through the AI Task launcher.
- Off by default; the Panel offers it once on macOS.

## Consequences

- JXA has had no new features since 2016. If a macOS release breaks the bridge, the item stops drawing and nothing else depends on it; a compiled helper is the fallback.
- Activity Monitor and Login Items show the process as `osascript`.
- A second LaunchAgent sits next to the Panel's; each is turned on and off on its own.

## Amendment (2026-10-19): a global shortcut

The menu opens from anywhere with a shortcut (⌥⌘S by default at first, ⌥X since the last amendment; config `menubar.hotkey`, `off` to turn it off). The script registers it with Carbon's `RegisterEventHotKey` through the JXA bridge, which needs no macOS permission. A global key monitor (`NSEvent.addGlobalMonitorForEvents`) was rejected: it needs Accessibility access for `osascript`, which would give that access to every AppleScript on the machine. While the menu is open the key is unregistered, so a second press reaches the menu and closes it through a hidden item with the same key; the key is registered again when the menu closes.

## Amendment (2026-10-20): running, not only on; a shortcut users choose; asking before hiding

- The state read only the file, so an item launchd had let go (a bootstrap that failed right after a bootout, when `pnpm local --off` rewrote the plist after a release) showed "on" with no icon and no way to fix it from the Panel. The status now carries `loaded` for this agent (`launchctl print`), the Panel offers "Start it again", and a rewrite waits until `launchctl print` no longer finds the old job before `bootstrap`, retrying error 5 up to three times. Homebrew and home-manager wait the same way; `bootout --wait` was rejected because it may never return.
- `sideby menubar hotkey` and a recorder in the Panel change the shortcut, as KeyboardShortcuts, MASShortcut and VS Code do: a new choice needs cmd or ctrl and may not be one macOS and most apps already use. The refused combinations are a fixed list because macOS tells no one: on macOS 27 (2026-10-20) a second process registering ⌥⌘S, ⇧⌘3 or ⌘Space got 0, and macOS's own shortcuts sit in `com.apple.symbolichotkeys` only once changed; so the Panel says "if nothing happens, pick another". The script reports whether `RegisterEventHotKey` succeeded through `menubar snapshot --hotkey ok|taken --hotkey-label <label>`, so it still reads and writes no file of its own; Node keeps the answer in `<state>/menubar.json`. A change reaches a running item as a macOS distributed notification (`dev.sideby.menubar.reload`, posted with the system's `osascript`), which makes it read its snapshot again within a second or two; the first version restarted it with `launchctl kickstart -k` on every change.
- "Hide from Menu Bar…" asks first and says how to bring it back. Rectangle and Maccy keep the app running when the icon is hidden and bring it back when the app is opened again; sideby's menu bar item is a LaunchAgent, not an app the user opens, so hiding stays `menubar off` (it also stops starting at login, which the question says), and the way back is the Panel switch, whose hint says so, or `sideby menubar on --yes`.

## Amendment (2026-10-20): choosing a shortcut, and saying where the icon went

- Recording a shortcut in the browser proved hard to use: macOS hands keys another app (or sideby's own current shortcut) registered to that app first, so the page saw only the modifiers and seemed stuck. The Panel now offers a list of checked combinations, Off and Custom…; only Custom… records. Native apps record in the process that registers the key; sideby's settings live in Node and its icon in osascript, so a choice is the dependable default and the distributed notification above carries it across.
- On macOS 26 and later a full menu bar puts icons behind «, which is where an "on" icon most often is. The script already knew (it drops its menu at the pointer when its window is not visible), so it reports `--icon visible|hidden` with its snapshot, and the Panel and `sideby menubar` say where the icon went instead of listing every possible cause. The script still reads and writes no file of its own.

## Amendment (2026-10-20): a default one hand presses

The default becomes ⌥X (config `opt+x`). Three-key combinations such as ⌥⌘S are awkward for the left hand alone; two keys are not. Launchers agree on ⌥Space (Raycast, ChatGPT), but Alfred takes it by default, and macOS keeps ⌘Space, ⌃Space, ⌃⌥Space and ⌥⌘Space. ⌥X is the thumb on ⌥ and the index finger on X, and no common app uses it; it costs typing ≈ with ⌥X. So a shortcut now needs opt, cmd or ctrl (shift alone is still refused, `hotkey.needs-modifier`), and the Panel's list is ⌥X, ⌥Z, ⌥⌘S, ⌃⌥S. A user who set ⌥⌘S keeps it; one who never set a shortcut gets ⌥X.
