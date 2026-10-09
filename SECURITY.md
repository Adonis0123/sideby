# Security

sideby is a local CLI. It starts the official Host binary on your `PATH` (Claude Code, Codex, Grok Build, or pi) with one config directory per account. It does not patch those binaries, and it does not call a model.

## What sideby does with credentials

Nothing sideby ships sends credential values off the machine. Built-in quota and usage readers make no network requests and do not call private quota endpoints (ADR-0003). They read local files, and for Claude Code the status-line payload the Host already hands to a local command.

- sideby does not read a subscription token to call a model, pool logins, or rotate accounts.
- `sideby list` and the panel show identity fields only: email, and for Claude Code the organization name. Codex's `id_token` is base64url-decoded only so the `email` claim can be shown. The token and every other claim are dropped and are never stored, logged, or returned.
- Values from `proxy.env`, `auth.json`, and `.claude.json` are never printed. Errors name the path or the variable, and for a parse error the line number only. The one setting shown as a Claude API account's model is `ANTHROPIC_MODEL`.
- Doctor checks those credential files for type and mode 600. The only content it reads is the single key a `json-key` shared item names (Claude's `mcpServers`).
- `sideby next` ranks accounts from quota data already on disk and starts the pick the same way `sideby run` does. It does not copy sessions or credentials between accounts.
- `launch` does not change the parent shell and clears each family's hijack variables for every account.

A plugin is local code with the user's full permissions. sideby does not sandbox plugins. Docs and `sideby plugins` say so.

## Supported versions

Only the version currently tagged `latest` on npm is supported. Older releases, including anything before the current `latest`, are not patched in place. Upgrade with `npm i -g sideby`.

## Reporting a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/Adonis0123/sideby/security/advisories/new) (Security Advisories). Do not open a public issue or discussion, and do not include token values, `proxy.env`, `auth.json`, or `.claude.json`.
