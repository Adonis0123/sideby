# ADR 0001: Isolate Accounts by directory and run them side by side; never switch, rotate or proxy

Date: 2026-10-05 · Status: accepted

## Context

People with several AI coding accounts (work and personal subscriptions, a DeepSeek or GLM key, a relay) want to use them at the same time from the terminal, keep one set of skills, hooks and rules, and not have one login overwrite another.

Existing tools pick other trade-offs:

- cc-switch and magpie rewrite the Host's global config, so one provider is active at a time. cc-switch issues #1105, #1106 and #2908 ask for several subscriptions and several sessions at once.
- Some proxies pool subscription logins and rotate them when a Quota runs out. Anthropic forbids third parties proxying subscription credentials and has blocked such traffic server side since 2026-01.
- Every Host already supports an isolated config directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `PI_CODING_AGENT_DIR`). An Anthropic maintainer recommended exactly this in anthropics/claude-code#20131.

## Decision

- One Account is one directory. sideby launches the official Host binary with that directory selected and Hijack Variables cleared.
- sideby never edits a Host's global config to change which Account is active.
- sideby never reads a subscription credential to call a model, never pools logins, and never rotates Accounts when a Quota runs out. Choosing the next Account stays a human decision.
- Shared configuration is kept consistent by Shared Items and repaired by Doctor.

## Consequences

- Accounts can run side by side across Families, and a broken Account cannot affect another.
- sideby cannot offer automatic failover between subscriptions. This is intentional.
- The core idea is easy to copy (see Digital-Threads/aimux, combinatrix-ai/agenv). sideby's value has to come from Doctor's Host-specific knowledge, the Panel's Quota view, and Plugins.

## Revisit when

A Host ships built-in multi-account support that covers side-by-side runs, or a vendor states that separate config directories on one machine violate its terms.
