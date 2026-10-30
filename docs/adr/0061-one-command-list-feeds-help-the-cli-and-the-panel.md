# 0061. One Command List feeds `sideby --help`, `sideby commands` and the Panel

Date: 2026-10-30 · Status: accepted

## Context

Users want to see quickly which commands sideby has. The only list was a hand-written `sideby --help` in the order commands were added, about 90 lines with no grouping, and the Panel had none. The Command Palette (ADR-0054) finds features by name, not commands.

Well-made tools agree on a few things:

- clig.dev: "Lead with examples." and "Display the most common flags and commands at the start of the help text." (https://clig.dev/#help)
- tldr pages show about five examples per command, simplest first (https://github.com/tldr-pages/tldr/blob/main/CONTRIBUTING.md).
- RStudio cheatsheets: "Each group should address a common problem or task." (https://github.com/rstudio/cheatsheets)
- GitHub and Linear open a keyboard shortcut list with `?` and also offer a visible way to it (https://docs.github.com/en/get-started/accessibility/keyboard-shortcuts); Figma and VS Code also reach theirs from the command palette.
- AWS, Docker and Supabase docs give each command a copy button.
- Netlify generates its CLI reference from the code, so it never drifts (https://cli.netlify.com).

## Decision

- One declarative Command List (`core/cli-commands.ts`): stable id, task group, usage line, the English `--help` line, an English and Chinese one-line summary, an optional runnable example, an optional `common` rank and an optional Search Catalog id for its place in the Panel. Entries sideby runs itself (hooks, `update-check`) are left out; a test fails when `main.ts` dispatches a command the list does not name.
- `sideby --help` is generated from it, grouped by task with headings; every usage line and description it showed before stays.
- `sideby commands` with no words lists it (common first; `--json` gives `{schemaVersion: 1, common, groups}`, schema `commands-list`). With words it stays the Search Catalog search of ADR-0054, output unchanged.
- The Panel embeds it and shows it in a Commands dialog, opened by a top-bar button next to Search, by `?` outside a text field, and from the Command Palette. It reuses the palette's dialog, motion and navigation: each row has the command, a one-line description, an example, a copy button beside what it copies, and "Open in Panel" when the Panel has a place for it.

## Consequences

Help, CLI and Panel cannot drift: adding a command means adding one entry, and the coverage test says so. The help layout changes (grouped, rewrapped) but loses no content. `id`, the group ids and `featureId` become public in JSON; groups are an open set consumers must tolerate. The Chinese summaries are maintained next to the English ones in the same file.
