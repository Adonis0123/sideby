// The Panel page: one self-contained HTML document with inline CSS and JS, no external resources. The parts live in
// sibling modules: page-styles.ts (tokens and CSS), page-script.ts (behaviour, with page-logic.ts helpers) and
// i18n.ts (English and Chinese text); this module assembles them under the CSP nonce.
import { createHash } from 'node:crypto'
import { FAVICON_SVG, MARK_SVG } from '../core/brand-mark.ts'
import { ALIAS_NAME, RESERVED_ALIASES } from '../core/config.ts'
import { QUOTA_FAIL_PERCENT, QUOTA_WARN_PERCENT, USAGE_DAYS } from '../core/quota-levels.ts'
import { REPO_URL, SKILL_INSTALL } from '../core/skill-check.ts'
import type { LocalBuild } from '../core/version.ts'
import { MESSAGES } from './i18n.ts'
import { widthTier } from './page-logic.ts'
import { PAGE_SCRIPT } from './page-script.ts'
import { pageStyles } from './page-styles.ts'
import { type ResolvedTheme, resolveTheme } from './theme.ts'

/** GitHub's mark, from Simple Icons (CC0 1.0, https://simpleicons.org); a trademark of GitHub that only names the site. */
const GITHUB_MARK =
  'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12'

/** Browsers keep a favicon past `no-cache`; a link that changes with the mark makes them fetch the new one. */
export const FAVICON_VERSION = createHash('sha256').update(FAVICON_SVG).digest('hex').slice(0, 10)

export { pageStyles }

export interface PageOptions {
  basePath: string
  token: string
  /** CSP nonce for the inline style and script. */
  nonce?: string
  version?: string
  /** buildId() of the serving process; the page reloads when /api/state reports another one. */
  build?: string
  /** localBuild() of the serving process (ADR-0024): the version pill names the commit. */
  local?: LocalBuild | null
  readOnly?: boolean
  /** Host theme from resolveTheme(); the default look when absent. */
  theme?: ResolvedTheme
  /** Host language from createPanelHandler's `lang`; `auto` (the default) lets the viewer choose. */
  lang?: 'auto' | 'en' | 'zh'
  /** createPanelHandler's `updates`: false hides everything about sideby updates. */
  updates?: boolean
  /**
   * createPanelHandler's `ask`: with the bridge, inside a frame, AI Task entries post to the Portal and the page script
   * hides the header button; opened on its own, the Panel keeps both.
   */
  ask?: { bridge: 'postMessage' }
  /** Config `panel` (spec §3.29): the theme and language saved for the Panel. */
  panel?: { theme?: string; language?: string }
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

// The layout band (page-logic.ts widthTier) is set in the head, so the first paint already has the narrow-screen
// layout; the page script then follows the width as it changes.
const SKELETON_ROW = `<div class="sk-row"><span class="sk sk-badge"></span><span class="sk sk-title"></span><span class="sk sk-bar"></span><span class="sk sk-bar"></span></div>`
const SKELETON_STAT = `<div class="stat"><span class="sk sk-stat w70"></span></div>`

export function renderPage(opts: PageOptions): string {
  const nonce = opts.nonce ? ` nonce="${attr(opts.nonce)}"` : ''
  const theme = opts.theme ?? resolveTheme(undefined)
  const scheme = theme.colorScheme === 'auto' ? 'light dark' : theme.colorScheme
  const lang = opts.lang ?? 'auto'
  const boot = jsonForScript({
    basePath: opts.basePath,
    token: opts.token,
    version: opts.version ?? '',
    build: opts.build ?? '',
    local: opts.local ?? null,
    readOnly: Boolean(opts.readOnly),
    updates: opts.updates !== false,
    ask: opts.ask ?? null,
    colorScheme: theme.colorScheme,
    lang,
    panel: opts.panel ?? {},
    warn: QUOTA_WARN_PERCENT,
    fail: QUOTA_FAIL_PERCENT,
    usageDays: USAGE_DAYS,
    // The alias rules of the config, so the new-account dialog checks a short command as sideby will.
    aliasPattern: ALIAS_NAME.source,
    reservedAliases: [...RESERVED_ALIASES],
    // The command that installs the sideby Agent Skill, which the Panel offers so an AI assistant can do the same.
    skillInstall: SKILL_INSTALL,
    // sideby's repository for the header link, set by the script: the page itself names no outside address.
    repoUrl: REPO_URL,
  })
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<meta name="referrer" content="no-referrer">
<title>sideby</title>
<link rel="icon" type="image/svg+xml" href="${attr(opts.basePath)}/favicon.svg?v=${FAVICON_VERSION}">
<style${nonce}>${pageStyles(theme)}</style>
<script${nonce}>document.documentElement.dataset.width = (${widthTier})(window.innerWidth)</script>
</head>
<body${theme.header === 'bar' ? ' class="header-bar"' : ''}>
<header class="top">
  <div class="top-in">
    <div class="brand">
      <span class="logo" aria-hidden="true">${MARK_SVG}</span>
      <div>
        <div class="title-row"><h1>sideby</h1><button id="ver-top" class="ver-pill" type="button" aria-haspopup="dialog" aria-expanded="false" hidden></button></div>
        <p class="tagline" data-i18n="top.tagline">Every AI coding account, side by side.</p>
      </div>
    </div>
    <div class="top-actions">
      <button id="update" class="btn update-btn" type="button" hidden></button>
      <button id="ask-ai" class="btn" type="button" aria-haspopup="dialog" aria-label="Let AI do it"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 5v4M9.5 13.5v1M14.5 13.5v1"/></svg><span class="hide-sm" data-i18n="ask.button">Let AI do it</span></button>
      <a id="repo" class="icon-btn repo-link" target="_blank" rel="noopener noreferrer" aria-label="sideby on GitHub" title="sideby on GitHub" hidden><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${GITHUB_MARK}"/></svg></a>
      <button id="settings" class="btn" type="button" aria-haspopup="dialog" aria-expanded="false"${lang === 'auto' ? '' : ' hidden'}><span data-i18n="set.button">Settings</span></button>
      <button id="refresh" class="btn" type="button" aria-label="Refresh"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg><span class="hide-sm" data-i18n="top.refresh">Refresh</span></button>
    </div>
  </div>
</header>
<main class="wrap">
  <div id="banners"></div>
  <nav id="pages" class="pages" role="tablist" hidden></nav>
  <section id="summary" class="summary" aria-busy="true">${SKELETON_STAT.repeat(4)}</section>
  <section id="handoff-page" class="block" aria-labelledby="h-handoff" hidden></section>
  <section id="tuning-page" class="block" aria-labelledby="h-tuning" hidden></section>
  <section id="accounts-page" class="block" aria-labelledby="h-accounts">
    <div class="section-head acct-head"><h2 id="h-accounts"><span data-i18n="acct.title">Accounts</span><span id="acct-count" class="muted small"></span></h2><span id="updated" class="muted small" role="status">Loading…</span></div>
    <div id="toolbar" class="toolbar" hidden></div>
    <div id="accounts" aria-busy="true"><div class="group group-list">${SKELETON_ROW.repeat(4)}</div></div>
  </section>
  <section id="checkup" class="panel checkup" aria-labelledby="h-checkup">
    <div class="section-head"><h2 id="h-checkup" data-i18n="health.title">Health check</h2></div>
    <span class="sk sk-line w70"></span><span class="sk sk-line w50"></span>
  </section>
  <footer class="foot muted small"><button id="ver" class="link-btn" type="button" aria-haspopup="dialog" aria-expanded="false">sideby</button> · <span id="foot-text" data-i18n="foot.text">runs on this machine; nothing leaves it.</span></footer>
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
