// The Panel page's styles: design tokens (a host theme layers its values over them, see theme.ts) and the rules
// that read them. Every color, radius and size below comes from a token, so a host theme reaches every component.

import { type PanelThemeTokens, type ResolvedTheme, resolveTheme, THEME_TOKENS } from './theme.ts'
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from './themes.ts'

// The default Theme's colors (spec §3.34): every color token, as declarations for the token blocks below.
const DEFAULT_THEME = BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID) as (typeof BUILTIN_THEMES)[number]
const colorDecls = (tokens: PanelThemeTokens) =>
  Object.entries(tokens)
    .map(([k, v]) => `${THEME_TOKENS[k as keyof PanelThemeTokens]}: ${v}`)
    .join('; ')

// Colors defined from other tokens, before each scheme's Theme colors so a Theme can set them; repeated in both schemes so they follow that scheme's base colors. Dark mode keeps
// the logo tile light: the mark's ink outline (core/brand-mark.ts) needs a light ground. The mark's body stays the brand
// blue whatever the Theme (ADR-0050).
const DERIVED_COLORS = `
  --btn-text: var(--text); --btn-hover-text: var(--accent); --check: var(--focus);
  --logo-bg: var(--surface-2); --logo-fg: #3f8fc4; /* design-system-ignore: the mark's body keeps the brand blue (ADR-0050) */ --logo-line: var(--border);
  --focus-outline: 2px solid var(--focus); --focus-ring: none;
  --scrim: color-mix(in srgb, var(--text) 40%, transparent);`
// The usage chart (--spark) takes the main button's hue at a readable lightness, keeping its chroma: a black-and-white
// Theme gets a gray chart instead of a made-up color.
// Design tokens. A host theme (theme.ts) layers its values over these: light values after LIGHT_TOKENS, dark values after
// DARK_TOKENS. DARK_TOKENS sets every color token again, so a host's light colors never leak into dark mode, while
// type, shape and layout tokens are shared by both schemes.
const LIGHT_TOKENS = `
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-size: 14px; --small: 12.5px; --control-size: 13.5px; --heading-size: 15px; --large: 16px; --title-size: 22px;
  --title-weight: 750; --heading-weight: 650; --strong-weight: 600; --button-weight: 600; --primary-weight: 500;
  --radius: 14px; --ctl-radius: 8px; --primary-radius: 999px; --chip-radius: 999px; --ctl-h: 34px; --ctl-h-sm: 28px; --field-h: 36px;
  --content-width: 1180px; --gutter: 24px;${DERIVED_COLORS}
  --spark: oklch(from var(--primary) clamp(0.55, l, 0.62) c h); --spark-soft: oklch(from var(--primary) 0.83 calc(c * 0.6) h);
  ${colorDecls(DEFAULT_THEME.light)};
  --float-shadow: 0 10px 30px color-mix(in srgb, var(--text) 14%, transparent), 0 2px 6px color-mix(in srgb, var(--text) 6%, transparent);`
const DARK_TOKENS = `${DERIVED_COLORS}
  --scrim: rgba(0,0,0,.55); /* design-system-ignore: a dark page's dialog backdrop darkens it; the text color would wash it out */
  --spark: oklch(from var(--primary) clamp(0.7, l, 0.78) c h); --spark-soft: oklch(from var(--primary) 0.45 calc(c * 0.6) h);
  ${colorDecls(DEFAULT_THEME.dark)};
  --float-shadow: 0 12px 32px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.3);` // design-system-ignore: a shadow on a dark page is black whatever the Theme

/**
 * The page's style block: default tokens, the host's tokens over them, then the rules that read them. With
 * `colorScheme: 'auto'` the page follows the system unless the viewer picked light or dark in the Panel, which sets
 * `data-theme` on the root element.
 */
export function pageStyles(theme: ResolvedTheme = resolveTheme(undefined)): string {
  return tokenStyles(theme) + CSS
}

/** Only the token rules of `pageStyles`: the page swaps them in when the user picks another Theme (spec §3.34). */
export function tokenStyles(theme: ResolvedTheme): string {
  const rule = (decls: string[], sel = ':root') => (decls.length ? `${sel} { ${decls.join('; ')}; }\n` : '')
  const scheme = theme.colorScheme === 'auto' ? 'light dark' : theme.colorScheme
  let css = `:root {${LIGHT_TOKENS}\n  color-scheme: ${scheme};\n}\n${rule(theme.light)}`
  if (theme.colorScheme === 'auto') {
    const sel = ':root:not([data-theme=light])'
    css += `@media (prefers-color-scheme: dark) {\n${sel} {${DARK_TOKENS}\n}\n${rule(theme.dark, sel)}}\n`
    css += `:root[data-theme=dark] {${DARK_TOKENS}\n  color-scheme: dark;\n}\n${rule(theme.dark, ':root[data-theme=dark]')}`
    css += ':root[data-theme=light] { color-scheme: light; }\n'
  } else if (theme.colorScheme === 'dark') css += `:root {${DARK_TOKENS}\n}\n${rule(theme.dark)}`
  return css
}

const CSS = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: var(--font-size)/1.5 var(--font); font-variant-numeric: tabular-nums; }
[hidden] { display: none !important; }
.top-in, .wrap { max-width: var(--content-width); margin: 0 auto; }
.top-in { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 28px var(--gutter) 0; }
/* When the name, its version pill and the buttons do not fit one row, the buttons wrap below, on the right. */
.top-in { flex-wrap: wrap; row-gap: 10px; }
.top-in > .top-actions { margin-left: auto; flex-wrap: wrap; justify-content: flex-end; }
.wrap { padding: 20px var(--gutter) 40px; }
.header-bar .top { background: var(--surface); border-bottom: 1px solid var(--border); }
.header-bar .top-in { min-height: 84px; padding: 14px var(--gutter); }
.header-bar .wrap { padding-top: 20px; }
h1, h2, h3 { margin: 0; letter-spacing: -0.01em; }
h2 { font-size: var(--heading-size); font-weight: var(--heading-weight); }
b, strong { font-weight: var(--strong-weight); }
p { margin: 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 0.92em; }
.muted { color: var(--muted); }
.faint { color: var(--faint); }
.small { font-size: var(--small); }
.sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.sep { color: var(--faint); margin: 0 6px; }
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.brand h1 { font-size: var(--title-size); font-weight: var(--title-weight); line-height: 1.3; letter-spacing: -0.02em; }
.tagline { color: var(--muted); font-size: 13px; }
/* When the account data was read; the dot says whether it still refreshes on its own (green) or stopped (amber). */
#updated { display: inline-flex; align-items: center; gap: 6px; }
#updated.is-live::before, #updated.is-stale::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: var(--ok-bar); }
#updated.is-stale::before { background: var(--warn-bar); }
/* The running version, a quiet pill after the name; with a newer version it takes the accent and a dot (spec §3.23). */
.title-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.ver-pill { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border: 1px solid var(--border); border-radius: 999px; background: var(--surface); color: var(--muted); font: 500 11.5px/18px var(--mono); cursor: pointer; white-space: nowrap; }
.ver-pill:hover:not(:disabled), .ver-pill[aria-expanded="true"] { color: var(--on-primary); border-color: var(--primary-hover-border); background: var(--primary-hover); }
.ver-pill.has-update:hover:not(:disabled), .ver-pill.has-update[aria-expanded="true"] { color: var(--accent); border-color: var(--accent); background: var(--active); }
.ver-pill:disabled { cursor: default; }
.ver-pill:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.ver-pill.has-update { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.ver-pill.has-update::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.logo { display: inline-flex; flex: none; width: 40px; height: 40px; border-radius: 10px; background: var(--logo-bg); box-shadow: inset 0 0 0 1px var(--logo-line); }
/* desktop/icon.ts draws the same two half discs for the app icon. */
.logo svg { display: block; width: 100%; height: 100%; fill: var(--logo-fg); }
.top-actions { display: flex; align-items: center; gap: 8px; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.section-head > div:first-child { min-width: 0; }
.block { margin-bottom: 22px; }
.ic { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

/* Themes (spec §3.34): the cards in the Theme dialog, and the short fade while the page takes a new Theme. */
.theme-head { margin: 12px 0 8px; color: var(--muted); font-size: var(--small); }
.theme-head b { color: var(--text); font-weight: var(--strong-weight); }
/* Theme dots: a 28px dot per Theme; the hairline keeps a black or white dot visible on a page of the same color. */
.theme-dots { display: flex; flex-wrap: wrap; gap: 12px; margin: 0 0 18px; padding: 4px; }
.theme-dot { position: relative; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 50%; background: var(--dot); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 18%, transparent); cursor: pointer; transition: transform .12s; }
.theme-dot:hover:not(:disabled) { transform: scale(1.08); }
.theme-dot[aria-checked=true] { outline: 2px solid var(--dot); outline-offset: 2px; cursor: default; }
.theme-dot[aria-checked=true]::after { content: "✓"; position: absolute; inset: 0; display: grid; place-items: center; color: #fff; font-size: 14px; font-weight: 700; text-shadow: 0 0 2px rgba(0,0,0,.45); } /* design-system-ignore: the check sits on the dot's own color, white with a soft edge reads on every accent */
.theme-dot:disabled:not([aria-checked=true]) { opacity: .6; cursor: default; }
.theme-dot:focus-visible { outline: var(--focus-outline); outline-offset: 3px; }
.theme-dot[aria-checked=true]:focus-visible { outline: 2px solid var(--focus); }
.theme-status { display: flex; align-items: center; gap: 8px; margin: 0 auto 0 0; min-width: 0; color: var(--muted); }
.theme-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 6px 0; }
.theme-label { font-weight: var(--strong-weight); }
.theme-row input[type=color] { width: 40px; height: 30px; padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--ctl-radius); background: var(--surface); cursor: pointer; }
.theme-files { margin-top: 16px; display: grid; gap: 6px; }
.theme-file { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 0; border-top: 1px solid var(--border); }
.theme-file-name { display: flex; flex-direction: column; min-width: 0; }
.theme-bad { color: var(--fail); }
.theme-fade, .theme-fade * { transition: background-color .18s ease, color .18s ease, border-color .18s ease, fill .18s ease !important; }
@media (prefers-reduced-motion: reduce) { .theme-fade, .theme-fade * { transition: none !important; } }
/* Summary: four quiet numbers in one surface. */
.summary[hidden], #checkup[hidden] { display: none; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 18px; overflow: hidden; }
.stat { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; min-width: 0; padding: 14px 18px; border-left: 1px solid var(--border); text-align: left; }
.stat:first-child { border-left: 0; }
.stat-text { min-width: 0; }
.stat-label { color: var(--muted); font-size: var(--small); display: flex; align-items: center; gap: 6px; }
.stat-value { font-size: 22px; font-weight: var(--heading-weight); letter-spacing: -0.02em; line-height: 1.35; white-space: nowrap; }
.stat-sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat-btn { font: inherit; color: inherit; background: none; border: 0; border-left: 1px solid var(--border); cursor: pointer; transition: background-color .12s; }
.stat-btn:hover { background: var(--hover); }
.stat-btn[aria-pressed=true] { background: var(--warn-soft); }
.stat-warn .stat-value { color: var(--warn); }
.stat-ok .stat-value { color: var(--ok); }
.label-tip { display: inline-flex; align-items: center; gap: 6px; }

/* Toolbar */
.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
.search { position: relative; flex: 1 1 160px; min-width: 120px; display: block; }
.search-ic { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--faint); pointer-events: none; }
.search .search-input { padding-left: 34px; padding-right: 34px; height: var(--ctl-h); }
.kbd { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); font: 11px/16px var(--mono); color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; pointer-events: none; }
.search:focus-within .kbd, .search input:not(:placeholder-shown) ~ .kbd { display: none; }
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.tb-select { width: auto; height: var(--ctl-h); font-size: var(--control-size); }
.seg { display: inline-flex; align-items: center; gap: 2px; height: var(--ctl-h); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--ctl-radius); background: var(--surface); }
.seg-btn { display: inline-flex; align-items: center; gap: 5px; height: 100%; padding: 0 10px; border: 0; border-radius: calc(var(--ctl-radius) - 2px); background: transparent; color: var(--muted); font: inherit; font-size: var(--control-size); cursor: pointer; }
.seg-btn:hover { color: var(--text); }
.seg-btn[aria-selected=true] { background: var(--active); color: var(--text); font-weight: var(--strong-weight); }
.pages { margin: 0 0 14px; }
.row-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.tune-confirm { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--border); padding-top: 10px; }
.pk-row { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 1px solid var(--border); }
.pk-row p { margin: 0; }
.tune-confirm ul { margin: 0; padding-left: 18px; }
.tune-undo { margin: 0; }
.tune-details { margin-top: 4px; }
.tune-details summary { cursor: pointer; color: var(--muted); font-size: var(--small); }
.tune-detail { border-left: 2px solid var(--border); padding: 4px 0 4px 10px; margin: 6px 0; display: flex; flex-direction: column; gap: 4px; }
.tune-setting { display: flex; flex-direction: column; gap: 8px; border: 1px dashed var(--border-strong); border-radius: calc(var(--radius) - 4px); padding: 10px 12px; }
.tune-acct { display: flex; flex-direction: column; gap: 8px; margin: 18px 0; }
.tune-acct-head { display: flex; align-items: center; gap: 8px; }
.seg-btn[aria-pressed=true] { background: var(--active); color: var(--text); font-weight: var(--strong-weight); }
.seg-btn:focus-visible { outline: var(--focus-outline); outline-offset: 1px; box-shadow: var(--focus-ring); }
.acct-head { margin-bottom: 10px; justify-content: flex-start; column-gap: 14px; }
.acct-head h2 { display: flex; align-items: baseline; gap: 10px; }
#acct-count { font-weight: 400; }

/* Family groups */
.group { margin-bottom: 14px; min-width: 0; }
.group-list { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.group-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px 8px 8px; min-height: 48px; flex-wrap: wrap; }
.group-cards .group-head { padding: 0 0 8px; min-height: 0; }
.group-toggle { display: inline-flex; align-items: center; gap: 9px; min-width: 0; padding: 5px 8px 5px 4px; border: 0; border-radius: var(--ctl-radius); background: none; color: var(--text); font: inherit; cursor: pointer; }
.group-toggle:hover { background: var(--hover); }
.group-toggle:focus-visible { outline: var(--focus-outline); outline-offset: 1px; box-shadow: var(--focus-ring); }
.chev { color: var(--faint); transition: transform .15s; }
.group-toggle[aria-expanded=true] .chev { transform: rotate(90deg); }
.group-title { font-weight: var(--heading-weight); font-size: var(--heading-size); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group-count { color: var(--muted); font-size: 12px; background: var(--surface-2); border-radius: var(--chip-radius); padding: 0 8px; line-height: 20px; }
.group-meta { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.group-quota { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }

/* List rows: identity, one column per quota window, last used, menu; a click opens the details (model, tokens,
   Health) under them. Every column but the first has a fixed width, so the rows of all groups line up under the
   same column titles. --qn is the number of quota columns; the page sets it on #accounts. */
#accounts { --qn: 2; --q-w: 176px; --l-w: 92px; --m-w: 92px; --col-gap: 28px; }
.row, .col-head { display: grid; grid-template-columns: minmax(0, 1fr) calc(var(--qn) * var(--q-w) + (var(--qn) - 1) * var(--col-gap)) var(--l-w) var(--m-w); column-gap: var(--col-gap); align-items: center; min-width: 0; }
.row { grid-template-areas: "id quota last more" "detail detail detail detail" "notes notes notes notes"; padding: 11px 10px 11px 16px; border-top: 1px solid var(--border); transition: background-color .12s; }
.rows .row:hover { background: color-mix(in srgb, var(--hover) 55%, transparent); }
.row:first-child { border-top: 0; }
.row:last-child { border-radius: 0 0 var(--radius) var(--radius); }
.row-error .ident-name .name { color: var(--fail); }
.row { position: relative; }
/* Old quota keeps its colour (the colour is how full it is) and says its age in words. */
.att-tag { font-weight: 500; }
.att-tag .dot { width: 6px; height: 6px; }
.more-opts { display: flex; flex-direction: column; gap: 12px; }
.more-opts > summary { cursor: pointer; color: var(--muted); font-size: 13px; }
.more-opts[open] > summary { margin-bottom: 4px; }
.tune-custom > summary { cursor: pointer; color: var(--muted); font-size: 13px; margin: 4px 0; }
.ai-asks { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ai-ask { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--ctl-radius); background: var(--surface); color: var(--text); font: inherit; text-align: left; cursor: pointer; }
.ai-ask:hover { border-color: var(--btn-hover-border); color: var(--accent); }
.ai-ask .ic { width: 14px; height: 14px; color: var(--muted); flex: none; }
.arrange-text .link-btn { margin-left: 6px; }
.q-asof { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 11px; }
.q-asof .ic { width: 11px; height: 11px; }
.stat-act { align-self: flex-end; color: var(--accent); font-size: 12px; white-space: nowrap; }
.next-why { margin: 0 0 10px; max-width: 280px; line-height: 1.5; }
.next-cmd { display: block; margin-top: 8px; color: var(--muted); font-size: 11px; }
/* A Same Login (spec §3.21, ADR-0026): one row; opened, a short line per directory. */
.login-mark { display: inline-flex; flex: none; color: var(--muted); cursor: help; }
.login-mark .ic { width: 13px; height: 13px; }
.login-detail { flex-direction: column; gap: 8px; }
.login-detail .rd-note { margin: 0; }
.login-detail > .rd-browser { flex-direction: row; align-items: center; gap: 14px; }
.login-detail > .rd-browser > .rd-label { flex: none; width: 68px; }
/* The directories share one set of columns (subgrid), so a wider cell in one line moves every line alike. */
.login-dirs { display: grid; grid-template-columns: minmax(120px, 1fr) auto var(--l-w) minmax(0, 1.4fr) auto auto auto auto; column-gap: 14px; border: 1px solid var(--border); border-radius: var(--ctl-radius); background: var(--surface); }
.login-dir { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; padding: 6px 6px 6px 12px; }
.login-dir > * { justify-self: start; min-width: 0; }
.login-dir + .login-dir { border-top: 1px solid var(--border); }
.login-dir .ld-name { display: flex; align-items: center; gap: 6px; min-width: 0; }
.login-dir .ld-name .name { font-weight: var(--strong-weight); }
.login-dir .usage { justify-content: flex-start; }
.login-dir .btn .ic { width: 13px; height: 13px; }
/* The arrange mode (spec §3.25): a bar over the list, short rows, grips, up and down, pin. Drag only here. */
.arrange-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; padding: 8px 10px 8px 14px; border: 1px solid var(--primary-border); border-radius: var(--radius); background: var(--accent-soft); color: var(--text); }
.arrange-text { display: inline-flex; align-items: center; gap: 8px; }
.arrange-text .ic { width: 14px; height: 14px; color: var(--accent); }
.arrange-actions { display: inline-flex; align-items: center; gap: 12px; }
.row.row-arrange { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 10px 6px 8px; }
.row-arrange .ident { flex: 1; }
.row-arrange.is-pinned { background: color-mix(in srgb, var(--accent-soft) 60%, transparent); }
.arrange-tools { display: inline-flex; align-items: center; gap: 2px; }
.arrange-tools .icon-btn { width: 28px; height: 28px; }
.arrange-tools .icon-btn .ic { width: 14px; height: 14px; }
/* One width for "Pin to top" and "Unpin", so the arrows line up down the list. */
.arrange-tools .pin-btn { min-width: 96px; margin-left: 6px; justify-content: center; }
.pin-btn[aria-disabled="true"] { color: var(--faint); cursor: not-allowed; }
.drag-handle { width: 20px; height: 28px; color: var(--muted); cursor: grab; }
.drag-handle:hover { color: var(--accent); }
.drag-handle .ic { width: 14px; height: 14px; }
.drag-handle:active { cursor: grabbing; }
.group-head > .drag-handle { margin-right: -8px; }
.is-dragging { opacity: .45; }
.drop-before { box-shadow: inset 0 2px 0 var(--accent); }
.drop-after { box-shadow: inset 0 -2px 0 var(--accent); }
.menu-head { padding: 6px 10px 2px; color: var(--muted); font-size: 11px; font-weight: var(--strong-weight); }
/* The arrow at a row's start opens and closes its details; so does a click anywhere else in the row. */
.row-toggle { width: 28px; height: 28px; margin: -4px -6px -4px -8px; }
.fold-hit { cursor: pointer; }
.fold-hit .row-detail { cursor: auto; }
.fold-hit:hover .row-toggle { background: var(--hover); color: var(--text); }
.row-toggle[aria-expanded=true] .chev { transform: rotate(90deg); }
.row-toggle[aria-expanded=true]:not(:hover) { background: transparent; color: var(--muted); }
.fold-hit:hover .row-toggle[aria-expanded=true] { background: var(--hover); color: var(--text); }
/* The details under a row's name (a Same Login's after a dashed line). Their left edge is the name's: the open arrow (--ctl-h-sm,
   less its 14px of negative margins), 10px, the 26px mark, 10px and the pin's 18px. */
.row-detail { grid-area: detail; display: flex; flex-wrap: wrap; gap: 10px 36px; margin: 10px 0 2px calc(var(--ctl-h-sm) + 50px); padding-top: 10px; border-top: 1px dashed var(--border); cursor: default; }
.rd-item { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
/* An open account's details sit in one bordered panel under the name: four cells side by side (how it runs, its web
   sign-in, tokens, health), each a label above its value, with the same widths in every row. Without browser
   sign-ins (rd-nobr) there are three. Medium and narrow widths make it two by two; phones put one detail on each line,
   its label in front. */
.row-detail:not(.login-detail) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, .7fr); grid-template-areas: "run br use hl"; gap: 0; align-items: stretch; margin-bottom: 4px; padding: 0; border: 1px solid var(--border); border-radius: var(--ctl-radius); background: var(--surface-2); }
.row-detail.rd-nobr:not(.login-detail) { grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, .7fr); grid-template-areas: "run use hl"; }
.row-detail:not(.login-detail) > .rd-item { display: flex; flex-direction: column; gap: 5px; min-width: 0; padding: 10px 14px; }
.row-detail > .rd-run { grid-area: run; } .row-detail > .rd-browser { grid-area: br; }
.row-detail > .rd-usage { grid-area: use; } .row-detail > .rd-health { grid-area: hl; }
.row-detail:not(.login-detail) > .rd-item:not(.rd-run) { border-left: 1px solid var(--border); }
.row-detail .rd-val, .row-detail:not(.login-detail) .br-line { min-width: 0; min-height: 22px; display: flex; align-items: center; gap: 4px 10px; }
.row-detail:not(.login-detail) .br-line { flex-wrap: nowrap; }
.row-detail:not(.login-detail) .br-line > * { flex: none; }
/* A long email shortens itself rather than push "Change" out; its tooltip and the browser dialog have it whole. */
.row-detail:not(.login-detail) .br-btn { flex: 0 1 auto; }
.rd-none { color: var(--faint); }
.row-detail .usage { gap: 12px; }
.row-detail .u-text { flex-direction: row; align-items: baseline; gap: 8px; }
.row-detail .spark { height: 18px; }
:where(:root[data-width=medium], :root[data-width=narrow]) .row-detail:not(.login-detail) { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "run br" "use hl"; }
:where(:root[data-width=medium], :root[data-width=narrow]) .row-detail.rd-nobr:not(.login-detail) { grid-template-areas: "run run" "use hl"; }
:where(:root[data-width=medium], :root[data-width=narrow]) .row-detail:not(.login-detail) > :is(.rd-usage, .rd-health) { border-top: 1px solid var(--border); }
:where(:root[data-width=medium], :root[data-width=narrow]) .row-detail:not(.login-detail) > .rd-usage { border-left: 0; }
:where(:root[data-width=phone]) .row-detail:not(.login-detail) { grid-template-columns: minmax(0, 1fr); grid-template-areas: "run" "br" "use" "hl"; }
:where(:root[data-width=phone]) .row-detail.rd-nobr:not(.login-detail) { grid-template-areas: "run" "use" "hl"; }
:where(:root[data-width=phone]) .row-detail:not(.login-detail) > .rd-item { flex-direction: row; align-items: center; gap: 12px; padding: 8px 12px; }
:where(:root[data-width=phone]) .row-detail:not(.login-detail) > .rd-item:not(.rd-run) { border-left: 0; border-top: 1px solid var(--border); }
:where(:root[data-width=phone]) .row-detail:not(.login-detail) > .rd-item > .rd-label { flex: none; width: 96px; }
:where(:root[data-width=phone]) .row-detail:not(.login-detail) > .rd-item > :not(.rd-label) { flex: 1; }
:where(:root[data-width=phone]) .row-detail:not(.login-detail) .br-line { flex-wrap: wrap; }
:where(:root[data-width=phone]) .row-detail:not(.login-detail) .usage { flex-wrap: wrap; row-gap: 2px; }
.rd-label { color: var(--faint); font-size: 11.5px; font-weight: var(--strong-weight); white-space: nowrap; }
.rd-note { color: var(--muted); font-size: 12px; }
.row-detail .ident-sub { margin-top: 0; }
.att-dot { flex: none; }
.col-head { position: sticky; top: 0; z-index: 2; padding: 7px 10px 7px 16px; border-top: 1px solid var(--border); background: var(--surface); color: var(--faint); font-size: 11.5px; font-weight: var(--strong-weight); line-height: 1.3; white-space: nowrap; }
.col-head > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.col-head .quota > span { overflow: hidden; text-overflow: ellipsis; }
.ident { grid-area: id; display: flex; align-items: center; gap: 10px; min-width: 0; }
.ident-text { min-width: 0; flex: 1; position: relative; padding-left: 18px; }
/* The pin sits in the text column's own gutter, so the name and the email below it start at the same place. */
.ident-text .pin-slot, .ident-text .pin-mark { position: absolute; left: 0; top: 2px; margin: 0; }
.ident-name { display: flex; align-items: center; gap: 6px; min-width: 0; flex-wrap: wrap; row-gap: 3px; }
.ident-name .name { font-weight: var(--strong-weight); font-size: var(--font-size); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.ident-name .alias { color: var(--muted); font-family: var(--mono); font-size: 12px; white-space: nowrap; }
.ident-email { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.email-btn, .model-btn { all: unset; cursor: pointer; border-radius: 4px; }
.model-btn:hover { color: var(--text); text-decoration: underline dotted; }
.model-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.model-set { color: var(--accent); }
.md-now { display: flex; flex-direction: column; gap: 4px; }
.br-line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; min-width: 0; }
.br-acts { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.br-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.br-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--ctl-radius); }
.email-btn:hover { color: var(--text); text-decoration: underline dotted; }
/* A button is laid out as one box, so the parent's ellipsis does not reach its text: it ends its own. */
.ident-email .email-btn { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.email-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.br-btn { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; max-width: 100%; min-width: 0; }
/* A long browser user shortens itself; the button's tooltip and the browser dialog have it whole. */
.br-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.br-btn:hover { color: var(--text); text-decoration: underline dotted; }
.br-ico { width: 12px; height: 12px; flex: none; }
.ident-email + .ident-sub { color: var(--faint); margin-top: 0; }
.tools .tb-icon { width: var(--ctl-h); height: var(--ctl-h); border-color: var(--border-strong); background: var(--surface); }
.tools .tb-icon:hover { background: var(--hover); }
.tools .tb-icon[aria-pressed=true] { background: var(--active); color: var(--text); }
.display-panel { display: flex; flex-direction: column; gap: 10px; min-width: 240px; }
.dp-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.dp-label { color: var(--muted); font-size: var(--small); }
.dp-check { justify-content: flex-start; gap: 8px; cursor: pointer; font-size: var(--small); }
.ident-sub { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 1px; }
.plan { text-transform: capitalize; }
.row > .quota { grid-area: quota; }
.row > .last { grid-area: last; }
.ident-meta { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.ident-meta > :first-child { min-width: 0; }
.last-inline { display: none; }
.row > .row-end { grid-area: more; display: flex; align-items: center; justify-content: flex-end; gap: 4px; }
.row-run { width: 28px; height: 28px; color: var(--muted); }
.row-run .ic { width: 15px; height: 15px; }
.row-run:hover { color: var(--accent); }
.row-run.is-off, .row-run.is-off:hover { color: var(--faint); background: transparent; cursor: not-allowed; }
.row-desk.is-open { color: var(--accent); }
.card-head > .row-end { display: flex; align-items: center; gap: 2px; margin-left: auto; }
/* A pinned row's mark (spec §3.25, §3.27): a small muted outline pin right before the name, not a button. */
.pin-mark { display: inline-flex; flex: none; margin-right: -2px; color: var(--faint); }
.pin-mark .ic { width: 12px; height: 12px; }
/* The pin before the name (spec §3.27): always there when pinned; a fainter one on hover or focus in the row
   otherwise. The slot keeps its width either way, so the name never moves. */
.pin-slot { display: inline-grid; place-items: center; flex: none; width: 16px; height: 16px; margin: 0 -4px 0 -2px; padding: 0; border: 0; border-radius: 4px; background: none; color: var(--faint); cursor: pointer; opacity: 0; }
.pin-slot .ic { width: 12px; height: 12px; }
.pin-slot.is-on { opacity: 1; }
.row:hover .pin-slot:not(.is-on), .row:focus-within .pin-slot:not(.is-on), .card:hover .pin-slot:not(.is-on), .card:focus-within .pin-slot:not(.is-on) { opacity: .5; }
.pin-slot:hover, .pin-slot:focus-visible { opacity: 1 !important; color: var(--accent); background: var(--hover); outline: none; }
.ctx-anchor { position: fixed; width: 0; height: 0; pointer-events: none; }
.row-notes { grid-area: notes; display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }

/* Quota meters: percent and countdown over a bar colored by level (ok, warn at 60%, fail at 85% used). */
.quota { display: grid; grid-template-columns: repeat(var(--qr, var(--qn)), minmax(0, 1fr)); column-gap: var(--col-gap); row-gap: 4px; min-width: 0; }
.row > .quota { grid-template-columns: repeat(var(--qn), var(--q-w)); }
.meter { min-width: 0; }
/* The countdown never ends in an ellipsis: where the line is too short it wraps to a line of its own, at the right. */
.m-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; font-size: 12px; line-height: 1.35; white-space: nowrap; min-width: 0; }
.m-label { color: var(--muted); font-weight: var(--strong-weight); }
.m-pct { font-weight: var(--strong-weight); font-size: 13px; font-variant-numeric: tabular-nums; }
.m-unit { color: var(--faint); font-weight: 400; font-size: 11.5px; }
.m-reset { margin-left: auto; color: var(--faint); font-size: 11.5px; font-variant-numeric: tabular-nums; }
.m-passed { color: var(--muted); }
.m-none { color: var(--faint); }
.bar { height: 6px; border-radius: 999px; background: var(--track); overflow: hidden; margin-top: 5px; }
.bar > span { display: block; height: 100%; min-width: 0; border-radius: inherit; background: var(--ok-bar); transition: width .4s ease; }
.lvl-warn .bar > span { background: var(--warn-bar); } .lvl-warn .m-pct { color: var(--warn); }
.lvl-fail .bar > span { background: var(--fail-bar); } .lvl-fail .m-pct { color: var(--fail); }
.lvl-reset .m-pct { color: var(--muted); }
.q-note { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: var(--small); }
.link-btn { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-weight: var(--strong-weight); cursor: pointer; }
.link-btn.small { font-size: var(--small); }
.link-btn:hover:not(:disabled) { text-decoration: underline; }
.link-btn:disabled { color: var(--faint); cursor: not-allowed; }
.foot .link-btn { color: inherit; font-weight: inherit; }
.update-btn { border-color: var(--accent); color: var(--accent); }
.link-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; border-radius: 3px; }

/* Usage: total over cache hits, with the 7 day bars beside both lines. In the wide list the bars sit at the column's
   right edge, so they line up down the column whatever the totals. */
.usage { display: flex; align-items: center; gap: 12px; min-width: 0; }
.rows .usage { justify-content: space-between; }
.u-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.u-num { font-weight: var(--strong-weight); font-size: 13.5px; line-height: 1.3; white-space: nowrap; font-variant-numeric: tabular-nums; }
.u-unit { color: var(--faint); font-weight: 400; font-size: 12px; }
.rows .u-unit { display: none; }
.u-sub, .u-note { color: var(--faint); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.u-note { font-size: var(--small); color: var(--muted); white-space: normal; }
/* One slot per day, bars grow from a shared baseline; past days are a tint of the accent, today is the accent. */
.spark { display: inline-flex; align-items: flex-end; gap: 3px; height: 26px; flex: none; }
.spark i { display: flex; align-items: flex-end; width: 5px; height: 100%; }
.spark b { display: block; width: 100%; min-height: 4px; border-radius: 1.5px; background: color-mix(in srgb, var(--accent) 32%, var(--surface)); transition: background-color .12s; }
.spark i.zero b { height: 2px; min-height: 0; background: color-mix(in srgb, var(--faint) 30%, transparent); }
.spark i.today b { background: var(--accent); }
.spark i:not(.zero):hover b { background: color-mix(in srgb, var(--accent) 70%, var(--surface)); }
.spark i.today:hover b { background: var(--accent); }
/* Where relative colors work, both shades keep the accent's hue at a set lightness and a floor on chroma, so a dark or
   muted accent still gives a clear light tint for past days and a vivid bar for today. */
@supports (color: oklch(from red l c h)) {
  .spark b { background: var(--spark-soft); }
  .spark i.today:not(.zero) b, .spark i:not(.zero):hover b { background: var(--spark); }
}
.spark-lg { height: 36px; gap: 4px; }
.spark-lg i { width: 7px; }
.spark-lg b { border-radius: 2px; }
.last { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.health { font-size: 11.5px; line-height: 20px; padding: 0 8px 0 7px; gap: 5px; max-width: 100%; }
.health .dot { width: 6px; height: 6px; }

/* In the wide list the column titles name the windows; elsewhere each meter carries its label. */
.rows .m-label, .rows .m-unit { display: none; }

/* Chips and badges */
.badge { flex: none; display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #fff; font-weight: 700; font-size: 12.5px; letter-spacing: .02em; } /* design-system-ignore: white initials on each Host's fixed logo color */
.badge-logo { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); }
.badge svg { display: block; width: 20px; height: 20px; fill: currentColor; }
.badge-sm { width: 26px; height: 26px; border-radius: 7px; font-size: 10.5px; }
.badge-sm svg { width: 16px; height: 16px; }
.badge svg.ic { fill: none; stroke: currentColor; }
.badge-xs { width: 16px; height: 16px; border-radius: 4px; border: 0; background: none; }
.badge-xs svg { width: 13px; height: 13px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: var(--chip-radius); background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); font: inherit; font-size: 12px; line-height: 20px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chip-sm { font-size: 11px; line-height: 16px; padding: 0 6px; }
.chip-btn { cursor: pointer; transition: filter .12s, border-color .12s; }
.chip-btn:hover { border-color: var(--border-strong); filter: brightness(.97); }
.chip-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; box-shadow: var(--focus-ring); }
.chip-accent { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.chip-ok { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.chip-warn { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.chip-fail { background: var(--fail-soft); border-color: transparent; color: var(--fail); }
.chip .badge-xs { margin-left: -3px; }
/* Tags next to a name: short command, API, signed out, host missing; one size for all. */
.tag { display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 6px; border: 0; border-radius: 5px; background: var(--surface-2); color: var(--muted); font: inherit; font-size: 11px; font-weight: var(--strong-weight); line-height: 1; white-space: nowrap; }
.tag-alias { font-family: var(--mono); font-weight: 400; }
.tag-warn { background: var(--warn-soft); color: var(--warn); }
.tag-fail { background: var(--fail-soft); color: var(--fail); }
.tag-ok { background: var(--ok-soft); color: var(--ok); }
.tag .dot { width: 6px; height: 6px; }
.tag-btn { cursor: pointer; transition: filter .12s; }
.tag-btn:hover { filter: brightness(.96); }
.tag-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.group-wait { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: var(--small); }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); flex: none; animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .3; } }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.dot-ok { background: var(--ok-bar); } .dot-fail { background: var(--fail-bar); } .dot-warn { background: var(--warn-bar); }
.title-logo { display: flex; align-items: center; gap: 9px; min-width: 0; }

/* Cards view */
/* Cards in a row share one height, so their foot lines and buttons line up; the foot sits at the bottom. */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.panel, .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.panel { padding: 18px; }
/* A card (spec §3.27, 2026-10-20): one left edge for everything. The head is the mark, the name and the menu; under it
   who it is and when it was last used, how it runs, its quota (label and percent, bar, reset, one under the other, so
   two windows line up), its Chrome sign-in as one line, and a foot with tokens and the row's own buttons. */
.card { padding: 18px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.m-short { display: none; }
.card .m-full { display: none; } .card .m-short { display: inline; }
/* Who and how it runs are one quiet block under the name; the run line is small, as it is reference only. */
.card .ident-sub { font-size: 11.5px; color: var(--faint); }
.card-error { border-color: var(--fail); }
.card-head { position: relative; display: flex; align-items: center; gap: 8px; min-width: 0; }
/* A card's pin is a small badge on the corner of its mark, so it belongs to the account and the name keeps its place
   on every card, pinned or not. Unpinned, it shows only while the card is hovered, as a way to pin it. */
.card-head .pin-slot, .card-head .pin-mark { position: absolute; left: 17px; top: -6px; z-index: 1; display: inline-grid; place-items: center; width: 16px; height: 16px; margin: 0; border-radius: 50%; background: var(--surface); box-shadow: 0 0 0 1px var(--border-strong); color: var(--muted); }
.card-head .pin-slot .ic, .card-head .pin-mark .ic { width: 11px; height: 11px; }
/* Pinned reads as on: the accent, on its soft tint. */
.card-head .pin-slot.is-on, .card-head .pin-mark { color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 55%, var(--surface)); }
.card-head .pin-slot:hover, .card-head .pin-slot:focus-visible { background: var(--accent-soft); color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.card-head > .ident-name { flex: 1; min-width: 0; flex-wrap: nowrap; }
.card-head > .row-end { margin-left: auto; }
.card-id { display: flex; flex-direction: column; gap: 3px; margin-top: -8px; min-width: 0; }
/* A Same Login card names its other directories under who it is. */
.card-dirs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 3px; color: var(--muted); font-size: 12px; }
.card-dirs .tag-dir { gap: 6px; color: var(--text); }
.card-dirs .tag-dir .alias { color: var(--muted); font-family: var(--mono); font-weight: 400; }
.card .last-inline { display: flex; flex: none; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; margin-top: 1px; }
.card .last-inline::before { content: "·"; color: var(--faint); }
.card .quota { gap: 12px 24px; }
.card .meter { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: baseline; column-gap: 6px; row-gap: 5px; }
.card .m-top { display: contents; }
.card .m-label { grid-area: 1 / 1; white-space: nowrap; }
.card .m-pct { grid-area: 1 / 2; white-space: nowrap; }
.card .bar { grid-area: 2 / 1 / 3 / 3; height: 6px; }
.card .m-reset { grid-area: 3 / 1 / 4 / 3; margin-left: 0; }
.card .m-none { grid-area: 1 / 2; }
.card-br { display: flex; align-items: center; gap: 8px; min-width: 0; }
.card-br > .br-btn { flex: 0 1 auto; color: var(--accent); }
.card-br > :not(.br-btn) { flex: none; }
.br-none { display: inline-flex; align-items: center; gap: 4px; color: var(--faint); font-size: 12px; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); padding-top: 14px; margin-top: auto; min-width: 0; }
.card-side { display: flex; align-items: center; gap: 2px; flex: none; }
.card .row-notes { margin: 0; }

/* Buttons: .btn is the secondary (outlined) variant; .btn-primary is the one main action of a block; .btn-ghost is a
   quiet action such as Close. Two sizes: default (--ctl-h) for block actions, .btn-sm (--ctl-h-sm) inside cards, notes
   and banners. .icon-btn is a square ghost button for icons. */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--ctl-h); padding: 0 14px; border-radius: var(--ctl-radius); border: 1px solid var(--border-strong); background: var(--surface); color: var(--btn-text); font: inherit; font-size: var(--control-size); font-weight: var(--button-weight); line-height: 1; cursor: pointer; white-space: nowrap; text-decoration: none; user-select: none; transition: background-color .12s, border-color .12s, color .12s; }
a.btn:hover { text-decoration: none; }
.btn:hover:not(:disabled) { background: var(--hover); border-color: var(--btn-hover-border); color: var(--btn-hover-text); }
.btn:active:not(:disabled) { background: var(--active); }
.btn-primary { background: var(--primary); border-color: var(--primary-border); color: var(--on-primary); font-weight: var(--primary-weight); border-radius: var(--primary-radius); }
.btn-primary:hover:not(:disabled) { background: var(--primary-hover); border-color: var(--primary-hover-border); color: var(--on-primary); }
.btn-primary:active:not(:disabled) { background: var(--primary-active); border-color: var(--primary-hover-border); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--muted); }
.btn-ghost:hover:not(:disabled) { border-color: transparent; color: var(--text); }
.btn-sm { height: var(--ctl-h-sm); padding: 0 10px; font-size: var(--small); }
.btn svg { width: 15px; height: 15px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.btn:disabled { background: var(--surface-2); border-color: var(--border); color: var(--faint); cursor: not-allowed; }
.btn-ghost:disabled { background: transparent; border-color: transparent; }
.btn-danger { border-color: var(--fail); color: var(--fail); }
.btn-danger:hover:not(:disabled) { background: color-mix(in srgb, var(--fail) 10%, transparent); border-color: var(--fail); color: var(--fail); }
/* A busy button is disabled but keeps its variant, so a running action does not look unavailable. */
.btn[aria-busy=true]:disabled { cursor: progress; color: var(--muted); }
.btn-primary[aria-busy=true]:disabled { background: var(--primary); border-color: var(--primary-border); color: var(--on-primary); opacity: .85; }
.is-spinning svg { animation: spin .8s linear infinite; }
.icon-btn { display: inline-grid; place-items: center; width: var(--ctl-h-sm); height: var(--ctl-h-sm); padding: 0; border: 1px solid transparent; border-radius: var(--ctl-radius); background: transparent; color: var(--muted); cursor: pointer; font: inherit; }
.icon-btn:hover:not(:disabled), .icon-btn[aria-expanded=true] { background: var(--hover); color: var(--text); }
.more .ic { stroke-width: 3.2; width: 17px; height: 17px; }
.icon-btn:disabled { color: var(--faint); cursor: not-allowed; }
.top-actions .icon-btn { width: var(--ctl-h); height: var(--ctl-h); border-color: var(--border-strong); background: var(--surface); }
.top-actions .icon-btn:hover { background: var(--hover); }
.repo-link svg { width: 17px; height: 17px; fill: currentColor; }
.btn:focus-visible, .icon-btn:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible, .stat-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; box-shadow: var(--focus-ring); }
.btn:focus-visible { border-color: var(--focus); }
.note a, .banner a { color: inherit; text-decoration: underline; text-underline-offset: 2px; font-weight: var(--strong-weight); }

/* Notes and banners */
.note { background: var(--surface-2); border-radius: calc(var(--radius) - 6px); padding: 8px 11px; font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: center; }
.note b { color: inherit; }
.note-read .read-why { overflow-wrap: anywhere; }
.note-fail { background: var(--fail-soft); color: var(--fail); }
.note-warn { background: var(--warn-soft); color: var(--warn); }
/* A note in two lines: what is wrong, then the command to run (with its copy button and the install page). */
.note-line { flex-basis: 100%; min-width: 0; overflow-wrap: anywhere; }
.note-cmd { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.error-note { justify-content: space-between; gap: 12px; }
.error-note > span { min-width: 0; overflow-wrap: anywhere; }
.error-note > .note-sub { flex-basis: 100%; color: var(--text); }
.banner { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 11px 14px; border-radius: calc(var(--radius) - 2px); margin-bottom: 12px; border: 1px solid var(--border); background: var(--surface); }
.banner > div { min-width: 0; }
/* The text takes the room; buttons that no longer fit beside it move below it instead of squeezing it. */
.banner > div:not(.banner-actions) { flex: 1 1 260px; }
.banner-quiet { padding: 8px 14px; background: transparent; border-style: dashed; }
.banner-fail { background: var(--fail-soft); border-color: transparent; color: var(--fail); }
.banner-warn { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.banner ul { margin: 6px 0 0; padding-left: 18px; }
.net-countries { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0 2px; }
.net-cty { display: inline-flex; align-items: center; gap: 4px; height: var(--ctl-h-sm); padding: 0 10px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface); color: var(--text); font: inherit; font-size: var(--control-size); cursor: pointer; transition: background-color 150ms ease, border-color 150ms ease, color 150ms ease; }
.net-cty:hover { background: var(--hover); }
.net-cty[aria-pressed=true] { background: var(--active); border-color: var(--accent); font-weight: var(--strong-weight); }
.net-cty .chip { margin-left: 2px; }
@media (prefers-reduced-motion: reduce) { .net-cty { transition: none; } }
.rc-list { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 8px; }
.rc-row { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; display: grid; gap: 2px; }
.rc-row code { word-break: break-all; }
.banner-actions { display: flex; flex-wrap: wrap; gap: 8px; flex: 0 1 auto; }
.hp-rules { list-style: none; margin: 0; padding: 0; counter-reset: hp-rule; display: flex; flex-direction: column; }
.hp-rules > li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; column-gap: 16px; padding: 10px 0; border-bottom: 1px solid var(--border); }
.hp-rules > li:last-child { border-bottom: 0; }
.hp-rule-text::before { counter-increment: hp-rule; content: counter(hp-rule) '. '; color: var(--muted); font-variant-numeric: tabular-nums; }
.hp-rule-ctl { display: flex; align-items: center; gap: 8px; justify-self: end; }
.hp-rule-ctl:empty { display: none; }
.hp-rule-below { grid-column: 1 / -1; margin-top: 8px; }
.hp-rule-sub { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.hp-rules .seg { height: var(--ctl-h-sm); }
.hp-rules .seg-btn[aria-pressed=true] { background: var(--accent-soft); color: var(--accent); }
.hp-on-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.hp-on-row > p { margin: 0; }
.hp-ai-order { margin: 0; }
.hp-ai-order li .title-logo { min-width: 150px; }
.ah-cross { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 6px 12px; }
.ah-fam > summary { cursor: pointer; }
.hp-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.hp-steps li { display: flex; gap: 8px; }
.hp-steps li::before { content: '•'; color: var(--muted); }
.hp-steps li > div { flex: 1; min-width: 0; }
.hp-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.hp-rows li { display: grid; grid-template-columns: minmax(0, 16rem) 7rem minmax(0, 1fr); align-items: center; column-gap: 14px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.hp-rows li:last-child { border-bottom: 0; }
.hp-rows .num { font-variant-numeric: tabular-nums; }
.hp-rows li > .num { text-align: end; }
.hp-recent li { grid-template-columns: minmax(0, 1fr) max-content minmax(0, 12rem); }
.hp-recent li > .num { white-space: nowrap; }
#handoff-page > * + * { margin-top: 12px; }
#handoff-page > h3 { margin-top: 28px; }
#handoff-page > h3 + * { margin-top: 8px; }
:where(:root[data-width=narrow], :root[data-width=phone]) {
  .hp-rows li { grid-template-columns: minmax(0, 1fr) auto; row-gap: 2px; }
  .hp-rows li > :last-child { grid-column: 1 / -1; }
  .hp-rules > li { grid-template-columns: minmax(0, 1fr); row-gap: 8px; }
  .hp-rule-ctl { justify-self: start; }
  .hp-rule-sub { justify-content: flex-start; }
  .hp-rows li > .num { text-align: start; }
}
/* Sessions page (spec §3.32): one row per Live Session; a Session that needs the user gets the warning tint. */
#sessions-page > * + * { margin-top: 12px; }
.sess-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; column-gap: 12px; padding: 11px 10px 11px 16px; border-top: 1px solid var(--border); transition: background-color .15s; }
.sess-row:first-child { border-top: 0; border-radius: var(--radius) var(--radius) 0 0; }
.sess-row:last-child { border-radius: 0 0 var(--radius) var(--radius); }
.sess-row:only-child { border-radius: var(--radius); }
.sess-needs-you { background: var(--warn-soft); }
.sess-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.sess-label { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.sess-label > * { flex: none; }
.sess-title { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess-id { color: var(--muted); }
.sess-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 12px; min-width: 0; }
.sess-status { display: inline-flex; align-items: center; gap: 6px; }
.sess-needs-you .sess-status { color: var(--warn); font-weight: var(--strong-weight); }
.sess-needs-you .sess-dot { background: var(--warn-bar); box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn-bar) 25%, transparent); }
.sess-busy .sess-dot { background: var(--ok-bar); animation: pulse 1.4s ease-in-out infinite; }
.sess-unknown .sess-dot { background: transparent; border: 1px solid var(--faint); }
.sess-cwd { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess-guessed { cursor: help; }
.sess-run { flex: 0 1 auto; min-width: 0; max-width: 24em; }
.sess-run-title { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sess-run-more { flex: none; font-weight: var(--strong-weight); }
.sess-age { white-space: nowrap; }
.sess-actions { display: flex; align-items: center; gap: 4px; }
.sess-copy { min-width: 8.5em; justify-content: center; transition: background-color .15s, border-color .15s, color .15s; }
.sess-copy.is-copied { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.sess-copy .ic { width: 14px; height: 14px; }
.sess-copy-text { display: block; width: 100%; box-sizing: border-box; margin-top: 8px; padding: 8px; border: 1px solid var(--border); border-radius: var(--ctl-radius); background: var(--surface-2); color: var(--text); resize: none; }
.pop-sess-copy { width: min(440px, calc(100vw - 16px)); }
.sess-send .ic { width: 14px; height: 14px; }
.sess-msg { flex: none; animation: chip-in .18s ease-out; }
.sess-msg-paste { display: inline-flex; align-items: center; gap: 2px; border: 0; font: inherit; cursor: pointer; }
.sess-msg-paste .ic { width: 11px; height: 11px; transform: rotate(90deg); }
.sess-msg-paste:hover { filter: brightness(.96); }
@keyframes chip-in { from { opacity: 0; } to { opacity: 1; } }
.sess-row.flash { animation: flash-row 2.4s ease-out; }
/* Wide enough for every label it shows, so it keeps its size while sending. */
.seg-badge { display: inline-grid; place-items: center; min-width: 16px; height: 16px; margin-left: 6px; padding: 0 4px; border-radius: 8px; background: var(--warn-soft); color: var(--warn); font-size: 11px; font-weight: 600; line-height: 1; animation: chip-in .18s ease-out; }
.send-go { min-width: 8.5em; justify-content: center; }
.popover.pop-sess-paste { width: min(420px, calc(100vw - 24px)); }
.pop-actions { display: flex; justify-content: flex-end; }
/* "Send to it" (spec §3.32 step 2): the result and the line the user pastes into the target. */
.note-ok { background: var(--ok-soft); color: var(--ok); }
.note-ok .ic { flex: none; width: 16px; height: 16px; }
.send-line { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--ctl-radius); background: var(--surface-2); }
.send-line-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; color: var(--text); }
.send-line-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.ah-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: end; }
.tune-model { border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.tune-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tune-vals { display: flex; gap: 24px; }
.tune-num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tune-best { color: var(--ok); }
.ah-fam { border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.ah-fam-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ah-order { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ah-order li { display: flex; align-items: center; gap: 6px; }
.ah-order li .mono { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ah-add { display: flex; gap: 6px; }
.ah-steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.disabled-why { color: var(--muted); font-size: var(--small); margin-top: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
/* A thin ring with an arc that fades out behind its head: lighter than a thick broken circle at text size. */
.spin { display: inline-block; width: 14px; height: 14px; border-radius: 50%; background: conic-gradient(from 0deg, transparent 0 8%, color-mix(in srgb, currentColor 18%, transparent) 30%, currentColor); -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.75px), #000 calc(100% - 1.5px)); mask: radial-gradient(farthest-side, transparent calc(100% - 1.75px), #000 calc(100% - 1.5px)); animation: spin .75s linear infinite; vertical-align: -2px; flex: none; } /* design-system-ignore: #000 sets mask opacity, not a color */
@keyframes spin { to { transform: rotate(360deg); } }
.copy { display: flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0; }
.copy code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; overflow-x: auto; white-space: nowrap; color: var(--text); min-width: 0; }

/* Health check */
.diff { margin: 0; max-height: 260px; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); padding: 10px 0; font: 12px/1.55 var(--mono); }
.diff span { display: block; padding: 0 12px; white-space: pre; }
.diff .add { background: var(--ok-soft); color: var(--ok); } .diff .del { background: var(--fail-soft); color: var(--fail); } .diff .hunk { color: var(--faint); }
.filter-bar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 8px 10px; margin-bottom: 4px; border-radius: var(--ctl-radius); background: var(--surface-2); }
.findings { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.more-findings { margin-top: 10px; }
.finding { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); }
.finding .dot { margin-top: 7px; }
.finding.lvl-fail .dot { background: var(--fail-bar); } .finding.lvl-warn .dot { background: var(--warn-bar); }
.finding-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.finding-top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.hint { color: var(--muted); font-size: var(--small); overflow-wrap: anywhere; }
.all-good { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 12px 14px; border-radius: calc(var(--radius) - 4px); background: var(--ok-soft); }
.check-icon { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--ok); color: var(--surface); font-weight: 700; flex: none; }
.warn-icon { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--warn); color: var(--surface); font-weight: 700; flex: none; }
.fix-result { margin-top: 12px; padding: 10px 12px; border-radius: calc(var(--radius) - 4px); font-size: 13px; }
.fix-result.is-ok { background: var(--ok-soft); color: var(--ok); } .fix-result.is-warn { background: var(--warn-soft); color: var(--warn); }
.fix-result ul { margin: 6px 0 0; padding-left: 18px; }

/* Forms */
.form { display: flex; flex-direction: column; gap: 14px; }
.field { display: flex; flex-direction: column; gap: 6px; border: 0; padding: 0; margin: 0; min-width: 0; }
.field > span, .field > legend { font-weight: var(--strong-weight); font-size: var(--small); padding: 0; margin-bottom: 6px; }
.field > span { margin-bottom: 0; }
input[type=text], input[type=search], input[type=number], select { height: var(--field-h); border-radius: var(--ctl-radius); border: 1px solid var(--border-strong); background-color: var(--surface); color: var(--text); font: inherit; padding: 0 12px; width: 100%; transition: border-color .12s, box-shadow .12s; }
input[type=search] { -webkit-appearance: none; appearance: none; }
input[type=search]::-webkit-search-cancel-button { -webkit-appearance: none; }
input::placeholder { color: var(--faint); }
input[type=text]:hover:not(:disabled), input[type=number]:hover:not(:disabled), input[type=search]:hover, select:hover:not(:disabled) { border-color: var(--btn-hover-border); }
input[type=text]:focus, input[type=search]:focus, select:focus { border-color: var(--focus); }
input[type=text]:disabled, select:disabled { background-color: var(--surface-2); color: var(--faint); cursor: not-allowed; }
input.invalid { border-color: var(--fail); }
/* AI Tasks (spec §3.28): the text box, the key field, the example chips and the account and terminal pickers. */
input[type=password] { height: var(--field-h); border-radius: var(--ctl-radius); border: 1px solid var(--border-strong); background-color: var(--surface); color: var(--text); font: inherit; padding: 0 12px; width: 100%; }
textarea.ask-text { min-height: 64px; resize: vertical; border-radius: var(--ctl-radius); border: 1px solid var(--border-strong); background-color: var(--surface); color: var(--text); font: inherit; padding: 8px 12px; width: 100%; line-height: 1.45; }
input[type=password]:focus, textarea.ask-text:focus { border-color: var(--focus); }
textarea.ask-text:focus-visible, input[type=password]:focus-visible { outline: var(--focus-outline); outline-offset: 2px; box-shadow: var(--focus-ring); }
textarea::placeholder { color: var(--faint); }
.ask-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.ask-chips .chip { font: inherit; font-size: var(--small); text-align: left; white-space: normal; }
.ask-attach-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; }
.ask-files-wrap { display: grid; gap: 6px; }
.ask-files-wrap:empty { display: none; }
.ask-files { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.ask-file { position: relative; display: grid; gap: 2px; width: 104px; padding: 4px; border: 1px solid var(--border); border-radius: var(--ctl-radius); background: var(--surface); }
.ask-file.is-error { border-color: var(--fail); } .ask-file.is-error .ask-file-face { color: var(--fail); }
.ask-file-img, .ask-file-face { width: 94px; height: 64px; border-radius: calc(var(--ctl-radius) - 2px); }
.ask-file-img { object-fit: cover; display: block; }
.ask-file-face { display: grid; place-items: center; align-content: center; gap: 2px; background: var(--surface-2); color: var(--muted); }
.ask-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ask-file-x { position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; background: var(--surface); }
.ask-file-retry { position: absolute; top: 2px; right: 26px; width: 22px; height: 22px; background: var(--surface); }
.dialog.drop-on { outline: 2px dashed var(--focus); outline-offset: -6px; }
.ask-pick {display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.ask-setup .link-btn { display: inline-flex; align-items: center; gap: 6px; }
.ask-setup .ic { width: 14px; height: 14px; }
.fam-other { background: transparent; color: inherit; font: inherit; text-align: left; border-style: dashed; }
.q-ask { margin-left: 6px; }
/* The select draws its own chevron with two gradient strokes (the CSP allows no external images), so it follows the
   text color in both schemes and on hover. */
select { --chevron: var(--muted); appearance: none; padding-right: 32px; cursor: pointer; text-overflow: ellipsis;
  background-image: linear-gradient(45deg, transparent calc(50% - .8px), var(--chevron) calc(50% - .8px) calc(50% + .8px), transparent calc(50% + .8px)), linear-gradient(-45deg, transparent calc(50% - .8px), var(--chevron) calc(50% - .8px) calc(50% + .8px), transparent calc(50% + .8px));
  background-position: right 16px center, right 11px center; background-size: 5px 5px; background-repeat: no-repeat; }
select:is(:hover, :focus) { --chevron: var(--text); }
.check-row { display: flex; align-items: flex-start; gap: 8px; }
.check-row .check { flex: 1; }
.check-row .tip { margin-top: 12px; }
.check { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--ctl-radius); transition: border-color .12s, background-color .12s; }
.check:hover { border-color: var(--btn-hover-border); }
.check:has(input:checked) { background: var(--accent-soft); border-color: transparent; }
.check input { width: 16px; height: 16px; margin: 2px 0 0; flex: none; accent-color: var(--check); cursor: pointer; }
.check span { display: flex; flex-direction: column; gap: 2px; }
.check b { font-size: var(--small); }
.field-error { color: var(--fail); font-size: var(--small); }
.field-hint { color: var(--muted); font-size: var(--small); }
.field-hint:empty { display: none; }
.field-error:empty { display: none; }
.field-error.field-note { color: var(--muted); }
/* Grok Bot windows (ADR-0019): a simple row of their own, since they have no quota, usage or health columns. */
.app-row { display: flex; align-items: center; gap: 12px; padding: 11px 10px 11px 16px; border-top: 1px solid var(--border); min-width: 0; }
.app-row:first-child { border-top: 0; }
.app-row > .ident { flex: 1; }
.app-actions { flex: none; justify-content: flex-end; }
/* The open arrow of an account row is --ctl-h-sm wide less its 14px of negative margins. */
.app-gap { flex: none; width: calc(var(--ctl-h-sm) - 14px); }
.app-foot { display: flex; flex-direction: column; gap: 6px; padding: 10px 16px 12px; border-top: 1px solid var(--border); }
.app-foot > .btn { align-self: flex-start; }
.app-new { display: flex; gap: 8px; align-items: center; max-width: 420px; }
.app-new input { height: var(--ctl-h-sm); flex: 1; min-width: 0; }
.fam-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.fam-card { position: relative; display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid var(--border); border-radius: var(--ctl-radius); cursor: pointer; min-width: 0; transition: border-color .12s, background-color .12s; }
.fam-card:hover { border-color: var(--btn-hover-border); }
.fam-card:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.fam-card:has(input:focus-visible) { outline: var(--focus-outline); outline-offset: 2px; }
.fam-card.is-off { cursor: not-allowed; opacity: .6; }
.fam-card.is-off:hover { border-color: var(--border); }
.fam-text { display: flex; flex-direction: column; min-width: 0; }
.fam-title { font-weight: var(--strong-weight); font-size: var(--small); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fam-sub { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.preview { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 14px; margin: 0; padding: 10px 12px; border-radius: var(--ctl-radius); background: var(--surface-2); font-size: var(--small); }
.preview dt { color: var(--muted); }
.preview dd { margin: 0; overflow-wrap: anywhere; color: var(--text); }
.preview.is-draft dd { color: var(--faint); }
.created { display: flex; flex-direction: column; gap: 10px; }
.created-head { display: flex; align-items: center; gap: 10px; }
.steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
.steps li::marker { color: var(--faint); }
.steps li { min-width: 0; }
.steps li > span:not(.copy) { display: block; margin-bottom: 4px; }

/* Dialog */
.dialog { padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); color: var(--text); width: min(560px, calc(100vw - 24px)); max-height: calc(100vh - 48px); box-shadow: var(--float-shadow); }
.dialog[open] { display: flex; }
.dialog::backdrop { background: var(--scrim); }
/* The dialog box takes focus when it opens (showModal) but is not a control: no ring around it. Any other focusable
   element without its own rule gets the Theme's focus ring, never the browser's default blue. */
.dialog:focus, .dialog:focus-visible { outline: none; }
:where(:focus-visible) { outline: var(--focus-outline); outline-offset: 2px; }
.dlg-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px 4px; }
.dlg-head h2 { font-size: var(--large); }
.dlg-body { padding: 10px 18px 16px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
.dlg-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 var(--radius) var(--radius); }

/* Menu, tooltips, toasts */
.menu { position: fixed; z-index: 40; min-width: 230px; max-width: min(380px, calc(100vw - 16px)); padding: 4px; background: var(--surface); border: 1px solid var(--border); border-radius: calc(var(--ctl-radius) + 2px); box-shadow: var(--float-shadow); overflow-y: auto; overscroll-behavior: contain; }
.menu-item { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 10px; border: 0; border-radius: calc(var(--ctl-radius) - 2px); background: none; color: var(--text); font: inherit; font-size: var(--control-size); text-align: left; cursor: pointer; }
.menu-item .ic { flex: none; color: var(--muted); }
.menu-item:hover:not(:disabled), .menu-item:focus-visible { background: var(--hover); outline: none; }
.menu-item:disabled { color: var(--faint); cursor: not-allowed; }
.menu-label { flex: none; white-space: nowrap; }
/* The hint gives way first: it shrinks to an ellipsis so a long label never pushes it past the menu's edge. */
.menu-hint { min-width: 0; margin-left: auto; padding-left: 12px; color: var(--faint); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.menu-sep { height: 1px; margin: 4px 6px; background: var(--border); }
.menu-sub > .ic:last-child { margin-left: 6px; color: var(--faint); }
.menu-sub > .menu-label + .ic:last-child { margin-left: auto; }
/* A menu that scrolls fades at the edge that has more: a strip that stays at that edge inside the scroll, so the menu
   keeps its border and shadow. */
.menu.more-above::before, .menu.more-below::after { content: ""; position: sticky; display: block; height: 24px; margin: 0 -4px; pointer-events: none; z-index: 1; }
.menu.more-above::before { top: -4px; margin-bottom: -24px; background: linear-gradient(var(--surface), transparent); }
.menu.more-below::after { bottom: -4px; margin-top: -24px; background: linear-gradient(transparent, var(--surface)); }
/* Popover: the menu's floating box with free content (text, a few buttons), lighter than a dialog. */
.popover { width: 280px; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.popover p { margin: 0; }
.popover-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.popover-foot { padding-top: 8px; border-top: 1px solid var(--border); }
/* The header's settings popover: two segmented choices, then links to Remote Control and Auto Handoff. */
.set-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.set-label { color: var(--muted); font-size: 13px; white-space: nowrap; }
.set-row .seg { height: var(--ctl-h-sm); }
.set-check { align-items: flex-start; }
.set-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.set-hint { color: var(--faint); font-size: 12px; max-width: 260px; }
.set-link { margin: 0 -8px; width: calc(100% + 16px); }
.set-link .chip { margin-left: auto; }
/* Groups in the settings (spec §3.29): a small muted title, then its rows; a line between groups. */
.pop-settings { width: 340px; }
.set-group { display: flex; flex-direction: column; gap: 8px; }
.set-check .set-label { white-space: normal; }
.set-link .menu-label { flex: 1 1 auto; min-width: 0; white-space: normal; line-height: 1.3; }
.set-link { height: auto; min-height: 32px; padding-top: 6px; padding-bottom: 6px; }
.set-link .chip { flex: none; }
.set-group-title { color: var(--faint); font-size: 11px; font-weight: var(--strong-weight); letter-spacing: .02em; }
.popover .set-sep { margin: 0 -14px; }
.set-hint .link-btn { font-size: 12px; }
.set-help { margin: 6px 0 0; padding-left: 16px; display: grid; gap: 3px; }
.note-fail-text { color: var(--fail); }
.hk-field { flex: none; display: flex; align-items: center; gap: 10px; }
.hk-select { flex: none; width: auto; min-width: 150px; }
.hk-custom { display: flex; justify-content: flex-end; margin-top: 8px; }
.note-warn-line { display: block; margin-top: 4px; color: var(--warn); }
.hk-rec { min-width: 140px; padding: 6px 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--text); font: 13px/18px var(--mono); text-align: center; cursor: pointer; }
.hk-rec:hover:not(:disabled) { border-color: var(--accent); }
.hk-rec:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.hk-rec.unset { color: var(--faint); font-family: var(--font); }
.hk-rec.recording { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent); color: var(--accent); font-family: var(--font); }
.hk-rec.taken { border-color: var(--fail); color: var(--fail); }
.mb-help-title { margin: 16px 0 4px; font-size: 13px; font-weight: var(--strong-weight); }
.as-details { margin-top: 8px; }
.as-details summary { color: var(--muted); font-size: 12px; cursor: pointer; }
.as-details[open] summary { margin-bottom: 6px; }
/* "More settings…" stays at the bottom of a popover that scrolls. */
.set-more { margin: 4px -14px -12px; width: calc(100% + 28px); height: 40px; padding: 0 16px 0 17px; border-top: 1px solid var(--border); border-radius: 0 0 var(--radius) var(--radius); }
.set-more .ic { margin-left: auto; }
/* The settings dialog: the sections in a list at the side, one section at a time beside it (spec §3.29). */
.dialog.dialog-wide { width: min(760px, calc(100vw - 24px)); }
.set-dialog { display: grid; grid-template-columns: 168px minmax(0, 1fr); gap: 0 24px; min-height: 380px; }
.set-nav { display: flex; flex-direction: column; gap: 2px; padding-right: 16px; border-right: 1px solid var(--border); }
.set-tab { all: unset; box-sizing: border-box; display: flex; align-items: center; min-height: 32px; padding: 6px 10px; border-radius: var(--ctl-radius); color: var(--muted); font-size: 13px; cursor: pointer; }
.set-tab:hover { background: var(--hover); color: var(--text); }
.set-tab[aria-selected=true] { background: var(--hover); color: var(--text); font-weight: var(--strong-weight); }
.set-tab:focus-visible { outline: var(--focus-outline); outline-offset: 1px; }
.set-pane { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.set-pane-title { margin: 4px 0 0; font-size: 15px; font-weight: var(--strong-weight); }
.set-foot { margin: -6px 0 4px; color: var(--muted); font-size: 12.5px; line-height: 1.5; }
.set-dialog .set-hint { max-width: none; }
.set-dialog .set-link { margin: 0 -10px; width: calc(100% + 20px); }
:where(:root[data-width=narrow], :root[data-width=phone]) {
  .set-dialog { grid-template-columns: minmax(0, 1fr); gap: 14px; min-height: 0; }
  .set-nav { flex-direction: row; overflow-x: auto; padding: 0 0 8px; border-right: 0; border-bottom: 1px solid var(--border); }
  .set-tab { flex: none; white-space: nowrap; }
}
.as-code { display: block; margin: -4px 0 4px; padding: 8px 10px; border-radius: var(--ctl-radius); background: var(--hover); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.set-dot { background: var(--warn-bar); }
.tip { display: inline-flex; position: relative; vertical-align: middle; }
.tip-btn { display: inline-grid; place-items: center; width: 16px; height: 16px; padding: 0; border: 1px solid var(--border-strong); border-radius: 50%; background: var(--surface); color: var(--muted); font: 700 10px/1 var(--font); cursor: help; }
.tip-btn:hover, .tip.is-open .tip-btn { color: var(--text); border-color: var(--muted); }
.tip-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.tip-body { display: none; position: fixed; z-index: 60; width: max-content; max-width: min(280px, calc(100vw - 16px)); padding: 7px 10px; border-radius: 7px; background: var(--text); color: var(--bg); font-size: 12px; font-weight: 400; line-height: 1.45; letter-spacing: 0; box-shadow: var(--float-shadow); pointer-events: none; text-align: left; white-space: normal; }
.tip.is-open .tip-body, .tip-float.is-shown { display: block; }
.toasts { position: fixed; inset: auto auto 20px 50%; margin: 0; padding: 0; border: 0; background: none; color: inherit; overflow: visible; transform: translateX(-50%); z-index: 50; display: flex; flex-direction: column; align-items: stretch; gap: 8px; width: max-content; max-width: calc(100vw - 24px); pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; max-width: min(460px, calc(100vw - 24px)); min-height: 40px; padding: 6px 6px 6px 14px; border-radius: calc(var(--ctl-radius) + 2px); background: var(--surface); color: var(--text); border: 1px solid var(--border); box-shadow: var(--float-shadow); font-size: 13px; animation: toast-in .18s ease-out; }
.toast-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ok); }
.toast-fail .toast-dot { background: var(--fail); } .toast-accent .toast-dot { background: var(--accent); } .toast-plain .toast-dot { background: var(--faint); } .toast-info .toast-dot { background: var(--warn); }
.toast-text { min-width: 0; overflow-wrap: anywhere; }
.toast-action { flex: none; height: 28px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--ctl-radius); background: var(--surface); color: var(--text); font: inherit; font-weight: var(--button-weight); cursor: pointer; }
.toast-action:hover { background: var(--hover); }
.toast-x { flex: none; display: inline-grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 6px; background: none; color: var(--faint); cursor: pointer; }
.toast-x:hover { color: var(--text); background: var(--hover); }
.toast-x .ic { width: 13px; height: 13px; }
.toast.bump { animation: toast-bump .25s ease-out; }
@keyframes toast-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
@keyframes toast-bump { 50% { transform: scale(1.03); } }
.conn { position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 55; display: flex; align-items: center; gap: 8px; max-width: calc(100vw - 24px); padding: 8px 14px; border-radius: var(--chip-radius); background: var(--warn-soft); color: var(--warn); border: 1px solid var(--border); box-shadow: var(--float-shadow); font-size: 13px; font-weight: var(--strong-weight); }

/* Empty, loading and filtered states */
.empty { text-align: center; padding: 36px 20px; background: var(--surface); border: 1px dashed var(--border-strong); border-radius: var(--radius); display: flex; flex-direction: column; align-items: center; gap: 12px; }
.empty-sm { padding: 28px 20px; }
/* The empty state is a block of its own, apart from what follows it (Grok Bot windows). */
#accounts > .empty { margin-bottom: 12px; }
.empty-fail { border-color: var(--fail); border-style: solid; background: var(--fail-soft); color: var(--fail); }
.empty h3 { font-size: 17px; font-weight: var(--heading-weight); }
.empty p { max-width: 520px; overflow-wrap: anywhere; }
.host-list { list-style: none; padding: 0; margin: 4px 0; display: flex; flex-direction: column; gap: 8px; min-width: min(360px, 100%); text-align: left; }
.host-list li { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); }
.host-list li > span:nth-child(2) { flex: 1; font-weight: var(--strong-weight); }
.sk { display: block; border-radius: 6px; background: linear-gradient(90deg, var(--surface-2) 25%, var(--track) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: shimmer 1.3s ease-in-out infinite; }
.sk-row { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-top: 1px solid var(--border); }
.sk-row:first-child { border-top: 0; }
.sk-badge { width: 26px; height: 26px; border-radius: 7px; flex: none; }
.sk-title { height: 12px; width: 22%; }
.sk-bar { height: 8px; flex: 1; max-width: 160px; margin-left: auto; }
.sk-line { height: 12px; margin: 8px 0; }
.sk-stat { height: 40px; margin: 14px 18px; }
.w50 { width: 50%; } .w70 { width: 70%; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.view-in > * { animation: view-in .22s ease-out both; }
@keyframes view-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
/* Menus, popovers and dialogs ease in and out instead of appearing at once; a row that appears inside one grows in. */
.menu { animation: float-in .14s cubic-bezier(.2, .8, .2, 1); transform-origin: top right; }
.menu.float-out { animation: float-out .12s ease-in forwards; }
@keyframes float-in { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
@keyframes float-out { to { opacity: 0; transform: translateY(-2px) scale(.99); } }
.dialog[open] { animation: dialog-in .18s cubic-bezier(.2, .8, .2, 1); }
.dialog[open]::backdrop { animation: backdrop-in .18s ease-out; }
@keyframes dialog-in { from { opacity: 0; transform: translateY(6px) scale(.985); } }
@keyframes backdrop-in { from { opacity: 0; } }
.enter { animation: grow-in .2s ease-out backwards; overflow: hidden; }
/* Many rows arriving at once (a page more, a renewal) fade in together instead of each growing in turn. */
.fade-in { animation: fade-in .16s ease-out backwards; }
@keyframes fade-in { from { opacity: 0; } }
@keyframes grow-in { from { opacity: 0; max-height: 0; } to { opacity: 1; max-height: 160px; } }
.row.flash { animation: flash-row 2.4s ease-out; }
.card.flash { animation: flash-card 2.4s ease-out; }
@keyframes flash-row { from { background: var(--accent-soft); } to { background: transparent; } }
@keyframes flash-card { from { box-shadow: 0 0 0 2px var(--accent), var(--shadow); } to { box-shadow: 0 0 0 2px transparent, var(--shadow); } }
.checkup { margin-top: 8px; }
.foot { margin-top: 28px; text-align: center; }

/* The narrow-screen layouts hang on the root's data-width (page-logic.ts widthTier: up to 1100px medium, 760 narrow,
   560 phone) rather than on media queries, so the page script can change them once a sliding width settles, inside a
   View Transition. :where() keeps each rule's specificity what it was inside a media query. */
:where(:root[data-width=medium], :root[data-width=narrow], :root[data-width=phone]) {
  .col-head { display: none; }
  .app-row { flex-wrap: wrap; }
  .app-actions { width: 100%; justify-content: flex-start; }
  /* No column titles here, so the last use sits right after the name and email, on the email's line, and the
     menu stays on the name's line; the quota windows share the full width below. */
  .row { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "id more" "quota quota" "detail detail" "notes notes"; row-gap: 8px; }
  .row-detail { margin-left: 0; }

  .row > .quota { grid-template-columns: repeat(var(--qr, var(--qn)), minmax(0, 1fr)); }
  .rows .m-label, .rows .m-unit, .rows .u-unit { display: inline; }
  .rows .usage { justify-content: flex-start; }
  .row > .last { display: none; }
  .last-inline { display: flex; flex: none; gap: 6px; color: var(--muted); font-size: 12px; white-space: nowrap; margin-top: 1px; }
  .last-inline::before { content: "·"; color: var(--faint); }
  .row > .row-end { align-self: start; margin-top: -2px; }
}
:where(:root[data-width=narrow], :root[data-width=phone]) {
  /* The toolbar stays one line: "New account" keeps its icon, its name moves to the tooltip and the label. */
  .toolbar > .btn-primary { width: var(--ctl-h); padding: 0; justify-content: center; }
  .toolbar > .btn-primary > span { display: none; }
  .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .stat:nth-child(3) { border-left: 0; }
  .stat:nth-child(n+3) { border-top: 1px solid var(--border); }
}
:root[data-width=phone] { --gutter: 14px; }
:where(:root[data-width=phone]) {
  .top-in { padding: 16px var(--gutter) 0; }
  .header-bar .top-in { min-height: 0; padding: 12px var(--gutter); }
  .update-btn span { display: none; }
  .wrap { padding: 14px var(--gutter) 32px; }
  .hide-sm { display: none; }
  .tagline { display: none; }
  .brand .logo { width: 34px; height: 34px; }
  .brand h1 { font-size: 19px; }
  .banner > div:not(.banner-actions) { flex-basis: 100%; }
  .stat { padding: 11px 13px; align-items: flex-start; flex-direction: column; gap: 6px; }
  .stat-value { font-size: 19px; }
  .stat-sub { white-space: normal; }
  .spark-lg { display: none; }
  .search { flex-basis: 100%; }
  .tools { width: 100%; }
  .tools .tb-select { flex: 1 1 140px; min-width: 0; }
  .toolbar > .btn-primary { flex: 1; width: auto; padding: 0 14px; }
  .toolbar > .btn-primary > span { display: inline; }
  /* A phone keeps the last use as a column of its own: the line under the name has no room for it. */
  .row { padding: 10px 12px; grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "id last more" "quota quota quota" "detail detail detail" "notes notes notes"; }
  .row > .last { display: block; justify-self: end; }
  .last-inline { display: none; }
  .row > .row-end { align-self: center; margin-top: 0; }
  /* A phone keeps only the menu at a row's end, so the name and email keep their room; opening the desktop app and
     copying the start command are the first items of that menu. */
  .row > .row-end > .row-run { display: none; }
  #accounts { --col-gap: 14px; }
  /* One window per line, so the reset time is never cut off. */
  .row > .quota { grid-template-columns: 1fr; row-gap: 10px; max-width: none; }
  /* On a phone the summary keeps what needs a look and the next reset. */
  .stat:nth-child(1), .stat:nth-child(3) { display: none; }
  .stat:nth-child(n) { border-top: 0; }
  .stat:nth-child(4) { border-left: 1px solid var(--border); }
  .row-end .icon-btn { width: 36px; height: 36px; }
  .sess-row { grid-template-columns: auto minmax(0, 1fr); row-gap: 10px; }
  .sess-actions { grid-column: 2; }
  .login-dirs { grid-template-columns: minmax(0, 1fr); }
  .login-dir { grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 14px; row-gap: 6px; }
  .login-dir .usage, .login-dir .health { display: none; }
  .login-dir .ld-other { grid-column: 1 / -1; order: 1; }
  .grid { grid-template-columns: 1fr; }
  .panel { padding: 14px; }
  .dlg-head { padding: 14px 14px 2px; } .dlg-body { padding: 10px 14px 14px; } .dlg-foot { padding: 10px 14px; flex-wrap: wrap; }
}
/* A change of layout band runs as a short View Transition (page-script.ts followWidth): each block below moves and
   resizes to its new place while its old and new look cross-fade; the rest of the page cross-fades as one. Same
   length and ease as a Portal's sliding sidebar (.26s, quick start, soft landing), so both read as one move. */
::view-transition-group(*) { animation-duration: .26s; animation-timing-function: cubic-bezier(.32, .72, 0, 1); }
/* Old and new looks keep their own size (pinned top left) instead of stretching to the moving box, so text never
   grows or shrinks on the way. */
::view-transition-old(*), ::view-transition-new(*) { animation-duration: .26s; height: 100%; object-fit: none; object-position: left top; }
.vt-width :is(.top-in, .summary, .stat, .section-head, .toolbar, .group-list, .group-head, .row) { view-transition-name: match-element; }
/* Session History (spec §3.33): the toolbar, then the projects on the left and the sessions on the right. The list
   keeps the projects in view while it scrolls; at narrow widths the projects become one
   scrolling row above the list (the narrow and phone widths). */
.sess-mode { flex: none; }
.hist-bar { align-items: center; }
.hist-search { flex: 1 1 240px; }
.hist-checks { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.hist-display { margin-left: auto; }
.pop-hist-display { width: 240px; }
.hist-opts { display: flex; flex-direction: column; gap: 1px; margin: 0 -6px; }
.hist-opt { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px; border: 0; border-radius: var(--ctl-radius); background: transparent; color: var(--text); font: inherit; font-size: var(--small); text-align: left; cursor: pointer; transition: background-color .12s; }
.hist-opt:hover { background: var(--hover); }
.hist-opt[aria-pressed=true] { font-weight: var(--strong-weight); }
.hist-opt:focus-visible { outline: var(--focus-outline); outline-offset: 1px; box-shadow: var(--focus-ring); }
.hist-opt-ck { flex: none; display: inline-flex; width: 14px; color: var(--accent); }
.hist-opt-ck .ic { width: 14px; height: 14px; }
.hist-group { display: flex; flex-direction: column; gap: 4px; }
.hist-group + .hist-group { margin-top: 10px; }
.hist-group.is-folded + .hist-group.is-folded { margin-top: 0; }
.hist-ghead { display: flex; align-items: center; min-width: 0; padding-left: 14px; }
.hist-gtoggle { max-width: 100%; padding: 3px 8px 3px 2px; font-size: var(--small); font-weight: var(--strong-weight); }
.hist-gtitle { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-gtoggle .spin { width: 12px; height: 12px; }
.hist-catgrp { display: flex; flex-direction: column; margin-top: 6px; }
.hist-cathead { display: flex; align-items: center; min-width: 0; }
.hist-cathead > .hist-proj { padding-left: 6px; }
.hist-cathead .chev { flex: none; width: 12px; height: 12px; }
.hist-cathead [aria-expanded=true] .chev { transform: rotate(90deg); }
/* The rows fold by easing the grid row from its content to nothing, so nothing below jumps. */
.hist-catbody { display: grid; grid-template-rows: 1fr; transition: grid-template-rows .18s ease, opacity .18s ease; }
.hist-catbody > .hist-catps { min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 1px; padding-top: 1px; }
.hist-catgrp.is-folded .hist-catbody { grid-template-rows: 0fr; opacity: 0; visibility: hidden; transition: grid-template-rows .18s ease, opacity .18s ease, visibility 0s .18s; }
.hist-cat { color: var(--text); font-weight: var(--strong-weight); }
.hist-catps .hist-proj { padding-left: 24px; }
.hist-check { display: inline-flex; align-items: center; gap: 6px; font-size: var(--small); color: var(--muted); cursor: pointer; white-space: nowrap; }
.hist-check input { margin: 0; accent-color: var(--accent); }
.hist-check:hover { color: var(--text); }
.hist-grid { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 16px; align-items: start; }
.hist-none .hist-bar, .hist-none .hist-side { display: none; }
.hist-none .hist-grid { grid-template-columns: minmax(0, 1fr); }
.hist-side { position: sticky; top: 12px; display: flex; flex-direction: column; gap: 6px; min-width: 0; max-height: calc(100vh - 160px); overflow: auto; padding-right: 4px; }
/* Inner scroll boxes get a thin bar in the theme's colours; the side list shows it only while the pointer is on it. */
:is(.hist-side, .hv-msgs, .diff, .dlg-body, .menu) { scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent; }
.hist-side:not(:hover, :focus-within) { scrollbar-color: transparent transparent; }
.hist-side-h { margin: 0 0 2px 10px; font-size: var(--small); font-weight: 400; color: var(--muted); }
.hist-projs { display: flex; flex-direction: column; gap: 1px; }
.hist-proj { display: flex; align-items: center; gap: 6px; width: 100%; padding: 5px 10px; border: 0; border-radius: var(--ctl-radius); background: transparent; color: var(--muted); font: inherit; font-size: var(--small); text-align: left; cursor: pointer; transition: background-color .12s, color .12s; }
.hist-proj:hover { background: var(--hover); color: var(--text); }
.hist-proj[aria-pressed=true] { background: var(--active); color: var(--text); font-weight: var(--strong-weight); }
.hist-proj:focus-visible { outline: var(--focus-outline); outline-offset: 1px; box-shadow: var(--focus-ring); }
.hist-proj-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-proj-gone { flex: none; display: inline-flex; color: var(--faint); }
.hist-proj-gone .ic { width: 12px; height: 12px; }
.hist-proj-n { flex: none; color: var(--muted); font-size: 11.5px; font-weight: 400; }
.hist-sk { width: 70%; margin: 8px 10px; }
.hist-main { min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.hist-status { display: flex; flex-direction: column; gap: 6px; }
.hist-status:empty { display: none; }
.hist-count { margin: 0; }
.hist-list { transition: opacity .15s; }
.hist-list.is-loading { opacity: .6; }
.hist-list.swap-in { animation: hist-swap .18s ease-out; }
@keyframes hist-swap { from { opacity: .6; } }
.hist-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; column-gap: 12px; padding: 11px 10px 11px 16px; border-top: 1px solid var(--border); transition: background-color .15s; }
/* In a long list, rows out of view are not laid out until they come near it, so it folds and scrolls without stalls;
   a short list lays out every row at once, so nothing moves when a guessed height is replaced by the real one. */
.hist-list.is-long .hist-row { content-visibility: auto; contain-intrinsic-size: auto 92px; }
.hist-row:first-child { border-top: 0; border-radius: var(--radius) var(--radius) 0 0; }
.hist-row:last-child { border-radius: 0 0 var(--radius) var(--radius); }
.hist-row:only-child { border-radius: var(--radius); }
.hist-row:hover { background: var(--hover); cursor: pointer; }
.hist-row > .badge { margin-top: 1px; }
.hist-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hist-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.hist-open { flex: 0 1 auto; min-width: 0; padding: 0; border: 0; background: none; color: var(--text); font: inherit; font-weight: var(--strong-weight); text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; border-radius: 4px; }
.hist-open:hover { text-decoration: underline; text-underline-offset: 2px; }
.hist-open:focus-visible { outline: var(--focus-outline); outline-offset: 2px; box-shadow: var(--focus-ring); }
.hist-open[aria-busy=true] { cursor: progress; opacity: .7; }
.hist-view[aria-busy=true] { cursor: progress; color: var(--muted); }
.hist-view[aria-busy=true] .ic { display: none; }
.hist-live { flex: none; display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--ok); }
.hist-live .hist-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok-bar); }
.hist-meta { min-width: 0; overflow: hidden; padding: 2px; margin: -2px; }
.hist-mi-wrap { display: flex; flex-wrap: wrap; align-items: center; row-gap: 2px; margin-left: -14px; }
.hist-mi { display: inline-flex; align-items: center; min-width: 0; max-width: 100%; }
.hist-mi::before { content: '·'; flex: none; width: 14px; text-align: center; opacity: .7; }
.hist-meta b { color: var(--text); font-weight: 500; }
.hist-pname, .hist-branch { min-width: 0; max-width: 18em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-age { white-space: nowrap; }
.hist-snip { color: var(--muted); font-size: var(--small); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
.hist mark, .hv-msgs mark { background: var(--accent-soft); color: var(--text); border-radius: 3px; padding: 0 1px; }
.hist-cont { min-width: 6.5em; justify-content: center; transition: background-color .15s, border-color .15s, color .15s; }
.hist-cont.is-copied { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.hist-cont .ic { width: 14px; height: 14px; }
.hist-tail { display: flex; justify-content: center; }
.hist-tail:empty { display: none; }
.hist-tail p { margin: 0; }
.hist-empty p { margin: 0 0 10px; }
.hist-ways { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.hist-toolbox { display: flex; flex-direction: column; gap: 8px; }
.hist-toolbox:empty { display: none; }
.hist-toolbox > p { margin: 0; }
.hist-tool-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.hist-tool-head h3 { margin: 0; font-size: 13.5px; }
.hist-tool-prog { display: inline-flex; align-items: center; }
.hist-sources-box { margin-top: 18px; }
.hist-sources summary { cursor: pointer; font-size: var(--small); color: var(--muted); width: fit-content; border-radius: 4px; }
.hist-sources summary:hover { color: var(--text); }
.hist-sources summary:focus-visible { outline: var(--focus-outline); outline-offset: 2px; box-shadow: var(--focus-ring); }
.hist-src { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: var(--small); }
.hist-src th { text-align: left; font-weight: var(--strong-weight); color: var(--muted); padding: 4px 8px; border-bottom: 1px solid var(--border); }
.hist-src td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.hist-src .num { text-align: right; white-space: nowrap; }
.hist-clear { margin: 10px 0 0; }
.hv-meta { margin: 0 0 10px; display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; }
.hv-msgs { max-height: min(60vh, 560px); overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px; border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); background: var(--surface-2); }
.hv-msgs:focus-visible { outline: var(--focus-outline); outline-offset: 2px; box-shadow: var(--focus-ring); }
.hv-earlier { align-self: center; }
.hv-start { margin: 0; text-align: center; }
.hv-msg { display: flex; flex-direction: column; gap: 3px; padding: 8px 11px; border-radius: calc(var(--radius) - 6px); background: var(--surface); border: 1px solid var(--border); max-width: 92%; }
.hv-user { align-self: flex-end; background: var(--accent-soft); border-color: transparent; }
.hv-who { display: flex; gap: 8px; align-items: baseline; }
.hv-text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.55; }
.hv-all { align-self: flex-start; }
.hv-md { white-space: normal; }
.hv-md > * { margin: 0; }
.hv-md > * + * { margin-top: 6px; }
.hv-md p, .hv-md li, .hv-md blockquote { white-space: pre-wrap; }
.hv-md .hv-h { font-weight: 600; }
.hv-md :is(ul, ol) { padding-left: 1.4em; }
.hv-md blockquote { padding-left: 10px; border-left: 2px solid var(--border); color: var(--muted); }
.hv-md hr { border: 0; border-top: 1px solid var(--border); }
.hv-md :not(pre) > code { background: var(--surface-2); border-radius: 4px; padding: 0 4px; }
.hv-md a { color: var(--accent); }
.hv-code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 7px 9px; overflow-x: auto; white-space: pre; font-size: 12px; line-height: 1.5; }
.hv-table { overflow-x: auto; max-width: 100%; }
.hv-table table { border-collapse: collapse; font-size: 12px; }
.hv-table :is(th, td) { border: 1px solid var(--border); padding: 3px 8px; text-align: left; vertical-align: top; }
.hv-table th { background: var(--surface-2); font-weight: 600; white-space: nowrap; }
.hv-tools { display: flex; align-items: center; gap: 6px; padding: 0 4px; }
.hv-tools .ic { flex: none; width: 13px; height: 13px; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-grid { grid-template-columns: minmax(0, 1fr); }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-side { position: static; max-height: none; flex-direction: row; align-items: center; overflow-x: auto; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-side-h { display: none; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-projs { flex-direction: row; align-items: center; gap: 4px; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-catbody > .hist-catps { flex-direction: row; overflow: visible; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-proj { width: auto; flex: none; max-width: 16em; }
:where(:root[data-width=narrow], :root[data-width=phone]) :is(.hist-catgrp, .hist-catps) { flex-direction: row; display: flex; gap: 4px; margin-top: 0; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-catps .hist-proj { padding-left: 10px; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-cathead { display: none; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-catbody { display: contents; }
/* Without its heading a folded category could not be opened again, so a narrow screen shows every category open. */
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-catgrp.is-folded .hist-catbody { opacity: 1; visibility: visible; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-row { grid-template-columns: auto minmax(0, 1fr); row-gap: 8px; }
:where(:root[data-width=narrow], :root[data-width=phone]) .hist-row .sess-actions { grid-column: 2; }
/* Small motions (2026-10-20): every state change of a control eases over 120 ms, a press shrinks it a little, and what
   appears or goes away fades. Only opacity and transform move, so nothing reflows. */
.icon-btn, .seg-btn, .menu-item, .set-tab, .link-btn, .email-btn { transition: background-color .12s, color .12s, border-color .12s, transform .1s; }
.tag-btn { transition: filter .12s, transform .1s; }
.btn { transition: background-color .12s, border-color .12s, color .12s, transform .1s; }
.chip-btn { transition: filter .12s, border-color .12s, transform .1s; }
:is(.btn, .icon-btn, .seg-btn, .set-tab, .chip-btn):not(.drag-handle):active:not(:disabled) { transform: scale(.97); }
.set-link .ic { transition: transform .15s; }
.set-link:hover .ic { transform: translateX(2px); }
.icon-btn.row-run.is-done { color: var(--ok); }
.row-run.is-done .ic { animation: pop-in .18s cubic-bezier(.2, .8, .2, 1); }
@keyframes pop-in { from { opacity: 0; transform: scale(.6); } }
.tip.is-open .tip-body, .tip-float.is-shown { animation: tip-in .12s ease-out; }
@keyframes tip-in { from { opacity: 0; transform: translateY(2px); } }
.toast.toast-out { box-sizing: border-box; overflow: hidden; animation: toast-out .18s ease-in forwards; }
@keyframes toast-out { to { opacity: 0; height: 0; min-height: 0; padding-top: 0; padding-bottom: 0; margin-top: -8px; border-width: 0; } }
.set-pane.view-in { animation: view-in .2s ease-out both; }
.set-pane.view-in > * { animation: none; }
/* A dialog closes at once (the page takes clicks again) and only its picture fades out: the browser keeps it in the top
   layer for the transition. Browsers without overlay transitions just close it. */
.dialog, .dialog::backdrop { transition: opacity .14s ease-in, transform .14s ease-in, overlay .14s ease-in allow-discrete, display .14s ease-in allow-discrete; }
/* A dialog that opens another in its place (Settings → Preferred terminal) eases to the new width instead of jumping. */
.dialog[open] { transition: width .2s cubic-bezier(.2, 0, 0, 1); }
/* While it fades out it is no longer modal. Its column layout must not depend on [open], or the content would turn
   into a row mid-fade; the geometry below matches the modal one for engines that drop the modal styles there. */
.dialog { position: fixed; inset: 0; margin: auto; height: fit-content; max-width: none; overflow: auto; flex-direction: column; }
.dialog.dialog-top { margin-top: min(12vh, 96px); max-height: calc(100vh - min(12vh, 96px) - 24px); }
.dialog:not([open]) { opacity: 0; transform: translateY(4px) scale(.985); pointer-events: none; }
.dialog:not([open])::backdrop { opacity: 0; }
/* Page tabs (2026-10-21): underline tabs across the content width, as GitHub and Vercel draw them. The selected page
   is in full text color with its mark in the accent and a 2px accent line under it; the others are muted. Each label
   reserves its bold width, so picking a tab never moves the ones after it. */
.pages { margin: 2px 0 22px; }
.tabs { display: flex; align-items: flex-end; gap: 2px; border-bottom: 1px solid var(--border); overflow-x: auto; scrollbar-width: none; }
.tab { position: relative; isolation: isolate; display: inline-flex; align-items: center; gap: 7px; flex: none; height: 44px; padding: 0 12px; border: 0; background: none; color: var(--muted); font: inherit; font-size: var(--font-size); font-weight: 500; white-space: nowrap; cursor: pointer; transition: color .12s; }
.tab::before { content: ""; position: absolute; inset: 6px 2px 7px; z-index: -1; border-radius: var(--ctl-radius); background: var(--hover); opacity: 0; transition: opacity .12s; }
.tab:hover { color: var(--text); }
.tab:hover::before { opacity: 1; }
/* The icon takes its tab's text color, so a tab is always one color: muted, then the accent once selected. */
.tab .ic { width: 16px; height: 16px; color: currentColor; transition: color .12s; }
.tab-label { display: inline-grid; }
.tab-label::after { content: attr(data-label); height: 0; overflow: hidden; visibility: hidden; font-weight: var(--strong-weight); }
.tab[aria-selected=true] { color: var(--accent); font-weight: var(--strong-weight); }
.tab[aria-selected=true]::after { content: ""; position: absolute; left: 10px; right: 10px; bottom: 0; height: 2px; border-radius: 2px 2px 0 0; background: var(--accent); animation: tab-line .22s cubic-bezier(.16, 1, .3, 1); }
@keyframes tab-line { from { opacity: 0; transform: scaleX(.3); } }
.tab:focus-visible { outline: var(--focus-outline); outline-offset: -5px; border-radius: var(--ctl-radius); }
.tab-count { min-width: 20px; padding: 0 6px; border-radius: var(--chip-radius); background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border); color: var(--muted); font-size: 11.5px; font-weight: 500; line-height: 18px; text-align: center; }
.tab[aria-selected=true] .tab-count { background: var(--accent-soft); box-shadow: none; color: var(--accent); }
.tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ok-bar); box-shadow: 0 0 0 3px var(--ok-soft); }
.tab .seg-badge { margin-left: 0; }
.tab .spin { width: 16px; height: 16px; }

/* Pages other than Accounts open the same way: a title with its actions on the right, one line saying what the page
   is for, then the content in surfaces. A section inside a page has a small heading with more room above than below. */
.page > .section-head { margin-bottom: 4px; min-height: var(--ctl-h); }
.page > .section-head h2 { font-size: 18px; letter-spacing: -0.015em; }
.page > .section-head + p { margin-bottom: 18px; max-width: 860px; color: var(--muted); font-size: 13px; line-height: 1.6; }
.page-sec { margin: 28px 0 10px; font-size: 13.5px; font-weight: var(--heading-weight); color: var(--text); }
.page-sec-head { display: flex; flex-direction: column; gap: 2px; margin: 28px 0 10px; }
.page-sec-head .page-sec { margin: 0; }

/* Auto Handoff's status card: its mark, on or off in words, what that means, and the one action that changes it. On,
   it takes a green edge and tint, so the state reads before the words. */
.hp-status { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 16px; padding: 18px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); transition: background-color .2s, border-color .2s; }
.hp-status-ic { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 11px; background: var(--surface-2); box-shadow: inset 0 0 0 1px var(--border); color: var(--muted); }
.hp-status-ic .ic { width: 20px; height: 20px; }
.hp-status-text { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.hp-status-text b { font-size: var(--large); font-weight: var(--heading-weight); }
.hp-status-text p { font-size: 13px; line-height: 1.55; }
.hp-status.is-on { border-color: color-mix(in srgb, var(--ok-bar) 40%, var(--border)); background: color-mix(in srgb, var(--ok-soft) 55%, var(--surface)); }
.hp-status.is-on .hp-status-ic { background: var(--ok-soft); box-shadow: none; color: var(--ok); }
.hp-status + :not(.page-sec-head, .page-sec) { margin-top: 12px; }
.page .hp-rules, .page .hp-rows { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.page .hp-rules > li { padding: 12px 16px; min-height: 52px; }
.page .hp-rows li { padding: 11px 16px; }
.hp-rule-text::before { color: var(--faint); }
:where(:root[data-width=narrow], :root[data-width=phone]) .hp-status { grid-template-columns: auto minmax(0, 1fr); }
:where(:root[data-width=narrow], :root[data-width=phone]) .hp-status > .btn { grid-column: 1 / -1; justify-self: start; }

/* Context tuning on its page: one surface per settings file. Now, the suggestion and what it saves are one strip like
   the Accounts summary; the per-account details sit in the card's foot. */
.tg-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tg-stats { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); background: var(--surface-2); border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); overflow: hidden; }
.tg-stat { min-width: 0; padding: 12px 16px; border-left: 1px solid var(--border); }
.tg-stat:first-child { border-left: 0; }
.tg-stats .tune-num { font-size: 24px; font-weight: var(--heading-weight); letter-spacing: -0.02em; line-height: 1.35; white-space: nowrap; }
#tuning-page .tune-acct { gap: 0; margin: 0 0 16px; overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
#tuning-page .tune-group { gap: 12px; padding: 18px 20px; border: 0; border-radius: 0; }
#tuning-page .tune-acct > .tune-details { margin: 0; padding: 11px 20px; border-top: 1px solid var(--border); background: var(--surface-2); }
#tuning-page .tune-acct > .tune-details:first-child { border-top: 0; }
#tuning-page .tune-acct > .tune-details[open] > summary { margin-bottom: 6px; }
:where(:root[data-width=phone]) .tg-stats { grid-auto-flow: row; }
:where(:root[data-width=phone]) .tg-stat { border-left: 0; border-top: 1px solid var(--border); }
:where(:root[data-width=phone]) .tg-stat:first-child { border-top: 0; }

/* Hidden Families and Accounts (spec §3.25): the line under the list, and the marks while they are shown. */
.hidden-bar { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 10px 0 2px; animation: chip-in .16s ease-out; }
.hidden-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--fail); flex: none; }
.hidden-chip .ic { width: 12px; height: 12px; }
.ident-name .hidden-chip { margin-left: 2px; }
.group.is-hidden .group-title, .row.is-hidden .name { color: var(--muted); }
.hide-btn .ic { width: 16px; height: 16px; }
.hide-btn.is-on { color: var(--muted); }
.hide-btn:disabled { opacity: .4; cursor: not-allowed; }

/* Unattended Mode (spec §3.37): the status card (green while on, amber while paused), the chooser under it, the
   Schedule's rows of day chips and times, and what sessions left for the user, grouped by session. Parts that come
   and go are animated from the script (uaPatch); these rules only lay them out. */
.ua-badge { gap: 6px; border-color: color-mix(in srgb, var(--ok-bar) 45%, var(--border-strong)); background: color-mix(in srgb, var(--ok-soft) 70%, var(--surface)); color: var(--ok); }
.ua-badge .ic { width: 15px; height: 15px; }
.ua-badge:hover { border-color: var(--ok-bar); }
.ua-status.is-paused { border-color: color-mix(in srgb, var(--warn-bar) 40%, var(--border)); background: color-mix(in srgb, var(--warn-soft) 50%, var(--surface)); }
.ua-status.is-paused .hp-status-ic { background: var(--warn-soft); box-shadow: none; color: var(--warn); }
.ua-status-rest { font-weight: 500; color: var(--text); }
.ua-chooser { max-width: 560px; margin-top: 12px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.ua-chooser-title { font-weight: var(--strong-weight); margin-bottom: 8px; }
.ua-opts { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
.ua-opt { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 4px 10px; border-radius: calc(var(--ctl-radius) - 2px); cursor: pointer; transition: background-color .12s; }
.ua-opt:hover { background: var(--hover); }
.ua-opt.is-on { background: var(--accent-soft); }
.ua-radio { display: inline-flex; align-items: center; gap: 10px; padding: 0; border: 0; background: none; color: var(--text); font: inherit; cursor: pointer; min-width: 9.5em; text-align: left; }
.ua-radio:focus-visible { outline: var(--focus-outline); outline-offset: 3px; border-radius: 4px; }
.ua-dot { flex: none; width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--border-strong); background: var(--surface); transition: border-color .12s, box-shadow .12s; }
.ua-radio[aria-checked=true] .ua-dot { border-color: var(--accent); box-shadow: inset 0 0 0 3.5px var(--surface), inset 0 0 0 8px var(--accent); }
.ua-when { margin-left: auto; font-size: 13px; white-space: nowrap; font-variant-numeric: tabular-nums; }
input.ua-time { width: 4.6em; height: var(--ctl-h-sm); padding: 0 6px; border: 1px solid var(--border-strong); border-radius: var(--ctl-radius); background: var(--surface); color: var(--text); font: inherit; font-size: 13px; font-variant-numeric: tabular-nums; text-align: center; transition: border-color .12s, box-shadow .12s; }
input.ua-time:hover:not(:disabled) { border-color: var(--btn-hover-border); }
input.ua-time:focus { border-color: var(--focus); outline: none; box-shadow: var(--focus-ring); }
input.ua-time:invalid { border-color: var(--fail); }
input.ua-time:disabled { background: var(--surface-2); color: var(--faint); }
input.ua-time::placeholder { color: var(--faint); }
.ua-slots, .ua-cover, .ua-items { list-style: none; margin: 0; padding: 0; }
.ua-slots { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.ua-slot { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 16px; padding: 10px 12px 10px 16px; border-top: 1px solid var(--border); }
.ua-slot:first-child { border-top: 0; }
.ua-slot-name { min-width: 7em; font-weight: var(--strong-weight); }
.ua-days { display: inline-flex; gap: 4px; }
.ua-day { display: inline-grid; place-items: center; min-width: 30px; height: 30px; padding: 0 6px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--surface); color: var(--muted); font: inherit; font-size: 12.5px; cursor: pointer; transition: background-color .12s, border-color .12s, color .12s; }
.ua-day:hover:not(:disabled) { border-color: var(--btn-hover-border); color: var(--text); }
.ua-day[aria-pressed=true] { background: var(--accent-soft); border-color: transparent; color: var(--accent); font-weight: var(--strong-weight); }
.ua-day:disabled { cursor: default; }
.ua-day[aria-pressed=false]:disabled { opacity: .5; }
.ua-day:focus-visible { outline: var(--focus-outline); outline-offset: 1px; box-shadow: var(--focus-ring); }
.ua-times { display: inline-flex; align-items: center; gap: 6px; }
.ua-dash { color: var(--muted); }
.ua-night { animation: fade-in .16s ease-out; }
.ua-del { margin-left: auto; }
.ua-del .ic { width: 15px; height: 15px; }
.ua-add-row { margin-top: 10px; }
.ua-empty { gap: 8px; }
.ua-empty .ic, .ua-first .ic { width: 15px; height: 15px; flex: none; }
.ua-first { margin-top: 12px; }
#unattended-page > .note:not(.ua-first, .ua-empty) { margin-bottom: 12px; }
.ua-sec-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ua-sec-row .tab-count { margin-left: 4px; vertical-align: 1px; }
.ua-groups { display: flex; flex-direction: column; }
.ua-group { margin-bottom: 12px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.ua-group-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 16px; background: var(--surface-2); border-bottom: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; }
.ua-group-who { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; min-width: 0; }
.ua-cwd { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.ua-item { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 16px; padding: 12px 12px 12px 16px; border-top: 1px solid var(--border); }
.ua-item:first-child { border-top: 0; }
.ua-item-meta { display: flex; align-items: center; gap: 8px; grid-column: 1; }
.ua-text { grid-column: 1; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.55; }
.ua-text.is-clamped { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; overflow: hidden; }
.ua-item-actions { grid-column: 2; grid-row: 1 / span 2; display: flex; align-items: flex-start; gap: 10px; }
.ua-cover { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.ua-cover li::before { content: "·"; margin-right: 8px; color: var(--faint); }
:where(:root[data-width=narrow], :root[data-width=phone]) .ua-item { grid-template-columns: minmax(0, 1fr); }
:where(:root[data-width=narrow], :root[data-width=phone]) .ua-item-actions { grid-column: 1; grid-row: auto; }
:where(:root[data-width=phone]) .ua-del { margin-left: 0; }
:where(:root[data-width=phone]) .ua-badge span { display: none; }
@media (prefers-reduced-motion: reduce) { .ua-opt, .ua-dot, .ua-day, input.ua-time { transition: none; } .ua-night { animation: none; } }

/* Command Palette (spec §3.36): a search box over one list; the dialog keeps its top edge while the list changes. */
.kbd-inline { font: 11px/16px var(--mono); color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; margin-left: 2px; }
.dialog.dialog-pal { width: min(620px, calc(100vw - 24px)); flex-direction: column; }
.pal-head { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.pal-ic { flex: none; color: var(--muted); }
.dialog .pal-input, .dialog .pal-input:focus, .dialog .pal-input:focus-visible { flex: 1; min-width: 0; height: 32px; padding: 0; border: 0; box-shadow: none; outline: none; background: none; color: var(--text); font: inherit; font-size: var(--large); outline: none; }
.pal-input::-webkit-search-cancel-button { display: none; }
.pal-list { overflow-y: auto; overscroll-behavior: contain; padding: 6px; display: flex; flex-direction: column; gap: 1px; max-height: min(56vh, 460px); }
.pal-group { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; color: var(--muted); }
.pal-opt { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 5px 10px; border-radius: calc(var(--ctl-radius) - 2px); color: var(--text); cursor: pointer; transition: background-color .12s ease; }
.pal-opt[aria-selected=true] { background: var(--hover); }
.pal-opt[aria-disabled=true] { color: var(--faint); cursor: not-allowed; }
.pal-kind { flex: none; min-width: 52px; font-size: 11px; line-height: 18px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 7px; text-align: center; }
.pal-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.pal-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pal-also { font-size: 11px; color: var(--muted); }
.pal-where { flex: none; max-width: 42%; font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pal-opt mark { background: var(--accent-soft); color: inherit; border-radius: 2px; padding: 0 1px; }
.pal-more .pal-main, .pal-hist .pal-title, .pal-ai .pal-title { color: var(--accent); }
.pal-hist { margin-top: 4px; }
.pal-none { padding: 14px 10px 4px; margin: 0; }
.pal-foot { padding: 8px 16px; border-top: 1px solid var(--border); background: var(--surface-2); border-radius: 0 0 var(--radius) var(--radius); }
[data-width=narrow] .pal-where, [data-width=narrow] .pal-foot { display: none; }
.dialog.dialog-cmds { width: min(760px, calc(100vw - 24px)); flex-direction: column; }
.cmd-list { overflow-y: auto; overscroll-behavior: contain; padding: 4px 6px 10px; height: min(62vh, 560px); }
.cmd-intro { margin: 8px 10px 2px; }
.cmd-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.cmd-row { display: flex; flex-direction: column; gap: 2px; padding: 7px 10px; border-top: 1px solid var(--border); }
.cmd-row:first-child { border-top: 0; }
.cmd-line, .cmd-ex { display: flex; align-items: center; gap: 8px; min-width: 0; }
.cmd-usage { flex: 1; min-width: 0; color: var(--text); font-weight: var(--strong-weight); overflow-wrap: anywhere; }
.cmd-desc { color: var(--muted); font-size: var(--small); }
.cmd-ex { font-size: 12px; color: var(--muted); }
.cmd-ex code { min-width: 0; color: var(--text); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; overflow-wrap: anywhere; }
.cmd-ex-label { flex: none; }
.cmd-open { flex: none; font-size: var(--small); }
.cmd-copy { flex: none; }
.cmd-copy.is-done { color: var(--ok); }
.cmd-none { padding: 14px 10px; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.cmd-none p { margin: 0; }
.cmd-none .link-btn { display: inline-flex; align-items: center; gap: 4px; }
.find-flash { animation: find-flash 1.2s ease-out; border-radius: var(--ctl-radius); }
@keyframes find-flash { 0%, 35% { box-shadow: 0 0 0 6px var(--accent-soft); background: var(--accent-soft); } to { box-shadow: 0 0 0 6px transparent; background: transparent; } }
@media (prefers-reduced-motion: reduce) { .find-flash { animation: none; } .pal-opt { transition: none; } }
@media (prefers-reduced-motion: reduce) {
  .sk, .spin, .hidden-bar, .is-spinning svg, .toast, .toast.bump, .toast.toast-out, .view-in > *, .set-pane.view-in, .row.flash, .sess-row.flash, .sess-msg, .seg-badge, .card.flash, .pulse, .sess-busy .sess-dot, .menu, .menu.float-out, .dialog[open], .dialog[open]::backdrop, .enter, .fade-in, .hist-list.swap-in, .tip-body, .tip-float, .row-run.is-done .ic, .tab[aria-selected=true]::after { animation: none; }
  .bar > span, .chev, .row, .sess-row, .sess-copy, .hist-row, .hist-cont, .hist-proj, .hist-catbody, .hist-opt, .hist-list, .icon-btn, .seg-btn, .menu-item, .set-tab, .link-btn, .tag-btn, .email-btn, .btn, .chip-btn, .set-link .ic, .dialog, .dialog[open], .dialog::backdrop, .tab, .tab::before, .tab .ic, .hp-status { transition: none; }
  :is(.btn, .icon-btn, .seg-btn, .set-tab, .chip-btn):active:not(:disabled), .set-link:hover .ic, .dialog:not([open]) { transform: none; }
}
`
