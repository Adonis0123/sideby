// The Panel page: one self-contained HTML document with inline CSS and JS, no external resources.
import { QUOTA_FAIL_PERCENT, QUOTA_WARN_PERCENT, USAGE_DAYS } from '../core/quota-levels.ts'

export interface PageOptions {
  basePath: string
  token: string
  /** CSP nonce for the inline style and script. */
  nonce?: string
  version?: string
  readOnly?: boolean
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

const SKELETON_CARD = `<div class="card skeleton" aria-hidden="true"><div class="sk-head"><span class="sk sk-badge"></span><span class="sk sk-title"></span></div><span class="sk sk-line w50"></span><span class="sk sk-bar"></span><span class="sk sk-bar"></span><span class="sk sk-line w70"></span></div>`

export function renderPage(opts: PageOptions): string {
  const nonce = opts.nonce ? ` nonce="${attr(opts.nonce)}"` : ''
  const boot = jsonForScript({
    basePath: opts.basePath,
    token: opts.token,
    version: opts.version ?? '',
    readOnly: Boolean(opts.readOnly),
  })
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>sideby</title>
<link rel="icon" href="data:,">
<style${nonce}>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div class="brand">
      <span class="logo" aria-hidden="true"><i></i><i></i></span>
      <div>
        <h1>sideby</h1>
        <p class="tagline">Every AI coding account, side by side.</p>
      </div>
    </div>
    <div class="top-actions">
      <span id="updated" class="muted small" aria-live="polite">Loading…</span>
      <button id="refresh" class="btn btn-ghost" type="button" aria-label="Refresh">&#x21bb;<span class="hide-sm"> Refresh</span></button>
    </div>
  </header>
  <div id="banners"></div>
  <section class="block" aria-labelledby="h-accounts">
    <div class="section-head"><h2 id="h-accounts">Accounts</h2><span id="acct-count" class="muted small"></span></div>
    <div id="cards" class="grid" aria-busy="true">${SKELETON_CARD.repeat(3)}</div>
  </section>
  <div class="cols">
    <section id="checkup" class="panel" aria-labelledby="h-checkup">
      <div class="section-head"><h2 id="h-checkup">Health check</h2></div>
      <span class="sk sk-line w70"></span><span class="sk sk-line w50"></span>
    </section>
    <section id="create" class="panel" aria-labelledby="h-create">
      <div class="section-head"><h2 id="h-create">New account</h2></div>
      <span class="sk sk-line w70"></span><span class="sk sk-line w50"></span>
    </section>
  </div>
  <footer class="foot muted small">sideby <span id="ver"></span> · runs on this machine; nothing leaves it.</footer>
</div>
<script type="application/json" id="sideby-boot">${boot}</script>
<script${nonce}>${SCRIPT}</script>
</body>
</html>
`
}

const CSS = `
:root {
  --bg: #f5f6f8; --surface: #ffffff; --surface-2: #f0f2f5; --border: #e2e5ea; --border-strong: #cfd4dc;
  --text: #15171c; --muted: #5b6372; --faint: #8b93a1; --accent: #4f46e5; --accent-soft: #eef0ff;
  --ok: #15803d; --ok-bar: #22c55e; --ok-soft: #e8f7ee; --warn: #b45309; --warn-bar: #f59e0b; --warn-soft: #fdf3e2;
  --fail: #c81e1e; --fail-bar: #ef4444; --fail-soft: #fdecec; --track: #e9ecf1;
  --shadow: 0 1px 2px rgba(16,24,40,.04), 0 2px 8px rgba(16,24,40,.05);
  --radius: 14px; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d0f12; --surface: #15181d; --surface-2: #1c2026; --border: #262b33; --border-strong: #353c47;
    --text: #e7e9ee; --muted: #a0a8b5; --faint: #6c7480; --accent: #8b87ff; --accent-soft: #23224a;
    --ok: #4ade80; --ok-bar: #22c55e; --ok-soft: #13291c; --warn: #fbbf24; --warn-bar: #f59e0b; --warn-soft: #2d2410;
    --fail: #f87171; --fail-bar: #ef4444; --fail-soft: #331717; --track: #252a32;
    --shadow: 0 1px 2px rgba(0,0,0,.3);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.wrap { max-width: 1180px; margin: 0 auto; padding: 28px 24px 40px; }
h1, h2, h3 { margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 15px; font-weight: 650; }
p { margin: 0; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 22px; }
.brand { display: flex; align-items: center; gap: 12px; }
.brand h1 { font-size: 22px; font-weight: 750; letter-spacing: -0.02em; }
.tagline { color: var(--muted); font-size: 13px; }
.logo { display: inline-flex; gap: 4px; padding: 8px; border-radius: 11px; background: var(--text); }
.logo i { display: block; width: 7px; height: 20px; border-radius: 3px; background: var(--bg); }
.logo i + i { opacity: .55; }
.top-actions { display: flex; align-items: center; gap: 10px; }
.block { margin-bottom: 22px; }
.section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 14px; }
.cols { display: grid; grid-template-columns: 1.25fr 1fr; gap: 14px; align-items: start; }
.panel, .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.panel { padding: 18px; }
.card { padding: 16px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.card-error { border-color: var(--fail); box-shadow: 0 0 0 1px var(--fail) inset, var(--shadow); }
.card-head { display: flex; align-items: center; gap: 10px; }
.card-title { min-width: 0; flex: 1; }
.card-title .name { font-size: 16px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.card-title .sub { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { flex: none; display: inline-grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; color: #fff; font-weight: 700; font-size: 12.5px; letter-spacing: .02em; }
.badge-sm { width: 24px; height: 24px; border-radius: 7px; font-size: 10.5px; }
.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); color: var(--muted); font-size: 12px; line-height: 20px; white-space: nowrap; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.chip-accent { background: var(--accent-soft); border-color: transparent; color: var(--accent); }
.chip-ok { background: var(--ok-soft); border-color: transparent; color: var(--ok); }
.chip-warn { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.chip-fail { background: var(--fail-soft); border-color: transparent; color: var(--fail); }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: none; }
.dot-ok { background: var(--ok-bar); } .dot-fail { background: var(--fail-bar); } .dot-warn { background: var(--warn-bar); }
.health { margin-left: auto; }
.quota { display: flex; flex-direction: column; gap: 10px; }
.q-top { display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; }
.q-label { font-weight: 600; }
.q-pct { font-variant-numeric: tabular-nums; font-weight: 650; }
.bar { height: 8px; border-radius: 999px; background: var(--track); overflow: hidden; margin: 4px 0 3px; }
.bar > span { display: block; height: 100%; border-radius: inherit; background: var(--ok-bar); transition: width .5s ease; }
.lvl-warn .bar > span { background: var(--warn-bar); } .lvl-fail .bar > span { background: var(--fail-bar); }
.lvl-warn .q-pct { color: var(--warn); } .lvl-fail .q-pct { color: var(--fail); }
.lvl-reset .q-pct { color: var(--faint); }
.q-meta, .q-foot { color: var(--muted); font-size: 12px; }
.q-foot { display: flex; justify-content: space-between; gap: 8px; }
.note { background: var(--surface-2); border-radius: 10px; padding: 10px 12px; font-size: 13px; color: var(--muted); display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.note b { color: var(--text); font-weight: 600; }
.note-fail { background: var(--fail-soft); color: var(--fail); }
.note-warn { background: var(--warn-soft); color: var(--warn); }
.usage { border-top: 1px solid var(--border); padding-top: 11px; margin-top: auto; }
.u-num { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
.u-sub { margin-top: 1px; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 13px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font: inherit; font-weight: 550; cursor: pointer; white-space: nowrap; }
.btn:hover:not(:disabled) { background: var(--surface-2); text-decoration: none; }
.btn:disabled { opacity: .55; cursor: default; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btn-primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--muted); }
.btn-sm { height: 26px; padding: 0 9px; font-size: 12.5px; border-radius: 7px; }
.btn:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.copy { display: flex; align-items: center; gap: 6px; max-width: 100%; }
.copy code { background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; padding: 3px 8px; overflow-x: auto; white-space: nowrap; color: var(--text); min-width: 0; }
.banner { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 14px; border-radius: 12px; margin-bottom: 12px; border: 1px solid var(--border); background: var(--surface); }
.banner > div { min-width: 0; }
.banner-accent { background: var(--accent-soft); border-color: transparent; }
.banner-fail { background: var(--fail-soft); border-color: transparent; color: var(--fail); }
.banner-warn { background: var(--warn-soft); border-color: transparent; color: var(--warn); }
.banner ul { margin: 6px 0 0; padding-left: 18px; }
.setup { flex-direction: column; align-items: stretch; }
.diff { margin: 0; max-height: 260px; overflow: auto; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 10px 0; font: 12px/1.55 var(--mono); }
.diff span { display: block; padding: 0 12px; white-space: pre; }
.diff .add { background: var(--ok-soft); color: var(--ok); } .diff .del { background: var(--fail-soft); color: var(--fail); } .diff .hunk { color: var(--faint); }
.findings { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.finding { display: flex; gap: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 11px; }
.finding .dot { margin-top: 7px; }
.finding.lvl-fail .dot { background: var(--fail-bar); } .finding.lvl-warn .dot { background: var(--warn-bar); }
.finding-body { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.finding-top { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.hint { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.all-good { display: flex; align-items: center; gap: 12px; margin-top: 12px; padding: 14px; border-radius: 12px; background: var(--ok-soft); }
.check-icon { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--ok-bar); color: #fff; font-weight: 700; flex: none; }
.fix-result { margin-top: 12px; padding: 10px 12px; border-radius: 11px; font-size: 13px; }
.fix-result.is-ok { background: var(--ok-soft); color: var(--ok); } .fix-result.is-warn { background: var(--warn-soft); color: var(--warn); }
.fix-result ul { margin: 6px 0 0; padding-left: 18px; }
.form { display: flex; flex-direction: column; gap: 12px; }
.field { display: flex; flex-direction: column; gap: 5px; }
.field > span { font-weight: 600; font-size: 12.5px; }
input[type=text], select { height: 36px; border-radius: 9px; border: 1px solid var(--border-strong); background: var(--surface); color: var(--text); font: inherit; padding: 0 10px; width: 100%; }
input.invalid { border-color: var(--fail); }
.check { display: flex; gap: 9px; align-items: flex-start; cursor: pointer; }
.check input { margin-top: 3px; accent-color: var(--accent); }
.check span { display: flex; flex-direction: column; }
.field-error { color: var(--fail); font-size: 12.5px; min-height: 0; }
.field-error:empty { display: none; }
.created { margin-top: 14px; padding: 14px; border-radius: 12px; background: var(--surface-2); display: flex; flex-direction: column; gap: 10px; }
.created-head { display: flex; align-items: center; gap: 10px; }
.warn-icon { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--warn, #b7791f); color: #fff; font-weight: 700; flex: none; }
.steps { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; }
.steps li::marker { color: var(--faint); }
.empty { grid-column: 1 / -1; text-align: center; padding: 36px 20px; background: var(--surface); border: 1px dashed var(--border-strong); border-radius: var(--radius); display: flex; flex-direction: column; align-items: center; gap: 12px; }
.empty h3 { font-size: 18px; }
.empty p { max-width: 520px; }
.host-list { list-style: none; padding: 0; margin: 4px 0; display: flex; flex-direction: column; gap: 8px; min-width: min(360px, 100%); text-align: left; }
.host-list li { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; }
.host-list li > span:nth-child(2) { flex: 1; font-weight: 550; }
.sk { display: block; border-radius: 7px; background: linear-gradient(90deg, var(--surface-2) 25%, var(--track) 50%, var(--surface-2) 75%); background-size: 200% 100%; animation: shimmer 1.3s ease-in-out infinite; }
.sk-head { display: flex; gap: 10px; align-items: center; }
.sk-badge { width: 34px; height: 34px; border-radius: 10px; }
.sk-title { height: 16px; flex: 1; max-width: 140px; }
.sk-line { height: 12px; margin: 6px 0; }
.sk-bar { height: 30px; }
.w50 { width: 50%; } .w70 { width: 70%; }
@keyframes shimmer { from { background-position: 100% 0; } to { background-position: -100% 0; } }
.foot { margin-top: 28px; text-align: center; }
@media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
@media (max-width: 560px) {
  .wrap { padding: 18px 16px 32px; }
  .grid { grid-template-columns: 1fr; }
  .hide-sm { display: none; }
  .tagline { display: none; }
  .banner { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) { .sk, .spin { animation: none; } .bar > span { transition: none; } }
`

const SCRIPT = String.raw`
(() => {
  'use strict'
  const BOOT = JSON.parse(document.getElementById('sideby-boot').textContent)
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
  const FAMILY_STYLE = { claude: ['CC', '#d97757'], codex: ['CX', '#0f9f7a'], grok: ['GK', '#52525b'], pi: ['π', '#7c3aed'] }
  const S = {
    state: null, loadError: null, loading: false, loadedAt: 0,
    report: null, reportAt: null, checking: false, fixing: false, checkError: null, fixes: null,
    setup: null, creating: false, created: null,
  }
  const $ = (id) => document.getElementById(id)

  function h(tag, props, ...kids) {
    const el = document.createElement(tag)
    if (props) for (const k of Object.keys(props)) {
      const v = props[k]
      if (v === null || v === undefined || v === false) continue
      if (k === 'class') el.className = v
      else if (k === 'css') for (const p of Object.keys(v)) el.style.setProperty(p, v[p])
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? '' : String(v))
    }
    add(el, kids)
    return el
  }
  // replaceChildren() would render null as the text "null"; route children through add(), which skips it.
  function setKids(el, kids) {
    el.replaceChildren()
    add(el, kids)
  }
  function add(el, kid) {
    if (kid === null || kid === undefined || kid === false) return
    if (Array.isArray(kid)) { for (const k of kid) add(el, k); return }
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }

  async function api(path, body) {
    const init = body === undefined ? {} : {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sideby-token': BOOT.token },
      body: JSON.stringify(body),
    }
    let res
    try { res = await fetch(BOOT.basePath + path, init) } catch { throw new Error('the panel server is not reachable; is sideby ui still running?') }
    let data = null
    try { data = await res.json() } catch {}
    if (!res.ok) throw new Error((data && data.error) || 'request failed (' + res.status + ')')
    return data
  }

  function ago(iso) {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    const s = Math.max(0, (Date.now() - t) / 1000)
    if (s < 45) return 'just now'
    const m = Math.round(s / 60)
    if (m < 60) return m + ' min ago'
    const hr = Math.round(m / 60)
    if (hr < 24) return hr + ' h ago'
    return Math.round(hr / 24) + ' d ago'
  }
  function clock(iso) {
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return '?'
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return time
    if (Math.abs(d - now) < 6 * 864e5) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
  }
  function tokens(n) {
    if (!Number.isFinite(n)) return '0'
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
    for (const [v, u] of units) if (n >= v) return (n / v).toFixed(n / v >= 100 ? 0 : 1).replace(/\.0$/, '') + u
    return String(Math.round(n))
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many) }

  function family(id) { return (S.state && S.state.families.find((f) => f.id === id)) || { id, title: id, bin: id, installUrl: '', installed: false } }
  function badge(id, small) {
    const st = FAMILY_STYLE[id]
    let color = st && st[1]
    if (!color) { let x = 0; for (const c of id) x = (x * 31 + c.charCodeAt(0)) % 360; color = 'hsl(' + x + ' 55% 46%)' }
    return h('span', { class: 'badge' + (small ? ' badge-sm' : ''), css: { background: color }, 'aria-hidden': 'true' }, st ? st[0] : id.slice(0, 2).toUpperCase())
  }
  function spinner() { return h('span', { class: 'spin', 'aria-hidden': 'true' }) }
  function link(text, url) {
    let ok = false
    try { const u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:' } catch {}
    return ok ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text) : null
  }
  async function copyText(text, btn) {
    try { await navigator.clipboard.writeText(text) } catch {
      const ta = h('textarea', { css: { position: 'fixed', opacity: '0' } })
      ta.value = text
      document.body.append(ta)
      ta.select()
      try { document.execCommand('copy') } catch {}
      ta.remove()
    }
    btn.textContent = 'Copied'
    setTimeout(() => { btn.textContent = 'Copy' }, 1400)
  }
  function codeCopy(text) {
    const btn = h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copyText(text, btn) }, 'Copy')
    return h('span', { class: 'copy' }, h('code', null, text), btn)
  }

  // ---------- doctor summary ----------
  // Health comes from the Doctor history, which keeps the latest result per Account: an Account that was
  // never checked shows "Not checked", never "Healthy".
  function entries() {
    const h = S.history
    return h ? Object.values(h.general).concat(Object.values(h.accounts)) : []
  }
  function findingsNow() {
    const list = entries()
    return list.length ? [].concat(...list.map((e) => e.findings)) : null
  }
  function lastCheckAt() {
    const times = entries().map((e) => e.at).sort()
    return times.length ? times[times.length - 1] : null
  }
  function healthOf(ref) {
    const e = S.history && S.history.accounts[ref]
    if (!e) return null
    let fail = 0, warn = 0
    for (const f of e.findings) { if (f.level === 'fail') fail++; else if (f.level === 'warn') warn++ }
    return { fail, warn }
  }

  // ---------- account cards ----------
  const REASON = {
    'no-session': (a) => ['No quota data yet. It shows up after your next session.', codeCopy('sideby run ' + a.ref)],
    'no-source': (a) => [(a.familyTitle || a.family) + ' has no public quota source.'],
    unrecognized: (a, q) => ['Could not read quota; the host format may have changed.', q.detail ? h('span', { class: 'small' }, q.detail) : null],
    'api-account': () => ['API account: usage is billed by your provider.'],
  }
  function setupFor(fam) { return S.state.quotaSetups.find((s) => s.family === fam) }

  function quotaBlock(a) {
    const q = a.quota
    if (!q) return null
    if (q.status === 'ok') {
      const now = Date.now()
      const order = (w) => (w.label === '5h' ? 0 : w.label === '7d' ? 1 : 2)
      const wins = q.windows.slice().sort((x, y) => order(x) - order(y) || x.windowMinutes - y.windowMinutes)
      return h('div', { class: 'quota' },
        wins.length ? wins.map((w) => quotaRow(w, now)) : h('p', { class: 'muted small' }, 'No quota windows reported.'),
        h('div', { class: 'q-foot' }, h('span', null, 'Data from ' + ago(q.observedAt)), q.plan ? h('span', null, q.plan) : null))
    }
    if (q.reason === 'not-enabled') {
      const setup = setupFor(a.family)
      const canTurnOn = setup && setup.plan.status === 'ready' && !BOOT.readOnly
      return h('div', { class: 'note' },
        h('span', null, h('b', null, 'Quota display is off. '), q.detail || 'Turn it on once to see 5h and 7d limits here.'),
        canTurnOn ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openSetup(a.family) }, 'Turn on quota') : null)
    }
    const fn = REASON[q.reason]
    return h('div', { class: 'note' }, fn ? fn(a, q) : 'Quota unavailable (' + q.reason + ').')
  }
  function quotaRow(w, now) {
    const reset = Date.parse(w.resetsAt)
    const passed = Number.isFinite(reset) && reset <= now
    const pct = Math.max(0, Math.min(100, Math.round(w.usedPercent)))
    const lvl = passed ? 'reset' : pct >= ${QUOTA_FAIL_PERCENT} ? 'fail' : pct >= ${QUOTA_WARN_PERCENT} ? 'warn' : 'ok'
    const shown = passed ? 0 : pct
    return h('div', { class: 'q-row lvl-' + lvl },
      h('div', { class: 'q-top' }, h('span', { class: 'q-label' }, w.label + ' limit'), h('span', { class: 'q-pct' }, passed ? '0%' : pct + '% used')),
      h('div', { class: 'bar', role: 'meter', 'aria-label': w.label + ' quota used', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown) }, h('span', { css: { width: shown + '%' } })),
      h('div', { class: 'q-meta' }, passed ? 'Reset. Updates after your next session.' : 'Resets ' + clock(w.resetsAt)))
  }
  function usageBlock(a) {
    const u = a.usage
    if (!u) return null
    if (u.status === 'ok')
      return h('div', { class: 'usage' },
        h('div', null, h('span', { class: 'u-num' }, tokens(u.totalTokens)), h('span', { class: 'muted small' }, ' tokens · last ' + u.days + ' days')),
        h('div', { class: 'u-sub muted small' }, plural(u.sessions, 'session', 'sessions') + ' · in ' + tokens(u.inputTokens) + ' · out ' + tokens(u.outputTokens) + ' · cache ' + tokens(u.cacheReadTokens + u.cacheWriteTokens)))
    const text = u.reason === 'no-session' ? 'No sessions in the last ${USAGE_DAYS} days.' : u.reason === 'no-source' ? 'This host keeps no local usage records.' : 'Could not read usage records' + (u.detail ? ': ' + u.detail : '.')
    return h('div', { class: 'usage muted small' }, text)
  }
  function healthChip(a) {
    if (a.error) return h('span', { class: 'chip chip-fail health' }, 'Error')
    const hs = healthOf(a.ref)
    if (!hs) return h('span', { class: 'chip health' }, S.checking ? 'Checking…' : 'Not checked')
    if (hs.fail) return h('span', { class: 'chip chip-fail health', title: 'See Health check' }, plural(hs.fail, 'issue', 'issues'))
    if (hs.warn) return h('span', { class: 'chip chip-warn health', title: 'See Health check' }, plural(hs.warn, 'warning', 'warnings'))
    return h('span', { class: 'chip chip-ok health' }, 'Healthy')
  }
  function card(a) {
    const fam = family(a.family)
    const login = a.login === 'logged-in' ? h('span', { class: 'chip' }, h('span', { class: 'dot dot-ok' }), 'Signed in')
      : a.login === 'logged-out' ? h('span', { class: 'chip' }, h('span', { class: 'dot dot-fail' }), 'Signed out') : null
    return h('article', { class: 'card' + (a.error ? ' card-error' : ''), 'aria-label': a.ref },
      h('header', { class: 'card-head' },
        badge(a.family),
        h('div', { class: 'card-title' }, h('div', { class: 'name', title: a.ref }, a.name), h('div', { class: 'sub' }, (a.familyTitle || fam.title) + ' · ' + a.ref)),
        healthChip(a)),
      h('div', { class: 'tags' },
        h('span', { class: 'chip ' + (a.kind === 'api' ? 'chip-warn' : 'chip-accent') }, a.kind === 'api' ? 'API key' : 'Subscription'),
        a.model ? h('span', { class: 'chip mono', title: 'Model' }, a.model) : null,
        login),
      a.error ? h('div', { class: 'note note-fail' }, h('b', null, 'Could not read this account'), h('span', { class: 'small' }, a.error)) : null,
      a.hostInstalled === false ? h('div', { class: 'note note-warn' }, h('span', null, fam.title + ' is not installed on this machine. ', link('Install it', fam.installUrl))) : null,
      a.login === 'logged-out' && a.kind !== 'api' ? h('div', { class: 'note' }, 'Sign in to start using it:', codeCopy('sideby login ' + a.ref)) : null,
      quotaBlock(a),
      usageBlock(a))
  }
  function emptyState() {
    const fams = S.state.families
    return h('div', { class: 'empty' },
      h('span', { class: 'logo', 'aria-hidden': 'true' }, h('i'), h('i')),
      h('h3', null, 'No accounts yet'),
      h('p', { class: 'muted' }, 'sideby picks up the folders your AI coding tools already use. Install a tool and run it once, then add a second account to run side by side.'),
      fams.length ? h('ul', { class: 'host-list' }, fams.map((f) => h('li', null, badge(f.id, true), h('span', null, f.title),
        f.installed ? h('span', { class: 'muted small' }, 'run ', h('code', null, f.bin), ' once') : link('Install', f.installUrl)))) : h('p', { class: 'muted small' }, 'No families are registered. Check sideby plugins.'),
      BOOT.readOnly ? null : h('a', { class: 'btn btn-primary', href: '#create' }, 'Create your first account'))
  }
  function renderCards() {
    const box = $('cards')
    if (!S.state) {
      if (S.loadError) { box.removeAttribute('aria-busy'); box.replaceChildren() }
      return
    }
    box.removeAttribute('aria-busy')
    const list = S.state.accounts
    $('acct-count').textContent = list.length ? plural(list.length, 'account', 'accounts') : ''
    setKids(box, list.length ? list.map(card) : [emptyState()])
  }

  // ---------- banners and quota setup ----------
  function diffView(diff) {
    return h('pre', { class: 'diff' }, diff.split('\n').map((l) => h('span', {
      class: l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : null,
    }, l || ' ')))
  }
  function setupPanel() {
    const st = S.setup
    const fam = family(st.family)
    const close = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { S.setup = null; renderBanners() } }, 'Close')
    const body = []
    if (st.loading) body.push(h('p', { class: 'muted' }, spinner(), ' Preparing the change…'))
    if (st.error) body.push(h('p', { class: 'note note-fail' }, st.error))
    if (st.plan) {
      const p = st.plan
      if (p.status === 'enabled') body.push(h('p', null, st.applied ? 'Done. ' : '', p.message || ('Quota display is on. Numbers appear after your next ' + fam.title + ' session.')))
      else if (p.status === 'blocked') body.push(h('p', { class: 'note note-warn' }, p.message))
      else {
        body.push(h('p', { class: 'muted' }, st.summary || p.message))
        if (p.file) body.push(h('p', { class: 'small' }, 'This changes ', h('code', null, p.file), ':'))
        if (p.diff) body.push(diffView(p.diff))
        body.push(h('div', { class: 'actions' },
          h('button', { class: 'btn btn-primary', type: 'button', disabled: st.applying, onclick: applySetup }, st.applying ? spinner() : null, st.applying ? 'Applying…' : 'Apply change'),
          h('button', { class: 'btn', type: 'button', disabled: st.applying, onclick: () => { S.setup = null; renderBanners() } }, 'Cancel')))
      }
    }
    return h('div', { class: 'banner banner-accent setup', id: 'setup', role: 'dialog', 'aria-label': 'Turn on quota' },
      h('div', { class: 'section-head' }, h('h2', null, 'Turn on ' + fam.title + ' quota'), close), body)
  }
  async function openSetup(fam) {
    S.setup = { family: fam, loading: true }
    renderBanners()
    $('setup').scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    try {
      const r = await api('/api/quota/setup', { family: fam })
      S.setup = { family: fam, plan: r.plan, summary: r.summary }
    } catch (e) { S.setup = { family: fam, error: e.message } }
    renderBanners()
  }
  async function applySetup() {
    const st = S.setup
    st.applying = true
    renderBanners()
    try {
      const r = await api('/api/quota/setup', { family: st.family, confirm: true })
      S.setup = { family: st.family, plan: r.plan, summary: r.summary, applied: r.plan.status === 'enabled' }
      if (r.plan.status === 'enabled') load()
    } catch (e) { st.applying = false; st.error = e.message }
    renderBanners()
  }
  function renderBanners() {
    const box = $('banners')
    const out = []
    if (S.loadError) out.push(h('div', { class: 'banner banner-fail', role: 'alert' },
      h('div', null, h('b', null, 'Could not load accounts. '), S.loadError),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load({ check: !S.report }) }, 'Retry')))
    if (S.state) {
      if (BOOT.readOnly) out.push(h('div', { class: 'banner' }, h('div', { class: 'muted' }, 'Read-only view. Use the sideby CLI to fix or create accounts.')))
      const errs = S.state.pluginErrors
      if (errs.length) out.push(h('div', { class: 'banner banner-warn', role: 'status' }, h('div', null,
        h('b', null, plural(errs.length, 'plugin', 'plugins') + ' failed to load. '), 'Run sideby plugins for details.',
        h('ul', null, errs.map((e) => h('li', null, h('code', null, e.where), ': ', e.message))))))
      for (const s of S.state.quotaSetups) {
        if (S.setup && S.setup.family === s.family) continue
        const off = S.state.accounts.some((a) => a.family === s.family && a.quota && a.quota.status === 'unavailable' && a.quota.reason === 'not-enabled')
        if (!off || s.plan.status === 'enabled') continue
        const title = family(s.family).title
        if (s.plan.status === 'blocked') out.push(h('div', { class: 'banner banner-warn' }, h('div', null, h('b', null, title + ' quota cannot be turned on. '), s.plan.message)))
        else if (!BOOT.readOnly) out.push(h('div', { class: 'banner banner-accent' },
          h('div', null, h('b', null, 'See ' + title + ' quota on every card. '), h('span', { class: 'muted' }, s.summary)),
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => openSetup(s.family) }, 'Turn on')))
      }
    }
    if (S.setup) out.push(setupPanel())
    setKids(box, out)
  }

  // ---------- health check ----------
  async function runCheck() {
    if (S.checking || S.fixing) return
    S.checking = true
    S.checkError = null
    renderCheckup(); renderCards()
    try {
      const r = await api('/api/doctor', {})
      S.report = r.report
      S.history = r.history
    } catch (e) { S.checkError = e.message }
    S.checking = false
    renderCheckup(); renderCards()
  }
  async function runFix() {
    if (S.checking || S.fixing) return
    S.fixing = true
    S.checkError = null
    S.fixes = null
    renderCheckup()
    try {
      const r = await api('/api/fix', {})
      S.report = r.report
      S.history = r.history
      S.fixes = r.report.fixes
    } catch (e) { S.checkError = e.message }
    S.fixing = false
    renderCheckup()
    load()
  }
  function findingRow(f) {
    return h('li', { class: 'finding lvl-' + f.level },
      h('span', { class: 'dot', title: f.level }),
      h('div', { class: 'finding-body' },
        h('div', { class: 'finding-top' },
          h('span', { class: 'chip mono' }, f.account),
          h('span', { class: 'muted small mono' }, f.item),
          f.fixable ? h('span', { class: 'chip chip-accent' }, 'auto-fix') : null,
          f.source && f.source !== 'core' ? h('span', { class: 'muted small' }, 'from ' + f.source) : null),
        h('p', null, f.message),
        f.hint ? h('p', { class: 'hint' }, f.hint) : null))
  }
  function renderCheckup() {
    const box = $('checkup')
    const findings = findingsNow()
    const at = lastCheckAt()
    const busy = S.checking || S.fixing
    const fixable = findings ? findings.filter((f) => f.fixable).length : 0
    const status = S.checking ? 'Checking accounts…' : S.fixing ? 'Fixing…' : at ? 'Last check ' + ago(at) : 'Not checked yet'
    const out = [h('div', { class: 'section-head' },
      h('div', null, h('h2', { id: 'h-checkup' }, 'Health check'), h('p', { class: 'muted small' }, status)),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', disabled: busy || !S.state, onclick: runCheck }, S.checking ? spinner() : null, S.checking ? 'Checking' : 'Run check'),
        BOOT.readOnly ? null : h('button', { class: 'btn btn-primary', type: 'button', disabled: busy || !fixable, onclick: runFix },
          S.fixing ? spinner() : null, S.fixing ? 'Fixing…' : 'Fix all' + (fixable ? ' (' + fixable + ')' : ''))))]
    if (S.checkError) out.push(h('div', { class: 'note note-fail', role: 'alert' }, S.checkError))
    if (S.fixes) {
      const failed = S.fixes.filter((f) => !f.ok)
      out.push(h('div', { class: 'fix-result ' + (failed.length ? 'is-warn' : 'is-ok'), role: 'status' },
        S.fixes.length ? 'Fixed ' + (S.fixes.length - failed.length) + ' of ' + S.fixes.length + '.' : 'Nothing needed fixing.',
        failed.length ? h('ul', null, failed.map((f) => h('li', null, h('b', null, f.account + ' · ' + f.item + ': '), f.message))) : null))
    }
    if (!findings) {
      if (busy || !S.state) out.push(h('span', { class: 'sk sk-line w70' }), h('span', { class: 'sk sk-line w50' }))
      else out.push(h('p', { class: 'muted' }, 'Checks that shared skills, settings and credentials are in place for every account.'))
    } else if (!findings.length) {
      out.push(h('div', { class: 'all-good' }, h('span', { class: 'check-icon', 'aria-hidden': 'true' }, '✓'),
        h('div', null, h('b', null, 'All healthy'), h('p', { class: 'muted small' }, 'Every account shares what it should.'))))
    } else {
      const rank = { fail: 0, warn: 1, ok: 2 }
      out.push(h('ul', { class: 'findings' }, findings.slice().sort((x, y) => rank[x.level] - rank[y.level]).map(findingRow)))
    }
    setKids(box, out)
  }

  // ---------- new account ----------
  const form = {}
  function nameProblem() {
    const fam = form.family.value
    const name = form.name.value.trim()
    if (!name) return ''
    if (name === 'main') return '"main" is the default account. Pick another name.'
    if (!NAME_RE.test(name)) return 'Use 1 to 32 lowercase letters, digits or "-", starting with a letter or digit.'
    if (S.state && S.state.accounts.some((a) => a.ref === fam + ':' + name)) return fam + ':' + name + ' already exists.'
    return ''
  }
  function familyProblem() {
    const fam = form.family.value
    if (!fam) return 'Pick a tool first.'
    const info = family(fam)
    const hasMain = S.state && S.state.accounts.some((a) => a.family === fam && a.isMain)
    if (!hasMain) return info.installed ? 'Run ' + info.bin + ' once so it creates its default folder, then try again.' : info.title + ' is not installed yet.'
    return ''
  }
  function validate() {
    const msg = nameProblem()
    form.name.classList.toggle('invalid', Boolean(msg))
    form.error.textContent = msg
    return msg
  }
  async function submit(ev) {
    ev.preventDefault()
    if (S.creating) return
    const msg = validate() || familyProblem() || (form.name.value.trim() ? '' : 'Enter a name.')
    if (msg) { form.error.textContent = msg; form.name.focus(); return }
    S.creating = true
    S.created = null
    renderCreateResult()
    try {
      S.created = await api('/api/accounts', { family: form.family.value, name: form.name.value.trim(), api: form.api.checked })
      form.name.value = ''
      form.api.checked = false
      load({ check: true })
    } catch (e) { form.error.textContent = e.message }
    S.creating = false
    renderCreateResult()
  }
  function stepRow(s) {
    const fill = /^fill in (.+)$/.exec(s)
    if (fill) return h('li', null, 'Add your key or relay to ', codeCopy(fill[1]))
    if (s.startsWith('sideby ')) return h('li', null, codeCopy(s))
    return h('li', null, s)
  }
  function renderCreateResult() {
    form.submit.disabled = S.creating || BOOT.readOnly
    form.submit.replaceChildren(...(S.creating ? [spinner(), 'Creating…'] : ['Create account']))
    const r = S.created
    if (!r) { form.result.replaceChildren(); return }
    const failed = r.steps.filter((s) => !s.ok)
    form.result.replaceChildren(h('div', { class: 'created', role: 'status' },
      r.ok
        ? h('div', { class: 'created-head' }, h('span', { class: 'check-icon', 'aria-hidden': 'true' }, '✓'), h('span', null, 'Created ', h('b', { class: 'mono' }, r.account.ref)))
        : h('div', { class: 'created-head' }, h('span', { class: 'warn-icon', 'aria-hidden': 'true' }, '!'), h('span', null, 'Created ', h('b', { class: 'mono' }, r.account.ref), ' with problems; see below')),
      failed.length || r.hookErrors.length ? h('div', { class: 'note note-warn' },
        failed.map((s) => h('span', { class: 'small' }, s.item + ': ' + (s.message || 'failed'))),
        r.hookErrors.map((e) => h('span', { class: 'small' }, 'plugin ' + e.plugin + ': ' + e.message))) : null,
      h('p', { class: 'muted small' }, 'Next steps'),
      h('ol', { class: 'steps' }, r.nextSteps.map(stepRow))))
  }
  function buildCreate() {
    const box = $('create')
    form.family = h('select', { id: 'nf-family', name: 'family' })
    form.name = h('input', { id: 'nf-name', name: 'name', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'work', maxlength: '32', 'aria-describedby': 'nf-err' })
    form.api = h('input', { id: 'nf-api', type: 'checkbox' })
    form.error = h('p', { class: 'field-error', id: 'nf-err', role: 'alert' })
    form.submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Create account')
    form.result = h('div', { 'aria-live': 'polite' })
    form.name.addEventListener('input', validate)
    form.family.addEventListener('change', validate)
    const fieldset = h('fieldset', { css: { border: '0', padding: '0', margin: '0', 'min-width': '0' }, disabled: BOOT.readOnly },
      h('form', { class: 'form', novalidate: true, onsubmit: submit },
        h('label', { class: 'field' }, h('span', null, 'Tool'), form.family),
        h('label', { class: 'field' }, h('span', null, 'Name'), form.name),
        h('label', { class: 'check' }, form.api, h('span', null, h('b', null, 'API key account'), h('span', { class: 'muted small' }, 'Gets its own proxy.env for a key or a relay. Leave off for a subscription.'))),
        form.error,
        h('div', { class: 'actions' }, form.submit)))
    setKids(box, [
      h('div', { class: 'section-head' }, h('div', null, h('h2', { id: 'h-create' }, 'New account'), h('p', { class: 'muted small' }, 'Runs next to your existing ones, sharing skills and settings.'))),
      BOOT.readOnly ? h('p', { class: 'muted small' }, 'Read-only view: create accounts with sideby new.') : null,
      fieldset, form.result])
  }
  function renderFamilies() {
    if (!S.state) return
    const keep = form.family.value
    form.family.replaceChildren(...S.state.families.map((f) => h('option', { value: f.id }, f.title + (f.installed ? '' : ' (not installed)'))))
    const fallback = S.state.families.find((f) => S.state.accounts.some((a) => a.family === f.id && a.isMain))
    form.family.value = keep && S.state.families.some((f) => f.id === keep) ? keep : fallback ? fallback.id : (S.state.families[0] || {}).id || ''
  }

  // ---------- top-level ----------
  function renderTop() {
    $('updated').textContent = S.loading && !S.state ? 'Loading…' : S.loading ? 'Refreshing…' : S.loadedAt ? 'Updated ' + ago(new Date(S.loadedAt).toISOString()) : ''
    $('refresh').disabled = S.loading
  }
  function renderAll() { renderTop(); renderBanners(); renderCards(); renderCheckup(); renderFamilies() }
  // A load that starts while another runs is queued, never dropped, so a change made meanwhile (a new
  // account, a fix) always ends up on screen; and only the newest response is ever rendered.
  let loadSeq = 0
  let queued = null
  async function load(opts) {
    if (S.loading) {
      queued = { check: Boolean((queued && queued.check) || (opts && opts.check)) }
      return
    }
    const seq = ++loadSeq
    S.loading = true
    renderTop()
    let state = null
    let error = null
    try { state = await api('/api/state') } catch (e) { error = e.message }
    if (seq === loadSeq) {
      if (state) {
        S.state = state; S.loadError = null; S.loadedAt = Date.now()
        // A read-only Panel never records checks, so keep the result of its own last check over the disk.
        if (!BOOT.readOnly || !S.history) S.history = state.history || null
      } else S.loadError = error
    }
    S.loading = false
    const next = queued
    queued = null
    if (next) return load(next)
    renderAll()
    if (S.state && opts && opts.check) runCheck()
  }

  $('ver').textContent = BOOT.version ? 'v' + BOOT.version : ''
  $('refresh').addEventListener('click', () => load({ check: true }))
  buildCreate()
  renderCreateResult()
  load({ check: true })
  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - S.loadedAt > 60000 && !S.creating && !S.fixing) load()
    else { renderTop(); renderCards(); renderCheckup() }
  }, 30000)
})()
`
