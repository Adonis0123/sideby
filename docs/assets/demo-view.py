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
    size = shutil.get_terminal_size((110, 32))
    cols = max(24, (size.columns - 3) // 2)
    rows = max(8, size.lines - 2)
    sys.stdout.write("\033[2J\033[H")
    try:
        while True:
            left = fit(capture("sideby:0.0"), cols, rows)
            right = fit(capture("sideby:0.1"), cols, rows)
            left_title = " personal ".center(cols, "─")
            right_title = " work ".center(cols, "─")
            sys.stdout.write("\033[H")
            sys.stdout.write(f"{left_title}   {right_title}\n")
            for a, b in zip(left, right):
                sys.stdout.write(f"{a} │ {b}\n")
            sys.stdout.flush()
            time.sleep(0.4)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
