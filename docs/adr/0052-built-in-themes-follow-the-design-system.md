# ADR-0052: Built-in Themes follow the maintainer's design system

Status: accepted
Date: 2026-10-25

Supersedes the parts of ADR-0050 that name the Built-in Themes, the tinted Sky default and the 600 weight for main buttons. The rest of ADR-0050 (Theme Files, checks, order, AI Task) stands.

## Context

ADR-0050 shipped two Built-in Themes, a tinted Sky (default) and New Leaf, and rejected a neutral page with one accent as lifeless. Since then the maintainer built one design system for all of their tools: cool-gray neutrals, layers told apart by lightness instead of lines, and color only on the main button, the current item, links and focus. Each product changes only its interface accent. Seen side by side with the other tools, the tinted Sky looked like a different product, and the pale main button with blue text read as disabled.

For the main button four styles were tried in review: the accent with near-black text, the accent darkened to 4.5:1 with white text (grayish, "not that color"), the accent with a dark same-hue text ("unnatural"), and the accent at its highest in-gamut OKLCH chroma with white text. Only the last was accepted. Research on Jimeng (ByteDance), Arco and Semi found their solid buttons all use white text, at about 3.3:1 and 2.8:1 on Jimeng.

## Decision

- **Five Built-in Themes from the design system**: `teal` (the default), `leaf`, `celeste`, `claude` and `codex`. All share Radix slate neutrals, status colors and shape; only the accent changes. `codex` has no hue: a black main button in light mode and a white one in dark mode, as in the product itself.
- **`sky` is renamed `celeste`.** Config, Theme Files (`base`) and commands that name `sky` read it as `celeste`, so a Panel set up before keeps a Theme instead of falling back.
- **Main buttons: saturated accent, white text, weight 500, pill shape.** The accent keeps its hue with OKLCH chroma raised to the edge of sRGB, then its lightness set for about 4:1 in light mode and 3:1 in dark mode; each mode has its own button color. White text stays at the 3:1 floor for controls; the label weight drops from 600 to 500, as in Material 3, Primer, Radix and shadcn, because 600 looks heavy in 12–13px Chinese. New token `primaryRadius`.
- **Neutral surfaces, not tinted ones.** This reverses ADR-0050's "Why Sky is tinted": inside one design system shared by several tools, a consistent neutral base matters more than a tint on one of them. The accent gives the page its color through the main button, the current tab and selection.
- **Faint text still reads at 4.5:1.** The design system's faint gray (slate 9) is meant for placeholders, but the Panel also uses `faint` for captions, units and reset times people read. The Built-in Themes darken it to pass 4.5:1, and `faint` joins the contrast check against the page and card.

## Consequences

- Users on the old default see teal after updating; users who picked `sky` see `celeste`, the closest new Theme.
- A Theme File whose `faint` passed before but sits under 4.5:1 now shows an adjustment in Settings and fails `sideby theme check`.
- Built-in values stay generated from the design system and committed as constants; `faint` is the one Panel-specific override.
