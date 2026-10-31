# Logos

- `sideby-mark.png` — the mark: Sai, the blue buddy with a gold crown and a red cape, painted in ink and watercolour (ADR-0064), 1024px on a transparent background. The soft paper shadow under his feet is part of the painting. Use it on a light ground (`logo-bg`) — keep that tile light in dark mode too. From `assets/brand/` via `src/core/brand-mark.ts`.
- `sideby-mark.svg` — the same painting at 128px wrapped in an SVG (`ICON_SVG`), for places that want an SVG. Use at 24px and up.
- `sideby-favicon.svg` — the 64px painting in an SVG (`FAVICON_SVG`). Browser tabs; the menu bar (18pt) uses the same PNG.
- `sideby-banner.jpg` — the painted README banner with the same characters (`docs/assets/banner.jpg`). Marketing only, never UI.

Fixed colors: the mark is a painting and does not follow the Theme. Never recolor it, never pair it with a second buddy, never redraw it as vectors.
