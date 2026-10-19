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

The menu opens from anywhere with a shortcut (⌥⌘S by default, config `menubar.hotkey`, `off` to turn it off). The script registers it with Carbon's `RegisterEventHotKey` through the JXA bridge, which needs no macOS permission. A global key monitor (`NSEvent.addGlobalMonitorForEvents`) was rejected: it needs Accessibility access for `osascript`, which would give that access to every AppleScript on the machine. While the menu is open the key is unregistered, so a second press reaches the menu and closes it through a hidden item with the same key; the key is registered again when the menu closes.
