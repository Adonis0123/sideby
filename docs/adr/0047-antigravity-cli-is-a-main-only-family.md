# ADR-0047: Antigravity CLI is a Main-only Family

Status: accepted
Date: 2026-10-21

## Context

Users ask for Antigravity CLI (`agy`, Google) next to Claude Code, Codex, Grok Build and pi. Every Family so far selects an Account through an environment variable that moves the Host's configuration directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`), and "Adding a family" in `AGENTS.md` requires one.

Tried with agy 1.4.4 on macOS on 2026-10-21:

- agy has no such variable or flag. It derives `$HOME/.gemini/antigravity-cli` (app data) and `$HOME/.gemini/config` (customization) from `HOME`. Its own guide confirms it: the paths are relative to the home directory, the sign-in lives only in the operating system's credential store, and switching accounts means `/logout` and signing in again.
- The sign-in is one fixed macOS keychain item, found through `$HOME/Library/Keychains`. With another `HOME` agy is signed out; given access to the login keychain it is signed in as the same account as before.

Running a second Account by setting `HOME` would also move git, ssh, gh and every other tool the agent runs, and could not give it a login of its own.

## Decision

Add a Main-only Family: one whose Host offers no way to run a second Account apart from the first.

- `FamilyDef` gets an optional `mainOnly: true` (install page: https://antigravity.google/docs/getting-started?tab=cli). A Main-only Family declares neither `selectVar` nor `layout.account`; registration rejects every other combination, so a plugin that forgets `selectVar` still fails `plugins check` with `select-var.missing`.
- Discovery finds only the Main Account of a Main-only Family and never scans HOME for others. Launch sets no selection variable for it.
- `Runtime.createAccount` refuses before writing anything, with `code: 'family-main-only'` and a message that says the Host cannot keep a second sign-in yet and to use the Main Account. This covers `sideby new`, `POST /api/accounts` and API Accounts (`new --api`, `sideby key`).
- The Panel shows no "Add account" for it, but one line saying sideby supports only the main account of this tool for now. `sideby families --json` adds `mainOnly: true` (an added field; `schemaVersion` stays 1, `selectVar` stays present for every other Family).
- Antigravity CLI is the first: id `agy`, title `Antigravity CLI`, Main Account `.gemini/antigravity-cli`, no Shared Items, no Identity, no Session History in v1, no default short command named `agy` (it would route every `agy` the user types through `sideby run`). Login state stays `unknown`: the sign-in lives in the keychain, which sideby never reads, and `loginState` cannot see the quota cache. A quota check that fails for want of a sign-in says so and names `sideby login agy:main`. Launch clears `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `AGY_ADC_AUTH`, `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_GENAI_USE_ENTERPRISE` and `ANTIGRAVITY_PROJECT_ID`, and keeps `GOOGLE_CLOUD_PROJECT` and `AGY_ACCOUNT`. AI Tasks drop `--dangerously-skip-permissions`. agy reads a prompt only from `-p`, `-i` or stdin, so `FamilyDef` gets an optional `promptArg` (additive): agy sets `--prompt-interactive`, and an AI Task passes `--prompt-interactive=<prompt>` instead of a positional prompt.
- sideby never sets `HOME` for a Host, and never links `.ssh`, `.gitconfig` or `Library/Keychains` into an Account to make a second one work.

## Consequences

Users see agy in the Panel, CLI and skill, with its quota and `sideby run agy`, but cannot run two agy logins side by side. "Adding a family" in `AGENTS.md` changes: a Host without a configuration-directory variable can still be a Main-only Family.

agy becomes a Handoff target only after a real cross-Family handoff into it has been verified, and is never the source of an Auto Handoff in v1.

Revisit when Google ships a variable that moves the configuration directory and a sign-in per directory, verified with two Accounts running at once. Then agy drops `mainOnly` and declares `selectVar`.
