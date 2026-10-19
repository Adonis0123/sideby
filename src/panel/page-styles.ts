// The Panel page's styles: design tokens (a host theme layers its values over them, see theme.ts) and the rules
// that read them. Every color, radius and size below comes from a token, so a host theme reaches every component.
import { type ResolvedTheme, resolveTheme } from './theme.ts'

// Colors defined from other tokens; repeated in both schemes so they follow that scheme's base colors. Dark mode keeps
// the logo tile light: the mark's ink outline (core/brand-mark.ts) needs a light ground.
const DERIVED_COLORS = `
  --btn-text: var(--text); --btn-hover-text: var(--accent); --check: var(--focus);
  --logo-bg: var(--accent-soft); --logo-fg: var(--focus); --logo-line: var(--border);
  --focus-outline: 2px solid var(--focus); --focus-ring: none;`
// Design tokens. A host theme (theme.ts) layers its values over these: light values after LIGHT_TOKENS, dark values after
// DARK_TOKENS. DARK_TOKENS sets every color token again, so a host's light colors never leak into dark mode, while
// type, shape and layout tokens are shared by both schemes.
const LIGHT_TOKENS = `
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --font-size: 14px; --small: 12.5px; --control-size: 13.5px; --heading-size: 15px; --large: 16px; --title-size: 22px;
  --title-weight: 750; --heading-weight: 650; --strong-weight: 600; --button-weight: 600; --primary-weight: var(--button-weight);
  --radius: 14px; --ctl-radius: 8px; --chip-radius: 999px; --ctl-h: 34px; --ctl-h-sm: 28px; --field-h: 36px;
  --content-width: 1180px; --gutter: 24px;
  --bg: #f2f8fc; --surface: #fcfcfa; --surface-2: #f6fafd; --border: #dce8f0; --border-strong: #c5d7e4;
  --text: #15171c; --muted: #555b63; --faint: #8b93a1; --accent: #27658f; --accent-soft: #e5f2fb;
  --primary: #e1f0fb; --primary-hover: #d2e8f9; --primary-active: #c3e0f6; --on-primary: #1f6396;
  --primary-border: #b9d8ef; --primary-hover-border: #9cc7e8; --btn-hover-border: #8fbde3;
  --hover: #f0f7fc; --active: #e6f1fa; --focus: #3f8fc4;
  --ok: #15803d; --ok-bar: #22c55e; --ok-soft: #e8f7ee; --warn: #b45309; --warn-bar: #f59e0b; --warn-soft: #fdf3e2;
  --fail: #c81e1e; --fail-bar: #ef4444; --fail-soft: #fdecec; --track: #e4edf4;
  --spark: oklch(from var(--accent) clamp(0.55, l, 0.62) max(c, 0.14) h); --spark-soft: oklch(from var(--accent) 0.83 calc(max(c, 0.14) * 0.6) h);
  --shadow: 0 1px 2px rgba(16,24,40,.04), 0 2px 8px rgba(16,24,40,.05);
  --float-shadow: 0 10px 30px rgba(16,24,40,.14), 0 2px 6px rgba(16,24,40,.06);${DERIVED_COLORS}`
const DARK_TOKENS = `
  --bg: #0e1621; --surface: #141e2a; --surface-2: #111a25; --border: #233244; --border-strong: #30455b;
  --text: #e6edf3; --muted: #9aa9b8; --faint: #6b7a8a; --accent: #8cc4ee; --accent-soft: #16314a;
  --primary: #173a58; --primary-hover: #1d4769; --primary-active: #22537a; --on-primary: #d3e9fa;
  --primary-border: #2b5b82; --primary-hover-border: #3a6f99; --btn-hover-border: #4a7fa8;
  --hover: #182736; --active: #1c2f42; --focus: #5aa7dc;
  --ok: #4ade80; --ok-bar: #22c55e; --ok-soft: #13291c; --warn: #fbbf24; --warn-bar: #f59e0b; --warn-soft: #2d2410;
  --fail: #f87171; --fail-bar: #ef4444; --fail-soft: #331717; --track: #1f2c3a;
  --spark: oklch(from var(--accent) clamp(0.7, l, 0.78) max(c, 0.14) h); --spark-soft: oklch(from var(--accent) 0.45 calc(max(c, 0.14) * 0.6) h);
  --shadow: 0 1px 2px rgba(0,0,0,.3); --float-shadow: 0 12px 32px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.3);${DERIVED_COLORS}
  --logo-bg: #dcebf7; --logo-line: transparent;`

/**
 * The page's style block: default tokens, the host's tokens over them, then the rules that read them. With
 * `colorScheme: 'auto'` the page follows the system unless the viewer picked light or dark in the Panel, which sets
 * `data-theme` on the root element.
 */
export function pageStyles(theme: ResolvedTheme = resolveTheme(undefined)): string {
  const rule = (decls: string[], sel = ':root') => (decls.length ? `${sel} { ${decls.join('; ')}; }\n` : '')
  const scheme = theme.colorScheme === 'auto' ? 'light dark' : theme.colorScheme
  let css = `:root {${LIGHT_TOKENS}\n  color-scheme: ${scheme};\n}\n${rule(theme.light)}`
  if (theme.colorScheme === 'auto') {
    const sel = ':root:not([data-theme=light])'
    css += `@media (prefers-color-scheme: dark) {\n${sel} {${DARK_TOKENS}\n}\n${rule(theme.dark, sel)}}\n`
    css += `:root[data-theme=dark] {${DARK_TOKENS}\n  color-scheme: dark;\n}\n${rule(theme.dark, ':root[data-theme=dark]')}`
    css += ':root[data-theme=light] { color-scheme: light; }\n'
  } else if (theme.colorScheme === 'dark') css += `:root {${DARK_TOKENS}\n}\n${rule(theme.dark)}`
  return css + CSS
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

/* Summary: four quiet numbers in one surface. */
.summary[hidden], #checkup[hidden] { display: none; }
.summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); margin-bottom: 18px; overflow: hidden; }
.stat { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; min-width: 0; padding: 14px 18px; border-left: 1px solid var(--border); text-align: left; }
.stat:first-child { border-left: 0; }
.stat-text { min-width: 0; }
.stat-label { color: var(--muted); font-size: var(--small); display: flex; align-items: center; gap: 6px; }
.stat-value { font-size: 22px; font-weight: var(--heading-weight); letter-spacing: -0.02em; line-height: 1.35; white-space: nowrap; }
.stat-sub { color: var(--faint); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
.kbd { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); font: 11px/16px var(--mono); color: var(--faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; pointer-events: none; }
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
/* The directories share one set of columns (subgrid), so a wider cell in one line moves every line alike. */
.login-dirs { display: grid; grid-template-columns: minmax(120px, 1fr) auto var(--l-w) minmax(0, 1.4fr) auto auto auto; column-gap: 14px; border: 1px solid var(--border); border-radius: var(--ctl-radius); background: var(--surface); }
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
.menu-head { padding: 6px 10px 2px; color: var(--faint); font-size: 11px; font-weight: var(--strong-weight); }
/* The arrow at a row's start opens and closes its details; so does a click anywhere else in the row. */
.row-toggle { width: 28px; height: 28px; margin: -4px -6px -4px -8px; }
.fold-hit { cursor: pointer; }
.fold-hit .row-detail { cursor: auto; }
.fold-hit:hover .row-toggle { background: var(--hover); color: var(--text); }
.row-toggle[aria-expanded=true] .chev { transform: rotate(90deg); }
.row-toggle[aria-expanded=true]:not(:hover) { background: transparent; color: var(--muted); }
.fold-hit:hover .row-toggle[aria-expanded=true] { background: var(--hover); color: var(--text); }
/* The details: ref and model, tokens, Health, side by side under the name. */
.row-detail { grid-area: detail; display: flex; flex-wrap: wrap; gap: 10px 36px; margin: 10px 0 2px 64px; padding-top: 10px; border-top: 1px dashed var(--border); cursor: default; }
.rd-item { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.rd-label { color: var(--faint); font-size: 11.5px; font-weight: var(--strong-weight); }
.rd-note { color: var(--muted); font-size: 12px; }
.rows .row-detail .usage { justify-content: flex-start; gap: 16px; }
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
.br-list { list-style: none; margin: 0 0 12px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.br-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--ctl-radius); }
.email-btn:hover { color: var(--text); text-decoration: underline dotted; }
/* A button is laid out as one box, so the parent's ellipsis does not reach its text: it ends its own. */
.ident-email .email-btn { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
.email-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.br-btn { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; max-width: 100%; }
.br-btn:hover { color: var(--text); text-decoration: underline dotted; }
.card > .rd-browser { flex-direction: row; align-items: center; gap: 8px; }
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
/* Old numbers keep their level's color, paler, so the bar and the number agree. */
.q-note { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; color: var(--muted); font-size: var(--small); }
.link-btn { padding: 0; border: 0; background: none; color: var(--accent); font: inherit; font-weight: var(--strong-weight); cursor: pointer; }
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
.badge { flex: none; display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #fff; font-weight: 700; font-size: 12.5px; letter-spacing: .02em; }
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
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.panel, .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.panel { padding: 18px; }
.card { padding: 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.card-error { border-color: var(--fail); }
.card-head { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.card-head .badge { margin-top: 1px; }
.card .quota { gap: 10px 16px; }
.card .bar { height: 6px; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; border-top: 1px solid var(--border); padding-top: 10px; margin-top: auto; min-width: 0; }
.card-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
.card .row-notes { margin: 0; }

/* Buttons: .btn is the secondary (outlined) variant; .btn-primary is the one main action of a block; .btn-ghost is a
   quiet action such as Close. Two sizes: default (--ctl-h) for block actions, .btn-sm (--ctl-h-sm) inside cards, notes
   and banners. .icon-btn is a square ghost button for icons. */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: var(--ctl-h); padding: 0 14px; border-radius: var(--ctl-radius); border: 1px solid var(--border-strong); background: var(--surface); color: var(--btn-text); font: inherit; font-size: var(--control-size); font-weight: var(--button-weight); line-height: 1; cursor: pointer; white-space: nowrap; text-decoration: none; user-select: none; transition: background-color .12s, border-color .12s, color .12s; }
a.btn:hover { text-decoration: none; }
.btn:hover:not(:disabled) { background: var(--hover); border-color: var(--btn-hover-border); color: var(--btn-hover-text); }
.btn:active:not(:disabled) { background: var(--active); }
.btn-primary { background: var(--primary); border-color: var(--primary-border); color: var(--on-primary); font-weight: var(--primary-weight); }
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
.note-fail { background: var(--fail-soft); color: var(--fail); }
.note-warn { background: var(--warn-soft); color: var(--warn); }
/* A note in two lines: what is wrong, then the command to run (with its copy button and the install page). */
.note-line { flex-basis: 100%; min-width: 0; overflow-wrap: anywhere; }
.note-cmd { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.error-note { justify-content: space-between; gap: 12px; }
.error-note > span { min-width: 0; overflow-wrap: anywhere; }
.error-note > .note-sub { flex-basis: 100%; color: var(--text); }
.banner { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 11px 14px; border-radius: calc(var(--radius) - 2px); margin-bottom: 12px; border: 1px solid var(--border); background: var(--surface); }
.banner > div { min-width: 0; }
.banner-quiet { padding: 8px 14px; background: transparent; border-style: dashed; }
.banner-fail { background: var(--fail-soft); border-color: transparent; color: var(--fail); }
.banner-warn { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.banner ul { margin: 6px 0 0; padding-left: 18px; }
.rc-list { list-style: none; margin: 10px 0; padding: 0; display: grid; gap: 8px; }
.rc-row { padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; display: grid; gap: 2px; }
.rc-row code { word-break: break-all; }
.banner-actions { display: flex; gap: 8px; flex: none; }
.hp-how { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; }
.hp-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.hp-steps li { display: flex; gap: 8px; }
.hp-steps li::before { content: '•'; color: var(--muted); }
.hp-steps li > div { flex: 1; min-width: 0; }
.hp-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
.hp-rows li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; padding: 8px 0; border-bottom: 1px solid var(--border); }
.hp-rows li:last-child { border-bottom: 0; }
#handoff-page > * + * { margin-top: 12px; }
.ah-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: end; }
.tune-model { border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.tune-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.tune-vals { display: flex; gap: 24px; }
.tune-num { font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.tune-best { color: var(--ok, var(--accent)); }
.ah-fam { border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.ah-fam-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ah-order { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.ah-order li { display: flex; align-items: center; gap: 6px; }
.ah-order li .mono { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ah-add { display: flex; gap: 6px; }
.ah-steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.disabled-why { color: var(--muted); font-size: var(--small); margin-top: 10px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.spin { display: inline-block; width: 13px; height: 13px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; vertical-align: -2px; flex: none; }
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
.ask-file.is-error { border-color: var(--fail); }
.ask-file-img, .ask-file-face { width: 94px; height: 64px; border-radius: calc(var(--ctl-radius) - 2px); }
.ask-file-img { object-fit: cover; display: block; }
.ask-file-face { display: grid; place-items: center; align-content: center; gap: 2px; background: var(--surface-2); color: var(--muted); }
.ask-file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ask-file-x { position: absolute; top: 2px; right: 2px; width: 22px; height: 22px; background: var(--surface); }
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
.dialog[open] { display: flex; flex-direction: column; }
.dialog::backdrop { background: rgba(10, 12, 16, .4); }
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
/* "More settings…" stays at the bottom of a popover that scrolls. */
.set-more { position: sticky; bottom: -12px; margin: 0 -14px -12px; width: calc(100% + 28px); height: 40px; padding: 0 16px 0 17px; border-top: 1px solid var(--border); border-radius: 0; background: var(--surface); }
.set-more:hover { background: var(--hover); }
.set-more .ic { margin-left: auto; }
.set-dialog { display: flex; flex-direction: column; gap: 12px; }
.set-dialog .set-hint { max-width: none; }
.set-dialog .set-link { margin: 0 -10px; width: calc(100% + 20px); }
.as-code { display: block; margin: -4px 0 4px; padding: 8px 10px; border-radius: var(--ctl-radius); background: var(--hover); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
.set-dot { background: var(--warn-bar); }
.tip { display: inline-flex; position: relative; vertical-align: middle; }
.tip-btn { display: inline-grid; place-items: center; width: 16px; height: 16px; padding: 0; border: 1px solid var(--border-strong); border-radius: 50%; background: var(--surface); color: var(--muted); font: 700 10px/1 var(--font); cursor: help; }
.tip-btn:hover, .tip.is-open .tip-btn { color: var(--text); border-color: var(--muted); }
.tip-btn:focus-visible { outline: var(--focus-outline); outline-offset: 2px; }
.tip-body { display: none; position: fixed; z-index: 60; width: max-content; max-width: min(280px, calc(100vw - 16px)); padding: 7px 10px; border-radius: 7px; background: var(--text); color: var(--bg); font-size: 12px; font-weight: 400; line-height: 1.45; letter-spacing: 0; box-shadow: var(--float-shadow); pointer-events: none; text-align: left; white-space: normal; }
.tip.is-open .tip-body { display: block; }
.toasts { position: fixed; inset: auto auto 20px 50%; margin: 0; padding: 0; border: 0; background: none; color: inherit; overflow: visible; transform: translateX(-50%); z-index: 50; display: flex; flex-direction: column; align-items: center; gap: 8px; width: max-content; max-width: calc(100vw - 24px); pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; max-width: min(460px, calc(100vw - 24px)); min-height: 40px; padding: 6px 6px 6px 14px; border-radius: calc(var(--ctl-radius) + 2px); background: var(--surface); color: var(--text); border: 1px solid var(--border); box-shadow: var(--float-shadow); font-size: 13px; animation: toast-in .18s ease-out; }
.toast-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--ok); }
.toast-fail .toast-dot { background: var(--fail); } .toast-plain .toast-dot { background: var(--faint); } .toast-info .toast-dot { background: var(--warn); }
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
  .banner { flex-direction: column; }
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
  #accounts { --col-gap: 14px; }
  /* One window per line, so the reset time is never cut off. */
  .row > .quota { grid-template-columns: 1fr; row-gap: 10px; max-width: none; }
  /* On a phone the summary keeps what needs a look and the next reset. */
  .stat:nth-child(1), .stat:nth-child(3) { display: none; }
  .stat:nth-child(n) { border-top: 0; }
  .stat:nth-child(4) { border-left: 1px solid var(--border); }
  .row-end .icon-btn { width: 36px; height: 36px; }
  .login-dirs { grid-template-columns: minmax(0, 1fr); }
  .login-dir { grid-template-columns: minmax(0, 1fr) auto auto; column-gap: 14px; row-gap: 6px; }
  .login-dir .usage, .login-dir .health { display: none; }
  .grid { grid-template-columns: 1fr; }
  .panel { padding: 14px; }
  .dlg-head { padding: 14px 14px 2px; } .dlg-body { padding: 10px 14px 14px; } .dlg-foot { padding: 10px 14px; }
}
/* A change of layout band runs as a short View Transition (page-script.ts followWidth): each block below moves and
   resizes to its new place while its old and new look cross-fade; the rest of the page cross-fades as one. Same
   length and ease as a Portal's sliding sidebar (.26s, quick start, soft landing), so both read as one move. */
::view-transition-group(*) { animation-duration: .26s; animation-timing-function: cubic-bezier(.32, .72, 0, 1); }
/* Old and new looks keep their own size (pinned top left) instead of stretching to the moving box, so text never
   grows or shrinks on the way. */
::view-transition-old(*), ::view-transition-new(*) { animation-duration: .26s; height: 100%; object-fit: none; object-position: left top; }
.vt-width :is(.top-in, .summary, .stat, .section-head, .toolbar, .group-list, .group-head, .row) { view-transition-name: match-element; }
@media (prefers-reduced-motion: reduce) {
  .sk, .spin, .is-spinning svg, .toast, .toast.bump, .view-in > *, .row.flash, .card.flash, .pulse { animation: none; }
  .bar > span, .chev, .row { transition: none; }
}
`
