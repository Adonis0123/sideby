// Generated from the shared UI component library (commit 975a5950e856). Do not edit by hand: run its
// add script again with --inline to update. Components: base, dropdown-menu.

/** Role declarations of the teal theme in light mode, such as `--primary: #0E8C88;`, ready for a rule body. */
export const UI_TOKENS_LIGHT = `--duration-fast: 120ms; --duration-base: 160ms; --duration-slow: 200ms; --ease-out: cubic-bezier(0.2, 0, 0, 1); --ease-in: cubic-bezier(0.4, 0, 1, 1); --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 10px; --radius-pill: 9999px; --background: #F9F9FB; --foreground: #1C2024; --sidebar: #F9F9FB; --card: #FCFCFD; --card-foreground: #1C2024; --popover: #FCFCFD; --popover-foreground: #1C2024; --muted: #F0F0F3; --muted-foreground: #60646C; --subtle-foreground: #8B8D98; --border: #E0E1E6; --border-strong: #CDCED6; --input: #D9D9E0; --hover: #F9F9FB; --primary: #0E8C88; --primary-foreground: #FFFFFF; --accent: color-mix(in srgb, #2BA5A0 12%, #FCFCFD); --accent-foreground: #04706D; --selected: color-mix(in srgb, #2BA5A0 12%, #FCFCFD); --nav-active: color-mix(in srgb, #2BA5A0 15%, transparent); --nav-active-foreground: #04706D; --link: #04706D; --ring: #37A29D; --page-tint: linear-gradient(color-mix(in srgb, #2BA5A0 10%, #F9F9FB) 0, #F9F9FB 180px); --track: #E8E8EC; --success: #27A644; --warning: #F0BF00; --danger: #EB5757; --info: #4EA7FC; --success-soft: color-mix(in srgb, #27A644 16%, transparent); --warning-soft: color-mix(in srgb, #F0BF00 20%, transparent); --danger-soft: color-mix(in srgb, #EB5757 16%, transparent); --warning-text: #A44D00; --danger-text: #641723; --disabled: #F0F0F3; --disabled-foreground: #B9BBC6; --chart-1: #2BA5A0; --chart-2: #4EA7FC; --chart-3: #27A644; --chart-4: #F0BF00; --chart-5: #FC7840; --tint: #F0FBFA; --tint-border: #A7E4E0; --shadow-accent: 0 12px 26px -14px #A7E4E0; --plate: #F7F2E8; --plate-border: #D7CCBA; --success-text: #193B2D; --primary-hover: #007D79; --primary-active: #006E6B; --secondary: #1C2024; --secondary-foreground: #FCFCFD; --secondary-hover: color-mix(in srgb, #1C2024 86%, #FCFCFD); --secondary-active: color-mix(in srgb, #1C2024 76%, #FCFCFD); --active: #F0F0F3; --accent-hover: color-mix(in srgb, #2BA5A0 18%, #FCFCFD); --accent-active: color-mix(in srgb, #2BA5A0 23%, #FCFCFD); --ring-halo: color-mix(in srgb, #37A29D 30%, transparent); --danger-solid: #D93B3B; --danger-solid-foreground: #FFFFFF; --danger-solid-hover: #C42F30; --danger-solid-active: #AE2526; --danger-soft-hover: color-mix(in srgb, #EB5757 24%, transparent); --danger-halo: color-mix(in srgb, #EB5757 22%, transparent); --info-soft: color-mix(in srgb, #4EA7FC 16%, transparent); --info-text: #113264; --overlay: color-mix(in srgb, #000000 40%, transparent); --shadow-popover: 0 12px 32px -12px rgba(0, 0, 0, 0.22), 0 2px 6px -2px rgba(0, 0, 0, 0.08); --nav-hover: color-mix(in srgb, #1C2024 6%, transparent); --nav-pressed: color-mix(in srgb, #1C2024 10%, transparent);`

/** The same roles in dark mode. */
export const UI_TOKENS_DARK = `--duration-fast: 120ms; --duration-base: 160ms; --duration-slow: 200ms; --ease-out: cubic-bezier(0.2, 0, 0, 1); --ease-in: cubic-bezier(0.4, 0, 1, 1); --radius-sm: 4px; --radius-md: 6px; --radius-lg: 8px; --radius-xl: 10px; --radius-pill: 9999px; --background: #111113; --foreground: #EDEEF0; --sidebar: #111113; --card: #212225; --card-foreground: #EDEEF0; --popover: #212225; --popover-foreground: #EDEEF0; --muted: #272A2D; --muted-foreground: #B0B4BA; --subtle-foreground: #696E77; --border: #2E3135; --border-strong: #43484E; --input: #363A3F; --hover: #272A2D; --primary: #0E8C88; --primary-foreground: #FFFFFF; --accent: color-mix(in srgb, #34ABA6 20%, #212225); --accent-foreground: #89C7C3; --selected: color-mix(in srgb, #34ABA6 20%, #212225); --nav-active: color-mix(in srgb, #34ABA6 24%, transparent); --nav-active-foreground: #89C7C3; --link: #89C7C3; --ring: #289591; --page-tint: linear-gradient(color-mix(in srgb, #34ABA6 10%, #111113) 0, #111113 180px); --track: #2E3135; --success: #27A644; --warning: #F0BF00; --danger: #EB5757; --info: #4EA7FC; --success-soft: color-mix(in srgb, #27A644 16%, transparent); --warning-soft: color-mix(in srgb, #F0BF00 20%, transparent); --danger-soft: color-mix(in srgb, #EB5757 16%, transparent); --warning-text: #FFCA16; --danger-text: #FF9592; --disabled: #212225; --disabled-foreground: #5A6169; --chart-1: #34ABA6; --chart-2: #4EA7FC; --chart-3: #27A644; --chart-4: #F0BF00; --chart-5: #FC7840; --tint: #05211F; --tint-border: #015F5C; --shadow-accent: none; --plate: #1A1712; --plate-border: #3B362D; --success-text: #3DD68C; --primary-hover: #007D79; --primary-active: #006E6B; --secondary: #EDEEF0; --secondary-foreground: #111113; --secondary-hover: color-mix(in srgb, #EDEEF0 86%, #212225); --secondary-active: color-mix(in srgb, #EDEEF0 76%, #212225); --active: #2E3135; --accent-hover: color-mix(in srgb, #34ABA6 23%, #212225); --accent-active: color-mix(in srgb, #34ABA6 26%, #212225); --ring-halo: color-mix(in srgb, #289591 18%, transparent); --danger-solid: #D93B3B; --danger-solid-foreground: #FFFFFF; --danger-solid-hover: #C42F30; --danger-solid-active: #AE2526; --danger-soft-hover: color-mix(in srgb, #EB5757 26%, transparent); --danger-halo: color-mix(in srgb, #EB5757 30%, transparent); --info-soft: color-mix(in srgb, #4EA7FC 16%, transparent); --info-text: #70B8FF; --overlay: color-mix(in srgb, #000000 60%, transparent); --shadow-popover: 0 16px 40px -12px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.06); --nav-hover: color-mix(in srgb, #EDEEF0 6%, transparent); --nav-pressed: color-mix(in srgb, #EDEEF0 10%, transparent);`

/** The components' rules (`ui-*` classes); they read only the roles above. */
export const UI_CSS = `.ui-root {
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", sans-serif;
  font-size: 13px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  color: var(--foreground);
  background: var(--background);
  -webkit-font-smoothing: antialiased;
}
.ui-root *, .ui-root *::before, .ui-root *::after { box-sizing: border-box; }
.ui-root :where(input, button, textarea, select) { font: inherit; }
.ui-num { font-variant-numeric: tabular-nums; }
.ui-sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}
.ui-menu {
  z-index: 50;
  min-width: 180px;
  max-width: calc(100vw - 16px);
  max-height: min(480px, 70vh, var(--radix-dropdown-menu-content-available-height, 70vh));
  padding: 4px;
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--popover);
  color: var(--popover-foreground);
  box-shadow: var(--shadow-popover);
  font-size: 13px;
  outline: none;
}
@supports (position-area: block-end) {
  .ui-menu[popover] { inset: auto; margin: 4px 0; position-area: block-end span-inline-end; position-try-fallbacks: flip-block, flip-inline; }
}
.ui-menu-label { padding: 8px 8px 4px; font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
.ui-menu-separator { height: 1px; margin: 4px -4px; border: 0; background: var(--border); }
.ui-menu-group { display: block; }
.ui-menu-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  outline: none;
}
.ui-menu-item > svg { width: 16px; height: 16px; flex: none; color: var(--muted-foreground); }
.ui-menu-item-inset { padding-left: 28px; }
.ui-menu-indicator { position: absolute; left: 8px; display: inline-flex; width: 14px; height: 14px; color: var(--accent-foreground); }
.ui-menu-indicator > svg { width: 14px; height: 14px; }
.ui-menu-item[aria-checked="false"] .ui-menu-indicator { visibility: hidden; }
.ui-menu-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ui-menu-meta { flex: none; margin-left: auto; padding-left: 16px; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--muted-foreground); }
.ui-menu-shortcut { margin-left: auto; font-family: inherit; padding-left: 16px; font-size: 12px; letter-spacing: 0.04em; color: var(--muted-foreground); }
.ui-menu-item:is(:hover, :focus-visible, [data-highlighted], [data-force="hover"], [data-force="focus"]):not(:disabled, [data-disabled], [aria-disabled="true"]) { background: var(--hover); }
.ui-menu-item:is(:active, [data-force="active"]):not(:disabled, [data-disabled], [aria-disabled="true"]) { background: var(--active); }
.ui-menu-item[role="menuitemradio"]:is([aria-checked="true"], [data-force="checked"]) { background: var(--accent); color: var(--accent-foreground); }
.ui-menu-item[role="menuitemradio"]:is([aria-checked="true"], [data-force="checked"]) .ui-menu-meta { color: var(--accent-foreground); }
.ui-menu-item[role="menuitemradio"][aria-checked="true"]:is(:hover, [data-highlighted]) { background: var(--accent-hover); }
.ui-menu-item[role="menuitemradio"][aria-checked="true"]:active { background: var(--accent-active); }
.ui-menu-item:is(:focus-visible, [data-force="focus"]) { box-shadow: inset 0 0 0 1px var(--ring); }
.ui-menu-item-danger, .ui-menu-item-danger > svg { color: var(--danger-text); }
.ui-menu-item-danger:is(:hover, :focus-visible, [data-highlighted], [data-force="hover"], [data-force="focus"]):not(:disabled, [data-disabled], [aria-disabled="true"]) { background: var(--danger-soft); }
.ui-menu-item-danger:is(:active, [data-force="active"]):not(:disabled, [data-disabled], [aria-disabled="true"]) { background: var(--danger-soft-hover); }
.ui-menu-item-danger:is(:focus-visible, [data-force="focus"]) { box-shadow: inset 0 0 0 1px var(--danger); }
.ui-menu-item:is(:disabled, [data-disabled], [aria-disabled="true"], [data-force="disabled"]) { background: transparent; color: var(--disabled-foreground); cursor: not-allowed; }
.ui-menu-item:is(:disabled, [data-disabled], [aria-disabled="true"], [data-force="disabled"]) :is(svg, .ui-menu-shortcut) { color: var(--disabled-foreground); }
.ui-menu:is(:popover-open, [data-state="open"]) { animation: ui-menu-in var(--duration-fast) var(--ease-out); }
@keyframes ui-menu-in { from { opacity: 0; transform: translateY(-2px); } }
@media (prefers-reduced-motion: reduce) { .ui-menu:is(:popover-open, [data-state="open"]) { animation: none; } }`
