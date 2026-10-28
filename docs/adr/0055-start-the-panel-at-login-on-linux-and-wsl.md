# 0055. Start the Panel at login on Linux and WSL

Date: 2026-10-28 · Status: accepted · Revises ADR-0029

## Context

ADR-0029 started the Panel at login on macOS only and promised Linux (an XDG autostart `.desktop`) and Windows (the Run key) later. Many users run sideby inside WSL and open the Panel in a Windows browser through WSL's mirrored or forwarded localhost. For them "login" means signing in to Windows: no Linux desktop session starts, so an XDG autostart file in WSL never runs. WSL also shuts a distribution down a short while after its last `wsl.exe` client exits, which ends a Panel started there (tried with WSL 2.4.13 and systemd on, 2026-10-28; the shutdown itself was not observed from inside a running session).

Options considered for WSL:

- An XDG `.desktop` inside WSL. Rejected: nothing runs it at Windows sign-in.
- A systemd user unit inside WSL. Rejected: it runs only once the distribution is started, which nothing does at sign-in, and `ui --background` detaches from the unit.
- A Windows scheduled task (`schtasks`). Rejected for now: harder to show as one file before writing and to undo exactly.
- A `.vbs` in the current Windows user's Startup folder that runs `wsl.exe` with a hidden window. Chosen.

For a Linux desktop, systemd user units were weighed against XDG autostart; XDG is what desktop sessions run at login and needs no unit management.

## Decision

- `sideby autostart` picks the mechanism from the system: `launchd` on macOS (ADR-0029, unchanged), `wsl-startup` on Linux under WSL, `xdg` on other Linux. `--json` reports it as `mechanism`. Native Windows and the menu bar item (ADR-0034) stay unsupported.
- `xdg`: `${XDG_CONFIG_HOME:-~/.config}/autostart/dev.sideby.panel.desktop` (mode 644) runs this Node and this sideby with `ui --background --no-open`. Only desktop sessions run it; the page and the CLI say so.
- `wsl-startup`: `sideby-panel.vbs` in the Startup folder of the Windows user that `cmd.exe` names (`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`). It runs `wsl.exe -d <distribution> --exec <node> <sideby> ui --background --no-open --wait` with a hidden window and does not wait for it. `--wait` keeps that `wsl.exe` attached while the background Panel runs, so WSL does not shut the distribution down under it; it ends when the Panel stops.
- Both files carry the sideby marker and a `sideby-args` line with the recorded arguments as JSON; sideby writes, replaces or removes only a file with its marker, as on macOS. Paths with `"`, `%` or characters outside printable ASCII are refused under WSL, since they cannot pass safely through VBScript and `wsl.exe`. The distribution name goes unquoted (`wsl.exe -d "Ubuntu"` exits -1 on WSL 2.4.13), so only letters, digits, `.`, `_` and `-` are accepted there.
- No program runs at `on` or `off` on Linux or WSL: the change takes effect at the next login, and `sideby ui --background` starts the Panel now.

## Consequences

- WSL users get the switch in the Panel's settings instead of "Linux and Windows come later"; the Panel says the trigger is signing in to Windows.
- sideby now writes one file on the Windows side, inside the user's own Startup folder, with the same marker, preview and undo rules as the LaunchAgent.
