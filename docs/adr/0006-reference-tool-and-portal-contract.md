# ADR 0006: sideby is the reference Tool, and its Panel handler is the Portal contract

Date: 2026-10-06 · Status: accepted

## Context

The author runs several local tools next to sideby (a skills manager, a todo list, a blog reader, a project dashboard) behind one local server that shows each tool's page under its own `*.localhost` host with a shared top bar. Some of them may become open source later. They should then look and work the way sideby does: one package per tool, everything done through the CLI, one Agent Skill, a local web page in English and Chinese with configurable theme tokens.

sideby already has every piece such a tool needs: a plugin loader with trust checks, a Panel handler that another server can mount (`createPanelHandler`, README "Embed the panel"), theme tokens, a typed en/zh dictionary, the `--json` contract, a skill whose version follows the package, and leak checks. Nothing else uses these pieces yet, so their shape is still sideby's shape.

## Decision

- **Words**: a *Portal* (`CONTEXT.md`) is a separate local server that shows sideby's Panel next to other tools' pages. In design notes, a *Tool* is one package with a CLI, a Panel and one Agent Skill (sideby is one), and the *Kit* is the library other Tools will share; neither is part of sideby.
- **sideby is the reference Tool.** A new Tool copies its conventions:
  - every capability is a CLI command with `--json` first; the Panel shows state and calls the same core functions, and has no write action the CLI lacks (pages that are only for reading are the exception);
  - one Skill per Tool; `SKILL.md` routes to `references/*.md` and the Skill turns requests into CLI commands, never into direct file edits;
  - Panel text in English and Chinese, CLI output, `--json` and the Skill in English.
- **`createPanelHandler` is a stable contract for Portals.**
  - *Mounting*: a Portal mounts the handler in its own server process under a base path (for example `/panel`) and shows that path in an iframe on a page of the same host and port, so the Panel and that page share one origin. A top bar on another host cannot frame the Panel.
  - *What is promised*: every field of `PanelHandlerOptions` (`runtime` as an instance or a per-request factory, `basePath`, `allowedHosts`, `readOnly`, `version`, `theme`, and `lang` since the amendment below); the handler's `Promise<boolean>` result, `false` for a request outside `basePath` so the Portal can pass it on; its `token` property; every `PanelTheme` field (`colorScheme`, `header`, `light`, `dark`) and the `PanelThemeTokens` key names (the CSS variable names behind them are internal); and the `/api/health` answer, which has at least `app: "sideby"` and `version`. These change only like the `--json` contract: adding keeps compatibility; removing, renaming or changing meaning needs a new ADR.
  - *What the Portal must provide*: plain `http`, with the `Host` it serves listed in `allowedHosts`. Every `POST` requires an `Origin` of `http://<Host>`, so with https or a proxy that rewrites `Host` the Panel still loads its state but every action is refused, running Doctor and previewing quota setup included.
  - *Isolation*: the Panel keeps its own CSP (`frame-ancestors 'self'` included), nonce and token, and a Portal never injects markup into it. The trust boundary is the origin: any page on the same origin, the Portal's own included, can fetch the token and make changes. A Portal that also serves code it does not trust should give the Panel a host of its own.
  - Framing a Panel served from another origin, such as a standalone `sideby ui`, is not supported and would need its own ADR. Whatever else a Portal offers around the Panel (its top bar, opening folders in other apps) belongs to the Portal and is not part of this contract.
- **The Kit starts as a copy.** When a second Tool needs the loader, theme tokens, i18n or handler checks, they are copied out of sideby into the Kit, using sideby's token names. sideby does not depend on the Kit until a second Tool has used it without changes; until then sideby's copy is the reference.

## Follow-ups (not built yet)

- `--json` output gains an optional `_notice` field, used only to say that an installed sideby Skill is for another sideby version than the CLI (the same check as Doctor's `skill.outdated`, which compares for equality), so an agent sees it without running `doctor`. It reads only the installed `SKILL.md` front matter. Whether the error envelope carries it too is decided when it is built.
- No `--dry-run` for `doctor --fix` or `new`. `doctor` without `--fix` already shows what a fix would do. `new` does write (Shared Item links and copies, `json-key` entries, `proxy.env` for an API Account, the alias and the shell-init file), but it refuses an existing directory, a plugin can refuse it in `account.create.before` before anything is written, `--json` lists every step, and undoing it is removing the new directory, then `sideby alias rm <alias>` if it made one or `sideby shell-init --write` otherwise (what a plugin's `account.created` hook did is the plugin's).

## Amendment (2026-10-08): Panel language

The follow-up that gave `createPanelHandler` a `lang` option is built, so a Portal can keep the Panel's language in step with its own.

- `lang: 'auto' | 'en' | 'zh'`, default `auto`. It is checked when the handler is created, like `theme`: any other value throws a `TypeError` that names the allowed values.
- It follows the rule `theme.colorScheme` already has. `en` or `zh` wins over what the viewer saved and hides the Panel's own switch; the viewer's saved choice stays saved and applies again under `auto`. `auto` keeps the earlier order: saved choice, then browser language.
- It is a creation option only. A running Portal switches language by creating the handler again (the author's Portal starts a new worker with a new handler when its language changes). There is no per-request option and no query parameter.

## Why not the others

- **One package for every tool, sideby as a plugin of it**: one install, but sideby's published scope would change and one failing tool would break the others.
- **The Kit first, sideby depending on it now**: the Kit's interface would be shaped by one user only, and every Kit change would force a sideby release.
- **A Portal that injects its top bar into the Panel's HTML**: the Panel would need a weaker CSP to accept outside markup.

## Consequences

- Panel handler options and theme token names are now public promises to Portal authors as well as to plugin authors.
- For a while the same code lives in sideby and in the Kit; the Kit's README must name sideby as the source until the move.

## Revisit when

A second Tool is published, or a Portal needs something from the Panel that the handler options cannot express.
