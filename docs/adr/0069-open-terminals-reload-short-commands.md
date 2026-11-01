# 0069 Open terminals reload short commands at their next prompt

Date: 2026-11-02. Status: accepted.

## Context

A short command is a shell function that `sideby shell-init` defines. Adding, renaming or removing one rewrote the
config and every `shellInitFile`, but a terminal that was already open kept the functions it loaded at start: the
new name did nothing there and the old one still worked until the user opened a new terminal. A child process
cannot change its parent shell, so the shell has to notice the change itself.

## Decision

- Each rewrite of the short commands writes a generation (the first 12 hex digits of the SHA-256 of the function
  lines) to the Shell Init Stamp, `<state>/shell-init.stamp`, in sideby's own state directory.
- The script `shell-init` prints carries its generation and a prompt hook (`add-zsh-hook precmd` in zsh,
  `PROMPT_COMMAND` in bash). Before each prompt the hook reads the stamp with the shell's builtin `read`, so no
  process starts. Only when the stamp holds a generation the terminal has not seen does it `unset -f` the functions
  the script defined and evaluate `sideby shell-init <shell>` again.
- A stamp that matches no script (the config edited by hand afterwards) causes one reload, not one per prompt.

## Consequences

- A rename in the Panel or with `sideby alias rename` works in every open terminal after one Enter.
- The hook writes nothing and reads one small file per prompt. It touches no Host directory and no rc file.
- A terminal started before this version has no hook and still needs to be reopened once.
