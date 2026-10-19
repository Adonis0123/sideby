# 0036. `shell-init setup` writes one line to the shell rc file

Date: 2026-10-19 · Status: accepted

## Context

Short commands (`cc008`) and Pick Commands (`cc`) are shell functions. A new terminal has them only when the user's shell rc file loads `sideby shell-init`, or sources a `shellInitFile`. Until now the Panel and the CLI added a short command and said "works in a new terminal", which is not true for a user who never added that line; only the sideby skill told an AI to append it. AGENTS.md asks that sideby never leave the user to copy a snippet into a config file.

Tools that need the same line agree on its form: one `eval "$(<tool> init zsh)"` at the end of `~/.zshrc` (mise, Starship, zoxide; read 2026-10-19). Tools that write it for the user preview and reverse it: `conda init` has `--dry-run` and `--reverse`, `volta setup` creates the file when it is missing.

Options considered:

- Keep telling the user to add the line. Rejected: a beginner adds `cc`, types it, and gets "command not found".
- Write a `shellInitFile` and add a `source` line. Rejected for now: two files and a config key to explain, for a startup cost of one `sideby` run per new shell that `eval` already accepts.
- Append the `eval` line, marked, after a preview. Chosen.

## Decision

- `sideby shell-init setup [zsh|bash]` shows the block it would append to `$ZDOTDIR/.zshrc` (else `~/.zshrc`) or `~/.bashrc` and exits 10; `--yes` appends it; `--undo` removes exactly that block. The shell comes from `$SHELL`, zsh by default.
- The block is three marked lines around `eval "$(sideby shell-init <shell>)"`. Nothing is written when the file already names `sideby shell-init` or the config has a `shellInitFile` for that shell.
- A missing rc file is created (mode 644). A linked rc file (dotfiles) is written at its real target and stays a link. Every other line is kept, and nothing is written when the file changed while sideby read it.
- The Panel shows the line and the file wherever a short command is added and the line is missing; its button is the yes, and the toast offers Undo.

## Consequences

- This is the first file sideby writes outside its own folders and the Host files listed in AGENTS.md; AGENTS.md lists it with them.
- A user's own alias of the same name in the rc file still wins over the function; the guide says to remove it.
- An rc file the user edited inside the block is no longer sideby's to undo: `--undo` then reports `not-added` and changes nothing.
