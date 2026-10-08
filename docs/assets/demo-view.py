#!/usr/bin/env python3
# Mirrors the two panes demo-setup.sh started.
# VHS's terminal cannot `tmux attach` ("open terminal failed: not a terminal"), so the tape
# shows those panes side by side. The processes are the real `sideby run` of the demo Host.
import shutil
import subprocess
import sys
import time


def capture(pane: str) -> list[str]:
    got = subprocess.run(
        ["tmux", "-L", "sideby-demo", "capture-pane", "-p", "-t", pane],
        check=False,
        capture_output=True,
        text=True,
    )
    if got.returncode != 0:
        sys.stderr.write(got.stderr or f"could not read pane {pane}\n")
        sys.exit(1)
    lines = got.stdout.splitlines()
    while lines and lines[-1].strip() == "":
        lines.pop()
    return lines or [""]


def fit(lines: list[str], cols: int, rows: int) -> list[str]:
    out = []
    for line in lines[:rows]:
        text = line.rstrip()
        if len(text) > cols:
            text = text[:cols]
        out.append(text.ljust(cols))
    while len(out) < rows:
        out.append(" " * cols)
    return out


def main() -> None:
    size = shutil.get_terminal_size((61, 11))
    cols = max(20, (size.columns - 3) // 2)
    rows = max(1, size.lines - 1)
    # Hide the cursor. A trailing newline on the last row would scroll and
    # leave a block cursor on the empty line under the panes.
    sys.stdout.write("\033[?25l\033[2J\033[H")
    sys.stdout.flush()
    with open("/tmp/sideby-demo-view.ready", "w", encoding="utf-8"):
        pass
    try:
        while True:
            left = fit(capture("sideby:0.0"), cols, rows)
            right = fit(capture("sideby:0.1"), cols, rows)
            lines = [" personal ".center(cols, "─") + "   " + " work ".center(cols, "─")]
            lines.extend(f"{a} │ {b}" for a, b in zip(left, right))
            lines = lines[: size.lines]
            sys.stdout.write("\033[?25l\033[H" + "\n".join(lines))
            sys.stdout.flush()
            time.sleep(0.1)
    except KeyboardInterrupt:
        sys.stdout.write("\033[?25h")


if __name__ == "__main__":
    main()
