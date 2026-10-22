# ADR-0050: Themes are data files over two Built-in Themes

Status: accepted
Date: 2026-10-22

## Context

The Panel had one fixed light-blue palette: blue page background, blue borders, a pale blue main button and a navy dark mode. Users found it washed out, and not everyone wants blue. Until now only a Portal could change the colors (`PanelTheme`, ADR-0006); a user on the plain Panel could pick light or dark and nothing else.

Research (2026-10-22) on how other tools let users change colors: VS Code, Zed, Obsidian, Ghostty, Warp and WezTerm keep a theme as a data file in a known folder where every key may be left out and falls back to the default; Linear and Raycast generate a full theme from a few seed colors; Raycast, Ghostty and Linear check contrast themselves instead of trusting the author. For the palettes, Radix's 12-step scales give each step a fixed job (1–2 backgrounds, 3–5 component fills, 6–8 borders, 9–10 solid colors, 11–12 text), and many polished blue products use a neutral page with color only on actions, links, selection and focus.

## Decision

- **A Theme is data, never code.** A Theme File is JSON in `<config>/themes/<id>.json`: `schemaVersion`, `name`, an optional `base` (a Built-in Theme), an optional `accent` (one color that regenerates the accent roles) and optional `light` / `dark` maps of `PanelThemeTokens`. Values go through the same checks as a Portal Theme; an unknown key is a warning, not an error, so a file written for a newer sideby still loads. Plugins are local code with the user's full permissions; a color scheme needs none of that.
- **Two Built-in Themes.** Sky (default) keeps the Panel's original colors from before Themes existed: a light blue page, near-white cards, a pale blue main button with blue text, green, amber and red quota, and a navy dark mode; only the faint caption text was darkened to reach 4.5:1. New Leaf takes Radix Colors' `grass` with the `olive` gray (MIT), with only the page tinted.
- **Why Sky is tinted.** A first Sky with a near-neutral gray page, white cards and one blue accent for buttons and normal quota read as lifeless and generic in review; design guides agree that "A grey screen with one accent colour is the category default" (pbakaus/impeccable) and ask for tinted neutrals (Nutlope/hallmark: "Tint the greys"). A tinted page with green, amber and red quota matched the Panel's first look, which users preferred. Later tries (tinting every surface, Radix `blue`, an OKLCH blue-gray with a solid blue button) were each rejected in review, and the maintainer chose the original colors for Sky.
- **Quota bars are their own tokens.** New tokens `okBar`, `warnBar`, `failBar` and `track` let a Theme or Portal set these bars; adding them keeps the contract's version (ADR-0006).
- **Main button text may be 3:1.** A main button's label weighted 600 or more may sit at WCAG's 3:1 floor for bold text and controls. All other text keeps 4.5:1.
- **The mark does not follow the Theme.** `logoColor` defaults to `#3f8fc4` whatever the Theme; a Portal or Theme File can still set it.
- **Order: the Theme the user picked, then the Portal Theme, then the default.** Until the user picks a Theme, an embedded Panel shows the Portal's colors, so it matches its page; the Theme dialog shows them as a card of their own ("This page's colors"), in use. A Theme the user picks, the Default Theme included, wins over the Portal's colors, because a switch that changes nothing on screen reads as broken. What a Theme does not name (font, sizes, header) stays the Portal's. `sideby theme use default` drops the choice and gives the Portal back its colors; `default` is reserved and names no Theme File.
- **sideby checks contrast itself.** `sideby theme check` reports each text and control pair in light and dark, with a value that would pass. When a Theme in use fails, the Panel moves the failing color's lightness until it passes and says so in Settings.
- **The user's AI writes Themes, sideby does not call a model.** "Let AI pick my colors" is an AI Task (ADR-0027): the user's own Host writes a Theme File, runs `sideby theme check` and `sideby theme preview`, and runs `sideby theme use` only after the user agrees.

## Consequences

- `panel.theme` keeps meaning light, dark or system; the chosen Theme is the new `panel.colorTheme` key, so existing configs keep working.
- A Portal's colors are the default inside it, not a lock: a user who picks a Theme sees that Theme there too. A Portal that set only some colors sees the Default Theme behind them until then.
- Built-in values are generated from the maintainer's palette and committed as constants; a change to them is a normal code change that updates the README screenshots.
- Removing or renaming a Built-in Theme breaks configs that name it; sideby then falls back to Sky and says so.
- **A tab is one color.** Its icon always takes its label's color: both muted, both the accent once the tab is selected, over the accent's soft fill. Icons in their own colors beside gray labels read as generated and were rejected in review.
