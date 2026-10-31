# ADR 0020: The logo is two faces side by side

Date: 2026-10-16 · Status: superseded by ADR-0022, then ADR-0064

## Context

The old mark was two blue half discs, the right one at 55% opacity. The maintainer found it plain, and the two shades read as one face split in two. The README demo used a third colouring (orange and blue halves). The Panel header, the empty state, the app icon (`src/desktop/icon.ts`), the demo GIF and the banner each drew their own copy.

Concepts were explored with the logo-design skill (https://github.com/kaankiziltug/logo-design-skill): three directions, tested at 16 to 256 px, in one colour, reversed, mirrored and on a shelf of 295 developer-tool logos. Rejected along the way:

- Two overlapping rounded squares with the shared area cut out. Distinct, but small sizes read as a pill or a toggle.
- A terminal split into two panes, `>` in one and `_` in the other. Clear, but it blends in with other terminal marks.
- Two faces placed diagonally. Too close to WeChat's two bubbles.
- Tall rounded faces. They read as ghosts or tombstones.

## Decision

- The mark is two wide rounded faces on one baseline, looking at each other: an amber one (`#f2b35e`) behind and a blue one (`#3f8fc4`, the Panel's brand blue) in front, with ink eyes (`#1e2a44`). A gap that follows the front face keeps them apart. Each face is one colour.
- `src/core/brand-mark.ts` holds the geometry (a 256-unit grid of rounded rectangles) and the colours. The Panel header and empty state, the app icon and the demo GIF's outro are all built from it.
- In the Panel the front face takes `--logo-fg`, so a Portal's `logoColor` still recolours it. The back face and the eyes are fixed. No `PanelTheme` field or token changes.
- Below about 24 px, where the two faces get too small, the front face alone is the small cut (favicon).

## Consequences

- The app icon is regenerated on the next `sideby app install`; an installed icon keeps the old mark until then.
- The animated intro's character uses the same faces and colours, so the logo, the film and the banner share one look.
- A future change to the mark is one edit in `brand-mark.ts` plus the icon test's sample points.
