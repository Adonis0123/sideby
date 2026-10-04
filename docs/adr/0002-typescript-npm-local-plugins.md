# ADR 0002: TypeScript on npm, with Plugins loaded from local directories

Date: 2026-10-05 · Status: accepted

## Context

sideby needs Plugins written by users (Families and Hooks), a library entry another Node program can import (a request handler for the Panel), and installation on macOS and Linux.

Options considered:

1. TypeScript published to npm.
2. TypeScript compiled to a single binary with `bun build --compile`.
3. Node single executable application (SEA).
4. Go or Rust single binary.

## Decision

Option 1 for the first release.

- Node 22.18 and later strip TypeScript types by default, so `import()` loads a `.ts` Plugin from disk without a build step. Node refuses to strip types under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so the published package itself is compiled to `dist/` with `tsc`; sideby's own tests run the `.ts` sources directly.
- The package exposes two entries: the CLI and a library (`createPanelHandler`).
- Plugins come from local directories only. They may `import type` from sideby but never import its values; the API is passed in when a Plugin registers. This keeps Plugins working if sideby later ships as a Bun binary.
- Releases use npm trusted publishing with provenance. No long-lived npm token exists; the release workflow never runs on `pull_request_target`.

## Why not the others

- Bun binaries can load external `.ts` files, but a Plugin cannot import the host package, and a library for other Node programs would still need npm. Kept as the second stage.
- Node SEA cannot `import()` files from disk from an ESM entry (Node docs).
- Go or Rust cannot load TypeScript Plugins or be imported by a Node program.

## Consequences

- Users need Node 22.18 or later. Users who installed Claude Code natively may not have Node; the second stage addresses this with a binary, a Homebrew tap and an install script.
- Installing Plugins from npm is out of scope: it would run third-party code on the user's machine.

## Revisit when

Issues show that requiring Node blocks adoption, or Plugins need values from sideby that injection cannot provide.
