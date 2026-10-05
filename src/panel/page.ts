// The Panel page: one self-contained HTML document with inline CSS and JS, no external resources. The parts live in
// sibling modules: page-styles.ts (tokens and CSS), page-script.ts (behaviour, with page-logic.ts helpers) and
// i18n.ts (English and Chinese text); this module assembles them under the CSP nonce.
import { ALIAS_NAME, RESERVED_ALIASES } from '../core/config.ts'
import { QUOTA_FAIL_PERCENT, QUOTA_WARN_PERCENT, USAGE_DAYS } from '../core/quota-levels.ts'
import { MESSAGES } from './i18n.ts'
import { PAGE_SCRIPT } from './page-script.ts'
import { pageStyles } from './page-styles.ts'
import { type ResolvedTheme, resolveTheme } from './theme.ts'

export { pageStyles }

export interface PageOptions {
  basePath: string
  token: string
  /** CSP nonce for the inline style and script. */
  nonce?: string
  version?: string
  readOnly?: boolean
  /** Host theme from resolveTheme(); the default look when absent. */
  theme?: ResolvedTheme
}

/** JSON that is safe inside a `<script>` element: no `</script>`, `<!--` or line separators survive. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

const SKELETON_ROW = `<div class="sk-row"><span class="sk sk-badge"></span><span class="sk sk-title"></span><span class="sk sk-bar"></span><span class="sk sk-bar"></span></div>`
const SKELETON_STAT = `<div class="stat"><span class="sk sk-stat w70"></span></div>`

export function renderPage(opts: PageOptions): string {
  const nonce = opts.nonce ? ` nonce="${attr(opts.nonce)}"` : ''
  const theme = opts.theme ?? resolveTheme(undefined)
  const scheme = theme.colorScheme === 'auto' ? 'light dark' : theme.colorScheme
  const boot = jsonForScript({
    basePath: opts.basePath,
    token: opts.token,
    version: opts.version ?? '',
    readOnly: Boolean(opts.readOnly),
    colorScheme: theme.colorScheme,
    warn: QUOTA_WARN_PERCENT,
    fail: QUOTA_FAIL_PERCENT,
    usageDays: USAGE_DAYS,
    // The alias rules of the config, so the new-account dialog checks a short command as sideby will.
    aliasPattern: ALIAS_NAME.source,
    reservedAliases: [...RESERVED_ALIASES],
  })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<meta name="referrer" content="no-referrer">
<title>sideby</title>
<link rel="icon" href="data:,">
<style${nonce}>${pageStyles(theme)}</style>
</head>
<body${theme.header === 'bar' ? ' class="header-bar"' : ''}>
<header class="top">
  <div class="top-in">
    <div class="brand">
      <span class="logo" aria-hidden="true"><i></i><i></i></span>
      <div>
        <h1>sideby</h1>
        <p class="tagline" data-i18n="top.tagline">Every AI coding account, side by side.</p>
      </div>
    </div>
    <div class="top-actions">
      <span id="updated" class="muted small">Loading…</span>
      <button id="lang" class="icon-btn lang-btn" type="button">中文</button>
      <button id="theme" class="icon-btn" type="button" hidden></button>
      <button id="refresh" class="btn" type="button" aria-label="Refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg><span class="hide-sm" data-i18n="top.refresh">Refresh</span></button>
    </div>
  </div>
</header>
<main class="wrap">
  <div id="banners"></div>
  <section id="summary" class="summary" aria-busy="true">${SKELETON_STAT.repeat(4)}</section>
  <section class="block" aria-labelledby="h-accounts">
    <div class="section-head acct-head"><h2 id="h-accounts"><span data-i18n="acct.title">Accounts</span><span id="acct-count" class="muted small"></span></h2></div>
    <div id="toolbar" class="toolbar" hidden></div>
    <div id="accounts" aria-busy="true"><div class="group group-list">${SKELETON_ROW.repeat(4)}</div></div>
  </section>
  <section id="checkup" class="panel checkup" aria-labelledby="h-checkup">
    <div class="section-head"><h2 id="h-checkup" data-i18n="health.title">Health check</h2></div>
    <span class="sk sk-line w70"></span><span class="sk sk-line w50"></span>
  </section>
  <footer class="foot muted small">sideby <span id="ver"></span> · <span data-i18n="foot.text">runs on this machine; nothing leaves it.</span></footer>
</main>
<div id="conn" class="conn" role="status" hidden></div>
<div id="toasts" class="toasts" aria-live="polite" popover="manual"></div>
<script type="application/json" id="sideby-boot">${boot}</script>
<script type="application/json" id="sideby-i18n">${jsonForScript(MESSAGES)}</script>
<script${nonce}>${PAGE_SCRIPT}</script>
</body>
</html>
`
}
