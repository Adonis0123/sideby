// The Panel page's inline script. Plain browser JavaScript in a string (no template literals inside, so String.raw
// keeps it verbatim); the pure helpers from page-logic.ts are prepended so the tested code is the code that runs.
import {
  aliasIssue,
  attentionReasons,
  cacheHitRate,
  formatDuration,
  maskEmail,
  matchesQuery,
  mergeDaily,
  newAccountDir,
  nextReset,
  panelHint,
  passedWindow,
  quotaPressure,
  sortAccounts,
  suggestAlias,
  suggestName,
  windowState,
} from './page-logic.ts'

const LOGIC = [
  aliasIssue,
  attentionReasons,
  cacheHitRate,
  formatDuration,
  maskEmail,
  matchesQuery,
  mergeDaily,
  newAccountDir,
  nextReset,
  panelHint,
  passedWindow,
  quotaPressure,
  sortAccounts,
  suggestAlias,
  suggestName,
  windowState,
]
  .map((fn) => fn.toString())
  .join('\n')

const MAIN = String.raw`
  const BOOT = JSON.parse(document.getElementById('sideby-boot').textContent)
  const MESSAGES = JSON.parse(document.getElementById('sideby-i18n').textContent)
  const WARN = BOOT.warn
  const FAIL = BOOT.fail
  // Quota data older than this is greyed and marked with its age.
  const STALE_MS = 60 * 60000
  // Findings listed before the rest fold behind a button.
  const FINDINGS_SHOWN = 5
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // Auto refresh: the state reloads every AUTO_MS while the page is visible, and every FAST_MS for FAST_FOR_MS after
  // quota is turned on, so the first numbers show up soon after a status line reports them.
  const AUTO_MS = 20000
  const FAST_MS = 5000
  const FAST_FOR_MS = 3 * 60000
  const S = {
    state: null, loadError: null, loading: false, loadedAt: 0, history: null,
    report: null, checking: false, fixing: false, checkError: null, checkRetry: null, fixes: null,
    // silent: the running load is a background one (no spinner); lastTry: when the last load started;
    // pending: a background load finished while the viewer was busy, so its render waits; fastUntil/fastFamily:
    // the quick polling after quota was turned on.
    silent: false, lastTry: 0, pending: false, fastUntil: 0, fastFamily: null,
  }
  // View state that is not saved: the search text, the attention filter, the Health check filter.
  const ui = { query: '', attention: false, allFindings: false, healthRef: null, checkingRef: null, highlight: null, fade: true }
  const $ = (id) => document.getElementById(id)

  // ---------- preferences ----------
  // Kept in localStorage, which can be missing or throw (private windows, blocked storage): every access is guarded
  // and the defaults apply.
  const PREFS_KEY = 'sideby.panel.v2'
  const CHOICES = { view: ['list', 'cards'], sort: ['pressure', 'name', 'recent'], quota: ['used', 'left'], theme: ['system', 'light', 'dark'], lang: ['en', 'zh'] }
  const prefs = loadPrefs()
  function loadPrefs() {
    let raw = {}
    try { raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {} } catch {}
    const p = { view: 'list', sort: 'pressure', quota: 'used', theme: 'system', lang: '', family: '', collapsed: {}, hideEmail: false }
    for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(raw[k])) p[k] = raw[k]
    if (raw.hideEmail === true) p.hideEmail = true
    if (typeof raw.family === 'string') p.family = raw.family
    if (raw.collapsed && typeof raw.collapsed === 'object')
      for (const k of Object.keys(raw.collapsed)) if (raw.collapsed[k] === true) p.collapsed[k] = true
    return p
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch {} }
  let lang = prefs.lang || (/^zh/i.test(navigator.language || '') ? 'zh' : 'en')

  // ---------- text ----------
  function t(key, vars) {
    const table = MESSAGES[lang] || {}
    let s = Object.hasOwn(table, key) ? table[key] : Object.hasOwn(MESSAGES.en, key) ? MESSAGES.en[key] : key
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m))
    return s
  }
  function tn(key, n, vars) { return t(key + (n === 1 ? '.one' : '.other'), Object.assign({ n }, vars)) }
  // A message whose placeholders are nodes, such as a code span inside a sentence.
  function tx(key, vars) {
    const s = t(key)
    const out = []
    let last = 0
    s.replace(/\{(\w+)\}/g, (m, k, i) => {
      out.push(s.slice(last, i), vars && Object.hasOwn(vars, k) ? vars[k] : m)
      last = i + m.length
      return m
    })
    out.push(s.slice(last))
    return out.filter((x) => x !== '')
  }
  const locale = () => (lang === 'zh' ? 'zh-CN' : 'en-US')

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
    // Every button gets an explicit accessible name; one without aria-label is named by its visible text.
    if (tag === 'button' && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) labelFromText(el)
    return el
  }
  function visibleText(node) {
    const parts = []
    for (const k of node.childNodes) {
      if (k.nodeType === 3) parts.push(k.data)
      else if (k.nodeType === 1 && k.getAttribute('aria-hidden') !== 'true') parts.push(visibleText(k))
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim()
  }
  function labelFromText(el) {
    const text = visibleText(el)
    if (text) el.setAttribute('aria-label', text)
    else el.removeAttribute('aria-label')
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
  function dots(parts) {
    const out = []
    for (const p of parts) {
      if (p === null || p === undefined || p === false || p === '') continue
      if (out.length) out.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'))
      out.push(p)
    }
    return out
  }

  // ---------- updating in place ----------
  // A refresh rebuilds the markup, then keeps every existing element whose markup did not change, so focus, hover,
  // text selection and scroll stay put and only changed rows are swapped. Children match by data-key, else by
  // position; a data-patch container that changed is updated child by child instead of being replaced. Rows carry
  // a data-sig of their account, so equal markup also means their click handlers see the same data.
  function markup(el) { return el.outerHTML.replace(/tip-[0-9]+/g, 'tip') }
  function syncAttrs(from, to) {
    for (const a of Array.from(from.attributes)) if (!to.hasAttribute(a.name)) from.removeAttribute(a.name)
    for (const a of Array.from(to.attributes)) if (from.getAttribute(a.name) !== a.value) from.setAttribute(a.name, a.value)
  }
  function flat(kids, out) {
    out = out || []
    if (kids === null || kids === undefined || kids === false) return out
    if (Array.isArray(kids)) { for (const k of kids) flat(k, out); return out }
    out.push(kids instanceof Node ? kids : document.createTextNode(String(kids)))
    return out
  }
  function patchKids(box, kids) {
    const next = flat(kids)
    const old = Array.from(box.childNodes)
    const byKey = new Map()
    for (const o of old) if (o.nodeType === 1 && o.dataset.key) byKey.set(o.dataset.key, o)
    const used = new Set()
    const result = next.map((n, i) => {
      const key = n.nodeType === 1 ? n.dataset.key : ''
      const o = key ? byKey.get(key) : old[i] && !(old[i].nodeType === 1 && old[i].dataset.key) ? old[i] : null
      if (!o || used.has(o) || o.nodeType !== n.nodeType || o.nodeName !== n.nodeName) return n
      if (n.nodeType === 3) { if (o.data !== n.data) o.data = n.data; used.add(o); return o }
      if (n.nodeType !== 1) return n
      if (markup(o) === markup(n)) { used.add(o); return o }
      if (o.hasAttribute('data-patch') && n.hasAttribute('data-patch')) { syncAttrs(o, n); patchKids(o, Array.from(n.childNodes)); used.add(o); return o }
      return n
    })
    for (const o of old) if (!used.has(o)) o.remove()
    result.forEach((n, i) => { if (box.childNodes[i] !== n) box.insertBefore(n, box.childNodes[i] || null) })
  }
  function pathOf(el, root) {
    const p = []
    while (el && el !== root) {
      const up = el.parentElement
      if (!up) return null
      p.unshift(Array.prototype.indexOf.call(up.children, el))
      el = up
    }
    return el === root ? p : null
  }
  // Replaces box's children like setKids, keeping unchanged elements. Focus inside a swapped element moves to the
  // element at the same place in its replacement, found through its keyed ancestors (rows can change order).
  function patch(box, kids) {
    const active = document.activeElement
    const keys = []
    let anchor = box
    if (active && active !== document.body && box.contains(active)) {
      for (let el = active.parentElement; el && el !== box; el = el.parentElement) if (el.hasAttribute('data-key')) keys.unshift(el)
      if (keys.length) anchor = keys[keys.length - 1]
    }
    const path = anchor !== box || (active && box.contains(active) && active !== box) ? pathOf(active, anchor) : null
    const chain = keys.map((el) => el.getAttribute('data-key'))
    patchKids(box, kids)
    if (path && !active.isConnected) {
      let el = box
      for (const k of chain) el = el && Array.from(el.querySelectorAll('[data-key]')).find((x) => x.getAttribute('data-key') === k)
      for (const i of path) el = el && el.children[i]
      if (el && typeof el.focus === 'function') el.focus({ preventScroll: true })
    }
  }
  // A short stable fingerprint of a value.
  function sig(value) {
    const s = JSON.stringify(value) || ''
    let x = 5381
    for (let i = 0; i < s.length; i++) x = ((x * 33) ^ s.charCodeAt(i)) >>> 0
    return x.toString(36) + s.length.toString(36)
  }
  // Whether the viewer is in the middle of something a background render would disturb: an open menu, dialog or
  // tooltip, a focused field, or a text selection in the account list.
  function uiBusy() {
    if (menu.el || (dlg.el && dlg.el.open) || document.querySelector('.tip.is-open')) return true
    const el = document.activeElement
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return true
    const sel = window.getSelection && window.getSelection()
    return Boolean(sel && !sel.isCollapsed && sel.anchorNode && $('accounts').contains(sel.anchorNode))
  }

  const ICONS = {
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2',
    chevron: 'M9 6l6 6-6 6',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    plus: 'M12 5v14M5 12h14',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    terminal: 'M4 17l6-5-6-5M12 19h8',
    key: 'M15 9a3 3 0 1 0-.01 0M12.9 11.1L4 20M7 17l2 2M9.5 14.5l2 2',
    folder: 'M3 6h6l2 2h10v11H3z',
    check: 'M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    userPlus: 'M15 19a6 6 0 0 0-12 0M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M16 11h6',
    x: 'M6 6l12 12M18 6L6 18',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    eyeOff: 'M3 3l18 18M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.4 17.4 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  }
  function icon(name, cls) {
    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''))
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', ICONS[name])
    svg.append(path)
    return svg
  }

  // ---------- server calls ----------
  // The token is per server process: after sideby ui restarts, the first write gets 403 "bad-token". The page then
  // fetches the new token from api/session and sends that same request once more; the server refused it before
  // running it, so the retry cannot apply anything twice. A request that got no answer is never replayed.
  let token = BOOT.token
  function failure(message, retryable, network, status, code) {
    const e = new Error(message)
    e.code = code || ''
    e.retryable = retryable
    e.network = Boolean(network)
    e.status = status || 0
    return e
  }
  async function send(path, init) {
    let res
    try { res = await fetch(BOOT.basePath + path, Object.assign({ cache: 'no-store' }, init)) } catch {
      connectionLost()
      throw failure(t('err.noAnswer'), true, true)
    }
    let data = null
    try { data = await res.json() } catch {}
    return { res, data }
  }
  async function refreshToken() {
    const { res, data } = await send('/api/session')
    if (!res.ok || !data || typeof data.token !== 'string') throw failure(t('err.session'), false)
    token = data.token
  }
  async function api(path, body) {
    for (let attempt = 0; ; attempt++) {
      const init = body === undefined ? {} : {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sideby-token': token },
        body: JSON.stringify(body),
      }
      const { res, data } = await send(path, init)
      if (res.ok) return data
      if (res.status === 403 && data && data.code === 'bad-token') {
        if (attempt === 0) { await refreshToken(); continue }
        throw failure(t('err.expired'), false)
      }
      const msg = (data && data.error) || 'request failed (' + res.status + ')'
      // 4xx messages are written for people (what is wrong, what to do); 5xx ones are internal, so they get a lead-in.
      if (res.status >= 500) throw failure(t('err.server', { msg }), true, false, res.status)
      throw failure(msg.charAt(0).toUpperCase() + msg.slice(1), false, false, res.status, data && typeof data.code === 'string' ? data.code : '')
    }
  }

  // ---------- connection ----------
  // A request that cannot reach the server shows a small notice and polls api/health, waiting 1 s and then up to 5 s
  // between tries. Once it answers, the page renews its token and reloads the state; writes are left for the user.
  const conn = { lost: false, timer: 0, delay: 1000 }
  function connectionLost() {
    if (conn.lost) return
    conn.lost = true
    conn.delay = 1000
    renderConnection()
    conn.timer = setTimeout(ping, conn.delay)
  }
  async function ping() {
    try {
      const res = await fetch(BOOT.basePath + '/api/health', { cache: 'no-store' })
      const data = await res.json()
      if (!res.ok || !data || data.app !== 'sideby') throw new Error('not sideby')
      const s = await fetch(BOOT.basePath + '/api/session', { cache: 'no-store' }).then((r) => r.json())
      if (typeof s.token !== 'string') throw new Error('no session')
      token = s.token
    } catch {
      conn.delay = Math.min(5000, Math.round(conn.delay * 1.6))
      conn.timer = setTimeout(ping, conn.delay)
      return
    }
    conn.lost = false
    renderConnection()
    toast(t('toast.reconnected'))
    load()
  }
  function renderConnection() {
    $('conn').replaceChildren(...(conn.lost ? [spinner(), t('conn.lost')] : []))
    $('conn').hidden = !conn.lost
  }

  // ---------- toasts ----------
  // Bottom center, newest last, at most three. The same text again restarts its timer instead of stacking.
  // Hovering a toast pauses it, so an Undo stays reachable.
  const toasts = []
  // The toast stack is a manual popover so it sits in the top layer; raising it again after a modal dialog
  // opens keeps toasts above that dialog's backdrop. Without popover support it stays a fixed element.
  function raiseToasts() {
    const el = $('toasts')
    if (typeof el.showPopover !== 'function') return
    try { if (el.matches(':popover-open')) el.hidePopover(); el.showPopover() } catch {}
  }
  function toast(text, opts) {
    opts = opts || {}
    const kind = opts.kind || 'ok'
    const ms = opts.duration || Math.max(2000, Math.min(8000, 1800 + text.length * 40 + (opts.action ? 4000 : 0) + (kind === 'fail' ? 2000 : 0)))
    // A keyed toast (such as the theme) replaces the earlier one with that key.
    const keyed = opts.key ? toasts.find((x) => x.key === opts.key && x.text !== text) : null
    if (keyed) dismiss(keyed)
    let item = toasts.find((x) => x.text === text)
    if (item) {
      clearTimeout(item.timer)
      item.el.classList.remove('bump')
      void item.el.offsetWidth
      item.el.classList.add('bump')
    } else {
      item = { text, ms, key: opts.key || null }
      const action = opts.action ? h('button', { class: 'toast-action', type: 'button', onclick: () => { dismiss(item); opts.action.run() } }, opts.action.label) : null
      item.el = h('div', { class: 'toast toast-' + kind, role: kind === 'fail' ? 'alert' : null },
        h('span', { class: 'toast-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'toast-text' }, text),
        action,
        h('button', { class: 'toast-x', type: 'button', 'aria-label': t('toast.dismiss'), onclick: () => dismiss(item) }, icon('x')))
      item.el.addEventListener('mouseenter', () => clearTimeout(item.timer))
      item.el.addEventListener('mouseleave', () => { item.timer = setTimeout(() => dismiss(item), 2500) })
      toasts.push(item)
      $('toasts').append(item.el)
      if (dlg.el && dlg.el.open) raiseToasts()
      while (toasts.length > 3) dismiss(toasts[0])
    }
    item.timer = setTimeout(() => dismiss(item), ms)
  }
  function dismiss(item) {
    clearTimeout(item.timer)
    const i = toasts.indexOf(item)
    if (i >= 0) toasts.splice(i, 1)
    item.el.remove()
  }

  // ---------- small parts ----------
  function ago(iso) {
    const ts = Date.parse(iso)
    if (!Number.isFinite(ts)) return ''
    const s = Math.max(0, (Date.now() - ts) / 1000)
    if (s < 45) return t('time.justNow')
    const m = Math.round(s / 60)
    if (m < 60) return t('time.minAgo', { n: m })
    const hr = Math.round(m / 60)
    if (hr < 24) return t('time.hAgo', { n: hr })
    return t('time.dAgo', { n: Math.round(hr / 24) })
  }
  // The header's "Updated …" age, in seconds for the first minute so the viewer sees it tick.
  function agoShort(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    if (s < 5) return t('time.justNow')
    if (s < 60) return t('time.secAgo', { n: s })
    return ago(new Date(Date.now() - ms).toISOString())
  }
  function clock(iso) {
    const d = new Date(iso)
    if (!Number.isFinite(d.getTime())) return '?'
    const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
    const now = new Date()
    if (d.toDateString() === now.toDateString()) return time
    if (Math.abs(d - now) < 6 * 864e5) return d.toLocaleDateString(locale(), { weekday: 'short' }) + ' ' + time
    return d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' }) + ' ' + time
  }
  function day(iso) {
    const d = new Date(iso)
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' }) : '?'
  }
  function countdown(iso, now) {
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) return '?'
    return t('time.in', { d: formatDuration(at - now, lang) })
  }
  function tokens(n) {
    if (!Number.isFinite(n)) return '0'
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']]
    for (const [v, u] of units) if (n >= v) return (n / v).toFixed(n / v >= 100 ? 0 : 1).replace(/\.0$/, '') + u
    return String(Math.round(n))
  }
  function isStale(iso, now) {
    const ts = Date.parse(iso)
    return Number.isFinite(ts) && now - ts > STALE_MS
  }

  function family(id) { return (S.state && S.state.families.find((f) => f.id === id)) || { id, title: id, bin: id, installUrl: '', installed: false } }
  function famTitle(a) { return a.familyTitle || family(a.family).title }
  // The email as the page shows it: masked everywhere while "Hide emails" is on (copying still gives the real one).
  function emailText(email) { return prefs.hideEmail ? maskEmail(email) : email }
  // A Family's mark: the logo its FamilyDef sets (checked by the loader), or its initials on a color derived from the id.
  // size: '' (cards), 'sm' (rows, groups, dialogs) or 'xs' (inside a chip; no initials fallback there).
  function badge(id, size) {
    const logo = family(id).logo
    const cls = 'badge' + (size ? ' badge-' + size : '')
    if (logo) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('focusable', 'false')
      const path = document.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', logo.path)
      if (logo.fillRule) path.setAttribute('fill-rule', logo.fillRule)
      svg.append(path)
      return h('span', { class: cls + ' badge-logo', css: logo.color ? { color: logo.color } : null, title: logo.title || family(id).title, 'aria-hidden': 'true' }, svg)
    }
    if (size === 'xs') return null
    let x = 0
    for (const c of id) x = (x * 31 + c.charCodeAt(0)) % 360
    return h('span', { class: cls, css: { background: 'hsl(' + x + ' 55% 46%)' }, 'aria-hidden': 'true' }, id.slice(0, 2).toUpperCase())
  }
  function spinner() { return h('span', { class: 'spin', 'aria-hidden': 'true' }) }
  function link(text, url, cls) {
    let ok = false
    try { const u = new URL(url); ok = u.protocol === 'https:' || u.protocol === 'http:' } catch {}
    return ok ? h('a', { class: cls, href: url, target: '_blank', rel: 'noopener noreferrer' }, text) : null
  }
  async function copyText(text) {
    let ok = true
    try { await navigator.clipboard.writeText(text) } catch {
      const ta = h('textarea', { css: { position: 'fixed', opacity: '0' } })
      ta.value = text
      document.body.append(ta)
      ta.select()
      try { ok = document.execCommand('copy') } catch { ok = false }
      ta.remove()
    }
    if (ok) toast(t('toast.copied', { text: prefs.hideEmail && text.includes('@') ? maskEmail(text) : text }))
    else toast(t('toast.copyFailed'), { kind: 'fail' })
  }
  function codeCopy(text) {
    return h('span', { class: 'copy' }, h('code', null, text),
      h('button', { class: 'btn btn-sm', type: 'button', 'aria-label': t('btn.copyText', { text }), onclick: () => copyText(text) }, icon('copy'), t('btn.copy')))
  }

  // A "?" next to a term; the explanation shows on hover and on keyboard focus.
  let tipSeq = 0
  function tipRaw(term, body) {
    const id = 'tip-' + (++tipSeq)
    return h('span', { class: 'tip' },
      h('button', { class: 'tip-btn', type: 'button', 'aria-label': t('tip.label', { term }), 'aria-describedby': id }, '?'),
      h('span', { class: 'tip-body', role: 'tooltip', id }, body))
  }
  function tip(key) { return tipRaw(t('tip.' + key + '.term'), t('tip.' + key + '.body')) }
  function showTip(btn) {
    const body = btn.nextElementSibling
    if (!body) return
    body.parentElement.classList.add('is-open')
    const r = btn.getBoundingClientRect()
    const w = body.offsetWidth
    const hgt = body.offsetHeight
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))
    const top = r.top - hgt - 8 >= 8 ? r.top - hgt - 8 : r.bottom + 8
    body.style.setProperty('left', left + 'px')
    body.style.setProperty('top', top + 'px')
  }
  function hideTip(btn) { if (btn.parentElement) btn.parentElement.classList.remove('is-open') }
  document.addEventListener('pointerover', (e) => { const b = e.target.closest && e.target.closest('.tip-btn'); if (b) showTip(b) })
  document.addEventListener('pointerout', (e) => { const b = e.target.closest && e.target.closest('.tip-btn'); if (b && !b.contains(e.relatedTarget)) hideTip(b) })
  document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('tip-btn')) showTip(e.target) })
  document.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('tip-btn')) hideTip(e.target) })

  // ---------- row menu ----------
  const menu = { el: null, anchor: null }
  function openMenu(anchor, items, label) {
    closeMenu()
    const el = h('div', { class: 'menu', role: 'menu', 'aria-label': label },
      items.filter(Boolean).map((it) => it === '-' ? h('div', { class: 'menu-sep', role: 'separator' })
        : h('button', { class: 'menu-item', type: 'button', role: 'menuitem', tabindex: '-1', disabled: it.disabled, onclick: () => { closeMenu(true); it.run() } },
          icon(it.icon), h('span', { class: 'menu-label' }, it.label), it.hint ? h('code', { class: 'menu-hint', title: it.hint }, it.hint.length > 24 ? '…' + it.hint.slice(-23) : it.hint) : null)))
    el.addEventListener('keydown', menuKeys)
    document.body.append(el)
    const r = anchor.getBoundingClientRect()
    const w = el.offsetWidth
    const hgt = el.offsetHeight
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w))
    const top = r.bottom + 4 + hgt > window.innerHeight - 8 && r.top - hgt - 4 > 8 ? r.top - hgt - 4 : r.bottom + 4
    el.style.setProperty('left', left + 'px')
    el.style.setProperty('top', top + 'px')
    anchor.setAttribute('aria-expanded', 'true')
    menu.el = el
    menu.anchor = anchor
    const first = el.querySelector('.menu-item:not(:disabled)')
    if (first) first.focus()
  }
  function closeMenu(restore) {
    if (!menu.el) return
    menu.el.remove()
    menu.anchor.setAttribute('aria-expanded', 'false')
    if (restore && menu.anchor.isConnected) menu.anchor.focus()
    menu.el = null
    menu.anchor = null
  }
  function menuKeys(e) {
    const items = Array.from(menu.el.querySelectorAll('.menu-item:not(:disabled)'))
    const i = items.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') items[(i + 1) % items.length].focus()
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length].focus()
    else if (e.key === 'Home') items[0].focus()
    else if (e.key === 'End') items[items.length - 1].focus()
    else if (e.key === 'Escape') closeMenu(true)
    else if (e.key === 'Tab') { closeMenu(true); return }
    else return
    e.preventDefault()
  }
  document.addEventListener('pointerdown', (e) => { if (menu.el && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu() })
  window.addEventListener('resize', () => closeMenu())
  window.addEventListener('scroll', () => closeMenu(), { passive: true })

  function accountMenu(a, anchor) {
    const run = 'sideby run ' + a.ref
    const items = [
      { icon: 'terminal', label: t('menu.copyRun'), hint: run, run: () => copyText(run) },
      ...(a.aliases || []).slice(0, 2).map((x) => ({ icon: 'terminal', label: t('menu.copyAlias'), hint: x, run: () => copyText(x) })),
      a.kind !== 'api' ? { icon: 'key', label: t('menu.copyLogin'), hint: 'sideby login ' + a.ref, run: () => copyText('sideby login ' + a.ref) } : null,
      a.dir ? { icon: 'folder', label: t('menu.copyDir'), hint: a.dir, run: () => copyText(a.dir) } : null,
      a.identity && a.identity.email ? { icon: 'mail', label: t('menu.copyEmail'), hint: emailText(a.identity.email), run: () => copyText(a.identity.email) } : null,
      '-',
      { icon: 'check', label: t('menu.check'), disabled: S.checking || S.fixing || Boolean(ui.checkingRef), run: () => checkAccount(a.ref) },
      BOOT.readOnly ? null : { icon: 'userPlus', label: t('menu.like'), run: () => openCreate({ family: a.family, api: a.kind === 'api' }) },
    ]
    openMenu(anchor, items, t('menu.label', { ref: a.ref }))
  }
  function moreButton(a) {
    const b = h('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': t('menu.label', { ref: a.ref }), title: t('menu.title') }, icon('more'))
    b.addEventListener('click', () => { if (menu.anchor === b) closeMenu(); else accountMenu(a, b) })
    return b
  }

  // ---------- Doctor history ----------
  // Health comes from the Doctor history, which keeps the latest result per Account: an Account that was
  // never checked shows "Not checked", never "Healthy".
  function entries() {
    const hist = S.history
    return hist ? Object.values(hist.general).concat(Object.values(hist.accounts)) : []
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
  function reasonsOf(a, now) { return attentionReasons(a, healthOf(a.ref), now, WARN) }
  function setupFor(fam) { return S.state && S.state.quotaSetups.find((s) => s.family === fam) }

  // ---------- header and summary ----------
  function renderUpdated() {
    const busy = S.loading && !S.silent
    const text = S.loading && !S.state ? t('top.loading') : busy ? t('top.refreshing') : S.loadedAt ? t('top.updated', { ago: agoShort(Date.now() - S.loadedAt) }) : ''
    const el = $('updated')
    if (el.textContent !== text) el.textContent = text
    el.title = S.loadedAt ? t('top.updatedTitle', { at: clock(new Date(S.loadedAt).toISOString()), s: Math.round((S.fastUntil > Date.now() ? FAST_MS : AUTO_MS) / 1000) }) : ''
  }
  function renderTop() {
    renderUpdated()
    // A background refresh keeps the button still; only one the viewer asked for spins it.
    const busy = S.loading && !S.silent
    const refresh = $('refresh')
    refresh.disabled = busy
    refresh.classList.toggle('is-spinning', busy)
    if (busy) refresh.setAttribute('aria-busy', 'true'); else refresh.removeAttribute('aria-busy')
  }
  function renderStatic() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
    for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'))
    $('refresh').setAttribute('aria-label', t('top.refresh'))
    const lb = $('lang')
    lb.textContent = lang === 'zh' ? 'EN' : '中文'
    lb.setAttribute('aria-label', t('top.language'))
    lb.title = t('top.language')
    const tb = $('theme')
    tb.hidden = BOOT.colorScheme !== 'auto'
    setKids(tb, icon(prefs.theme === 'light' ? 'sun' : prefs.theme === 'dark' ? 'moon' : 'monitor'))
    tb.title = t('theme.' + prefs.theme)
    tb.setAttribute('aria-label', t('theme.' + prefs.theme))
  }
  function applyTheme() {
    if (BOOT.colorScheme !== 'auto') return
    if (prefs.theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', prefs.theme)
  }
  function stat(label, value, sub, extra, opts) {
    const kids = [h('div', { class: 'stat-text' }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-sub' }, sub)), extra]
    if (opts && opts.onclick) return h('button', { class: 'stat stat-btn' + (opts.cls ? ' ' + opts.cls : ''), type: 'button', 'aria-pressed': String(Boolean(opts.pressed)), 'aria-label': t('stat.btnLabel', { label, value, sub, action: opts.title || '' }), title: opts.title, onclick: opts.onclick }, kids)
    return h('div', { class: 'stat' + (opts && opts.cls ? ' ' + opts.cls : '') }, kids)
  }
  function spark(daily, cls) {
    if (!Array.isArray(daily) || !daily.length) return null
    const max = Math.max(0, ...daily.map((d) => Number(d.totalTokens) || 0))
    return h('span', { class: 'spark' + (cls ? ' ' + cls : ''), role: 'img', 'aria-label': t('usage.sparkLabel', { n: daily.length }) },
      daily.map((d, i) => {
        const v = Number(d.totalTokens) || 0
        const date = new Date(d.date + 'T12:00:00')
        const day = Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale(), { weekday: 'short', month: 'numeric', day: 'numeric' }) : d.date
        // Every day keeps its slot (a faint track), so empty days read as gaps in time, not missing bars.
        return h('i', { class: i === daily.length - 1 ? 'today' : null, title: day + ': ' + tokens(v) },
          v ? h('b', { css: { height: (max ? Math.max(12, Math.round((v / max) * 100)) : 0) + '%' } }) : null)
      }))
  }
  function renderSummary() {
    const box = $('summary')
    if (!S.state) { if (S.loadError) box.hidden = true; return }
    const list = S.state.accounts
    box.hidden = !list.length
    box.removeAttribute('aria-busy')
    if (!list.length) return
    const now = Date.now()
    const famCount = new Set(list.map((a) => a.family)).size
    const apiCount = list.filter((a) => a.kind === 'api').length
    const counts = {}
    let need = 0
    for (const a of list) {
      const rs = reasonsOf(a, now)
      if (rs.length) need++
      for (const r of rs) counts[r] = (counts[r] || 0) + 1
    }
    const order = ['error', 'health-fail', 'signed-out', 'not-installed', 'quota-high', 'health-warn']
    const needSub = need ? order.filter((r) => counts[r]).slice(0, 2).map((r) => tn('need.' + r, counts[r])).join(' · ') : t('stat.allClear')
    const usages = list.filter((a) => a.usage && a.usage.status === 'ok')
    const total = usages.reduce((s, a) => s + (Number(a.usage.totalTokens) || 0), 0)
    const sessions = usages.reduce((s, a) => s + (Number(a.usage.sessions) || 0), 0)
    const daily = mergeDaily(usages.map((a) => a.usage.daily)).slice(-BOOT.usageDays)
    const nr = nextReset(list, now)
    patch(box, [
      stat(t('stat.accounts'), String(list.length), dots([tn('stat.families', famCount), apiCount ? tn('stat.api', apiCount) : null])),
      need
        ? stat(t('stat.attention'), String(need), needSub, null, { cls: 'stat-warn', pressed: ui.attention, title: t(ui.attention ? 'stat.attentionOff' : 'stat.attentionOn'), onclick: () => { ui.attention = !ui.attention; renderSummary(); renderAccounts() } })
        : stat(t('stat.attention'), '0', needSub, null, { cls: 'stat-ok' }),
      stat(t('stat.tokens', { n: BOOT.usageDays }), tokens(total), tn('stat.sessions', sessions), spark(daily, 'spark-lg')),
      stat(h('span', { class: 'label-tip' }, t('stat.nextReset'), tip('age')),
        nr ? t('time.in', { d: formatDuration(nr.at - now, lang) }) : '—',
        nr ? dots([h('span', { class: 'mono' }, nr.ref), nr.label, clock(new Date(nr.at).toISOString())]) : t('stat.noQuota')),
    ])
  }

  // ---------- toolbar ----------
  const tb = {}
  function seg(label, options, value, onPick) {
    const btns = options.map((o) => h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(o[0] === value), title: o[2] || null, 'aria-label': o[2] || t('tb.segLabel', { group: label, option: o[1] }), onclick: () => {
      for (const b of btns) b.setAttribute('aria-pressed', String(b === btn(o[0])))
      onPick(o[0])
    } }, o[1]))
    const btn = (v) => btns[options.findIndex((o) => o[0] === v)]
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, btns)
  }
  function buildToolbar() {
    const hadFocus = tb.search && document.activeElement === tb.search
    tb.search = h('input', { type: 'search', id: 'q', class: 'search-input', autocomplete: 'off', spellcheck: 'false', 'aria-label': t('tb.search'), placeholder: t('tb.searchPh'), 'aria-keyshortcuts': '/ Meta+F Control+F' })
    tb.search.value = ui.query
    tb.search.addEventListener('input', () => { ui.query = tb.search.value; renderAccounts() })
    tb.search.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (tb.search.value) { tb.search.value = ''; ui.query = ''; renderAccounts() } else tb.search.blur()
    })
    tb.family = h('select', { class: 'tb-select', 'aria-label': t('tb.family') })
    tb.family.addEventListener('change', () => { prefs.family = tb.family.value; savePrefs(); renderAccounts() })
    tb.sort = h('select', { class: 'tb-select', 'aria-label': t('tb.sort') },
      CHOICES.sort.map((v) => h('option', { value: v }, t('sort.' + v))))
    tb.sort.value = prefs.sort
    tb.sort.addEventListener('change', () => { prefs.sort = tb.sort.value; savePrefs(); renderAccounts() })
    const quota = seg(t('tb.quota'), [['used', t('tb.used')], ['left', t('tb.left')]], prefs.quota, (v) => { prefs.quota = v; savePrefs(); renderAccounts() })
    const view = seg(t('tb.view'), [['list', icon('list'), t('tb.list')], ['cards', icon('grid'), t('tb.cards')]], prefs.view, (v) => { prefs.view = v; savePrefs(); ui.fade = true; renderAccounts() })
    tb.hideEmail = h('button', { class: 'icon-btn tb-icon', type: 'button', 'aria-pressed': String(prefs.hideEmail), onclick: () => {
      prefs.hideEmail = !prefs.hideEmail
      savePrefs()
      renderEmailToggle()
      renderAccounts()
    } })
    const create = BOOT.readOnly ? null : h('button', { class: 'btn btn-primary', type: 'button', 'aria-label': t('tb.new'), onclick: () => openCreate(null) }, icon('plus'), h('span', null, t('tb.new')))
    setKids($('toolbar'), [
      h('label', { class: 'search' }, icon('search', 'search-ic'), tb.search, h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, '/')),
      h('div', { class: 'tools' }, tb.family, tb.sort, quota, view, tb.hideEmail),
      create,
    ])
    renderFamilyFilter()
    renderEmailToggle()
    if (hadFocus) tb.search.focus()
  }
  // "Hide emails": shown once any account has one; its icon and label say what a click does.
  function renderEmailToggle() {
    const b = tb.hideEmail
    if (!b) return
    b.hidden = !(S.state && S.state.accounts.some((a) => a.identity && a.identity.email))
    b.setAttribute('aria-pressed', String(prefs.hideEmail))
    const label = t(prefs.hideEmail ? 'tb.showEmails' : 'tb.hideEmails')
    b.setAttribute('aria-label', label)
    b.title = label
    setKids(b, icon(prefs.hideEmail ? 'eyeOff' : 'eye'))
  }
  function renderFamilyFilter() {
    if (!tb.family) return
    const fams = S.state ? S.state.families.filter((f) => S.state.accounts.some((a) => a.family === f.id)) : []
    tb.family.replaceChildren(h('option', { value: '' }, t('tb.allFamilies')),
      ...fams.map((f) => h('option', { value: f.id }, f.title + ' (' + S.state.accounts.filter((a) => a.family === f.id).length + ')')))
    if (prefs.family && S.state && !fams.some((f) => f.id === prefs.family)) prefs.family = ''
    tb.family.value = prefs.family
    tb.family.hidden = fams.length < 2 && !prefs.family
  }
  document.addEventListener('keydown', (e) => {
    if (dlg.el && dlg.el.open) return
    const el = e.target
    const typing = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
    const find = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'f' || e.key === 'F')
    if ((find || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey)) && tb.search && S.state && S.state.accounts.length) {
      e.preventDefault()
      tb.search.focus()
      tb.search.select()
    }
  })

  // ---------- accounts ----------
  // One column per Quota window label. 5h and 7d always have one, so rows of every group line up under the same
  // header; a label only some account reports (such as 60m) adds a column, at most three in all.
  const KNOWN_WINDOWS = { '5h': 300, '7d': 10080 }
  function quotaColumns(list) {
    const mins = Object.assign({}, KNOWN_WINDOWS)
    for (const a of list)
      if (a.quota && a.quota.status === 'ok')
        for (const w of a.quota.windows || []) if (!Object.hasOwn(mins, w.label)) mins[w.label] = Number(w.windowMinutes) || 0
    return Object.keys(mins).sort((x, y) => mins[x] - mins[y]).slice(0, 3)
  }
  // A window's cell: percent and countdown on one line, the bar under them. The label shows where no column
  // header does (cards, narrow screens).
  function meter(w, now, stale, observedAt) {
    const st = windowState(w, now, WARN, FAIL)
    const passed = passedWindow(w, observedAt, now)
    const left = prefs.quota === 'left'
    const shown = left ? 100 - st.pct : st.pct
    const title = passed ? t('quota.resetNoData', { date: day(passed.since) }) : t('quota.resetsAt', { at: clock(w.resetsAt) })
    return h('div', { class: 'meter lvl-' + st.level + (stale || passed ? ' lvl-stale' : ''), title },
      h('div', { class: 'm-top' },
        h('span', { class: 'm-label' }, w.label),
        h('span', { class: 'm-pct' }, shown + '%', h('span', { class: 'm-unit' }, ' ' + t(left ? 'quota.unitLeft' : 'quota.unitUsed'))),
        h('span', { class: 'm-reset' + (passed ? ' m-passed' : '') }, passed ? t('quota.resetShort') : countdown(w.resetsAt, now))),
      h('div', { class: 'bar', role: 'meter', 'aria-label': t(left ? 'quota.meterLeft' : 'quota.meterUsed', { label: w.label }), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown), 'aria-valuetext': t(left ? 'quota.pctLeft' : 'quota.pctUsed', { n: shown }) }, h('span', { css: { width: shown + '%' } })))
  }
  // A column whose window this account does not report right now, such as a 5h window that has not started.
  function noMeter(label) {
    return h('div', { class: 'meter meter-none', title: t('quota.missing', { label }) },
      h('div', { class: 'm-top' }, h('span', { class: 'm-label' }, label), h('span', { class: 'm-none', 'aria-label': t('quota.missing', { label }) }, '—')))
  }
  function quotaNote(a, q) {
    const setup = setupFor(a.family)
    // One setup turns quota on for every account of the Family, so the switch lives in the group header only.
    if (q.reason === 'not-enabled') {
      const host = famTitle(a)
      const body = setup && setup.plan.status === 'ready' && !BOOT.readOnly ? t('tip.quotaOff.body', { host })
        : setup && setup.plan.status === 'blocked' ? setup.plan.message
          : t('tip.quotaOff.cli', { host, family: a.family })
      return h('div', { class: 'q-note q-off' }, h('span', { class: 'muted' }, t('quota.off')), tipRaw(t('tip.quotaOff.term'), body))
    }
    if (q.reason === 'api-account') return h('div', { class: 'q-note' }, t('quota.api'), tip('api'))
    const text = { 'no-session': 'quota.noSession', 'no-source': 'quota.noSource', unrecognized: 'quota.unrecognized' }[q.reason]
    return h('div', { class: 'q-note', title: q.reason === 'no-session' ? t('quota.noSessionHint') : q.detail || null }, text ? t(text) : t('quota.unavailable', { reason: q.reason }))
  }
  function quotaBlock(a, now, cols) {
    const q = a.quota
    if (!q) return h('div', { class: 'quota' }, h('div', { class: 'q-note' }, '—'))
    if (q.status !== 'ok') return h('div', { class: 'quota' }, quotaNote(a, q))
    const stale = isStale(q.observedAt, now)
    const wins = q.windows || []
    return h('div', { class: 'quota' + (stale ? ' is-stale' : ''), title: stale ? null : t('quota.dataFrom', { ago: ago(q.observedAt) }) },
      wins.length ? cols.map((c) => {
        const w = wins.find((x) => x.label === c)
        return w ? meter(w, now, stale, q.observedAt) : noMeter(c)
      }) : h('div', { class: 'q-note' }, t('quota.noWindows')),
      stale ? h('div', { class: 'q-asof' }, icon('clock'), t('quota.asOf', { ago: ago(q.observedAt) })) : null)
  }
  function usageBlock(a) {
    const u = a.usage
    if (!u) return h('div', { class: 'usage' })
    if (u.status !== 'ok') {
      const key = u.reason === 'no-session' ? 'usage.none' : u.reason === 'no-source' ? 'usage.noSource' : 'usage.unreadable'
      return h('div', { class: 'usage' }, h('span', { class: 'u-note', title: u.detail || null }, t(key, { n: BOOT.usageDays })))
    }
    const rate = cacheHitRate(u)
    const detail = t('usage.detail', { days: u.days, sessions: u.sessions, input: tokens(u.inputTokens), output: tokens(u.outputTokens), cache: tokens(u.cacheReadTokens + u.cacheWriteTokens) })
    return h('div', { class: 'usage', title: detail },
      h('div', { class: 'u-top' },
        h('span', { class: 'u-num' }, tokens(u.totalTokens), h('span', { class: 'u-unit' }, ' ' + t('usage.tokens'))),
        u.totalTokens ? spark(u.daily) : null),
      h('div', { class: 'u-sub' }, rate === null ? tn('usage.sessions', u.sessions) : t('usage.cache', { n: Math.round(rate * 100) })))
  }
  function lastUsed(a) {
    const at = a.usage && a.usage.status === 'ok' && a.usage.lastActivityAt
    return h('div', { class: 'last', title: at ? t('last.title', { at: clock(at) }) : t('last.unknown') }, at ? ago(at) : h('span', { class: 'faint' }, '—'))
  }
  function healthChip(a) {
    const hs = healthOf(a.ref)
    let lvl = ''
    let text
    if (ui.checkingRef === a.ref || (S.checking && !hs)) text = t('health.checking')
    else if (a.error) { lvl = 'fail'; text = t('health.error') }
    else if (!hs) text = t('health.notChecked')
    else if (hs.fail) { lvl = 'fail'; text = tn('health.issues', hs.fail) }
    else if (hs.warn) { lvl = 'warn'; text = tn('health.warnings', hs.warn) }
    else { lvl = 'ok'; text = t('health.ok') }
    return h('button', { class: 'chip chip-btn health' + (lvl ? ' chip-' + lvl : ''), type: 'button', title: t('health.filterHint'), 'aria-label': t('health.chipLabel', { ref: a.ref, status: text }), onclick: () => filterHealth(a.ref) },
      h('span', { class: 'dot' + (lvl ? ' dot-' + lvl : ''), 'aria-hidden': 'true' }), text)
  }
  function nameLine(a) {
    return h('div', { class: 'ident-name' },
      h('span', { class: 'name', title: a.name }, a.name),
      (a.aliases || []).slice(0, 3).map((x) => h('span', { class: 'tag tag-alias', title: t('acct.alias') }, x)),
      a.kind === 'api' ? h('span', { class: 'tag tag-warn', title: t('tip.api.body') }, t('acct.api')) : null,
      a.login === 'logged-out' && a.kind !== 'api'
        ? h('button', { class: 'tag tag-fail tag-btn', type: 'button', title: t('acct.signInHint'), 'aria-label': t('acct.signedOutLabel', { ref: a.ref }), onclick: () => copyText('sideby login ' + a.ref) }, h('span', { class: 'dot dot-fail', 'aria-hidden': 'true' }), t('acct.signedOut'))
        : null,
      a.hostInstalled === false ? h('span', { class: 'tag tag-warn' }, t('acct.notInstalled')) : null)
  }
  // Who the account is signed in as, under its name; masked while "Hide emails" is on.
  function emailLine(a) {
    const id = a.identity
    if (!id || (!id.email && !id.org)) return null
    const email = id.email ? emailText(id.email) : ''
    return h('div', { class: 'ident-email', title: [email, id.org].filter(Boolean).join(' · ') },
      dots([email ? h('span', { class: 'email' }, email) : null, id.org ? h('span', { class: 'org' }, id.org) : null]))
  }
  function subLine(a) {
    const plan = a.quota && a.quota.status === 'ok' && a.quota.plan
    return h('div', { class: 'ident-sub' }, dots([
      h('span', { class: 'mono' }, a.ref),
      a.kind === 'api' && a.model ? h('span', { class: 'mono', title: t('acct.model') }, a.model) : null,
      a.kind !== 'api' && plan ? h('span', { class: 'plan' }, plan) : null,
    ]))
  }
  function notes(a) {
    const fam = family(a.family)
    const out = []
    if (a.error) out.push(h('div', { class: 'note note-fail' }, h('b', null, t('acct.readError')), ' ', h('span', null, a.error)))
    if (a.hostInstalled === false) out.push(h('div', { class: 'note note-warn' }, tx('acct.installHost', { host: fam.title, link: link(t('acct.installIt'), fam.installUrl) || '' })))
    return out.length ? h('div', { class: 'row-notes' }, out) : null
  }
  // What a row or card shows depends on more than the account (health, view preferences, language); the
  // fingerprint covers what its click handlers use.
  function rowSig(a) { return sig([a, healthOf(a.ref)]) }
  function row(a, now, cols) {
    return h('div', { class: 'row' + (a.error ? ' row-error' : ''), role: 'listitem', 'data-ref': a.ref, 'data-key': a.ref, 'data-sig': rowSig(a) },
      h('div', { class: 'ident' }, badge(a.family, 'sm'), h('div', { class: 'ident-text' }, nameLine(a), emailLine(a), subLine(a))),
      quotaBlock(a, now, cols),
      usageBlock(a),
      lastUsed(a),
      h('div', { class: 'cell-health' }, healthChip(a)),
      moreButton(a),
      notes(a))
  }
  function card(a, now, cols) {
    return h('article', { class: 'card' + (a.error ? ' card-error' : ''), 'data-ref': a.ref, 'data-key': a.ref, 'data-sig': rowSig(a), 'aria-label': a.ref },
      h('header', { class: 'card-head' },
        badge(a.family, 'sm'),
        h('div', { class: 'ident-text' }, nameLine(a), emailLine(a), subLine(a)),
        moreButton(a)),
      notes(a),
      quotaBlock(a, now, cols),
      h('footer', { class: 'card-foot' }, usageBlock(a), h('div', { class: 'card-side' }, lastUsed(a), healthChip(a))))
  }
  // The list's column titles, once per group under its header. Screen readers get each cell's own label instead.
  function colHead(cols, list) {
    const left = prefs.quota === 'left'
    // A group where no account reports windows (no public source, quota off) keeps the columns but not their titles.
    const titled = list.some((a) => a.quota && a.quota.status === 'ok')
    return h('div', { class: 'col-head', 'aria-hidden': 'true', 'data-key': 'cols' },
      h('span', { class: 'ch-id' }, t('col.account')),
      h('span', { class: 'quota' }, titled ? cols.map((c) => h('span', null, t(left ? 'col.left' : 'col.used', { label: c }))) : null),
      h('span', { class: 'ch-usage' }, t('col.tokens', { n: BOOT.usageDays })),
      h('span', { class: 'ch-last' }, t('col.last')),
      h('span', { class: 'ch-health' }, t('col.health')),
      h('span', { class: 'ch-more' }))
  }
  // Quota is on but no account of the Family has numbers yet: say what brings the first ones.
  function waitingForQuota(fam) {
    const setup = setupFor(fam)
    if (!setup || setup.plan.status !== 'enabled') return false
    const all = S.state.accounts.filter((a) => a.family === fam && a.kind !== 'api')
    const waiting = all.some((a) => a.quota && a.quota.status === 'unavailable' && a.quota.reason === 'no-session')
    const any = all.some((a) => a.quota && a.quota.status === 'ok')
    return waiting && !any
  }
  function group(fam, list, total, now, cols) {
    const info = family(fam)
    const filtering = Boolean(ui.query.trim()) || ui.attention
    const collapsed = !filtering && prefs.collapsed[fam] === true
    const need = list.filter((a) => reasonsOf(a, now).length).length
    const setup = setupFor(fam)
    const off = list.some((a) => a.quota && a.quota.status === 'unavailable' && a.quota.reason === 'not-enabled')
    const bodyId = 'grp-' + fam.replace(/[^a-zA-Z0-9_-]/g, '_')
    const cards = prefs.view === 'cards'
    const head = h('div', { class: 'group-head', 'data-key': 'head' },
      h('button', { class: 'group-toggle', type: 'button', 'aria-expanded': String(!collapsed), 'aria-controls': bodyId, title: t(collapsed ? 'group.expand' : 'group.collapse'), 'aria-label': t('group.toggle', { title: info.title, count: list.length === total ? String(total) : list.length + ' / ' + total, action: t(collapsed ? 'group.expand' : 'group.collapse') }), onclick: () => {
        if (collapsed) delete prefs.collapsed[fam]; else prefs.collapsed[fam] = true
        savePrefs()
        renderAccounts()
      } },
        icon('chevron', 'chev'), badge(fam, 'sm'), h('span', { class: 'group-title' }, info.title),
        h('span', { class: 'group-count' }, list.length === total ? String(total) : list.length + ' / ' + total)),
      h('div', { class: 'group-meta' },
        waitingForQuota(fam) ? h('span', { class: 'group-wait', role: 'status' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), t('quota.waiting', { host: info.title })) : null,
        need ? h('span', { class: 'tag tag-warn' }, tn('group.attention', need)) : null,
        off && setup && setup.plan.status === 'ready' && !BOOT.readOnly
          ? h('span', { class: 'group-quota' },
            h('span', { class: 'muted small' }, t('quota.turnOnFamilyNote', { host: info.title })),
            h('button', { class: 'btn btn-sm', type: 'button', title: setup.summary, 'aria-label': t('quota.turnOnFamilyLabel', { host: info.title }), onclick: () => openSetup(fam) }, t('quota.turnOnFamily')))
          : null,
        off && setup && setup.plan.status === 'blocked' ? h('span', { class: 'muted small label-tip' }, t('quota.blocked'), tipRaw(t('quota.blocked'), setup.plan.message)) : null))
    const body = collapsed ? null : cards
      ? h('div', { class: 'grid', id: bodyId, 'data-key': 'cards', 'data-patch': '' }, list.map((a) => card(a, now, cols)))
      : h('div', { class: 'rows', id: bodyId, role: 'list', 'data-key': 'rows', 'data-patch': '' }, list.map((a) => row(a, now, cols)))
    return h('section', { class: 'group' + (cards ? ' group-cards' : ' group-list') + (collapsed ? ' is-collapsed' : ''), 'aria-label': info.title, 'data-key': 'g:' + fam, 'data-patch': '' },
      head, collapsed || cards ? null : colHead(cols, list), body)
  }
  function emptyState() {
    const fams = S.state.families.slice().sort((x, y) => Number(y.installed) - Number(x.installed))
    return h('div', { class: 'empty' },
      h('span', { class: 'logo', 'aria-hidden': 'true' }, h('i'), h('i')),
      h('h3', null, t('empty.title')),
      h('p', { class: 'muted' }, t('empty.body')),
      fams.length ? h('ul', { class: 'host-list' }, fams.map((f) => h('li', null, badge(f.id, 'sm'), h('span', null, f.title),
        f.installed ? h('span', { class: 'muted small' }, tx('empty.runOnce', { bin: h('code', null, f.bin) })) : link(t('empty.install'), f.installUrl, 'btn btn-sm')))) : h('p', { class: 'muted small' }, t('empty.noFamilies')),
      BOOT.readOnly ? null : h('button', { class: 'btn', type: 'button', onclick: () => openCreate(null) }, icon('plus'), t('empty.create')))
  }
  function clearFilters() {
    ui.query = ''
    ui.attention = false
    prefs.family = ''
    savePrefs()
    if (tb.search) tb.search.value = ''
    if (tb.family) tb.family.value = ''
    renderSummary()
    renderAccounts()
  }
  function noMatch() {
    return h('div', { class: 'empty empty-sm' },
      h('h3', null, t('filter.none')),
      h('p', { class: 'muted' }, ui.query.trim() ? t('filter.noneQuery', { q: ui.query.trim() }) : t('filter.noneBody')),
      h('button', { class: 'btn', type: 'button', onclick: clearFilters }, t('filter.clear')))
  }
  function loadErrorBlock() {
    return h('div', { class: 'empty empty-sm empty-fail', role: 'alert' },
      h('h3', null, t('load.failed')),
      h('p', null, S.loadError.message),
      h('button', { class: 'btn', type: 'button', onclick: () => load({ check: !S.report }) }, icon('refresh'), t('btn.retry')))
  }
  function renderAccounts() {
    closeMenu()
    const box = $('accounts')
    const count = $('acct-count')
    if (!S.state) {
      if (S.loadError) { box.removeAttribute('aria-busy'); patch(box, loadErrorBlock()); setKids(count, null) }
      return
    }
    box.removeAttribute('aria-busy')
    const all = S.state.accounts
    const now = Date.now()
    $('toolbar').hidden = !all.length
    if (!all.length) { setKids(count, null); patch(box, emptyState()); return }
    const shown = all.filter((a) => (!prefs.family || a.family === prefs.family) && matchesQuery(a, ui.query, famTitle(a)) && (!ui.attention || reasonsOf(a, now).length))
    const filtered = shown.length !== all.length
    patch(count, filtered
      ? [t('count.filtered', { n: shown.length, total: all.length }), ' ', h('button', { class: 'link-btn', type: 'button', onclick: clearFilters }, t('filter.clear'))]
      : tn('count.accounts', all.length))
    if (!shown.length) { patch(box, noMatch()); return }
    const cols = quotaColumns(shown)
    box.style.setProperty('--qn', String(cols.length))
    const ids = S.state.families.map((f) => f.id)
    for (const a of all) if (!ids.includes(a.family)) ids.push(a.family)
    const groups = []
    for (const fam of ids) {
      const list = shown.filter((a) => a.family === fam)
      if (list.length) groups.push(group(fam, sortAccounts(list, prefs.sort, now), all.filter((a) => a.family === fam).length, now, cols))
    }
    patch(box, groups)
    if (ui.fade && !REDUCED) {
      box.classList.add('view-in')
      setTimeout(() => box.classList.remove('view-in'), 400)
    }
    ui.fade = false
    // A new account is highlighted once its dialog is closed, so the flash is not spent behind it.
    if (ui.highlight && !(dlg.el && dlg.el.open)) flashRow(ui.highlight)
  }
  function flashRow(ref) {
    const el = document.querySelector('[data-ref="' + CSS.escape(ref) + '"]')
    if (!el) return
    ui.highlight = null
    el.classList.add('flash')
    el.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' })
    setTimeout(() => el.classList.remove('flash'), 2600)
  }

  // ---------- Health check ----------
  async function runCheck() {
    if (S.checking || S.fixing) return
    S.checking = true
    S.checkError = null
    renderCheckup(); renderAccounts()
    try {
      const r = await api('/api/doctor', {})
      S.report = r.report
      S.history = r.history
    } catch (e) { S.checkError = e; S.checkRetry = runCheck }
    S.checking = false
    renderCheckup(); renderAccounts(); renderSummary()
    // A check can follow a change made outside the Panel; pick up the rest of the state too.
    load({ silent: true })
  }
  async function checkAccount(ref) {
    if (S.checking || S.fixing || ui.checkingRef) return
    ui.checkingRef = ref
    renderAccounts(); renderCheckup()
    try {
      const r = await api('/api/doctor', { target: ref })
      S.history = r.history
      const hs = healthOf(ref)
      if (!hs || (!hs.fail && !hs.warn)) toast(t('toast.checkOk', { ref }))
      else toast(t('toast.checkFound', { ref, what: hs.fail ? tn('health.issues', hs.fail) : tn('health.warnings', hs.warn) }), { kind: hs.fail ? 'fail' : 'info', action: { label: t('toast.show'), run: () => filterHealth(ref) } })
    } catch (e) { toast(t('toast.checkFailed', { ref, msg: e.message }), { kind: 'fail' }) }
    ui.checkingRef = null
    renderAccounts(); renderCheckup(); renderSummary()
    load({ silent: true })
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
      const failed = S.fixes.filter((f) => !f.ok).length
      toast(S.fixes.length ? t('fix.result', { ok: S.fixes.length - failed, n: S.fixes.length }) : t('fix.nothing'), { kind: failed ? 'fail' : 'ok' })
    } catch (e) { S.checkError = e; S.checkRetry = runFix }
    S.fixing = false
    renderCheckup()
    load()
  }
  function filterHealth(ref) {
    ui.healthRef = ref
    renderCheckup()
    $('checkup').scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'start' })
  }
  function findingRow(f) {
    return h('li', { class: 'finding lvl-' + f.level },
      h('span', { class: 'dot', title: f.level }),
      h('div', { class: 'finding-body' },
        h('div', { class: 'finding-top' },
          ui.healthRef ? null : h('button', { class: 'chip chip-btn mono', type: 'button', title: t('health.only', { ref: f.account }), 'aria-label': t('health.only', { ref: f.account }), onclick: () => filterHealth(f.account) }, badge(f.account.split(':')[0], 'xs'), f.account),
          h('span', { class: 'muted small mono' }, f.item),
          f.fixable ? h('span', { class: 'chip chip-sm chip-accent' }, t('health.autoFix')) : null,
          f.source && f.source !== 'core' ? h('span', { class: 'muted small' }, t('health.from', { source: f.source })) : null),
        h('p', null, f.message),
        f.hint ? h('p', { class: 'hint' }, panelHint(f.hint, f.fixable && !BOOT.readOnly, t('fix.hintAction'))) : null))
  }
  function renderCheckup() {
    const box = $('checkup')
    const all = findingsNow()
    const ref = ui.healthRef
    const findings = all && ref ? all.filter((f) => f.account === ref) : all
    const at = lastCheckAt()
    const busy = S.checking || S.fixing
    const fixable = all ? all.filter((f) => f.fixable).length : 0
    // Say why Fix all is off, unless a running check or fix already explains it.
    const fixWhy = busy || fixable ? null : !all ? t('fix.whyNoCheck') : all.length ? t('fix.whyManual') : t('fix.whyNothing')
    const status = S.checking ? t('health.running') : S.fixing ? t('health.fixing') : at ? t('health.last', { ago: ago(at) }) : t('health.never')
    const out = [h('div', { class: 'section-head' },
      h('div', null,
        h('h2', { id: 'h-checkup' }, t('health.title')),
        h('p', { class: 'muted small' }, status, h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          tx('health.lead', { shared: h('span', { class: 'label-tip' }, t('health.sharedTerm'), tip('shared')), drift: h('span', { class: 'label-tip' }, t('health.driftTerm'), tip('drift')) }))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', disabled: busy || !S.state, 'aria-busy': S.checking ? 'true' : null, title: !S.state && !busy ? t('health.waiting') : null, onclick: runCheck }, S.checking ? spinner() : null, S.checking ? t('health.running') : t('health.run')),
        BOOT.readOnly ? null : h('button', { class: 'btn btn-primary', type: 'button', disabled: busy || !fixable, 'aria-busy': S.fixing ? 'true' : null, title: fixWhy, onclick: runFix },
          S.fixing ? spinner() : null, S.fixing ? t('health.fixing') : t('fix.all') + (fixable ? ' (' + fixable + ')' : ''))))]
    if (ref) out.push(h('div', { class: 'filter-bar' },
      h('span', { class: 'chip chip-accent mono' }, badge(ref.split(':')[0], 'xs'), ref),
      h('span', { class: 'muted small' }, t('health.filtered')),
      ui.checkingRef === ref ? h('span', { class: 'muted small' }, spinner(), ' ', t('health.checking'))
        : h('button', { class: 'link-btn', type: 'button', disabled: busy || Boolean(ui.checkingRef), onclick: () => checkAccount(ref) }, t('health.checkThis')),
      h('button', { class: 'link-btn', type: 'button', onclick: () => { ui.healthRef = null; renderCheckup() } }, t('health.showAll'))))
    if (S.checkError) out.push(errorNote(S.checkError, S.checkRetry))
    if (!BOOT.readOnly && all && all.length && fixWhy && !ref) out.push(h('p', { class: 'disabled-why' }, t('fix.off', { why: fixWhy })))
    if (S.fixes) {
      const failed = S.fixes.filter((f) => !f.ok)
      out.push(h('div', { class: 'fix-result ' + (failed.length ? 'is-warn' : 'is-ok'), role: 'status' },
        S.fixes.length ? t('fix.result', { ok: S.fixes.length - failed.length, n: S.fixes.length }) : t('fix.nothing'),
        failed.length ? h('ul', null, failed.map((f) => h('li', null, h('b', null, f.account + ' · ' + f.item + ': '), f.message))) : null))
    }
    if (!findings) {
      if (busy || !S.state) out.push(h('span', { class: 'sk sk-line w70' }), h('span', { class: 'sk sk-line w50' }))
      else out.push(h('p', { class: 'muted' }, t('health.intro')))
    } else if (ref && !healthOf(ref) && !findings.length) {
      out.push(h('p', { class: 'muted' }, t('health.refNever', { ref })))
    } else if (!findings.length) {
      out.push(h('div', { class: 'all-good' }, h('span', { class: 'check-icon', 'aria-hidden': 'true' }, '✓'),
        h('div', null, h('b', null, ref ? t('health.refGood', { ref }) : t('health.allGood')), h('p', { class: 'muted small' }, t('health.allGoodSub')))))
    } else {
      // Long lists show the most serious first and fold the rest behind one button.
      const rank = { fail: 0, warn: 1, ok: 2 }
      const sorted = findings.slice().sort((x, y) => rank[x.level] - rank[y.level])
      const cut = ui.allFindings || sorted.length <= FINDINGS_SHOWN + 1 ? sorted.length : FINDINGS_SHOWN
      out.push(h('ul', { class: 'findings' }, sorted.slice(0, cut).map(findingRow)))
      if (cut < sorted.length) out.push(h('button', { class: 'btn btn-sm more-findings', type: 'button', onclick: () => { ui.allFindings = true; renderCheckup() } }, tn('health.more', sorted.length - cut)))
    }
    patch(box, out)
  }
  // An error from a server call, with a Retry button when trying again can help.
  function errorNote(err, retry, extra) {
    return h('div', { class: 'note note-fail error-note', role: 'alert' },
      h('span', null, err.message),
      err.retryable && retry ? h('button', { class: 'btn btn-sm', type: 'button', onclick: retry }, t('btn.retry')) : null,
      extra ? h('span', { class: 'note-sub' }, extra) : null)
  }

  // ---------- dialogs ----------
  const dlg = { el: null, kind: null, busy: false, onClose: null }
  function ensureDialog() {
    if (dlg.el) return dlg.el
    dlg.el = h('dialog', { class: 'dialog', 'aria-labelledby': 'dlg-title' })
    dlg.el.addEventListener('cancel', (e) => { if (dlg.busy) e.preventDefault() })
    dlg.el.addEventListener('click', (e) => { if (e.target === dlg.el && !dlg.busy) dlg.el.close() })
    dlg.el.addEventListener('close', () => {
      const after = dlg.onClose
      dlg.kind = null
      dlg.onClose = null
      if (after) after()
    })
    document.body.append(dlg.el)
    return dlg.el
  }
  function dialogFrame(title, fam, body, foot) {
    return [
      h('div', { class: 'dlg-head' },
        h('h2', { id: 'dlg-title', class: 'title-logo' }, fam ? badge(fam, 'sm') : null, title),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('btn.close'), disabled: dlg.busy, onclick: () => dlg.el.close() }, icon('x'))),
      h('div', { class: 'dlg-body' }, body),
      foot ? h('div', { class: 'dlg-foot' }, foot) : null,
    ]
  }
  function showDialog(kind) {
    const el = ensureDialog()
    dlg.kind = kind
    if (!el.open) { el.showModal(); raiseToasts() }
  }

  // New account. The form is built once per opening so typing keeps focus; only its derived parts re-render.
  let nf = null
  function familyStatus(f) {
    const hasMain = S.state && S.state.accounts.some((a) => a.family === f.id && a.isMain)
    if (hasMain) return 'ready'
    return f.installed ? 'no-main' : 'missing'
  }
  function openCreate(prefill) {
    if (BOOT.readOnly || !S.state) return
    const fams = S.state.families.slice().sort((x, y) => {
      const rank = (f) => ({ ready: 0, 'no-main': 1, missing: 2 })[familyStatus(f)]
      return rank(x) - rank(y)
    })
    const ready = fams.filter((f) => familyStatus(f) === 'ready')
    const pick = prefill && ready.some((f) => f.id === prefill.family) ? prefill.family : prefs.family && ready.some((f) => f.id === prefs.family) ? prefs.family : ready.length ? ready[0].id : ''
    // name / alias: what the user typed, or null while the field shows the suggestion (an emptied alias stays empty).
    nf = { fams, family: pick, api: Boolean(prefill && prefill.api), name: null, alias: null, creating: false, result: null, error: null, els: {} }
    showDialog('create')
    renderCreate()
    if (nf.els.name) { nf.els.name.focus(); nf.els.name.select() }
  }
  function suggestionFor(fam) {
    return fam && S.state ? suggestName(S.state.accounts.filter((a) => a.family === fam).map((a) => a.name)) : ''
  }
  function nameProblem() {
    const name = nf.els.name.value.trim()
    if (!name) return ''
    if (name === 'main') return t('nf.mainTaken')
    if (!NAME_RE.test(name)) return t('nf.badName')
    if (S.state && S.state.accounts.some((a) => a.ref === nf.family + ':' + name)) return t('nf.exists', { ref: nf.family + ':' + name })
    return ''
  }
  // The short command offered for the typed name: the Family's alias pattern (cc001… gives cc008), if it is usable.
  function aliasSuggestion() {
    const name = nf.els.name.value.trim()
    if (!nf.family || !name || nameProblem()) return ''
    const sug = suggestAlias(S.state.accounts, nf.family, name)
    return sug && !aliasIssue(sug, BOOT.aliasPattern, BOOT.reservedAliases, S.state.configAliases, nf.family + ':' + name) ? sug : ''
  }
  function followAlias() {
    if (nf.alias !== null) return
    nf.els.alias.value = aliasSuggestion()
  }
  function aliasProblem() {
    const alias = nf.els.alias.value.trim()
    const ref = nf.family + ':' + nf.els.name.value.trim()
    const issue = aliasIssue(alias, BOOT.aliasPattern, BOOT.reservedAliases, S.state.configAliases, ref)
    if (issue === 'pattern') return t('nf.aliasBad')
    if (issue === 'reserved') return t('nf.aliasReserved', { alias })
    if (issue === 'taken') return t('nf.aliasTaken', { alias, ref: S.state.configAliases[alias] })
    return ''
  }
  function renderCreate() {
    const el = dlg.el
    if (nf.result) { setKids(el, createdView()); return }
    const e = nf.els
    const sug = suggestionFor(nf.family)
    e.name = h('input', { id: 'nf-name', name: 'name', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: sug || 'work', maxlength: '32', 'aria-label': t('nf.name'), 'aria-describedby': 'nf-sug nf-err', 'aria-invalid': 'false' })
    e.name.value = nf.name === null ? sug : nf.name
    e.alias = h('input', { id: 'nf-alias', name: 'alias', type: 'text', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: t('nf.aliasPh'), maxlength: '64', 'aria-describedby': 'nf-alias-hint nf-alias-err', 'aria-invalid': 'false' })
    e.aliasHint = h('p', { class: 'field-hint', id: 'nf-alias-hint' })
    e.aliasErr = h('p', { class: 'field-error', id: 'nf-alias-err', role: 'alert' })
    e.api = h('input', { id: 'nf-api', type: 'checkbox', 'aria-label': t('nf.api') })
    e.api.checked = nf.api
    e.suggest = h('p', { class: 'field-hint', id: 'nf-sug' })
    e.error = h('p', { class: 'field-error', id: 'nf-err', role: 'alert' })
    e.preview = h('dl', { class: 'preview' })
    e.submit = h('button', { class: 'btn btn-primary', type: 'submit', form: 'nf-form', 'aria-label': t('nf.create') }, t('nf.create'))
    e.name.addEventListener('input', () => { nf.name = e.name.value; followAlias(); validateCreate(); renderPreview() })
    e.alias.addEventListener('input', () => { nf.alias = e.alias.value; validateCreate(); renderPreview() })
    e.api.addEventListener('change', () => {
      nf.api = e.api.checked
      // A refusal was about the old choice; the hint under it no longer applies.
      if (e.errNote) { e.errNote.remove(); e.errNote = null; nf.error = null }
    })
    const cards = nf.fams.map((f) => {
      const st = familyStatus(f)
      const input = h('input', { type: 'radio', name: 'nf-family', value: f.id, class: 'sr-only', disabled: st !== 'ready', 'aria-label': f.title })
      input.checked = f.id === nf.family
      input.addEventListener('change', () => {
        // A name the user has not changed follows the Family: Claude's next free name differs from Cursor's.
        const typed = e.name.value.trim()
        const untouched = nf.name === null || !typed || typed === suggestionFor(nf.family)
        nf.family = f.id
        if (untouched) { nf.name = null; e.name.value = suggestionFor(f.id); e.name.placeholder = e.name.value || 'work' }
        followAlias()
        validateCreate()
        renderPreview()
      })
      const n = S.state.accounts.filter((a) => a.family === f.id).length
      const sub = st === 'ready' ? tn('nf.accounts', n) : st === 'no-main' ? tx('nf.runOnce', { bin: h('code', null, f.bin) }) : t('nf.notInstalled')
      return h('label', { class: 'fam-card' + (st === 'ready' ? '' : ' is-off') }, input, badge(f.id, 'sm'),
        h('span', { class: 'fam-text' }, h('span', { class: 'fam-title' }, f.title), h('span', { class: 'fam-sub' }, sub)))
    })
    const body = h('form', { id: 'nf-form', class: 'form', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); create() } },
      h('p', { class: 'muted small' }, t('nf.intro')),
      h('fieldset', { class: 'field fam-field' }, h('legend', null, t('nf.tool')), nf.fams.length ? h('div', { class: 'fam-grid' }, cards) : h('p', { class: 'muted small' }, t('empty.noFamilies'))),
      h('div', { class: 'field' }, h('label', { class: 'field', for: 'nf-name' }, h('span', null, t('nf.name')), e.name), e.suggest),
      h('div', { class: 'field' }, h('label', { class: 'field', for: 'nf-alias' }, h('span', null, t('nf.alias'), ' ', h('span', { class: 'muted small' }, t('nf.optional'))), e.alias), e.aliasHint, e.aliasErr),
      h('div', { class: 'check-row' }, h('label', { class: 'check' }, e.api, h('span', null, h('b', null, t('nf.api')), h('span', { class: 'muted small' }, t('nf.apiHint')))), tip('api')),
      e.preview,
      e.error,
      e.errNote = nf.error ? errorNote(nf.error, create, nf.error.code === 'create-refused' && !nf.api ? t('nf.refusedApi') : null) : null)
    setKids(el, dialogFrame(t('nf.title'), null, body, [
      h('button', { class: 'btn', type: 'button', onclick: () => el.close() }, t('btn.cancel')),
      e.submit,
    ]))
    if (nf.alias === null) followAlias(); else e.alias.value = nf.alias
    validateCreate()
    if (!nf.family) e.error.textContent = t('nf.noReady')
    renderPreview()
  }
  // Create stays off until the name is usable; the message under the field says why.
  function validateCreate() {
    const e = nf.els
    const msg = nameProblem()
    const name = e.name.value.trim()
    e.name.classList.toggle('invalid', Boolean(msg))
    e.name.setAttribute('aria-invalid', String(Boolean(msg)))
    e.error.textContent = msg
    const sug = suggestionFor(nf.family)
    e.suggest.textContent = sug && name === sug ? t('nf.suggested') : ''
    const aliasMsg = aliasProblem()
    const alias = e.alias.value.trim()
    e.alias.classList.toggle('invalid', Boolean(aliasMsg))
    e.alias.setAttribute('aria-invalid', String(Boolean(aliasMsg)))
    e.aliasErr.textContent = aliasMsg
    e.aliasHint.textContent = alias && alias === aliasSuggestion() ? t('nf.aliasSuggested', { host: family(nf.family).title }) : t('nf.aliasHint')
    if (!nf.creating) e.submit.disabled = Boolean(msg) || Boolean(aliasMsg) || !name || !nf.family
    return msg || aliasMsg
  }
  function renderPreview() {
    const name = nf.els.name.value.trim()
    const ok = name && !nameProblem() && nf.family
    const shown = ok ? name : '<' + t('nf.namePh') + '>'
    const dir = nf.family ? newAccountDir(S.state.accounts, nf.family, shown) : null
    const alias = nf.els.alias.value.trim()
    const run = nf.family ? 'sideby run ' + nf.family + ':' + shown : '—'
    setKids(nf.els.preview, [
      dir ? [h('dt', null, t('nf.dir')), h('dd', { class: 'mono' }, dir)] : null,
      h('dt', null, t('nf.launch')),
      alias && !aliasProblem() && nf.family
        ? h('dd', null, h('span', { class: 'mono' }, alias), h('span', { class: 'muted small' }, ' ' + t('nf.or') + ' '), h('span', { class: 'mono' }, run))
        : h('dd', { class: 'mono' }, run),
    ])
    nf.els.preview.classList.toggle('is-draft', !ok)
  }
  async function create() {
    if (nf.creating) return
    const name = nf.els.name.value.trim()
    const alias = nf.els.alias.value.trim()
    const aliasMsg = aliasProblem()
    const msg = nameProblem() || (nf.family ? '' : t('nf.noReady')) || (name ? '' : t('nf.enterName'))
    validateCreate()
    if (msg) { nf.els.error.textContent = msg; nf.els.name.focus(); return }
    if (aliasMsg) { nf.els.alias.focus(); return }
    nf.creating = true
    nf.error = null
    dlg.busy = true
    nf.els.submit.disabled = true
    nf.els.submit.setAttribute('aria-busy', 'true')
    nf.els.submit.replaceChildren(spinner(), t('nf.creating'))
    labelFromText(nf.els.submit)
    try {
      nf.result = await api('/api/accounts', alias ? { family: nf.family, name, api: nf.els.api.checked, alias } : { family: nf.family, name, api: nf.els.api.checked })
      toast(t(nf.result.ok ? 'toast.created' : 'toast.createdProblems', { ref: nf.result.account.ref }), { kind: nf.result.ok ? 'ok' : 'info' })
      ui.highlight = nf.result.account.ref
      dlg.onClose = () => { if (ui.highlight) flashRow(ui.highlight) }
      load({ check: true })
    } catch (e) { nf.error = e }
    nf.creating = false
    dlg.busy = false
    renderCreate()
    if (!nf.result && nf.els.name) {
      nf.els.name.value = name
      nf.alias = alias
      nf.els.alias.value = alias
      validateCreate()
      renderPreview()
      // A refused subscription account is usually fixed by turning on "API key account".
      if (nf.error && nf.error.code === 'create-refused' && !nf.api) nf.els.api.focus()
      else if (nf.error && nf.error.code === 'alias-invalid') nf.els.alias.focus()
      else nf.els.name.focus()
    }
  }
  function stepRow(s) {
    const fill = /^fill in (.+)$/.exec(s)
    if (fill) return h('li', null, h('span', null, t('nf.fillIn')), codeCopy(fill[1]))
    if (s.startsWith('sideby ')) return h('li', null, codeCopy(s))
    return h('li', null, s)
  }
  function createdView() {
    const r = nf.result
    const failed = r.steps.filter((s) => !s.ok)
    // An incomplete account creation is not shown as a success.
    const body = h('div', { class: 'created', role: 'status' },
      r.ok
        ? h('div', { class: 'created-head' }, h('span', { class: 'check-icon', 'aria-hidden': 'true' }, '✓'), h('span', null, tx('nf.created', { ref: h('b', { class: 'mono' }, r.account.ref) })))
        : h('div', { class: 'created-head' }, h('span', { class: 'warn-icon', 'aria-hidden': 'true' }, '!'), h('span', null, tx('nf.createdProblems', { ref: h('b', { class: 'mono' }, r.account.ref) }))),
      failed.length || r.hookErrors.length ? h('div', { class: 'note note-warn' },
        failed.map((s) => h('span', { class: 'small' }, s.item + ': ' + (s.message || 'failed'))),
        r.hookErrors.map((e) => h('span', { class: 'small' }, 'plugin ' + e.plugin + ': ' + e.message))) : null,
      r.account.dir ? h('p', { class: 'small' }, h('span', { class: 'muted' }, t('nf.dir') + ' '), h('code', null, r.account.dir)) : null,
      r.alias && r.alias.added ? h('div', { class: 'small created-alias' }, h('span', { class: 'muted' }, t('nf.alias') + ' '), codeCopy(r.alias.name), h('span', { class: 'muted' }, ' ' + t('nf.aliasNewShell'))) : null,
      r.alias && !r.alias.added ? h('div', { class: 'note note-warn' }, h('b', null, t('nf.aliasNotAdded')), ' ', h('span', { class: 'small' }, r.alias.message || '')) : null,
      (r.shellInitFiles || []).map((f) => f.ok
        ? h('p', { class: 'muted small' }, t(f.action === 'unchanged' ? 'nf.shellFileSame' : 'nf.shellFileUpdated', { file: f.path }))
        : h('div', { class: 'note note-warn' }, h('span', { class: 'small' }, f.message))),
      h('p', { class: 'muted small' }, t('nf.next')),
      h('ol', { class: 'steps' }, r.nextSteps.map(stepRow)))
    return dialogFrame(t('nf.title'), r.account.family, body, [
      h('button', { class: 'btn', type: 'button', onclick: () => openCreate({ family: r.account.family, api: nf.api }) }, t('nf.another')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => dlg.el.close() }, t('btn.done')),
    ])
  }

  // Quota setup: preview the diff, apply, then offer Undo (teardown) in the toast.
  let qs = null
  function diffView(diff) {
    return h('pre', { class: 'diff' }, diff.split('\n').map((l) => h('span', {
      class: l.startsWith('@@') ? 'hunk' : l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : null,
    }, l || ' ')))
  }
  async function openSetup(fam) {
    if (BOOT.readOnly) return
    qs = { family: fam, loading: true }
    showDialog('setup')
    renderSetup()
    try {
      const r = await api('/api/quota/setup', { family: fam })
      if (qs && qs.family === fam) qs = { family: fam, plan: r.plan, summary: r.summary }
    } catch (e) { if (qs && qs.family === fam) qs = { family: fam, error: e } }
    if (dlg.kind === 'setup') renderSetup()
  }
  function renderSetup() {
    const fam = family(qs.family)
    const body = []
    const foot = []
    if (qs.loading) body.push(h('p', { class: 'muted' }, spinner(), ' ', t('qs.preparing')))
    // With a plan on screen, its Apply button is the retry.
    if (qs.error) body.push(errorNote(qs.error, qs.plan ? null : () => openSetup(qs.family)))
    if (qs.plan) {
      const p = qs.plan
      if (p.status === 'enabled') body.push(h('p', null, p.message || t('qs.alreadyOn', { host: fam.title })))
      else if (p.status === 'blocked') body.push(h('p', { class: 'note note-warn' }, p.message))
      else {
        body.push(h('p', { class: 'muted' }, qs.summary || p.message))
        if (p.file) body.push(h('p', { class: 'small' }, tx('qs.changes', { file: h('code', null, p.file) })))
        if (p.diff) body.push(diffView(p.diff))
        body.push(h('p', { class: 'muted small' }, t('qs.undoHint')))
        foot.push(h('button', { class: 'btn', type: 'button', disabled: qs.applying, onclick: () => dlg.el.close() }, t('btn.cancel')),
          h('button', { class: 'btn btn-primary', type: 'button', disabled: qs.applying, 'aria-busy': qs.applying ? 'true' : null, onclick: applySetup }, qs.applying ? spinner() : null, qs.applying ? t('qs.applying') : t('qs.apply')))
      }
    }
    if (!foot.length) foot.push(h('button', { class: 'btn', type: 'button', onclick: () => dlg.el.close() }, t('btn.close')))
    setKids(dlg.el, dialogFrame(t('qs.title', { host: fam.title }), qs.family, body, foot))
  }
  async function applySetup() {
    const st = qs
    st.applying = true
    st.error = null
    dlg.busy = true
    renderSetup()
    try {
      const r = await api('/api/quota/setup', { family: st.family, confirm: true })
      dlg.busy = false
      if (r.plan.status === 'enabled') {
        const fam = st.family
        dlg.el.close()
        toast(t('toast.quotaOn', { host: family(fam).title }), { action: { label: t('toast.undo'), run: () => undoSetup(fam) }, duration: 10000 })
        // The first numbers arrive with the next status line refresh; poll quickly for a while to show them soon.
        S.fastUntil = Date.now() + FAST_FOR_MS
        S.fastFamily = fam
        load()
        return
      }
      qs = { family: st.family, plan: r.plan, summary: r.summary }
    } catch (e) { st.applying = false; st.error = e; dlg.busy = false }
    renderSetup()
  }
  async function undoSetup(fam) {
    S.fastUntil = 0
    S.fastFamily = null
    try {
      const r = await api('/api/quota/teardown', { family: fam })
      if (r && r.ok === false) toast(r.message || t('toast.undoFailed', { msg: '' }), { kind: 'fail' })
      else toast(t('toast.quotaOff', { host: family(fam).title }))
    } catch (e) {
      toast(e.status === 404 ? t('toast.undoMissing') : t('toast.undoFailed', { msg: e.message }), { kind: 'fail' })
    }
    load()
  }

  // ---------- banners ----------
  function renderBanners() {
    const out = []
    if (S.loadError && S.state) out.push(h('div', { class: 'banner banner-fail', role: 'alert' },
      h('div', null, h('b', null, t('load.failedShort') + ' '), S.loadError.message),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load({ check: !S.report }) }, t('btn.retry'))))
    if (S.state) {
      if (BOOT.readOnly) out.push(h('div', { class: 'banner banner-quiet' }, h('div', { class: 'muted small' }, t('banner.readOnly'))))
      const errs = S.state.pluginErrors
      if (errs.length) out.push(h('div', { class: 'banner banner-warn', role: 'status' }, h('div', null,
        h('b', null, tn('banner.plugins', errs.length) + ' '), t('banner.pluginsHint'),
        h('ul', null, errs.map((e) => h('li', null, h('code', null, e.where), ': ', e.message))))))
    }
    patch($('banners'), out)
  }

  // ---------- loading ----------
  function renderAll() { renderTop(); renderBanners(); renderSummary(); renderFamilyFilter(); renderEmailToggle(); renderAccounts(); renderCheckup() }
  // A load that starts while another runs is queued, never dropped, so a change made meanwhile (a new
  // account, a fix) always ends up on screen; and only the newest response is ever rendered. A silent load is a
  // background refresh: no spinner, and its render waits while the viewer is busy (see uiBusy).
  let loadSeq = 0
  let queued = null
  async function load(opts) {
    opts = opts || {}
    if (S.loading) {
      queued = {
        check: Boolean((queued && queued.check) || opts.check),
        announce: Boolean((queued && queued.announce) || opts.announce),
        silent: Boolean((queued ? queued.silent : true) && opts.silent),
      }
      return
    }
    const seq = ++loadSeq
    S.loading = true
    S.silent = Boolean(opts.silent)
    S.lastTry = Date.now()
    renderTop()
    let state = null
    let error = null
    try { state = await api('/api/state') } catch (e) { error = e }
    if (seq === loadSeq) {
      if (state) {
        if (!S.state) ui.fade = true
        S.state = state; S.loadError = null; S.loadedAt = Date.now()
        // A read-only Panel never records checks, so keep the result of its own last check over the disk.
        if (!BOOT.readOnly || !S.history) S.history = state.history || null
      } else if (!error.network) S.loadError = error // a lost connection has its own notice
    }
    S.loading = false
    S.silent = false
    const next = queued
    queued = null
    if (next) return load(next)
    if (opts.silent && uiBusy()) { S.pending = true; renderTop() } else { S.pending = false; renderAll() }
    if (opts.announce) {
      if (state) toast(t('toast.refreshed'))
      else toast(t('toast.refreshFailed', { msg: error.message }), { kind: 'fail' })
    }
    if (S.state && opts.check) runCheck()
  }
  // Once a second: the "Updated" age ticks, a deferred render lands once the viewer is done, and the state
  // reloads on schedule while the page is visible.
  function tick() {
    renderUpdated()
    if (document.visibilityState !== 'visible' || !S.state) return
    if (S.pending && !S.loading && !uiBusy()) { S.pending = false; renderAll() }
    const now = Date.now()
    const every = now < S.fastUntil ? FAST_MS : AUTO_MS
    if (!S.loading && !conn.lost && !S.fixing && !S.checking && !dlg.busy && now - S.lastTry >= every) load({ silent: true })
  }
  // Coming back to the page refreshes at once.
  function wake() {
    if (document.visibilityState !== 'visible' || !S.state || S.loading || conn.lost) return
    if (Date.now() - S.lastTry > 3000) load({ silent: true })
  }

  // ---------- start ----------
  $('ver').textContent = BOOT.version ? 'v' + BOOT.version : ''
  $('refresh').addEventListener('click', () => load({ check: true, announce: true }))
  $('lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh'
    prefs.lang = lang
    savePrefs()
    renderStatic()
    buildToolbar()
    renderAll()
    if (dlg.kind === 'create' && nf && !nf.creating) renderCreate()
    else if (dlg.kind === 'setup' && qs) renderSetup()
  })
  $('theme').addEventListener('click', () => {
    const order = CHOICES.theme
    prefs.theme = order[(order.indexOf(prefs.theme) + 1) % order.length]
    savePrefs()
    applyTheme()
    renderStatic()
    toast(t('theme.' + prefs.theme), { key: 'theme', kind: 'plain' })
  })
  applyTheme()
  renderStatic()
  buildToolbar()
  raiseToasts()
  load({ check: true })
  setInterval(tick, 1000)
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
`

/** The page script: the tested helpers, then the page logic, in one strict-mode function. */
export const PAGE_SCRIPT = `(() => {\n  'use strict'\n${LOGIC}\n${MAIN}})()\n`
