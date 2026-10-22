# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who run several AI coding accounts side by side on one machine (Claude Code, Codex, Grok Build, pi, Cursor CLI and others, often several accounts of one tool). While they code, they glance at the Panel many times a day to see which account is running low on quota, which one to switch to, and which one needs a fix. The Panel is usually open beside their work, or embedded in a Portal such as a personal tools page.

## Product Purpose

sideby keeps every account of every AI coding tool in one place: it creates and repairs account folders that share skills and settings, shows each account's quota and usage, starts the right account, and hands a task to another account when quota runs out. Success is that the user never has to think about which account to use or why one broke.

## Positioning

One local tool for all of a user's AI coding accounts across tools, read from local files and the tools' own CLIs, with no credential pooling and no private quota endpoints. Every feature is available three ways: a Panel button, a `sideby` command with `--json`, and the shipped skill, so the user can click it, type it, or ask their AI.

## Operating Context

- The Panel runs locally (`sideby ui`, a background server, a macOS menu bar app) and can be embedded by a Portal through `createPanelHandler`; a Portal may pass its own colors, which apply until the user picks a Theme.
- Light and dark, English and Chinese, on desktop widths and down to phone width.
- Glanced at between coding tasks, often for a second: the state of quota and what needs a look must read at once.

## Capabilities and Constraints

- Pages: Accounts (grouped by tool, quota bars, attention badges), Sessions, Context tuning, Auto Handoff, Settings.
- Colors come from Themes (spec §3.34, ADR-0050): two built-in Themes, Theme Files, a Portal's colors, and the user's own accent. Text keeps 4.5:1 contrast; a bold main button label 3:1.
- Quota states must be told apart at a glance: normal, running out, used up.
- The Panel's CSP, Host/Origin and token checks are never loosened.
- Interactions ease in 120 to 200 ms and stop under `prefers-reduced-motion`.

## Brand Commitments

- Name: sideby, lowercase. Mascot: two buddies side by side (ADR-0022). The maintainer allowed every color to change in the 2026-10-22 redesign as long as it looks good.
- Red lines from the 2026-10-22 review: never a lifeless gray page with one blue accent; never so much color that it glares; never half-colored navigation (icons in color while their labels stay gray).

## Evidence on Hand

- Demo HOME with fake accounts for screenshots: `scripts/demo-home.ts`; README screenshots in `docs/assets/`.
- No testimonials, customer names or usage numbers exist; do not invent them.

## Product Principles

1. The default is already right: a beginner reads the screen and knows what to do next.
2. State before decoration: color says what is selected, what needs a look and how much quota is left.
3. Every feature lives in the Panel, the CLI and the skill.
4. Nothing jumps: views open at their final size, and a refresh with the same answer redraws nothing.

## Accessibility & Inclusion

WCAG AA contrast in light and dark (4.5:1 text, 3:1 bold main button label and controls); no state shown by color alone; reduced motion respected.
