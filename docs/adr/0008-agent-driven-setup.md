# ADR 0008: Let the user's agent set sideby up, from facts the CLI states

Date: 2026-10-08 · Status: accepted

## Context

Most people do not read the README. They tell their coding agent "install sideby" or "set up another Claude account for me, cc008". The agent then has to answer questions the docs answered only in part: which Host files a new Account shares with the Main Account, what the next free name is, which step needs the person. Spec §3.4 listed the Shared Items, but no user-facing page, `--help` text or the skill did, and Plugin Families (a local Cursor plugin, for example) are in no document at all. CLIs built for agents, such as the Lark CLI, give the agent its own quick start, a command per fact and a clear hand-off for browser sign-in.

Options considered:

- Write the Shared Items into the docs only. Plugin Families stay unknown, and every doc copy drifts from the code.
- A bootstrap command (`npx sideby setup`) that installs the CLI and the skill and signs in, as Lark and Firecrawl do. It would make sideby run npm and reach the network.
- Let the agent run the Host's sign-in in the background and pass the authorization link on, as the Lark skill does. Each Host signs in its own way (pi only inside its TUI), and none is verified to print a link without a terminal.
- Let the CLI state the facts (`sideby families`, `sideby new --next`), and keep the human steps to one command each.

## Decision

- The CLI is where an agent learns a Family's facts: `sideby families [family] --json` prints, for every loaded Family including plugins, the layout, select variable, sign-in, quota support and each Shared Item with its Share Mode and a fixed one-line meaning. Docs keep a readable copy for the built-in Families.
- `sideby new <family> --next` picks the next name and short command with the same functions the Panel uses, so an agent and the Panel give the same answer and no agent guesses a numbering scheme. sideby does not learn any prefix such as `cc`; it only continues the pattern it finds in the config.
- No bootstrap command. Installing the CLI and the skill are two documented commands the agent runs itself; sideby stays a program that calls no remote service.
- Sign-in stays with the person. The agent hands them `sideby login <ref>` as one line; filling `proxy.env` stays with them too.
- The guidance lives in three places that say the same thing: a copyable prompt in the README, the "Set up sideby for a user" section of `llms.txt`, and `references/setup.md` in the skill. `--help` points agents to them.

## Consequences

- `families --json` is a new public JSON contract (`schemas/families.json`), and the `meaning` sentences become part of what agents read; changing their sense needs the usual schema rules.
- Runtime gains `familyDetails()`. The Panel's naming helpers are now used by the CLI too, so a change to them changes both.
- Setup still has one human step per subscription Account.

## Revisit when

Every built-in Host can print its sign-in link without a terminal, or a widely used agent can show a link mid-turn reliably; then an agent-run sign-in hand-off like Lark's is worth adding.
