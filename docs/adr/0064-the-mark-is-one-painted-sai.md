# ADR 0064: The mark is one painted Sai

Date: 2026-10-31 · Status: accepted

Supersedes ADR-0022 (and with it ADR-0020), the mark parts of the ADR-0006 amendment (2026-10-16) and the `logoColor` point of ADR-0050.

## Context

Since ADR-0022 the mark has been two vector buddies side by side, Bai (amber, behind) and Sai (blue, in front), drawn from shapes in `src/core/brand-mark.ts`, with a separate small cut of Sai alone below about 24 px. The maintainer has since restyled the brand's characters in ink and watercolour, and asked for the whole logo family (Panel header, Portal icon, favicon, menu bar and app icon) to follow: one painted Sai, not the pair.

- One buddy reads better small. The pair needed its own small cut to survive at 16 px; one buddy is already that cut, so every size shows the same picture.
- The painting matches the restyled banner and characters, so the mark, the README and the brand look like one family again.
- ADR-0022 rejected a painted raster because it blurred at 16 to 20 px and weighed about 40 KB per icon. Here the painting is prepared at each size by hand (64, 128, 256 and 1024 px), every place uses the one sharp at twice its size, and the weight is accepted: about 10 KB for the favicon and menu bar, 34 KB for the Panel header.

## Decision

- The mark is Sai, the blue buddy with a gold crown and a red cape, painted in ink and watercolour on a transparent background, with a soft paper shadow under his feet. There is no second buddy and no separate small cut.
- The paintings are PNGs in `assets/brand/sai-painted-<size>.png`, shipped in the npm package (`files` lists `assets/brand`). `src/core/brand-mark.ts` reads them (two levels above `src/`, three above `dist/src/`) and stays the single source:
  - The Panel header and empty state show the 128 px PNG as a `data:` image (`MARK_IMG`) on the existing light 40 px tile, 3 px in from its edge. The page's CSP already allows `img-src 'self' data:`.
  - `<basePath>/icon.svg` (`ICON_SVG`, 128 px) and `<basePath>/favicon.svg` (`FAVICON_SVG`, 64 px) are SVGs that hold the PNG as a `data:` image, still served as `image/svg+xml`. Browsers load `data:` images inside an SVG used as an image or a tab icon.
  - The Menu Bar Item loads the 64 px PNG directly (`MENUBAR_ICON_PNG`) at 18 pt for the status item and 30 pt for its card, in colour; the `gauge.with.needle` template symbol stays the fallback.
  - The app icon (`src/desktop/icon.ts`) decodes the smallest painting at least as large as it needs, scales it with an exact area average and lays it over the light tile on the macOS icon grid (824 of 1024, radius a quarter of the tile, same inset as the Panel), in pure Node. The Linux SVG icon is the tile plus the 1024 px PNG as a `data:` image.
  - The README demo's outro and the Design System's logos use the same paintings.
- The mark keeps its own colours whatever the Theme. `logoColor` (`--logo-fg`) no longer recolours it, since a painting has no body fill to set; the field and token stay so existing Themes and Portals still load. `logoBg` and `logoBorder` still style the tile.
- The vector buddies (`BUDDY`, `SAI`, `BAI`, `MARK`, the path rasteriser in `icon.ts`) are removed: nothing else drew them.

## Consequences

- Every size shows the same Sai, and the mark matches the restyled brand.
- The npm package grows by about 1.7 MB, almost all of it the 1024 px painting the app icon needs. The Panel page grows by about 46 KB (the inline header image).
- An installed app icon and menu bar keep the old mark until `sideby app install` and the Menu Bar Item run again from the new version. A Portal that shows `<basePath>/icon.svg` gets the new mark with the next sideby; the favicon link's version changes with the mark, so browsers fetch it again.
- The README's demo GIF and the menu bar screenshots show the old mark until they are retaken.
- A future change to the mark is new PNGs in `assets/brand/` at the same sizes; the app icon test checks the tile and the painting's blue centre, not individual shapes.
