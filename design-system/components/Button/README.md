Buttons run every action in the Panel: one main button per view (`btn-primary`), secondary buttons (`btn`), and quiet ones (`btn-ghost`).

Static rendition: these are the Panel's real `.btn` rules from `src/panel/page-styles.ts`, shipped in `components/bundle.css`. sideby has no component library, so there is no JS component; use the classes.

## Use
- One `btn-primary` per view, for the default path (AGENTS.md: "the default path is one clear action").
- `btn` for everything else; `btn-ghost` for Cancel and dismiss; `btn-sm` (height `ctl-h-sm`) inside cards and banners.
- Labels say what happens: "Switch account", "Fix", not "OK".
- Icons: a 15px stroke SVG before the label, `stroke: currentColor`, width 2.

## Tokens
Height `ctl-h` (34px), radius `ctl-radius`, text `control` style (13.5px, weight 600; the main button 650). Fill `surface`, border `border-strong`, text `btn-text`; hover `hover` / `btn-hover-border` / `btn-hover-text`; pressed `active`. Main: `primary`, `primary-border`, `on-primary`; hover `primary-hover`, `primary-hover-border`. Focus: 2px solid `focus` outline. Transitions 120 ms on background, border and color; none under reduced motion.
