sideby keeps every account of every AI coding tool in one Panel. People glance at it for a second between coding tasks, so state reads first and decoration last.

## Content fundamentals

- The name is **sideby**, always lowercase, even at the start of a sentence.
- Write for a beginner. Say what happens and what the user gets, in plain words: "Switch account", "Quota resets in 2 h", not "weighted tokens" or "Host".
- Sentence case for labels and headings. No exclamation marks, no emoji in the UI.
- One clear default action per view. Details go behind a click.
- English and Chinese ship together; keep labels short enough to fit both.
- Never invent testimonials, customer names or usage numbers.

## Color

- Colors come from Themes. Four themes ship here: **Sky** (the default) and **New Leaf**, each with light and dark. Build on Sky · Light unless told otherwise; New Leaf is Radix `grass` over the `olive` gray.
- Page on `bg` (a tinted page, never plain gray); cards, fields and buttons on `surface`; quiet areas inside a card on `surface-2`. Borders: `border` for cards, `border-strong` for controls.
- Text: `text` for body, `muted` for labels and meta, `faint` for captions. In Sky · Light, set `faint` on `surface` rather than `bg` (4.47:1 on `bg`).
- Color means state: what is selected (`accent`, `accent-soft`, `active`), what needs a look (`warn`, `fail`), and how much quota is left (`ok-bar`, `warn-bar`, `fail-bar` on `track`). Never use color for decoration alone.
- Status text pairs with its soft fill: `ok` on `ok-soft`, `warn` on `warn-soft`, `fail` on `fail-soft`. Each status also carries a word or a percentage.
- Never set `warn`, `fail`, `warn-bar` or `fail-bar` to the accent's hue; never make `ok-bar` red or amber.
- Main button: `primary` with `on-primary` text and `primary-border`. Its label may sit at 3:1 because it is weight 650; all other text keeps 4.5:1.
- Avoid the three red lines from the 2026-10-22 review: a lifeless gray page with one blue accent; so much color it glares; half-colored navigation. A tab's icon always takes its label's color (both `muted`, or both `accent` on `accent-soft` when selected).

## Type

- System fonts only: `sans` (system-ui stack) for everything, `mono` for versions, aliases, paths and keyboard hints. Ship no web fonts.
- Body is `body` (14px / 1.5) with tabular numerals. Page title `title` (22px, 750). Section headings `heading` (15px, 650); account names `large` (16px, 650). Buttons `control` (13.5px, 600). Meta `small` (12.5px). Chips `chip`, tags `tag`.
- Headings take -0.01em letter spacing, the title -0.02em.

## Shape, space and depth

- Radii: `radius` (14px) for cards and panels; `ctl-radius` (8px) for buttons and fields; `chip-radius` for pills. Nested notes use `radius` − 4px.
- Heights: buttons `ctl-h` (34px), buttons inside cards `ctl-h-sm` (28px), fields `field-h` (36px).
- Page: content up to `content-width` (1180px) with `gutter` (24px) on each side. The Panel must also work at phone width.
- Depth: `shadow` on cards in light themes only; dark themes use borders. Menus and dialogs take `float-shadow`.

## States and motion

- Focus: a 2px solid `focus` outline, offset 1–2px, on every interactive element.
- Hover: secondary controls fill with `hover`; pressed with `active`.
- Ease in 120–200 ms (backgrounds, borders, colors); quota bar widths 0.4 s. Stop all of it under `prefers-reduced-motion`.
- Nothing jumps: views open at their final size, and a refresh with the same data redraws nothing.

## Components

Use the Panel's classes from `components/bundle.css` (its real stylesheet): `btn` / `btn-primary` / `btn-ghost` / `btn-sm`, `chip` and its `chip-*` states, `tag` and its `tag-*` states, and `bar` inside `lvl-warn` / `lvl-fail`. Read each component's guide before using it.

## Iconography

- The mark is two buddies side by side (`assets/Logos/sideby-mark.svg`), on a light 40px tile (`logo-bg`, 10px radius), even in dark mode. Below about 24px use `sideby-favicon.svg`. The mark keeps its colors whatever the Theme; only the front buddy's body follows `logo-fg`.
- UI icons are 15px inline stroke SVGs (`stroke: currentColor`, width 2, round caps and joins, no fill), colored like the text beside them.

## Not synced

- Not tokens: the font stacks, sizes and weights the rules read by name (`--font`, `--font-size`, `--button-weight`, …), the `spark` / `spark-soft` colors (derived with `oklch(from var(--accent) …)`), `focus-outline` (`2px solid var(--focus)`) and `focus-ring` (`none`). `components/bundle.css` declares them in a `:root` block before the rules, at their light values, so the components keep their type and focus outline.
- No font files: the Panel uses system fonts only.
- UI icons were not copied as files: they are inline SVG strings in `src/panel/page-script.ts`.
- Components took the read-only route: sideby's Panel is server-rendered HTML with one stylesheet, not a component library, so Button, Chip, Tag and QuotaBar are static previews styled by the real CSS. Cards, rows, dialogs, tabs and the summary strip are styled in `bundle.css` but have no preview card yet.
- `logo-line` is `transparent` in the dark themes; it is stored as `#00000000`.
