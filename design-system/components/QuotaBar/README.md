The quota bar shows how much of a quota window is used: normal, running out, used up — readable in one glance.

Static rendition of the Panel's `.bar` rules (`components/bundle.css`); the meter layout around it is simplified from `.card .meter`.

## Use
- A 6px pill: `track` behind, fill `ok-bar`; wrap in `lvl-warn` (fill `warn-bar`, percent in `warn`) when running out and `lvl-fail` (fill `fail-bar`, percent in `fail`) when used up.
- Always show the percentage (and reset time) beside it: the bar fills miss 3:1 on `track` in the light themes, and state must not rest on color alone.
- Never make the normal bar red or amber, and never set warn/fail to the accent's hue.
- Width animates over 0.4 s; none under reduced motion.
