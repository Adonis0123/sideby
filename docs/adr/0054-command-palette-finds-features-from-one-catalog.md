# 0054. The Command Palette finds features from one catalog, and the CLI shares it

Date: 2026-10-28 · Status: accepted

## Context

The Panel has four pages and a settings popover, and a beginner cannot tell where a setting lives. Well-made tools agree on a Cmd/Ctrl+K palette that groups pages, settings and actions, highlights a setting in place and shows recent items on an empty query (VS Code, GitHub https://docs.github.com/en/get-started/accessibility/github-command-palette, Linear, Raycast; Chrome and macOS settings search). The React libraries (cmdk, kbar) do not fit a vanilla page, and the Panel's CSP allows only nonce scripts, so no CDN library.

AGENTS.md asks every user-facing feature to land in the Panel, a command and the skill. An AI cannot press Cmd+K but can be asked "where is the language setting".

## Decision

- One declarative Search Catalog (stable id, kind, English and Chinese titles, synonyms, internal target, optional CLI command) feeds both the Panel and the CLI; a test checks every target exists.
- The Panel's palette searches pages, settings and actions; actions only open their existing preview or confirmation, and are disabled with a reason in a read-only Panel. A trailing row hands the query to Session History. Ranking is exact > prefix > contains, self-written, no dependency.
- `sideby commands <query> --json` is read-only and returns `{schemaVersion: 1, results: [{id, kind, title, panel, cliCommand|null}]}`, exit 0 with no results. `panel` is a readable location ("Settings → General → Language"); Panel hashes stay internal.

## Consequences

The three-place rule holds without an exemption. The verb `commands` keeps the search of features apart from `sideby history`. `id` and `kind` become public; `kind` is an open string consumers must tolerate.
