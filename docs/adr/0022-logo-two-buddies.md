# ADR 0022: The logo is two buddies side by side

Date: 2026-10-16 · Status: superseded by ADR-0064

Supersedes the drawing of ADR-0020.

## Context

ADR-0020 made the mark two flat rounded-rectangle faces. The maintainer found the flat geometric shapes unattractive, and they did not look like the characters of the painted intro film and the banner, which people remember. A first set of flat geometric icons in the same grammar was rejected too.

Two candidates of the film's characters were compared:

- A painted raster from the animation engine. It matches the film, but it blurs at 16 to 20 px and weighs about 40 KB per icon.
- A clean vector redrawn following the logo-design skill (https://github.com/kaankiziltug/logo-design-skill). It stays legible at 16 to 20 px. Chosen.

ADR-0020's conclusions still hold: one colour per character, no diagonal layout (too close to WeChat's two bubbles), `logoColor` recolours the front one, and a small cut below about 24 px.

## Decision

- The mark is two cartoon buddies side by side, looking at each other: a rounded gumdrop body with short arms and feet, a thick ink outline (`#1e2a44`), big ink eyes with a light highlight, a small mouth and a small `>` chevron on the forehead. The amber buddy (`#f2b35e`, feet `#c98a35`, blue chevron) stands behind on the left; the blue buddy (`#3f8fc4`, the Panel's brand blue, feet `#29658e`, amber chevron) in front on the right.
- `src/core/brand-mark.ts` stays the single source: one buddy on a 64-unit grid, the two placements and the colours. The Panel header and empty state, `<basePath>/icon.svg`, `<basePath>/favicon.svg`, the app icon (`src/desktop/icon.ts`) and the Local tools Portal's icons are all built from it.
- In the Panel the blue buddy's body takes `--logo-fg`, so a Portal's `logoColor` still recolours it. Everything else is fixed. No `PanelTheme` field or token changes.
- `<basePath>/icon.svg` is the whole pair on a transparent square. Below about 24 px the blue buddy alone is the small cut: `<basePath>/favicon.svg`, the Panel's favicon.
  - Amendment 2026-10-16: the small cut is redrawn for a 16 pt browser tab rather than scaled down. On a 32 grid the body fills the width; arms, `>` and mouth are dropped; eyes are larger; the outline is 2 units (about 6% of the canvas). The Local tools Portal shows it in the browser tab of the sideby page.
- Amendment 2026-10-18: the buddies follow the redrawn crew of the brand design sheet. The forehead `>` is gone (it belongs to the brand's lead character only); both keep the same gumdrop body and are told apart by two props each in their own accent colour. Sai, the blue one, wears a gold crown and a red cape (`#e0685a`) and smiles; Bai, the amber one, has a bent green antenna and a green spare battery on his back (`#5bb06a`) and laughs. Bai's props are mirrored in the mark so the battery stays on his back as he turns towards Sai. The small cut is Sai alone at half scale on the 32 grid with body, eyes, cape and crown, as the sheet's tab icon.

## Consequences

- The logo, the intro film and the banner now share the same characters.
- The app icon is regenerated on the next `sideby app install`; an installed icon keeps the old mark until then. A Portal that shows `<basePath>/icon.svg` gets the new mark with the next sideby.
- The outline adds detail that a flat mark did not have; the small cut keeps it legible at 16 px by dropping the second buddy.
- A future change to the mark is one edit in `brand-mark.ts` plus the app icon test's sample points.
