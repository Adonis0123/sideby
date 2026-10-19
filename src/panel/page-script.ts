// The Panel page's inline script. Plain browser JavaScript in a string (no template literals inside, so String.raw
// keeps it verbatim); the pure helpers from page-logic.ts are prepended so the tested code is the code that runs.
import {
  aiTaskAccounts,
  aliasArgsOf,
  aliasIssue,
  askBridge,
  askBridged,
  askCopy,
  attentionReasons,
  attentionWhy,
  autostartNote,
  cacheHitRate,
  canLeaveLocal,
  codeSwapOutcome,
  fileSize,
  fixPrompt,
  foldSkips,
  formatDuration,
  handoffChangeOf,
  handoffHintAccount,
  handoffTaskFacts,
  inDisplayOrder,
  loginClusters,
  loginKey,
  maskEmail,
  matchesQuery,
  menuPlacement,
  mergeDaily,
  newAccountDir,
  nextReset,
  panelFixes,
  panelHint,
  panelLang,
  panelMigration,
  panelPrefs,
  passedWindow,
  pinnedIn,
  quotaAskable,
  quotaPressure,
  remoteControlSummary,
  remoteControlTodo,
  reorder,
  rowBadge,
  runCodeSwap,
  sortAccounts,
  stripSecrets,
  suggestAlias,
  suggestName,
  switchFailure,
  taskFindings,
  updatedAge,
  widthFollower,
  widthTier,
  windowState,
  withPinned,
} from './page-logic.ts'

const LOGIC = [
  aiTaskAccounts,
  askBridge,
  askBridged,
  askCopy,
  quotaAskable,
  stripSecrets,
  taskFindings,
  aliasArgsOf,
  aliasIssue,
  attentionReasons,
  attentionWhy,
  autostartNote,
  cacheHitRate,
  fileSize,
  fixPrompt,
  foldSkips,
  formatDuration,
  handoffChangeOf,
  handoffHintAccount,
  handoffTaskFacts,
  inDisplayOrder,
  loginClusters,
  loginKey,
  maskEmail,
  matchesQuery,
  menuPlacement,
  mergeDaily,
  newAccountDir,
  nextReset,
  canLeaveLocal,
  codeSwapOutcome,
  runCodeSwap,
  switchFailure,
  panelFixes,
  panelHint,
  panelLang,
  panelMigration,
  panelPrefs,
  passedWindow,
  quotaPressure,
  remoteControlSummary,
  remoteControlTodo,
  reorder,
  rowBadge,
  sortAccounts,
  suggestAlias,
  suggestName,
  updatedAge,
  pinnedIn,
  widthFollower,
  widthTier,
  windowState,
  withPinned,
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
  // After the layout follows a width into another band, how long the width must hold still before a later crossing
  // in the same gesture is applied (page-logic.ts, widthFollower).
  const WIDTH_SETTLE_MS = 90
  const S = {
    state: null, loadError: null, loading: false, loadedAt: 0, history: null,
    report: null, checking: false, fixing: false, checkError: null, checkRetry: null, fixes: null,
    // silent: the running load is a background one (no spinner); lastTry: when the last load started;
    // pending: a background load finished while the viewer was busy, so its render waits; fastUntil/fastFamily:
    // the quick polling after quota was turned on.
    silent: false, lastTry: 0, pending: false, fastUntil: 0, fastFamily: null,
  }
  // View state that is not saved: the search text, the attention filter, the Health check filter.
  const ui = { query: '', attention: false, allFindings: false, healthRef: null, checkingRef: null, desktopRef: null, browserRef: null, appBusy: null, appRemove: null, appNew: null, highlight: null, fade: true, loginRefs: new Map(), order: { families: [], units: {} }, drag: null, arrange: null }
  const $ = (id) => document.getElementById(id)

  // ---------- preferences ----------
  // Kept in localStorage, which can be missing or throw (private windows, blocked storage): every access is guarded
  // and the defaults apply.
  const PREFS_KEY = 'sideby.panel.v2'
  const CHOICES = { view: ['list', 'cards'], sort: ['pressure', 'name', 'recent', 'manual'], quota: ['used', 'left'], theme: ['system', 'light', 'dark'], lang: ['en', 'zh'] }
  const prefs = loadPrefs()
  function loadPrefs() {
    let raw = {}
    try { raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {} } catch {}
    const p = { view: 'list', sort: 'pressure', quota: 'used', theme: 'system', lang: '', family: '', collapsed: {}, open: {}, hideEmail: false }
    for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(raw[k])) p[k] = raw[k]
    if (raw.hideEmail === true) p.hideEmail = true
    if (typeof raw.ahHintAt === 'number') p.ahHintAt = raw.ahHintAt
    if (raw.rcHide === true) p.rcHide = true
    if (raw.mbHintDone === true) p.mbHintDone = true
    if (raw.cfgDone === true) p.cfgDone = true
    if (typeof raw.family === 'string') p.family = raw.family
    if (raw.collapsed && typeof raw.collapsed === 'object')
      for (const k of Object.keys(raw.collapsed)) if (raw.collapsed[k] === true) p.collapsed[k] = true
    if (raw.open && typeof raw.open === 'object')
      for (const k of Object.keys(raw.open)) if (raw.open[k] === true) p.open[k] = true
    return p
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)) } catch {} }
  // A host lang other than auto wins over the saved choice (which stays saved) and hides the switch.
  const LANG_FIXED = BOOT.lang === 'en' || BOOT.lang === 'zh'
  // Theme and language live in config panel.* (spec §3.29), so the CLI and an AI assistant can change them too. A
  // choice this browser saved before is written there once (cfgDone), then config is the only source. A read-only
  // Panel cannot write config and keeps the browser's choice.
  const CFG = !BOOT.readOnly
  let cfgPanel = Object.assign({}, BOOT.panel || {})
  let cfgSaving = 0
  const cfgMigrate = CFG && !prefs.cfgDone ? panelMigration(cfgPanel, { theme: prefs.theme, lang: prefs.lang }) : null
  if (cfgMigrate) Object.assign(cfgPanel, cfgMigrate)
  function viewPrefs() { return panelPrefs(cfgPanel, { theme: prefs.theme, lang: prefs.lang }, CFG) }
  let lang = panelLang(BOOT.lang, viewPrefs().language, navigator.language)

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
    // A row or group in the middle of folding; a render now would cut the motion short.
    for (const el of folding) if (el.isConnected) return true
    // A row or group being dragged into a new place (spec §3.25).
    if (ui.drag) return true
    if (menu.el || (dlg.el && dlg.el.open) || document.querySelector('.tip.is-open')) return true
    // A plan on the Auto Handoff page, and the change a person opened to read, stay as they are.
    if (!$('handoff-page').hidden && (hp.preview || hp.askSame || document.querySelector('#handoff-page details[open]'))) return true
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
    grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
    plus: 'M12 5v14M5 12h14',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z',
    monitor: 'M3 5h18v11H3zM8 20h8M12 16v4',
    // Lucide "settings" (ISC license)
    gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    terminal: 'M4 17l6-5-6-5M12 19h8',
    key: 'M15 9a3 3 0 1 0-.01 0M12.9 11.1L4 20M7 17l2 2M9.5 14.5l2 2',
    folder: 'M3 6h6l2 2h10v11H3z',
    file: 'M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h6',
    check: 'M9 12l2 2 4-4M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
    userPlus: 'M15 19a6 6 0 0 0-12 0M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M16 11h6',
    x: 'M6 6l12 12M18 6L6 18',
    arrowUp: 'M12 19V5M5 12l7-7 7 7',
    arrowDown: 'M12 5v14M5 12l7 7 7-7',
    swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
    // Lucide "pin" (ISC license)
    pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
    // Lucide "link" (ISC license)
    link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
    bot: 'M6 9h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM12 5v4M9.5 13.5v1M14.5 13.5v1',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    sliders: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
    image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01',
    film: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4',
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
  // The header's "Updated …" age (see updatedAge).
  function agoShort(ms) {
    const a = updatedAge(ms)
    return t(a.key, { n: a.n })
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
  async function copyText(text, shown) {
    let ok = true
    try { await navigator.clipboard.writeText(text) } catch {
      const ta = h('textarea', { css: { position: 'fixed', opacity: '0' } })
      ta.value = text
      document.body.append(ta)
      ta.select()
      try { ok = document.execCommand('copy') } catch { ok = false }
      ta.remove()
    }
    if (ok) toast(t('toast.copied', { text: shown || (prefs.hideEmail && text.includes('@') ? maskEmail(text) : text) }))
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

  // ---------- floating panels: menus and popovers ----------
  // One shared base for everything that floats next to a button: it is placed under (or above) its anchor, kept
  // inside the window, closed by a click outside, Escape or a resize, and only one is open at a time. One taller than
  // the room it gets scrolls inside itself (menuPlacement), and that scroll never closes it; a scroll of the page
  // moves it along with its anchor and closes it only when the anchor leaves the window.
  // openMenu() fills it with menu items; openPopover() with any content that render() returns (re-run by refreshPopover()).
  // returnTo: where focus goes back on close when that is not the anchor (a right-click menu's point).
  const menu = { el: null, anchor: null, kind: null, render: null, align: 'end', returnTo: null }
  function placeFloat() {
    const el = menu.el
    const r = menu.anchor.getBoundingClientRect()
    if (r.bottom < 0 || r.top > window.innerHeight) { closeMenu(); return }
    // Its full height, not the capped one: a menu that got more room grows back.
    const height = el.scrollHeight + el.offsetHeight - el.clientHeight
    const p = menuPlacement(r, { width: el.offsetWidth, height }, { width: window.innerWidth, height: window.innerHeight }, menu.align)
    el.style.setProperty('left', p.left + 'px')
    el.style.setProperty('top', p.top + 'px')
    el.style.setProperty('max-height', p.maxHeight + 'px')
    if (menu.kind === 'settings') settingsFit()
  }
  function openFloat(anchor, el, kind, align) {
    closeMenu()
    document.body.append(el)
    anchor.setAttribute('aria-expanded', 'true')
    menu.el = el
    menu.anchor = anchor
    menu.kind = kind
    menu.align = align
    placeFloat()
    // The wheel over it never scrolls the page behind: overscroll-behavior covers a menu that scrolls, this one that
    // does not or has reached its end.
    el.addEventListener('wheel', (e) => {
      const end = e.deltaY < 0 ? el.scrollTop <= 0 : el.scrollTop + el.clientHeight >= el.scrollHeight - 1
      if (end) e.preventDefault()
    }, { passive: false })
  }
  function openMenu(anchor, items, label) {
    const el = h('div', { class: 'menu', role: 'menu', 'aria-label': label },
      items.filter(Boolean).map((it) => it === '-' ? h('div', { class: 'menu-sep', role: 'separator' })
        : it.header ? h('div', { class: 'menu-head', role: 'presentation' }, it.header)
        : h('button', { class: 'menu-item', type: 'button', role: 'menuitem', tabindex: '-1', disabled: it.disabled, onclick: () => { closeMenu(true); it.run() } },
          icon(it.icon), h('span', { class: 'menu-label' }, it.label), it.hint ? h('code', { class: 'menu-hint', title: it.hint }, it.hint.length > 24 ? '…' + it.hint.slice(-23) : it.hint) : null)))
    el.addEventListener('keydown', menuKeys)
    openFloat(anchor, el, 'menu', 'end')
    const first = el.querySelector('.menu-item:not(:disabled)')
    if (first) first.focus()
  }
  // A popover: a small panel of text and buttons, lighter than a dialog. A second click on its anchor closes it.
  function openPopover(anchor, kind, label, render, align = 'start') {
    if (menu.anchor === anchor) { closeMenu(true); return }
    const el = h('div', { class: 'menu popover pop-' + kind, role: 'dialog', 'aria-label': label })
    el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeMenu(true) } })
    setKids(el, render())
    openFloat(anchor, el, kind, align)
    menu.render = render
    const first = el.querySelector('button:not(:disabled), a[href]')
    if (first) first.focus()
  }
  function refreshPopover(kind) {
    if (menu.el && menu.kind === kind && menu.render) { setKids(menu.el, menu.render()); placeFloat() }
  }
  function closeMenu(restore) {
    if (!menu.el) return
    menu.el.remove()
    menu.anchor.setAttribute('aria-expanded', 'false')
    const back = menu.returnTo || menu.anchor
    if (restore && back.isConnected) back.focus()
    if (menu.anchor.classList.contains('ctx-anchor')) menu.anchor.remove()
    menu.el = null
    menu.anchor = null
    menu.kind = null
    menu.render = null
    menu.returnTo = null
  }
  // Right-click on an account row or card (spec §3.27) opens the row's "…" menu at the pointer; the ContextMenu key
  // and Shift+F10 open it at the focused element in the row. Inputs, links, buttons and selected text keep the
  // browser's own menu. Each row carries its opener as el.sidebyMenu(anchor).
  let kbMenuAt = 0
  function menuTarget(node) {
    let el = node && node.closest ? node.closest('.row, .card, .login-dir') : null
    while (el && !el.sidebyMenu) el = el.parentElement ? el.parentElement.closest('.row, .card, .login-dir') : null
    return el && $('accounts').contains(el) ? el : null
  }
  function openContextMenu(target, x, y, back) {
    const pt = h('span', { class: 'ctx-anchor', 'aria-hidden': 'true', css: { left: x + 'px', top: y + 'px' } })
    document.body.append(pt)
    target.sidebyMenu(pt)
    if (menu.anchor !== pt) { pt.remove(); return }
    // Opens to the right of the point, or to its left where the right edge is too near, as system menus do.
    menu.align = x + menu.el.offsetWidth + 8 > window.innerWidth ? 'end' : 'start'
    menu.returnTo = back && back !== document.body && target.contains(back) ? back : target.querySelector('.more')
    placeFloat()
  }
  function onContextMenu(e) {
    if (Date.now() - kbMenuAt < 600) { e.preventDefault(); return }
    if (ui.arrange || !e.target.closest || e.target.closest('input, textarea, select, a, button, [contenteditable], .tip')) return
    if (window.getSelection && String(window.getSelection())) return
    const target = menuTarget(e.target)
    if (!target) return
    e.preventDefault()
    openContextMenu(target, e.clientX, e.clientY, document.activeElement)
  }
  function onMenuKey(e) {
    if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey)) return
    if (menu.el || (dlg.el && dlg.el.open) || ui.arrange) return
    const at = document.activeElement
    // Text fields and links keep the browser's own menu, as with the mouse; the row's own buttons open the row menu.
    if (at && at.closest && at.closest('input, textarea, select, a, [contenteditable]')) return
    const target = menuTarget(at)
    if (!target) return
    e.preventDefault()
    kbMenuAt = Date.now()
    const r = (at && at !== document.body ? at : target).getBoundingClientRect()
    openContextMenu(target, r.left, r.bottom, at)
  }
  function menuKeys(e) {
    const items = Array.from(menu.el.querySelectorAll('.menu-item:not(:disabled)'))
    const i = items.indexOf(document.activeElement)
    // A menu that scrolls inside keeps the focused item in sight; focus() alone does not always scroll it there.
    const go = (it) => { it.focus({ preventScroll: true }); it.scrollIntoView({ block: 'nearest' }) }
    if (e.key === 'ArrowDown') go(items[(i + 1) % items.length])
    else if (e.key === 'ArrowUp') go(items[(i - 1 + items.length) % items.length])
    else if (e.key === 'Home') go(items[0])
    else if (e.key === 'End') go(items[items.length - 1])
    else if (e.key === 'Escape') closeMenu(true)
    else if (e.key === 'Tab') { closeMenu(true); return }
    else return
    e.preventDefault()
  }
  document.addEventListener('pointerdown', (e) => { if (menu.el && !menu.el.contains(e.target) && !menu.anchor.contains(e.target)) closeMenu() })
  window.addEventListener('resize', () => closeMenu())
  // Layout bands: the page's narrow-screen rules hang on the root's data-width (set before the first paint by the
  // head script), not on media queries, so a width that slides across a breakpoint (a dragged window, a Portal's
  // sidebar opening around this frame) changes the layout as it crosses, as one short cross-fade, not once per frame.
  function applyWidthTier(tier) {
    const root = document.documentElement
    const set = () => { root.dataset.width = tier }
    if (REDUCED || document.hidden || !document.startViewTransition) return set()
    root.classList.add('vt-width')
    document.startViewTransition(set).finished.finally(() => root.classList.remove('vt-width'))
  }
  let widthFollow = null
  function followWidth(width) {
    if (!widthFollow) {
      const timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) }
      const shown = document.documentElement.dataset.width || widthTier(window.innerWidth)
      widthFollow = widthFollower(shown, widthTier, applyWidthTier, WIDTH_SETTLE_MS, timers)
    }
    widthFollow(width)
  }
  window.addEventListener('resize', () => followWidth(window.innerWidth))
  // Capture also sees the scroll of an inner scroller (a dialog, a list); the menu's own scroll is left alone.
  window.addEventListener('scroll', (e) => { if (menu.el && !menu.el.contains(e.target)) placeFloat() }, { passive: true, capture: true })

  // What one directory does: start it, its short commands, its desktop app, its folder, model, tuning, Health.
  function dirCopies(a) {
    const run = 'sideby run ' + a.ref
    return [
      { icon: 'terminal', label: t('menu.copyRun'), hint: run, run: () => copyText(run) },
      ...(a.aliases || []).slice(0, 2).map((x) => ({ icon: 'terminal', label: t('menu.copyAlias'), hint: x, run: () => copyText(x) })),
      a.dir ? { icon: 'folder', label: t('menu.copyDir'), hint: a.dir, run: () => copyText(a.dir) } : null,
    ]
  }
  function deskItem(a) {
    return a.desktopApp && a.desktopApp.installed && a.kind !== 'api' && !BOOT.readOnly ? { icon: 'monitor', label: t(a.desktopApp.running ? 'desk.show' : 'desk.open', { app: a.desktopApp.app }), disabled: Boolean(ui.desktopRef), run: () => openDesktop(a) } : null
  }
  function dirItems(a) { return [...dirCopies(a), deskItem(a)] }
  function dirTools(a) {
    return [
      a.modelInfo && a.modelInfo.settable ? { icon: 'terminal', label: t('menu.model'), run: () => openModel(a) } : null,
      family(a.family).tuning ? { icon: 'check', label: t('menu.tune'), run: () => openTune(a) } : null,
      settingsItem(a),
      { icon: 'check', label: t('menu.check'), disabled: S.checking || S.fixing || Boolean(ui.checkingRef), run: () => checkAccount(a.ref) },
    ]
  }
  // The directory's own Host settings file, opened in the user's editor (spec §3.30); it starts a program, so a
  // read-only Panel has no such item.
  function settingsItem(a) {
    const file = family(a.family).settingsFile
    if (!file || !a.dir || BOOT.readOnly) return null
    return { icon: 'file', label: t('menu.editSettings', { file }), hint: a.dir + '/' + file, run: () => editSettings(a, file) }
  }
  async function editSettings(a, file) {
    try {
      const r = await api('/api/account/edit-settings', { account: a.ref })
      toast(t('edit.opened', { ref: a.ref, file }))
      if (r.sharedWith && r.sharedWith.length) toast(t('edit.shared', { names: r.sharedWith.map(refName).join(', ') }), { kind: 'info', duration: 8000 })
    } catch (e) { toast(t('edit.failed', { ref: a.ref, file, msg: e.message }), { kind: 'fail' }) }
  }
  // What the login does, whichever directory: the browser, signing in, the email, a new account like it.
  function loginItems(a) {
    return [
      browserFor(a) ? { icon: 'globe', label: t('br.open'), disabled: Boolean(ui.browserRef), run: () => openBrowserDialog(a) } : null,
      a.kind !== 'api' && !BOOT.readOnly ? { icon: 'terminal', label: t('menu.signIn'), run: () => signIn(a) } : null,
      a.kind !== 'api' ? { icon: 'key', label: t('menu.copyLogin'), hint: 'sideby login ' + a.ref, run: () => copyText('sideby login ' + a.ref) } : null,
      keyable(a) ? { icon: 'key', label: t('menu.enterKey'), run: () => openKey(a) } : null,
      a.identity && a.identity.email ? { icon: 'mail', label: t('menu.copyEmail'), hint: emailText(a.identity.email), run: () => copyText(a.identity.email) } : null,
    ]
  }
  function likeItem(a) { return BOOT.readOnly ? null : { icon: 'userPlus', label: t('menu.like'), run: () => openCreate({ family: a.family, api: a.kind === 'api' }) } }
  // Grouped by what the user wants to do: open, copy, manage.
  function accountMenu(a, anchor) {
    const [browser, signInItem, login, key, email] = loginItems(a)
    const opens = [deskItem(a), browser].filter(Boolean)
    const copies = dirCopies(a)
    const items = [pinItem(a),
      opens.length ? '-' : null, opens.length ? { header: t('menu.groupOpen') } : null, ...opens,
      '-', { header: t('menu.groupCopy') }, ...copies, login, email,
      '-', { header: t('menu.groupManage') }, signInItem, key, ...dirTools(a), likeItem(a)]
    openMenu(anchor, items, t('menu.label', { ref: a.ref }))
  }
  // A Same Login row (ADR-0026): pin first, then a section per directory, then what the login shares.
  function loginMenu(ms, anchor) {
    const items = [pinItem(ms[0])]
    for (const m of ms) items.push('-', { header: m.name + ((m.aliases || []).length ? ' · ' + m.aliases[0] : '') }, ...dirItems(m), ...dirTools(m))
    items.push('-', ...loginItems(ms[0]), likeItem(ms[0]))
    openMenu(anchor, items, t('login.label', { names: ms.map((m) => m.name).join(', ') }))
  }
  function loginMoreButton(ms) {
    const b = h('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': t('login.label', { names: ms.map((m) => m.name).join(', ') }), title: t('menu.title') }, icon('more'))
    b.addEventListener('click', () => { if (menu.anchor === b) closeMenu(); else loginMenu(ms, b) })
    return b
  }
  // The most used action, on the row itself: copy the command that starts this account (its short command when it
  // has one, which is shorter to type).
  function runButton(a) {
    const cmd = (a.aliases || [])[0] || 'sideby run ' + a.ref
    const text = t('row.copyRun', { cmd })
    return h('button', { class: 'icon-btn row-run', type: 'button', 'aria-label': text, title: text, onclick: (e) => { e.stopPropagation(); copyText(cmd) } }, icon('terminal'))
  }
  // A pinned row (spec §3.25, §3.27) says so with a small muted pin right before its name, and nothing at its end;
  // pinning and unpinning are in the row's menu and in the arrange mode.
  function pinMark(a) {
    return isPinned(a) ? h('span', { class: 'pin-mark', role: 'img', title: t('pin.mark'), 'aria-label': t('pin.mark') }, icon('pin')) : null
  }
  // Before the name (spec §3.27, 2026-10-18): a pinned row always shows its pin, and a click unpins it; any other
  // row shows a fainter pin in the same place on hover or keyboard focus, and a click pins it. The slot keeps its
  // width when empty, so the name never moves. A read-only Panel shows only the mark.
  function pinSlot(a) {
    if (BOOT.readOnly) return pinMark(a)
    const on = isPinned(a)
    const label = t(on ? 'pin.unpin' : 'pin.pin')
    return h('button', { class: 'pin-slot' + (on ? ' is-on' : ''), type: 'button', 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); togglePin(a) } }, icon('pin'))
  }
  function pinItem(a) {
    if (BOOT.readOnly) return null
    const on = isPinned(a)
    const full = !on && pinnedUnits(a.family) >= PIN_MAX
    return { icon: 'pin', label: full ? t('pin.full', { n: PIN_MAX }) : t(on ? 'pin.unpin' : 'pin.pin'), disabled: full, run: () => togglePin(a) }
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
  // One line on why an Account needs a look, such as "7d at 62% (warns from 60%)".
  function whyOf(a, now) {
    const m = attentionWhy(a, healthOf(a.ref), now, WARN)
    if (m && m.key === 'why.not-installed' && family(a.family).brokenBin) return t('why.broken')
    return m ? t(m.key, m.vars && m.vars.label ? Object.assign({}, m.vars, { label: winTitle(m.vars.label) }) : m.vars) : ''
  }
  function setupFor(fam) { return S.state && S.state.quotaSetups.find((s) => s.family === fam) }

  // ---------- header and summary ----------
  function renderUpdated() {
    const busy = S.loading && !S.silent
    const every = Math.round((S.fastUntil > Date.now() ? FAST_MS : AUTO_MS) / 1000)
    const text = S.loading && !S.state ? t('top.loading') : busy ? t('top.refreshing') : S.loadedAt ? t('top.updated', { ago: agoShort(Date.now() - S.loadedAt), s: every }) : ''
    const el = $('updated')
    if (el.textContent !== text) el.textContent = text
    // A dot says whether the numbers are live: green while they refresh on their own, amber when they stopped.
    const stale = conn.lost || Boolean(S.loadError)
    el.classList.toggle('is-live', Boolean(S.loadedAt) && !stale)
    el.classList.toggle('is-stale', Boolean(S.loadedAt) && stale)
    el.title = !S.loadedAt ? '' : (stale ? t('top.stale') + ' ' : '') + t('top.updatedTitle', { at: clock(new Date(S.loadedAt).toISOString()), s: Math.round((S.fastUntil > Date.now() ? FAST_MS : AUTO_MS) / 1000) })
  }
  function renderTop() {
    renderUpdated()
    renderSettingsButton()
    renderUpdateButton()
    const u = updState()
    $('foot-text').textContent = t(u && !u.checksOff ? 'foot.textChecks' : 'foot.text')
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
    $('ask-ai').setAttribute('aria-label', t('ask.button'))
    const repo = $('repo')
    for (const k of ['aria-label', 'title']) repo.setAttribute(k, t('top.repo'))
    if (/^https:\/\/github\.com\//.test(BOOT.repoUrl || '')) { repo.href = BOOT.repoUrl; repo.hidden = false }
    renderSettingsButton()
  }
  function applyTheme() {
    if (BOOT.colorScheme !== 'auto') return
    const theme = viewPrefs().theme
    if (theme === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', theme)
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
        // Every day keeps its slot; an empty day shows only a short stub on the baseline, so it reads as a gap in time.
        return h('i', { class: (i === daily.length - 1 ? 'today' : '') + (v ? '' : ' zero') || null, title: day + ': ' + tokens(v) },
          h('b', { css: { height: v && max ? Math.max(10, Math.round((v / max) * 100)) + '%' : null } }))
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
    // Who needs a look, by name: counting reasons beside a count of accounts made numbers that did not add up.
    const needing = list.filter((a) => reasonsOf(a, now).length)
    const needSub = need ? t(needing.length > 2 ? 'stat.needWhoMore' : 'stat.needWho', { names: needing.slice(0, 2).map((a) => a.ref).join(' · '), n: needing.length - 2 }) : t('stat.allClear')
    const needTitle = need ? order.filter((r) => counts[r]).map((r) => tn('need.' + r, counts[r])).join(' · ') : null
    const usages = list.filter((a) => a.usage && a.usage.status === 'ok')
    const total = usages.reduce((s, a) => s + (Number(a.usage.totalTokens) || 0), 0)
    const sessions = usages.reduce((s, a) => s + (Number(a.usage.sessions) || 0), 0)
    const daily = mergeDaily(usages.map((a) => a.usage.daily)).slice(-BOOT.usageDays)
    const nr = nextReset(list, now)
    patch(box, [
      stat(t('stat.accounts'), String(list.length), dots([tn('stat.families', famCount), apiCount ? tn('stat.api', apiCount) : null])),
      need
        ? stat(t('stat.attention'), String(need), needSub, h('span', { class: 'stat-act' }, t(ui.attention ? 'stat.attentionOff' : 'stat.attentionOn')), { cls: 'stat-warn', pressed: ui.attention, title: [needTitle, t(ui.attention ? 'stat.attentionOff' : 'stat.attentionOn')].join('\n'), onclick: () => { ui.attention = !ui.attention; renderSummary(); renderAccounts() } })
        : stat(t('stat.attention'), '0', needSub, null, { cls: 'stat-ok' }),
      stat(t('stat.tokens', { n: BOOT.usageDays }), tokens(total), tn('stat.sessions', sessions), spark(daily, 'spark-lg')),
      stat(h('span', { class: 'label-tip' }, t('stat.nextReset'), tip('age')),
        nr ? t('time.in', { d: formatDuration(nr.at - now, lang) }) : '—',
        nr ? dots([h('span', { class: 'mono' }, nr.ref), winTitle(nr.label), clock(new Date(nr.at).toISOString())]) : t('stat.noQuota')),
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
    // "Arrange order…" is not a sort: it opens the arrange mode (spec §3.25), and the sort shows "my order".
    tb.sort = h('select', { class: 'tb-select', 'aria-label': t('tb.sort') },
      CHOICES.sort.map((v) => h('option', { value: v }, t('sort.' + v))),
      BOOT.readOnly ? null : h('option', { value: 'arrange' }, t('sort.arrange')))
    tb.sort.value = prefs.sort
    tb.sort.addEventListener('change', () => {
      const v = tb.sort.value
      // "My order" before any order of one's own would show nothing new: it opens the arrange mode instead.
      if (v === 'arrange' || (v === 'manual' && !ordered() && !BOOT.readOnly)) { startArrange(); return }
      if (ui.arrange) endArrange()
      prefs.sort = v
      savePrefs()
      renderAccounts()
    })
    const display = h('button', { class: 'btn tb-display', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: t('tb.display') }, icon('sliders'), h('span', null, t('tb.display')))
    display.addEventListener('click', () => openPopover(display, 'display', t('tb.display'), displayPanel, 'end'))
    const create = BOOT.readOnly ? null : h('button', { class: 'btn btn-primary', type: 'button', 'aria-label': t('tb.new'), title: t('tb.new'), onclick: () => openCreate(null) }, icon('plus'), h('span', null, t('tb.new')))
    setKids($('toolbar'), [
      h('label', { class: 'search' }, icon('search', 'search-ic'), tb.search, h('kbd', { class: 'kbd', 'aria-hidden': 'true' }, '/')),
      h('div', { class: 'tools' }, tb.family, tb.sort, display),
      create,
    ])
    renderFamilyFilter()
    if (hadFocus) tb.search.focus()
  }
  // "Display": the view settings people change rarely, one popover instead of three buttons in the toolbar.
  // "Hide emails" shows once any account has one.
  function displayPanel() {
    const redo = () => { savePrefs(); renderAccounts(); refreshPopover('display') }
    const emails = S.state && S.state.accounts.some((a) => a.identity && a.identity.email)
    return h('div', { class: 'display-panel' },
      h('div', { class: 'dp-row' }, h('span', { class: 'dp-label' }, t('tb.quota')),
        seg(t('tb.quota'), [['used', t('tb.used')], ['left', t('tb.left')]], prefs.quota, (v) => { prefs.quota = v; redo() })),
      h('div', { class: 'dp-row' }, h('span', { class: 'dp-label' }, t('tb.view')),
        seg(t('tb.view'), [['list', [icon('list'), h('span', null, t('tb.list'))], t('tb.list')], ['cards', [icon('grid'), h('span', null, t('tb.cards'))], t('tb.cards')]], prefs.view, (v) => { prefs.view = v; ui.fade = true; redo() })),
      emails ? h('label', { class: 'dp-row dp-check' },
        h('input', { type: 'checkbox', checked: prefs.hideEmail, onchange: (e) => { prefs.hideEmail = e.target.checked; redo() } }),
        h('span', null, t('tb.hideEmails'))) : null)
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
  // A window's column: the models it covers when it covers only some (Cursor's "Other models"), else its length.
  function winKey(w) { return w.name || w.label }
  // The words for a window in labels (5-hour, weekly) instead of 5h and 7d; other labels as they are.
  function winTitle(k) { return k === '5h' || k === '7d' ? t('win.' + k) : k }
  // One group's columns: the windows its accounts report, shortest first; 5h and 7d when none reports any yet.
  function quotaColumns(list) {
    const mins = {}
    for (const a of list)
      if (a.quota && a.quota.status === 'ok')
        for (const w of a.quota.windows || []) if (!Object.hasOwn(mins, winKey(w))) mins[winKey(w)] = (Number(w.windowMinutes) || 0) + (w.name ? -0.5 : 0)
    if (!Object.keys(mins).length) Object.assign(mins, KNOWN_WINDOWS)
    return Object.keys(mins).sort((x, y) => mins[x] - mins[y]).slice(0, 4)
  }
  // A window's cell: percent and countdown on one line, the bar under them. The label shows where no column
  // header does (cards, narrow screens).
  function meter(w, now, stale, observedAt) {
    const st = windowState(w, now, WARN, FAIL)
    const passed = passedWindow(w, observedAt, now)
    const left = prefs.quota === 'left'
    const shown = left ? 100 - st.pct : st.pct
    const asOf = stale ? t('quota.asOf', { ago: ago(observedAt) }) : ''
    const reset = passed ? t('quota.resetShort') : t('quota.resetsIn', { d: formatDuration(Date.parse(w.resetsAt) - now, lang) })
    const title = [passed ? t('quota.resetNoData', { date: day(passed.since) }) : t('quota.resetsAt', { at: clock(w.resetsAt) }), asOf].filter(Boolean).join(' · ')
    return h('div', { class: 'meter lvl-' + st.level + (stale || passed ? ' lvl-stale' : ''), title },
      h('div', { class: 'm-top' },
        h('span', { class: 'm-label' }, winTitle(winKey(w))),
        h('span', { class: 'm-pct' }, shown + '%', h('span', { class: 'm-unit' }, ' ' + t(left ? 'quota.unitLeft' : 'quota.unitUsed')),
          null),
        h('span', { class: 'm-reset' + (passed ? ' m-passed' : '') }, Number.isFinite(Date.parse(w.resetsAt)) || passed ? reset : '?')),
      h('div', { class: 'bar', role: 'meter', 'aria-label': t(left ? 'quota.meterLeft' : 'quota.meterUsed', { label: winTitle(winKey(w)) }), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown), 'aria-valuetext': t(left ? 'quota.pctLeft' : 'quota.pctUsed', { n: shown }) }, h('span', { css: { width: shown + '%' } })))
  }
  // A column whose window this account does not report right now, such as a 5h window that has not started.
  function noMeter(label) {
    return h('div', { class: 'meter meter-none', title: t('quota.missing', { label }) },
      h('div', { class: 'm-top' }, h('span', { class: 'm-label' }, label), h('span', { class: 'm-none', 'aria-label': t('quota.missing', { label }) }, '—')))
  }
  function quotaNote(a, q) {
    const setup = setupFor(a.family)
    // One setup turns quota on for every account of the Family, so the switch lives in the group header only.
    // A check that asks the Host (Grok) and is turned off, or failed (spec §3.26): say why and what to do.
    if (q.reason === 'fetch-failed') return h('div', { class: 'q-note q-off' }, h('span', { class: 'muted' }, t('quota.fetchFailed')), tipRaw(t('quota.fetchFailed'), q.detail || ''), askWhy(a, q))
    if (q.reason === 'not-enabled' && checkOf(a.family)) return h('div', { class: 'q-note q-off' }, h('span', { class: 'muted' }, t('quota.checkOff')), tipRaw(t('quota.checkOff'), q.detail || t('quota.checkOffHint')))
    if (q.reason === 'not-enabled') {
      const host = famTitle(a)
      const body = setup && setup.plan.status === 'ready' && !BOOT.readOnly ? t('tip.quotaOff.body', { host })
        : setup && setup.plan.status === 'blocked' ? setup.plan.message
          : t('tip.quotaOff.cli', { host, family: a.family })
      return h('div', { class: 'q-note q-off' }, h('span', { class: 'muted' }, t('quota.off')), tipRaw(t('tip.quotaOff.term'), body))
    }
    if (q.reason === 'api-account') return h('div', { class: 'q-note' }, t('quota.api'), tip('api'))
    const text = { 'no-session': 'quota.noSession', 'no-source': 'quota.noSource', unrecognized: 'quota.unrecognized' }[q.reason]
    return h('div', { class: 'q-note', title: q.reason === 'no-session' ? t('quota.noSessionHint') : q.detail || null }, text ? t(text) : t('quota.unavailable', { reason: q.reason }), askWhy(a, q))
  }
  // "Ask AI why" in a quota cell with no data or an error (spec §3.28).
  function askWhy(a, q) {
    if (!quotaAskable(q.reason)) return null
    return h('button', { class: 'link-btn small q-ask', type: 'button', onclick: (e) => { e.stopPropagation(); openAsk({ task: 'quota', context: { account: a.ref, family: a.family, quotaReason: q.reason + (q.detail ? ': ' + q.detail : ''), version: BOOT.version } }) } }, t('ask.quotaWhy'))
  }
  function quotaBlock(a, now, cols) {
    const q = a.quota
    if (!q) return h('div', { class: 'quota' }, h('div', { class: 'q-note' }, '—'))
    if (q.status !== 'ok') return h('div', { class: 'quota' }, quotaNote(a, q))
    const stale = isStale(q.observedAt, now)
    const wins = q.windows || []
    // A reading borrowed from another Account of the same login says where it came from (spec §3.21).
    const from = q.from ? t('quota.sharedFrom', { name: refName(q.from), ago: ago(q.observedAt) }) : null
    // Where the numbers came from when the Host was asked (spec §3.26), and why the latest ask failed.
    const via = q.fetched ? t('quota.fetchedFrom', { host: famTitle(a), ago: ago(q.observedAt) }) : null
    const failed = q.fetchError ? t('quota.lastCheckFailed', { why: q.fetchError }) : null
    const title = [from || via || (stale ? null : t('quota.dataFrom', { ago: ago(q.observedAt) })), failed].filter(Boolean).join('\n') || null
    // --qr: this row's own number of windows, so a narrow list can split the width between them alone (--qn is the
    // widest Family's, for the wide list's shared columns).
    return h('div', { class: 'quota' + (stale ? ' is-stale' : ''), title, css: wins.length ? { '--qr': String(cols.length) } : null },
      wins.length ? cols.map((c) => {
        const w = wins.find((x) => winKey(x) === c)
        return w ? meter(w, now, stale, q.observedAt) : noMeter(winTitle(c))
      }) : h('div', { class: 'q-note' }, t('quota.noWindows')),
      // Old numbers keep their colours and say their age once, under the bars.
      stale && wins.length ? h('div', { class: 'q-asof', title: t('quota.asOf', { ago: ago(q.observedAt) }) }, icon('clock'), t('quota.staleShort', { ago: agoShort(now - Date.parse(q.observedAt)) })) : null)
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
      h('div', { class: 'u-text' },
        h('span', { class: 'u-num' }, tokens(u.totalTokens), h('span', { class: 'u-unit' }, ' ' + t('usage.tokens'))),
        h('div', { class: 'u-sub' }, rate === null ? tn('usage.sessions', u.sessions) : t('usage.cache', { n: Math.round(rate * 100) }))),
      u.totalTokens ? spark(u.daily) : null)
  }
  function lastUsed(a, cls = 'last') {
    const at = a.usage && a.usage.status === 'ok' && a.usage.lastActivityAt
    return h('div', { class: cls, title: at ? t('last.title', { at: clock(at) }) : t('last.unknown') }, at ? ago(at) : h('span', { class: 'faint' }, '—'))
  }
  // The line under a row's name, with a copy of the last use at its end: the medium-width list shows that copy
  // instead of the column (the styles show one of the two), so the time stays next to the account it belongs to.
  function metaLine(line, a) {
    return h('div', { class: 'ident-meta' }, line, lastUsed(a, 'last-inline'))
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
  // Who the attention words speak about. Inside a login group the quota warning is the first row's, so another
  // row's word is only about the row itself.
  function attentionSubject(a) {
    const lead = loginLead(a)
    return !lead ? a
      : lead !== a.ref ? Object.assign({}, a, { quota: undefined })
        : Object.assign({}, a, { quota: a.quota && Object.assign({}, a.quota, { from: undefined }) })
  }
  // A word, not only a colour (spec §3.8): what kind of look the account needs; the reason is on hover.
  function attentionWord(subject, reason) {
    const lvl = reason === 'health-fail' ? 'fail' : 'warn'
    const why = whyOf(subject, Date.now())
    const word = reason === 'health-fail' ? t('att.fix') : reason === 'quota-high' ? t('att.quota') : t('att.check')
    return h('span', { class: 'tag tag-' + lvl + ' att-tag', title: why, 'aria-label': why }, h('span', { class: 'dot dot-' + lvl, 'aria-hidden': 'true' }), word)
  }
  // The word a directory inside a Same Login's details shows when it needs a fix or a look.
  function attentionDot(a) {
    const subject = attentionSubject(a)
    const r = reasonsOf(subject, Date.now())
    const reason = ['health-fail', 'quota-high', 'health-warn'].find((x) => r.includes(x))
    return reason ? attentionWord(subject, reason) : null
  }
  // The one status badge after the name (spec §3.27): needs a fix, running low, the other attention words, then
  // recommended, then API. The rest is in the details or on hover.
  function statusBadge(a, members) {
    const subject = attentionSubject(a)
    const next = members ? members.some(isNext) : isNext(a)
    const k = rowBadge(reasonsOf(subject, Date.now()), { next, api: a.kind === 'api' })
    if (k === 'health-fail' || k === 'quota-high' || k === 'health-warn') return attentionWord(subject, k)
    if (k === 'signed-out')
      return h('button', { class: 'tag tag-fail tag-btn', type: 'button', title: t('acct.signInHint'), 'aria-label': t('acct.signedOutLabel', { ref: a.ref }), onclick: (e) => { e.stopPropagation(); signIn(a) } }, h('span', { class: 'dot dot-fail', 'aria-hidden': 'true' }), t('acct.signedOut'))
    if (k === 'not-installed') return h('span', { class: 'tag tag-warn' }, t(family(a.family).brokenBin ? 'acct.broken' : 'acct.notInstalled'))
    if (k === 'next') return nextTag(a)
    if (k === 'api') return h('span', { class: 'tag tag-warn', title: t('tip.api.body') }, t('acct.api'))
    return null
  }
  // The short command, as quiet text after the name; every alias and its arguments are on hover.
  function aliasText(a) {
    const all = a.aliases || []
    if (!all.length) return null
    const lines = all.map((x) => { const args = aliasArgsOf(a, x); return x + ' · ' + (args ? t('acct.aliasArgs', { args: args.join(' ') }) : t('acct.alias')) })
    return h('span', { class: 'alias', title: lines.join('\n') }, all[0])
  }
  // A Same Login row (spec §3.21) gets a link mark after the name; what it means is on hover.
  function loginMark(members) {
    if (!members || members.length < 2) return null
    const text = t('login.label', { names: members.map((m) => m.name).join(', ') }) + '\n' + t('login.explain')
    return h('span', { class: 'login-mark', role: 'img', title: text, 'aria-label': text }, icon('link'))
  }
  // members: the directories of a Same Login shown as this one row (spec §3.21).
  function nameLine(a, members) {
    return h('div', { class: 'ident-name' },
      pinSlot(a),
      h('span', { class: 'name', title: a.name }, a.name),
      loginMark(members),
      aliasText(a),
      statusBadge(a, members))
  }
  // An organization name as the vendor wrote it, without a trailing comma or full stop it sometimes carries.
  function orgText(org) { return org ? String(org).replace(/[\s,，;；、。]+$/u, '') : '' }
  // The name part of a ref (claude:001 gives 001), as rows show other Accounts of the same Family.
  function refName(ref) { return String(ref).slice(String(ref).indexOf(':') + 1) }
  // Who the account is signed in as, under its name, in full unless the cell is too narrow; masked while "Hide
  // emails" is on. The Browser Sign-in is in the details (spec §3.27).
  function emailLine(a) {
    const id = a.identity
    if (!id || !id.email) return null
    const email = emailText(id.email)
    const full = [email, orgText(id.org)].filter(Boolean).join(' · ')
    return h('div', { class: 'ident-email', title: full },
      h('button', { class: 'email email-btn', type: 'button', title: full + '\n' + t('menu.copyEmail'), 'aria-label': t('menu.copyEmail') + ' ' + email, onclick: (e) => { e.stopPropagation(); copyText(id.email) } }, email))
  }
  // The Browser Sign-in as a line of the details: which Chrome browser user signed in to the account's website.
  function browserItem(a) {
    const b = browserButton(a)
    return b ? h('div', { class: 'rd-item rd-browser' }, h('span', { class: 'rd-label' }, t('row.browser')), b) : null
  }
  function subLine(a) {
    const plan = a.quota && a.quota.status === 'ok' && a.quota.plan
    return h('div', { class: 'ident-sub' }, dots([
      h('span', { class: 'mono' }, a.ref),
      a.kind === 'api' && a.model ? h('span', { class: 'mono', title: t('acct.model') }, a.model) : null,
      a.kind !== 'api' ? modelChip(a) : null,
      a.kind !== 'api' && plan ? h('span', { class: 'plan' }, plan) : null,
    ]))
  }
  async function openDesktop(a) {
    if (ui.desktopRef) return
    ui.desktopRef = a.ref
    renderAccounts()
    try {
      const r = await api('/api/account/desktop', { account: a.ref })
      const text = r.action === 'started' ? t('desk.started', { app: r.app, ref: r.ref }) : r.action === 'focused' ? t('desk.focused', { app: r.app, ref: r.ref }) : ''
      if (text) toast(text)
      // Notices say what to do next (sign in, close other windows while signing in); they stay a little longer.
      for (const n of r.notices || []) toast(n, { kind: 'info', duration: 12000 })
    } catch (e) { toast(t('desk.failed', { ref: a.ref, msg: e.message }), { kind: 'fail' }) }
    ui.desktopRef = null
    renderAccounts()
    load({ silent: true })
  }
  // Browser Sign-ins (spec §3.24): which Chrome browser user signed in to the account's website, read on this
  // computer only. Off: the button explains what turning it on reads. On: it names the browser user, and opens it.
  const BR_URL = { claude: 'claude.ai', codex: 'chatgpt.com', grok: 'grok.com' }
  function browserInfo() { return S.state && S.state.browser }
  function browserFor(a) {
    const b = browserInfo()
    if (!b || a.kind === 'api' || BOOT.readOnly) return null
    if (!b.families.matched.includes(a.family) && !b.families.openOnly.includes(a.family)) return null
    return { b, found: b.enabled ? b.profiles.filter((p) => p.signIns.includes(a.ref)) : [] }
  }
  // A browser user's name may be an email; it hides with the others.
  function profileName(name) { return String(name).includes('@') ? emailText(name) : name }
  // A browser user shows as the Google account it uses in Chrome, else its name. Two that would show the same get
  // their folder after it.
  function profileLabel(p) {
    const b = browserInfo()
    const full = (b && b.profiles.find((o) => o.dir === p.dir)) || p
    const key = (x) => x.email || x.name
    const twin = b && b.profiles.some((o) => o.dir !== full.dir && key(o) === key(full))
    return (full.email ? emailText(full.email) : profileName(full.name)) + (twin ? ' (' + full.dir + ')' : '')
  }
  function browserButton(a) {
    const info = browserFor(a)
    if (!info) return null
    const busy = ui.browserRef === a.ref
    const first = info.found[0]
    if (!first) return null
    const label = t(info.found.length > 1 ? 'br.signedInMore' : 'br.signedIn', { name: profileLabel(first), n: info.found.length })
    return h('button', { class: 'email-btn br-btn', type: 'button', disabled: busy, title: t('br.hint', { url: BR_URL[a.family], ref: a.ref }), 'aria-label': 'Chrome ' + label + ' (' + a.ref + ')', onclick: (e) => { e.stopPropagation(); if (info.found.length === 1) openBrowser(a, first); else openBrowserDialog(a) } },
      busy ? spinner() : icon('globe', 'br-ico'), label)
  }
  async function openBrowser(a, p) {
    if (ui.browserRef) return
    ui.browserRef = a.ref
    renderAccounts()
    if (dlg.kind === 'browser') renderBrowser()
    try {
      const r = await api('/api/browser/open', { account: a.ref, profile: p.dir })
      toast(t('br.opened', { url: r.url.replace(/^https:\/\//, ''), name: profileLabel(r.profile) }))
      if (dlg.kind === 'browser') dlg.el.close()
    } catch (e) { toast(t('br.failed', { ref: a.ref, msg: e.message }), { kind: 'fail' }) }
    ui.browserRef = null
    renderAccounts()
    if (dlg.kind === 'browser') renderBrowser()
  }
  let br = null
  function openBrowserDialog(a) {
    br = { ref: a.ref, busy: false, error: null }
    showDialog('browser')
    // Rows skip background renders while a dialog is open; turning the finding on changes what they show.
    dlg.onClose = () => renderAccounts()
    renderBrowser()
  }
  async function brSwitch(on) {
    br.busy = true
    dlg.busy = true
    br.error = null
    renderBrowser()
    try {
      await api('/api/browser/settings', { enabled: on, confirm: true })
      toast(t(on ? 'br.enabled' : 'br.disabled'))
      await load({ silent: true })
    } catch (e) { br.error = e }
    br.busy = false
    dlg.busy = false
    if (!on && !br.error) { dlg.el.close(); return }
    renderBrowser()
  }
  function brProfileRow(a, p) {
    const busy = ui.browserRef === a.ref
    return h('li', { class: 'br-row' },
      h('span', null, h('b', null, profileName(p.name)), p.email ? h('span', { class: 'muted small' }, ' · ' + emailText(p.email)) : null, ' ', h('span', { class: 'muted small mono' }, p.dir), p.changedAt ? h('span', { class: 'muted small' }, ' · ' + t('br.changed', { when: ago(p.changedAt) })) : null),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: Boolean(ui.browserRef), 'aria-busy': busy ? 'true' : null, onclick: () => openBrowser(a, p) }, t('br.openIt')))
  }
  function renderBrowser() {
    if (!br || dlg.kind !== 'browser') return
    const a = S.state && S.state.accounts.find((x) => x.ref === br.ref)
    const info = a && browserFor(a)
    if (!info) { dlg.el.close(); return }
    const url = BR_URL[a.family]
    const body = []
    const foot = [h('button', { class: 'btn', type: 'button', disabled: br.busy, onclick: () => dlg.el.close() }, t('btn.close'))]
    if (!info.b.enabled) {
      body.push(h('p', null, t('br.offIntro', { ref: a.ref, url })))
      body.push(h('p', { class: 'small' }, t('br.reads')), h('ul', { class: 'small' }, ['br.read1', 'br.read2', 'br.read3'].map((k) => h('li', null, t(k)))))
      body.push(h('p', { class: 'muted small' }, t('br.never')))
      foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: br.busy, 'aria-busy': br.busy ? 'true' : null, onclick: () => brSwitch(true) }, br.busy ? spinner() : null, t('br.enable')))
    } else if (!info.b.found) {
      body.push(h('p', { class: 'note' }, t('br.noChrome')))
    } else {
      const others = info.b.profiles.filter((p) => !info.found.includes(p))
      if (info.found.length) body.push(h('p', { class: 'small' }, t('br.found', { ref: a.ref })), h('ul', { class: 'br-list' }, info.found.map((p) => brProfileRow(a, p))))
      else body.push(h('p', { class: 'muted small' }, t(info.b.families.matched.includes(a.family) ? 'br.none' : 'br.noMatch', { ref: a.ref, url })))
      if (others.length) body.push(h('p', { class: 'small' }, t(info.found.length ? 'br.others' : 'br.all')), h('ul', { class: 'br-list' }, others.map((p) => brProfileRow(a, p))))
      body.push(h('p', { class: 'muted small' }, t('br.local')))
      foot.unshift(h('button', { class: 'btn', type: 'button', disabled: br.busy, onclick: () => brSwitch(false) }, t('br.disable')))
    }
    if (br.error) body.push(errorNote(br.error, null))
    setKids(dlg.el, dialogFrame(t('br.title') + ' · ' + a.ref, a.family, body, foot))
  }
  // How to get a Host that cannot run: the sentence, then on its own line the install command to copy (with the
  // install page next to it) when the Family has one; without a command the sentence ends with the page's link.
  function hostNote(fam) {
    const cmdLine = () => h('div', { class: 'note-line note-cmd' }, codeCopy(fam.installCommand), link(t('acct.installDocs'), fam.installUrl))
    if (fam.brokenBin) {
      const text = tx('acct.brokenHost', { host: fam.title, path: h('code', null, fam.brokenBin) })
      return fam.installCommand ? [h('div', { class: 'note-line' }, text), cmdLine()] : [h('div', { class: 'note-line' }, text, ' ', link(t('acct.installIt'), fam.installUrl) || '')]
    }
    if (fam.installCommand) return [h('div', { class: 'note-line' }, tx('acct.installHostCmd', { host: fam.title })), cmdLine()]
    return tx('acct.installHost', { host: fam.title, link: link(t('acct.installIt'), fam.installUrl) || '' })
  }
  function notes(a) {
    const fam = family(a.family)
    const out = []
    if (a.error) out.push(h('div', { class: 'note note-fail' }, h('b', null, t('acct.readError')), ' ', h('span', null, a.error)))
    if (a.hostInstalled === false) out.push(h('div', { class: 'note note-warn' }, hostNote(fam)))
    return out.length ? h('div', { class: 'row-notes' }, out) : null
  }
  // What a row or card shows depends on more than the account (health, view preferences, language); the
  // fingerprint covers what its click handlers use.
  function rowSig(a) { return sig([a, healthOf(a.ref), isNext(a), ui.desktopRef === a.ref, ui.browserRef === a.ref, browserFor(a), prefs.hideEmail, isOpen(a), loginLead(a), isPinned(a)]) }
  // Whether the row sits in a login group (spec §3.21): its first row then shows the quota for all of them.
  function inLogin(a) { return ui.loginRefs.has(a.ref) }
  // The group's first row, which shows the quota for all of them.
  function loginLead(a) { return ui.loginRefs.get(a.ref) || null }
  // A row shows who the account is, its quota and its last use; a click opens the details under it (model, tokens,
  // Health) and closes them again. The choice is kept in this browser's preferences.
  function isOpen(a) { return prefs.open[a.ref] === true }
  function rowToggle(a) {
    const open = isOpen(a)
    const label = t(open ? 'row.collapse' : 'row.expand', { name: a.name })
    return h('button', { class: 'icon-btn row-toggle', type: 'button', 'aria-expanded': String(open), 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); toggleRow(a) } }, icon('chevron', 'chev'))
  }
  // The whole account cell (and a folded row anywhere) folds and opens it, not only the arrow; the buttons and links
  // inside keep their own action, and a click that ends a text selection does nothing.
  // A click folds the row unless it ended a drag that selects text; a selection left from before does not block it.
  let downAt = null
  document.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY } }, true)
  // A double click would select a word under the pointer as well as fold the row twice; keep the word unselected.
  document.addEventListener('mousedown', (e) => {
    if (e.detail > 1 && e.target.closest && e.target.closest('.fold-hit') && !e.target.closest('input, select, textarea')) e.preventDefault()
  })
  function foldClick(a) { return foldHit(() => toggleRow(a)) }
  function foldHit(run) {
    return (e) => {
      if (foldSkips(e.target)) return
      const dragged = downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4
      if (dragged && window.getSelection && String(window.getSelection())) return
      run()
    }
  }
  // Folding animates: the height eases while the details fade and the arrow turns. A click during the motion turns
  // it around from where it is. Reduced motion just switches.
  const EASE = 'cubic-bezier(.2, 0, 0, 1)'
  const FOLD_MS = 220
  const folding = new Set()
  function rowDetails(el) { return Array.from(el.querySelectorAll(':scope > .row-detail')) }
  function moving() { return !(REDUCED || document.hidden || !Element.prototype.animate) }
  // Eases el's height from 'from' to its current height (measured with the 'hide' parts out of the layout),
  // fading 'parts' toward 'opacity'; 'done' runs at the end unless a newer fold took over.
  function ease(el, from, hide, parts, opacity, done) {
    const run = el._fold
    const fades = parts.map((p) => +getComputedStyle(p).opacity)
    if (run) run.cancel()
    for (const p of hide) p.style.display = 'none'
    const to = el.getBoundingClientRect().height
    for (const p of hide) p.style.display = ''
    el.style.overflow = 'hidden'
    const anims = [el.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: FOLD_MS, easing: EASE })]
    parts.forEach((p, i) => anims.push(p.animate([{ opacity: fades[i] }, { opacity }], { duration: FOLD_MS, easing: 'ease-out', fill: 'forwards' })))
    const me = { cancel: () => { for (const x of anims) x.cancel() } }
    el._fold = me
    folding.add(el)
    anims[0].finished.then(() => {
      if (el._fold !== me) return
      el._fold = null
      folding.delete(el)
      el.style.overflow = ''
      me.cancel()
      done()
    }, () => {})
  }
  // A row folds in place: only its arrow, class and details change, so the rest of the list is left alone.
  function toggleRow(a) {
    const open = !isOpen(a)
    if (open) prefs.open[a.ref] = true; else delete prefs.open[a.ref]
    savePrefs()
    const el = document.querySelector('#accounts [data-ref="' + CSS.escape(a.ref) + '"]')
    if (!el) { renderAccounts(); return }
    const from = el.getBoundingClientRect().height
    const btn = el.querySelector('.row-toggle')
    if (btn) syncAttrs(btn, rowToggle(a))
    el.classList.toggle('row-open', open)
    // A Same Login row (ADR-0026) opens onto its directories.
    const ms = el.classList.contains('row-login') ? loginMembers(S.state.accounts.filter((x) => ui.loginRefs.get(x.ref) === a.ref)) : null
    el.dataset.sig = ms ? sig(ms.map(rowSig)) : rowSig(a)
    let detail = rowDetails(el)[0]
    if (open && !detail) {
      detail = ms ? loginDetail(ms) : rowDetail(a, Boolean(emailLine(a)))
      const more = el.querySelector(':scope > .row-end')
      el.insertBefore(detail, more ? more.nextSibling : null)
      detail.style.opacity = '0'
    }
    if (!detail) return
    if (!moving()) { if (!open) detail.remove(); return }
    ease(el, from, open ? [] : [detail], [detail], open ? 1 : 0, () => { if (!open) detail.remove() })
    detail.style.opacity = ''
  }
  function groupParts(el) { return Array.from(el.querySelectorAll(':scope > :not(.group-head)')) }
  // A group closes on the page as it is and renders when the motion ends; it opens by rendering its body first.
  function toggleGroup(key, domKey) {
    const find = () => document.querySelector('#accounts > [data-key="' + CSS.escape(domKey) + '"]')
    const el = find()
    const btn = el && el.querySelector('.group-head .group-toggle')
    const open = btn ? btn.getAttribute('aria-expanded') !== 'true' : prefs.collapsed[key] === true
    if (open) delete prefs.collapsed[key]; else prefs.collapsed[key] = true
    savePrefs()
    if (!el || !moving()) { renderAccounts(); return }
    const from = el.getBoundingClientRect().height
    if (!open) {
      btn.setAttribute('aria-expanded', 'false')
      const parts = groupParts(el)
      ease(el, from, parts, parts, 0, renderAccounts)
      return
    }
    // Turned around while closing: the body is still there.
    if (el._fold) { btn.setAttribute('aria-expanded', 'true'); ease(el, from, [], groupParts(el), 1, renderAccounts); return }
    renderAccounts()
    const now = find()
    if (!now) return
    const parts = groupParts(now)
    for (const p of parts) p.style.opacity = '0'
    const chev = now.querySelector('.group-head .chev')
    if (chev) chev.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(90deg)' }], { duration: FOLD_MS, easing: EASE })
    ease(now, from, [], parts, 1, () => {})
    for (const p of parts) p.style.opacity = ''
  }
  // The Account 'sideby next <family>' would pick; the server ranks it with the CLI's rule (spec §3.13).
  // "Suggested": a click says what it means and offers the command, instead of copying without a word.
  function nextTag(a) {
    const b = h('button', { class: 'tag tag-ok tag-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: t('acct.nextWhy', { title: famTitle(a) }) }, t('acct.next'))
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      openPopover(b, 'next', t('acct.next'), () => [
        h('p', { class: 'next-why' }, t('acct.nextWhy', { title: famTitle(a) })),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { closeMenu(true); copyText('sideby next ' + a.family) } }, icon('copy'), t('acct.nextCopy')),
        h('code', { class: 'next-cmd' }, 'sideby next ' + a.family),
      ])
    })
    return b
  }
  function isNext(a) { return Boolean(S.state && S.state.handoff && S.state.handoff[a.family] === a.ref) }
  function row(a, now, cols) {
    if (ui.arrange) return arrangeRow(a, [a])
    const open = isOpen(a)
    const email = emailLine(a)
    return withMenu(h('div', { class: 'row fold-hit' + (open ? ' row-open' : '') + (a.error ? ' row-error' : ''), role: 'listitem', 'data-ref': a.ref, 'data-key': a.ref, 'data-sig': rowSig(a), onclick: foldClick(a) },
      h('div', { class: 'ident' }, rowToggle(a), badge(a.family, 'sm'), h('div', { class: 'ident-text' }, nameLine(a), metaLine(email || subLine(a), a))),
      quotaBlock(a, now, cols),
      lastUsed(a),
      h('div', { class: 'row-end' }, runButton(a), moreButton(a)),
      open ? rowDetail(a, Boolean(email)) : null,
      notes(a)), (anchor) => accountMenu(a, anchor))
  }
  // What a right-click on el opens (see openContextMenu).
  function withMenu(el, open) { el.sidebyMenu = open; return el }
  // Directories signed in as one login (spec §3.21, ADR-0026) are one row: the vendor counts one quota, so the row
  // shows it once, with the email and the newest use; opening it lists each directory with its own short command,
  // last use, tokens, Health, a button that copies its start command and its own menu.
  // The directory that names a Same Login row: the one the user put first (Display Order), else the main one, else
  // the first by name.
  function loginMembers(members) {
    const order = accountOrder(members[0].family) || []
    const at = (m) => { const i = order.indexOf(m.name); return i < 0 ? Infinity : i }
    return members.slice().sort((x, y) => at(x) - at(y) || Number(Boolean(y.isMain)) - Number(Boolean(x.isMain)) || x.name.localeCompare(y.name, undefined, { numeric: true }))
  }
  // Names the row after another directory: puts it just before the current one in the Display Order.
  function showLoginAs(ms, m) {
    const before = displayOf()
    const next = copyDisplay(before)
    const names = allNames(m.family).filter((n) => n !== m.name)
    names.splice(Math.max(0, names.indexOf(ms[0].name)), 0, m.name)
    next.accounts[m.family] = names
    saveDisplay(before, next)
  }
  function newestOf(members) {
    const at = (m) => { const v = Date.parse((m.usage && m.usage.status === 'ok' && m.usage.lastActivityAt) || ''); return Number.isFinite(v) ? v : -1 }
    return members.reduce((x, y) => at(y) > at(x) ? y : x)
  }
  function loginRow(members, now, cols) {
    const ms = loginMembers(members)
    const a = ms[0]
    if (ui.arrange) return arrangeRow(a, ms)
    const open = isOpen(a)
    const email = emailLine(a)
    return withMenu(h('div', { class: 'row row-login fold-hit' + (open ? ' row-open' : '') + (a.error ? ' row-error' : ''), role: 'listitem', 'aria-label': t('login.label', { names: ms.map((m) => m.name).join(', ') }), 'data-ref': a.ref, 'data-key': loginKey(ms.map((m) => m.ref)), 'data-sig': sig(ms.map(rowSig)), onclick: foldClick(a) },
      h('div', { class: 'ident' }, rowToggle(a), badge(a.family, 'sm'), h('div', { class: 'ident-text' }, nameLine(a, ms), metaLine(email || subLine(a), newestOf(ms)))),
      quotaBlock(a, now, cols),
      lastUsed(newestOf(ms)),
      h('div', { class: 'row-end' }, runButton(a), loginMoreButton(ms)),
      open ? loginDetail(ms) : null,
      notes(a)), (anchor) => loginMenu(ms, anchor))
  }
  function loginDetail(ms) {
    return h('div', { class: 'row-detail login-detail' },
      h('p', { class: 'rd-note' }, t('login.explain')),
      browserItem(ms[0]),
      h('div', { class: 'login-dirs', role: 'list' }, ms.map((m) => {
        const run = 'sideby run ' + m.ref
        return withMenu(h('div', { class: 'login-dir', role: 'listitem', 'data-ref': m.ref },
          h('div', { class: 'ld-name' },
            h('span', { class: 'name' }, m.name),
            m.ref !== ms[0].ref ? attentionDot(m) : null,
            (m.aliases || []).slice(0, 3).map((x) => h('span', { class: 'tag tag-alias' }, x))),
          m.ref === ms[0].ref ? h('span', { class: 'tag ld-shown', title: t('login.shownHint') }, t('login.shown'))
            : BOOT.readOnly ? h('span') : h('button', { class: 'link-btn small', type: 'button', title: t('login.showAsHint', { name: m.name }), onclick: () => showLoginAs(ms, m) }, t('login.showAs')),
          lastUsed(m),
          usageBlock(m),
          healthChip(m),
          h('button', { class: 'btn btn-sm', type: 'button', title: run, onclick: () => copyText(run) }, icon('terminal'), t('login.copyRun')),
          moreButton(m)), (anchor) => accountMenu(m, anchor))
      })))
  }
  // What a click on a row opens: how it runs (ref, model and effort, a shared login), its tokens and its Health.
  function sameLoginNote(a) {
    if (!a.sameLogin || !a.sameLogin.length || inLogin(a)) return null
    const names = a.sameLogin.map(refName).join(', ')
    return h('div', { class: 'rd-note', title: t('acct.sameLoginHint', { names }) }, t('acct.sameLogin', { names }))
  }
  function rowDetail(a, withSub) {
    const same = sameLoginNote(a)
    return h('div', { class: 'row-detail' },
      withSub || same ? h('div', { class: 'rd-item rd-run' }, h('span', { class: 'rd-label' }, t('row.runs')), withSub ? subLine(a) : null, same) : null,
      browserItem(a),
      h('div', { class: 'rd-item rd-usage' }, h('span', { class: 'rd-label' }, t('col.tokens', { n: BOOT.usageDays })), usageBlock(a)),
      h('div', { class: 'rd-item rd-health' }, h('span', { class: 'rd-label' }, t('col.health')), healthChip(a)))
  }
  // A card shows everything at once; it has room for it.
  function card(a, now, cols) {
    return withMenu(h('article', { class: 'card' + (a.error ? ' card-error' : ''), 'data-ref': a.ref, 'data-key': a.ref, 'data-sig': rowSig(a), 'aria-label': a.ref },
      h('header', { class: 'card-head' },
        badge(a.family, 'sm'),
        h('div', { class: 'ident-text' }, nameLine(a), emailLine(a), subLine(a), sameLoginNote(a)),
        h('div', { class: 'row-end' }, moreButton(a))),
      notes(a),
      browserItem(a),
      quotaBlock(a, now, cols),
      h('footer', { class: 'card-foot' }, usageBlock(a), h('div', { class: 'card-side' }, lastUsed(a), healthChip(a)))), (anchor) => accountMenu(a, anchor))
  }
  // The list's column titles, once per group under its header. Screen readers get each cell's own label instead.
  function colHead(cols, list) {
    const left = prefs.quota === 'left'
    // A group where no account reports windows (no public source, quota off) keeps the columns but not their titles.
    const titled = list.some((a) => a.quota && a.quota.status === 'ok')
    return h('div', { class: 'col-head', 'aria-hidden': 'true', 'data-key': 'cols' },
      h('span', { class: 'ch-id' }, t('col.account')),
      h('span', { class: 'quota' }, titled ? cols.map((c) => h('span', null, t(left ? 'col.left' : 'col.used', { label: winTitle(c) }))) : null),
      h('span', { class: 'ch-last' }, t('col.last')),
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
  // The group's attention tag says who and why: with one Account its name and reason, and a click shows its row;
  // with more, the count, each one's reason on hover, and a click shows only them (as the summary card does).
  function attentionTag(needing, now) {
    if (needing.length === 1) {
      const a = needing[0]
      const label = a.name + ' · ' + whyOf(a, now)
      return h('button', { class: 'tag tag-warn tag-btn', type: 'button', title: t('group.attentionShow', { name: a.name }), onclick: () => flashRow(a.ref) }, label)
    }
    const list = needing.map((a) => a.name + ': ' + whyOf(a, now)).join('\n')
    return h('button', { class: 'tag tag-warn tag-btn', type: 'button', title: list, 'aria-pressed': String(ui.attention), onclick: () => { ui.attention = !ui.attention; renderSummary(); renderAccounts() } }, tn('group.attention', needing.length))
  }
  // ---------- Grok Bot windows (ADR-0019) ----------
  // Windows of an app that signs in apart from every account, so they get a group of their own after the accounts.
  // A new window gets the next free three-digit name; removing one asks inside its row first.
  const APP_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/
  // A plain bot glyph, not the grok mark: these windows are not grok (Grok Build) accounts.
  function appBadge() { return h('span', { class: 'badge badge-sm badge-logo', 'aria-hidden': 'true' }, icon('bot')) }
  function appProfiles() { return (S.state && S.state.appProfiles) || [] }
  function appId(ref) { return String(ref).slice(0, String(ref).indexOf(':')) }
  function nextAppName(list) {
    const taken = new Set(list.map((p) => p.name))
    for (let i = 1; i < 1000; i++) { const n = String(i).padStart(3, '0'); if (!taken.has(n)) return n }
    return ''
  }
  function appNameProblem(name) {
    if (!name) return t('app.nameEmpty')
    return APP_NAME.test(name) ? '' : t('app.nameBad')
  }
  function appRow(p) {
    const busy = ui.appBusy === p.ref
    const asking = ui.appRemove === p.ref
    const can = !BOOT.readOnly && p.installed
    const actions = !can ? null : asking
      ? h('div', { class: 'row-actions app-actions', role: 'group', 'aria-label': t('app.removeAsk', { ref: p.ref }) },
        h('span', { class: 'small' }, t('app.removeAsk', { ref: p.ref })),
        h('button', { class: 'btn btn-sm btn-danger', type: 'button', disabled: busy, onclick: () => removeApp(p) }, t(busy ? 'app.removing' : 'app.removeYes')),
        h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: busy, onclick: () => { ui.appRemove = null; renderAccounts() } }, t('btn.cancel')))
      : h('div', { class: 'row-actions app-actions' },
        h('button', { class: 'btn btn-sm' + (p.running ? '' : ' btn-primary'), type: 'button', disabled: Boolean(ui.appBusy), title: t(p.running ? 'app.showHint' : 'app.openHint', { app: p.app, ref: p.ref }), 'aria-label': t(p.running ? 'app.show' : 'app.openBtn') + ' (' + p.ref + ')', onclick: () => openApp(p.ref) },
          busy ? t('desk.opening', { app: p.app }) : t(p.running ? 'app.show' : 'app.openBtn')),
        p.isMain ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: p.running || Boolean(ui.appBusy), title: t(p.running ? 'app.removeRunning' : 'app.removeHint', { app: p.app }), 'aria-label': t('app.remove') + ' (' + p.ref + ')', onclick: () => { ui.appRemove = p.ref; renderAccounts() } }, t('app.remove')))
    return h('div', { class: 'app-row', role: 'listitem', 'data-ref': p.ref, 'data-key': p.ref, 'data-sig': sig([p, busy, asking, Boolean(ui.appBusy)]) },
      h('div', { class: 'ident' }, appBadge(), h('div', { class: 'ident-text' },
        h('div', { class: 'ident-name' },
          h('span', { class: 'name' }, p.isMain ? t('app.mainName') : p.name),
          p.running ? h('span', { class: 'tag tag-ok' }, h('span', { class: 'dot dot-ok', 'aria-hidden': 'true' }), t('app.isOpen')) : null,
          p.signedIn === true ? h('span', { class: 'tag', title: t('app.signedInHint') }, t('app.signedIn'))
            : p.signedIn === false ? h('span', { class: 'tag tag-warn', title: t('app.signedInHint') }, t('app.signedOut')) : null),
        h('div', { class: 'ident-sub' }, dots([h('span', { class: 'mono' }, p.ref), h('span', { class: 'muted' }, p.isMain ? t('app.mainData') : p.appData)])))),
      actions)
  }
  function appFoot(list) {
    if (BOOT.readOnly || !list[0].installed) return null
    const n = ui.appNew
    if (!n)
      return h('div', { class: 'app-foot', 'data-key': 'foot' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: Boolean(ui.appBusy), onclick: () => {
          ui.appNew = { name: nextAppName(list) }
          renderAccounts()
          const el = $('app-new-name')
          if (el) { el.focus(); el.select() }
        } }, icon('plus'), t('app.another', { app: list[0].app })),
        h('span', { class: 'muted small' }, t('app.anotherHint')))
    const input = h('input', { id: 'app-new-name', type: 'text', class: 'mono', value: n.name, maxlength: '32', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', 'aria-label': t('app.nameLabel'), 'aria-describedby': 'app-new-err' })
    const err = h('span', { id: 'app-new-err', class: 'field-error', role: 'status' })
    const go = h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: Boolean(appNameProblem(n.name)) || Boolean(ui.appBusy), onclick: () => createApp(list) }, t('app.create'))
    const sync = () => {
      n.name = input.value.trim()
      const problem = appNameProblem(n.name)
      const exists = list.some((p) => p.name === n.name)
      err.textContent = problem && input.value ? problem : exists ? t('app.exists', { ref: appId(list[0].ref) + ':' + n.name }) : ''
      err.classList.toggle('field-note', !problem && exists)
      input.classList.toggle('invalid', Boolean(problem && input.value))
      go.disabled = Boolean(problem) || Boolean(ui.appBusy)
    }
    input.addEventListener('input', sync)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !appNameProblem(n.name)) { e.preventDefault(); createApp(list) }
      if (e.key === 'Escape') { ui.appNew = null; renderAccounts() }
    })
    return h('div', { class: 'app-foot', 'data-key': 'foot-new' },
      h('label', { for: 'app-new-name', class: 'small' }, t('app.nameLabel')),
      h('div', { class: 'app-new' }, input, go, h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { ui.appNew = null; renderAccounts() } }, t('btn.cancel'))),
      err,
      h('span', { class: 'muted small' }, t('app.newHint', { app: list[0].app })))
  }
  function appGroup(list) {
    const app = list[0].app
    const id = appId(list[0].ref)
    ui.order.units[id] = list.map((p) => [p.name])
    const collapsed = prefs.collapsed['app:' + app] === true && !ui.arrange
    const bodyId = 'grp-app-' + app.replace(/[^a-zA-Z0-9_-]/g, '_')
    const head = h('div', { class: 'group-head', 'data-key': ui.arrange ? 'head-arrange' : 'head' },
      dragHandle('family', id, id, app),
      h('button', { class: 'group-toggle', type: 'button', disabled: ui.arrange ? true : undefined, 'aria-expanded': String(!collapsed), 'aria-controls': bodyId, title: t(collapsed ? 'group.expand' : 'group.collapse'), 'aria-label': t('group.toggle', { title: app, count: String(list.length), action: t(collapsed ? 'group.expand' : 'group.collapse') }), onclick: () => toggleGroup('app:' + app, 'app:' + app) },
        icon('chevron', 'chev'), appBadge(), h('span', { class: 'group-title' }, app),
        h('span', { class: 'group-count' }, String(list.length))),
      h('div', { class: 'group-meta' },
        h('span', { class: 'muted small label-tip' }, t('app.apart'), tipRaw(app, t('app.apartTip', { app })))),
      list[0].installed ? null : h('div', { class: 'group-meta' }, h('span', { class: 'tag tag-warn' }, t('acct.notInstalled'))))
    const body = collapsed ? null : h('div', { class: 'rows', id: bodyId, role: 'list', 'data-key': ui.arrange ? 'rows-arrange' : 'rows', 'data-patch': '' }, list.map((p) => ui.arrange ? appArrangeRow(p, id) : appRow(p)))
    return h('section', { class: 'group group-list' + (collapsed ? ' is-collapsed' : '') + (ui.arrange ? ' is-arranging' : ''), 'aria-label': app, 'data-key': 'app:' + app, 'data-fam': id, 'data-patch': '' },
      head, body, collapsed || ui.arrange ? null : appFoot(list))
  }
  // A desktop app window in the arrange mode: grip, mark, name, up and down.
  function appArrangeRow(p, id) {
    const units = ui.order.units[id] || []
    const at = units.findIndex((u) => u[0] === p.name)
    const name = p.isMain ? t('app.mainName') : p.name
    return h('div', { class: 'row row-arrange', role: 'listitem', 'data-ref': p.ref, 'data-key': 'arr:' + p.ref, 'data-sig': sig([p.ref, at, units.length]) },
      h('div', { class: 'ident' }, dragHandle('account', id, p.name, name), appBadge(), h('div', { class: 'ident-text' }, h('div', { class: 'ident-name' }, h('span', { class: 'name' }, name), h('span', { class: 'muted small mono' }, p.ref)))),
      h('div', { class: 'arrange-tools' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('order.up', { name }), title: t('order.up', { name }), disabled: at <= 0 ? true : undefined, onclick: () => moveUnit('account', id, at, at - 1, { focus: p.name, label: name, button: 'up' }) }, icon('arrowUp')),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('order.down', { name }), title: t('order.down', { name }), disabled: at >= units.length - 1 ? true : undefined, onclick: () => moveUnit('account', id, at, at + 1, { focus: p.name, label: name, button: 'down' }) }, icon('arrowDown'))))
  }
  // Shown with the account groups unless a family filter or the attention filter is on; the search matches names.
  function appGroups() { return appIds().map(appGroupFor).filter(Boolean) }
  // A desktop app's group, its windows in the Display Order (spec §3.25); none under a family or attention filter.
  function appGroupFor(id) {
    if (prefs.family || ui.attention) return null
    const q = ui.query.trim().toLowerCase()
    const all = inDisplayOrder(appProfiles().filter((p) => appId(p.ref) === id), (p) => p.name, accountOrder(id))
    const app = all.length ? all[0].app : ''
    const list = q && !app.toLowerCase().includes(q) ? all.filter((p) => p.ref.toLowerCase().includes(q)) : all
    return list.length ? appGroup(list) : null
  }
  async function openApp(ref) {
    if (ui.appBusy) return
    ui.appBusy = ref
    renderAccounts()
    let ok = false
    try {
      const r = await api('/api/app-profile/open', { ref })
      const text = r.action === 'started' ? t('app.started', { app: r.app, ref: r.ref }) : r.action === 'focused' ? t('desk.focused', { app: r.app, ref: r.ref }) : ''
      if (text) toast(text)
      for (const m of r.notices || []) toast(m, { kind: 'info', duration: 12000 })
      ok = true
    } catch (e) { toast(t('app.failed', { ref, msg: e.message }), { kind: 'fail' }) }
    ui.appBusy = null
    if (ok) ui.appNew = null
    renderAccounts()
    load({ silent: true })
  }
  function createApp(list) {
    const n = ui.appNew
    if (!n || appNameProblem(n.name)) return
    openApp(appId(list[0].ref) + ':' + n.name)
  }
  async function removeApp(p) {
    if (ui.appBusy) return
    ui.appBusy = p.ref
    renderAccounts()
    try {
      await api('/api/app-profile/remove', { ref: p.ref })
      toast(t('app.removed', { ref: p.ref }))
    } catch (e) { toast(t('app.removeFailed', { ref: p.ref, msg: e.message }), { kind: 'fail' }) }
    ui.appBusy = null
    ui.appRemove = null
    renderAccounts()
    load({ silent: true })
  }
  function group(fam, list, total, now, cols) {
    const info = family(fam)
    const filtering = Boolean(ui.query.trim()) || ui.attention
    const collapsed = !filtering && prefs.collapsed[fam] === true
    const needing = list.filter((a) => reasonsOf(a, now).length)
    const need = needing.length
    const setup = setupFor(fam)
    const off = list.some((a) => a.quota && a.quota.status === 'unavailable' && a.quota.reason === 'not-enabled')
    const bodyId = 'grp-' + fam.replace(/[^a-zA-Z0-9_-]/g, '_')
    // The arrange mode shows every group open, as a short list, in either view (spec §3.25).
    const cards = prefs.view === 'cards' && !ui.arrange
    const collapsedNow = collapsed && !ui.arrange
    if (!cards) ui.order.units[fam] = loginClusters(list).map((x) => Array.isArray(x) ? x.map((a) => a.name) : [x.name])
    const head = h('div', { class: 'group-head', 'data-key': ui.arrange ? 'head-arrange' : 'head' },
      dragHandle('family', fam, fam, info.title),
      h('button', { class: 'group-toggle', type: 'button', disabled: ui.arrange ? true : undefined, 'aria-expanded': String(!collapsedNow), 'aria-controls': bodyId, title: t(collapsed ? 'group.expand' : 'group.collapse'), 'aria-label': t('group.toggle', { title: info.title, count: list.length === total ? String(total) : list.length + ' / ' + total, action: t(collapsed ? 'group.expand' : 'group.collapse') }), onclick: () => toggleGroup(fam, 'g:' + fam) },
        icon('chevron', 'chev'), badge(fam, 'sm'), h('span', { class: 'group-title' }, info.title),
        h('span', { class: 'group-count' }, list.length === total ? String(total) : list.length + ' / ' + total)),
      h('div', { class: 'group-meta' },
        waitingForQuota(fam) ? h('span', { class: 'group-wait', role: 'status' }, h('span', { class: 'pulse', 'aria-hidden': 'true' }), t('quota.waiting', { host: info.title })) : null,
        need ? attentionTag(needing, now) : null,
        off && setup && setup.plan.status === 'ready' && !BOOT.readOnly
          ? h('span', { class: 'group-quota' },
            h('span', { class: 'muted small' }, t('quota.turnOnFamilyNote', { host: info.title })),
            h('button', { class: 'btn btn-sm', type: 'button', title: setup.summary, 'aria-label': t('quota.turnOnFamilyLabel', { host: info.title }), onclick: () => openSetup(fam) }, t('quota.turnOnFamily')))
          : null,
        off && setup && setup.plan.status === 'blocked' ? h('span', { class: 'muted small label-tip' }, t('quota.blocked'), tipRaw(t('quota.blocked'), setup.plan.message)) : null))
    const body = collapsedNow ? null : cards
      ? h('div', { class: 'grid', id: bodyId, 'data-key': 'cards', 'data-patch': '' }, list.map((a) => card(a, now, cols)))
      : h('div', { class: 'rows', id: bodyId, role: 'list', 'data-key': ui.arrange ? 'rows-arrange' : 'rows', 'data-patch': '' }, loginClusters(list).map((x) => Array.isArray(x) ? loginRow(x, now, cols) : row(x, now, cols)))
    return h('section', { class: 'group' + (cards ? ' group-cards' : ' group-list') + (collapsedNow ? ' is-collapsed' : '') + (ui.arrange ? ' is-arranging' : ''), 'aria-label': info.title, 'data-key': 'g:' + fam, 'data-fam': fam, 'data-patch': '' },
      head, collapsedNow || cards || ui.arrange ? null : colHead(cols, list), body)
  }
  function emptyState() {
    const fams = S.state.families.slice().sort((x, y) => Number(y.installed) - Number(x.installed))
    return h('div', { class: 'empty' },
      // The header's mark, cloned (page.ts draws it from core/brand-mark.ts).
      h('span', { class: 'logo', 'aria-hidden': 'true' }, document.querySelector('.brand .logo svg')?.cloneNode(true) ?? null),
      h('h3', null, t('empty.title')),
      h('p', { class: 'muted' }, t('empty.body')),
      fams.length ? h('ul', { class: 'host-list' }, fams.map((f) => h('li', null, badge(f.id, 'sm'), h('span', null, f.title),
        f.installed ? h('span', { class: 'muted small' }, tx('empty.runOnce', { bin: h('code', null, f.bin) })) : f.installCommand ? codeCopy(f.installCommand) : link(t('empty.install'), f.installUrl, 'btn btn-sm')))) : h('p', { class: 'muted small' }, t('empty.noFamilies')),
      BOOT.readOnly ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openCreate(null) }, icon('plus'), t('empty.create')),
      BOOT.readOnly ? null : h('p', { class: 'muted small' }, t('ai.emptyHint'), ' ', h('button', { class: 'link-btn', type: 'button', onclick: () => openAsk({ task: 'account', context: { version: BOOT.version } }) }, t('ask.title.account'))))
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
  // ---------- Display Order and Pinned Accounts (spec §3.25) ----------
  const PIN_MAX = 3
  function displayOf() { return (S.state && S.state.display) || {} }
  // Every Family id in the Display Order, the ones only accounts name (a plugin that failed) last.
  function familyOrder() {
    const ids = S.state.families.map((f) => f.id)
    for (const a of S.state.accounts) if (!ids.includes(a.family)) ids.push(a.family)
    // Desktop apps with windows of their own (Grok Bot) take a place in the same order, after the tools by default.
    for (const id of appIds()) if (!ids.includes(id)) ids.push(id)
    return inDisplayOrder(ids, (x) => x, displayOf().families)
  }
  function appIds() { return [...new Set(appProfiles().map((p) => appId(p.ref)))] }
  function isAppGroup(id) { return appIds().includes(id) && !S.state.families.some((f) => f.id === id) }
  function accountOrder(fam) { return (displayOf().accounts || {})[fam] }
  function pinnedOf(fam) { return (displayOf().pinned || {})[fam] || [] }
  function isPinned(a) { return pinnedIn(a, pinnedOf(a.family)) }
  // Whether a shown unit (an account, or the directories of one login) is pinned.
  function unitPinned(fam, unit) {
    const pins = pinnedOf(fam)
    return unit.some((n) => { const a = S.state.accounts.find((x) => x.family === fam && x.name === n); return a ? pinnedIn(a, pins) : pins.includes(n) })
  }
  // Pinned places taken in a Family: a Same Login pinned together counts once.
  function pinnedUnits(fam) {
    const names = pinnedOf(fam)
    return loginClusters(S.state.accounts.filter((a) => a.family === fam && names.includes(a.name))).length
  }
  // Every account name of a Family, hidden ones too, in the Display Order.
  function allNames(fam) {
    if (isAppGroup(fam)) return inDisplayOrder(appProfiles().filter((p) => appId(p.ref) === fam).map((p) => p.name), (x) => x, accountOrder(fam))
    return sortAccounts(S.state.accounts.filter((a) => a.family === fam), 'manual', Date.now(), accountOrder(fam)).map((a) => a.name)
  }
  function ordered() { const d = displayOf(); return Boolean((d.families && d.families.length) || (d.accounts && Object.keys(d.accounts).length)) }
  function copyDisplay(d) {
    return { families: d.families ? d.families.slice() : [], accounts: Object.assign({}, d.accounts || {}), pinned: Object.assign({}, d.pinned || {}) }
  }
  // Shows next at once and writes it to the config. Writes go one at a time; a failed one puts back what the config
  // last confirmed, never another write's unsaved state.
  const displaySaves = { chain: Promise.resolve(), pending: 0, confirmed: null }
  function saveDisplay(before, next, failKey) {
    if (!displaySaves.pending) displaySaves.confirmed = before
    displaySaves.pending++
    S.state.display = next
    renderAccounts()
    const run = displaySaves.chain.then(async () => {
      try {
        const r = await api('/api/display-order', { display: next })
        displaySaves.confirmed = r.display
        if (S.state.display === next) S.state.display = r.display
        return true
      } catch (e) {
        // A newer write already on its way settles the screen; only the latest one puts things back.
        if (S.state.display === next) { S.state.display = displaySaves.confirmed; renderAccounts() }
        toast(t(failKey || 'order.failed', { msg: e.message }), { kind: 'fail' })
        return false
      } finally { displaySaves.pending-- }
    })
    displaySaves.chain = run.catch(() => {})
    return run
  }
  // Pins or unpins an Account, with the other directories of its Same Login. A new pin goes last among the pinned.
  function togglePin(a) {
    const before = displayOf()
    const next = copyDisplay(before)
    const names = [a.name].concat((a.sameLogin || []).map(refName))
    // Names of accounts that are gone are dropped on the way (spec §3.25).
    const list = pinnedOf(a.family).filter((n) => !names.includes(n) && S.state.accounts.some((x) => x.family === a.family && x.name === n))
    if (!isPinned(a)) {
      if (pinnedUnits(a.family) >= PIN_MAX) { toast(t('pin.full', { n: PIN_MAX }), { kind: 'fail' }); return }
      list.push(...names.filter((n) => S.state.accounts.some((x) => x.family === a.family && x.name === n)))
    }
    next.pinned[a.family] = list
    saveDisplay(before, next, 'pin.failed')
  }

  // The arrange mode: the only place to drag (spec §3.25). It starts from the order on screen, saves each move at
  // once, and "Done" offers to put back the order it started from.
  function sortAfter(start) { return start.sortBefore === 'manual' ? 'pressure' : start.sortBefore }
  function startArrange() {
    if (BOOT.readOnly) return
    closeMenu()
    if (!ui.arrange) ui.arrange = { before: copyDisplay(displayOf()), sortBefore: prefs.sort }
    prefs.sort = 'manual'
    savePrefs()
    if (tb.sort) tb.sort.value = 'manual'
    renderAccounts()
    const first = document.querySelector('#accounts .drag-handle')
    if (first) first.focus({ preventScroll: true })
  }
  function endArrange() {
    const start = ui.arrange
    if (!start) return
    ui.arrange = null
    // With no order of one's own left, "my order" is the default order: go back to the usual sort.
    if (!ordered()) { prefs.sort = sortAfter(start); savePrefs() }
    if (tb.sort) tb.sort.value = prefs.sort
    renderAccounts()
    if (JSON.stringify(copyDisplay(displayOf())) === JSON.stringify(start.before)) return
    toast(t('order.saved'), { action: { label: t('order.undo'), run: async () => {
      if (!(await saveDisplay(displayOf(), start.before))) return
      if (!ordered() && prefs.sort === 'manual') { prefs.sort = sortAfter(start); savePrefs(); if (tb.sort) tb.sort.value = prefs.sort; renderAccounts() }
      toast(t('order.undone'))
    } } })
  }
  function arrangeBar() {
    return h('div', { class: 'arrange-bar', role: 'region', 'aria-label': t('sort.arrange'), 'data-key': 'arrange-bar', 'data-sig': sig([ordered(), lang]) },
      h('span', { class: 'arrange-text' }, icon('grip'), h('span', null, t('order.bar')), h('button', { class: 'link-btn small', type: 'button', onclick: () => openAsk() }, t('ai.orderHint'))),
      h('div', { class: 'arrange-actions' },
        h('button', { class: 'link-btn', type: 'button', title: t('order.resetHint'), disabled: ordered() ? undefined : true, onclick: resetOrder }, t('order.resetButton')),
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: endArrange }, t('order.done'))))
  }
  // An account row in the arrange mode: grip, mark, name and short commands, then up, down and pin. Nothing else.
  function arrangeRow(a, ms) {
    const fam = a.family
    const units = ui.order.units[fam] || []
    const at = units.findIndex((u) => u.includes(a.name))
    const nPinned = units.filter((u) => unitPinned(fam, u)).length
    const pinned = isPinned(a)
    const lo = pinned ? 0 : nPinned
    const hi = pinned ? nPinned - 1 : units.length - 1
    const label = ms.map((m) => m.name).join(', ')
    const full = !pinned && pinnedUnits(fam) >= PIN_MAX
    const pinLabel = full ? t('pin.full', { n: PIN_MAX }) : t(pinned ? 'pin.unpinName' : 'pin.pinName', { name: label, title: family(fam).title })
    return h('div', { class: 'row row-arrange' + (pinned ? ' is-pinned' : ''), role: 'listitem', 'data-ref': a.ref, 'data-key': 'arr:' + loginKey(ms.map((m) => m.ref)), 'data-sig': sig([ms.map(rowSig), at, lo, hi, full]) },
      h('div', { class: 'ident' }, dragHandle('account', fam, a.name, label), badge(fam, 'sm'), h('div', { class: 'ident-text' }, h('div', { class: 'ident-name' },
        pinMark(a),
        h('span', { class: 'name', title: a.name }, a.name),
        loginMark(ms),
        aliasText(a)))),
      h('div', { class: 'arrange-tools' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('order.up', { name: label }), title: t('order.up', { name: label }), disabled: at <= lo ? true : undefined, onclick: () => moveUnit('account', fam, at, at - 1, { focus: a.name, label, button: 'up' }) }, icon('arrowUp')),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('order.down', { name: label }), title: t('order.down', { name: label }), disabled: at >= hi ? true : undefined, onclick: () => moveUnit('account', fam, at, at + 1, { focus: a.name, label, button: 'down' }) }, icon('arrowDown')),
        // Words, not a lone pin icon at the end of the row: the arrange mode is where the order and the pins are set.
        h('button', { class: 'btn btn-sm pin-btn', type: 'button', 'aria-pressed': String(pinned), 'aria-label': pinLabel, title: pinLabel, 'aria-disabled': full ? 'true' : null, onclick: () => { if (full) toast(t('pin.full', { n: PIN_MAX })); else togglePin(a) } }, t(pinned ? 'pin.unpin' : 'pin.pin'))))
  }
  // A grip to drag a Family group or an account (a Same Login moves as one) into a new place, or to move it with
  // the arrow keys. Only in the arrange mode.
  function dragHandle(kind, fam, key, name) {
    if (BOOT.readOnly || !ui.arrange) return null
    const label = t(kind === 'family' ? 'order.moveFamily' : 'order.moveAccount', { name })
    return h('button', { class: 'icon-btn drag-handle', type: 'button', draggable: 'true', 'data-move': kind, 'data-fam': fam, 'data-name': key, 'aria-label': label, title: t('order.handle'),
      onclick: (e) => e.stopPropagation(),
      onkeydown: (e) => {
        const keys = { ArrowUp: -1, ArrowDown: 1, Home: -Infinity, End: Infinity }
        if (!Object.hasOwn(keys, e.key)) return
        e.preventDefault()
        e.stopPropagation()
        const units = unitsOf(kind, fam)
        const from = units.findIndex((u) => u.includes(key))
        const step = keys[e.key]
        const to = Math.max(0, Math.min(units.length - 1, Number.isFinite(step) ? from + step : step < 0 ? 0 : units.length - 1))
        moveUnit(kind, fam, from, to, { focus: key, label: name })
      },
      ondragstart: (e) => {
        const units = unitsOf(kind, fam)
        ui.drag = { kind, fam, from: units.findIndex((u) => u.includes(key)), to: null, other: null, dropped: false }
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', name) } catch {}
        const el = unitElement(kind, fam, key)
        if (el) { e.dataTransfer.setDragImage(el, 16, 16); requestAnimationFrame(() => el.classList.add('is-dragging')) }
      },
      ondragend: () => endDrag(),
    }, icon('grip'))
  }
  function unitsOf(kind, fam) { return kind === 'family' ? ui.order.families.map((f) => [f]) : (ui.order.units[fam] || []) }
  // The element that moves: a Family's group, or an account's row (a Same Login is one row).
  function unitElement(kind, fam, key) {
    if (kind === 'family') return document.querySelector('#accounts > section[data-fam="' + CSS.escape(fam) + '"]')
    return document.querySelector('#accounts .row[data-ref="' + CSS.escape(fam + ':' + key) + '"]')
  }
  // Where a drop at the pointer lands: the list of places it can go and the index among them, or null outside.
  function dropTarget(e) {
    const d = ui.drag
    if (!d) return null
    if (d.kind === 'family') {
      const els = Array.from(document.querySelectorAll('#accounts > section[data-fam]'))
      return els.length ? { els, at: slotAt(els, e.clientY) } : null
    }
    const sec = e.target.closest && e.target.closest('#accounts > section[data-fam]')
    // Over another Family: remembered, so letting go there can say why nothing moved.
    d.other = sec && sec.getAttribute('data-fam') !== d.fam ? sec.getAttribute('data-fam') : null
    if (!sec || d.other) return null
    const box = sec.querySelector('.rows')
    if (!box) return null
    const els = Array.from(box.children)
    return { els, at: slotAt(els, e.clientY) }
  }
  function slotAt(els, y) {
    for (let i = 0; i < els.length; i++) {
      const r = els[i].getBoundingClientRect()
      if (y < r.top + r.height / 2) return i
    }
    return els.length
  }
  function clearDropMarks() { for (const el of document.querySelectorAll('.drop-before, .drop-after')) el.classList.remove('drop-before', 'drop-after') }
  function endDrag() {
    const d = ui.drag
    clearDropMarks()
    for (const el of document.querySelectorAll('.is-dragging')) el.classList.remove('is-dragging')
    ui.drag = null
    if (d && d.other && !d.dropped) toast(t('order.sameFamily', { title: family(d.fam).title }))
    if (S.pending) { S.pending = false; renderAll() }
  }
  function onDragOver(e) {
    const tgt = dropTarget(e)
    if (!tgt) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    clearDropMarks()
    if (tgt.at < tgt.els.length) tgt.els[tgt.at].classList.add('drop-before')
    else tgt.els[tgt.els.length - 1].classList.add('drop-after')
    // Dropped after itself means one place earlier once it is taken out.
    ui.drag.to = tgt.at > ui.drag.from ? tgt.at - 1 : tgt.at
  }
  function onDrop(e) {
    const d = ui.drag
    if (!d || !dropTarget(e)) return
    e.preventDefault()
    d.dropped = true
    const to = d.to
    endDrag()
    if (to !== null && to !== d.from) moveUnit(d.kind, d.fam, d.from, to)
  }
  // Records a move: Families anywhere; pinned accounts only among the pinned (their pin order), the others only
  // below them (the Display Order). A move past the edge of its part stops at the edge.
  function moveUnit(kind, fam, from, to, opts) {
    opts = opts || {}
    const units = unitsOf(kind, fam)
    if (from < 0 || to < 0 || from >= units.length || to >= units.length) return
    const before = displayOf()
    const next = copyDisplay(before)
    let place = to
    let first = 0
    let total = units.length
    if (kind === 'family') next.families = reorder(familyOrder(), units, from, to)
    else {
      // Names of accounts that are gone are dropped on the way (spec §3.25).
      const pins = pinnedOf(fam).filter((n) => S.state.accounts.some((x) => x.family === fam && x.name === n))
      const nPinned = units.filter((u) => unitPinned(fam, u)).length
      const pinned = from < nPinned
      place = pinned ? Math.min(to, nPinned - 1) : Math.max(to, nPinned)
      first = pinned ? 0 : nPinned
      total = pinned ? nPinned : units.length - nPinned
      if (place !== from) {
        if (pinned) next.pinned[fam] = reorder(pins, units.slice(0, nPinned), from, place)
        else next.accounts[fam] = reorder(allNames(fam), units, from, place)
      }
    }
    const where = () => { if (opts.label) say(t('order.position', { name: opts.label, n: place - first + 1, total })) }
    if (place === from) { where(); return }
    saveDisplay(before, next)
    if (opts.focus) {
      const grip = '#accounts .drag-handle[data-move="' + kind + '"][data-fam="' + CSS.escape(fam) + '"][data-name="' + CSS.escape(opts.focus) + '"]'
      let btn = opts.button ? document.querySelector('#accounts .row[data-ref="' + CSS.escape(fam + ':' + opts.focus) + '"] .arrange-tools button:nth-child(' + (opts.button === 'up' ? 1 : 2) + ')') : null
      // At the edge the arrow it used is off now: the grip keeps the focus.
      if (!btn || btn.disabled) btn = document.querySelector(grip)
      if (btn) btn.focus({ preventScroll: false })
      where()
    }
  }
  // Forgets the order of Families and accounts; pins stay.
  async function resetOrder() {
    const before = displayOf()
    const pinned = before.pinned && Object.keys(before.pinned).length ? before.pinned : null
    if (await saveDisplay(before, pinned ? { pinned } : {})) toast(t('order.reset'))
  }
  // Words for screen readers only, such as the new place of something moved with the keyboard.
  let live = null
  function say(text) {
    if (!live) { live = h('div', { class: 'sr-only', 'aria-live': 'polite' }); document.body.append(live) }
    live.textContent = ''
    setTimeout(() => { live.textContent = text }, 30)
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
    if (!all.length) { setKids(count, null); patch(box, [emptyState()].concat(appGroups())); return }
    const shown = all.filter((a) => (!prefs.family || a.family === prefs.family) && matchesQuery(a, ui.query, famTitle(a)) && (!ui.attention || reasonsOf(a, now).length))
    const filtered = shown.length !== all.length
    patch(count, filtered
      ? [t('count.filtered', { n: shown.length, total: all.length }), ' ', h('button', { class: 'link-btn', type: 'button', onclick: clearFilters }, t('filter.clear'))]
      : tn('count.accounts', all.length))
    const apps = appGroups()
    if (!shown.length && !apps.length) { patch(box, noMatch()); return }
    ui.loginRefs = new Map()
    if (prefs.view !== 'cards' || ui.arrange)
      for (const x of loginClusters(shown)) if (Array.isArray(x)) for (const a of x) ui.loginRefs.set(a.ref, loginMembers(x)[0].ref)
    // Families in the Display Order (spec §3.25) whatever the sort; each group gets the quota columns it uses.
    // Every group is as wide as the one with the most windows, so the columns after them line up.
    ui.order = { families: [], units: {} }
    const groups = []
    let width = 1
    for (const fam of familyOrder()) {
      if (isAppGroup(fam)) {
        const g = appGroupFor(fam)
        if (g) { ui.order.families.push(fam); groups.push(g) }
        continue
      }
      const list = shown.filter((a) => a.family === fam)
      if (!list.length) continue
      ui.order.families.push(fam)
      const sorted = withPinned(sortAccounts(list, prefs.sort, now, accountOrder(fam)), pinnedOf(fam))
      const cols = quotaColumns(sorted)
      width = Math.max(width, cols.length)
      groups.push(group(fam, sorted, all.filter((a) => a.family === fam).length, now, cols))
    }
    box.style.setProperty('--qn', String(width))
    patch(box, (ui.arrange ? [arrangeBar()] : []).concat(groups))
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
  // The Panel updates an outdated sideby skill itself when the Update plan allows it (spec §3.16, §3.23).
  function skillFixable() {
    const u = updState()
    return !BOOT.readOnly && !!(u && u.method.kind !== 'local' && u.skillUpdate && u.skillUpdate.outdated && u.skillUpdate.canRun)
  }
  // A Finding in plain words (its code's sentence); the check's own text goes under "Details".
  function findingRow(f) {
    const own = panelFixes(f, skillFixable())
    const key = 'finding.' + f.code
    const plain = Object.hasOwn(MESSAGES.en, key) ? t(key, { item: f.item }) : ''
    const fixHere = plain && f.fixable && !BOOT.readOnly && !own
    return h('li', { class: 'finding lvl-' + f.level },
      h('span', { class: 'dot', title: f.level }),
      h('div', { class: 'finding-body' },
        h('div', { class: 'finding-top' },
          ui.healthRef ? null : h('button', { class: 'chip chip-btn mono', type: 'button', title: t('health.only', { ref: f.account }), 'aria-label': t('health.only', { ref: f.account }), onclick: () => filterHealth(f.account) }, badge(f.account.split(':')[0], 'xs'), f.account),
          h('span', { class: 'muted small mono' }, f.item),
          f.fixable ? h('span', { class: 'chip chip-sm chip-accent' }, t('health.autoFix')) : null,
          f.source && f.source !== 'core' ? h('span', { class: 'muted small' }, t('health.from', { source: f.source })) : null,
          own ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: openUpdate }, icon('arrowUp'), t('upd.skillLabel')) : null),
        h('p', null, plain || f.message),
        own ? null
          : fixHere ? h('p', { class: 'hint' }, t('finding.fixHint'))
            : f.hint && !plain ? h('p', { class: 'hint' }, panelHint(f.hint, f.fixable && !BOOT.readOnly, t('fix.hintAction'))) : null,
        // The check's own words (and any command to run) stay one click away.
        plain ? h('details', { class: 'finding-raw' }, h('summary', null, t('finding.raw')), h('p', { class: 'mono small' }, f.message), f.hint ? h('p', { class: 'mono small' }, f.hint) : null) : null))
  }
  function renderCheckup() {
    const box = $('checkup')
    // With no account there is nothing to check: the empty state is the only thing to do.
    box.hidden = Boolean(S.state && !S.state.accounts.length)
    if (box.hidden) return
    const all = findingsNow()
    const ref = ui.healthRef
    const findings = all && ref ? all.filter((f) => f.account === ref) : all
    const at = lastCheckAt()
    const busy = S.checking || S.fixing
    const fixable = all ? all.filter((f) => f.fixable).length : 0
    // Say why Fix all is off, unless a running check or fix already explains it.
    const skillFix = skillFixable()
    const forAi = (list) => list.filter((f) => !panelFixes(f, skillFix))
    const fixWhy = busy || fixable ? null : !all ? t('fix.whyNoCheck') : !all.length ? t('fix.whyNothing')
      : forAi(all).length ? t('fix.whyManual') : t('fix.whyButton')
    const prompt = findings && !busy ? fixPrompt(forAi(findings), { lead: t('fix.promptLead'), hint: t('fix.promptHint'), fixFirst: t('fix.promptFixFirst'), check: t('fix.promptCheck') }) : ''
    const status = S.checking ? t('health.running') : S.fixing ? t('health.fixing') : at ? t('health.last', { ago: ago(at) }) : t('health.never')
    const out = [h('div', { class: 'section-head' },
      h('div', null,
        h('h2', { id: 'h-checkup' }, t('health.title')),
        h('p', { class: 'muted small' }, status, h('span', { class: 'sep', 'aria-hidden': 'true' }, '·'),
          tx('health.lead', { shared: h('span', { class: 'label-tip' }, t('health.sharedTerm'), tip('shared')) }))),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', disabled: busy || !S.state, 'aria-busy': S.checking ? 'true' : null, title: !S.state && !busy ? t('health.waiting') : null, onclick: runCheck }, S.checking ? spinner() : null, S.checking ? t('health.running') : t('health.run')),
        prompt && BOOT.readOnly ? h('button', { class: 'btn', type: 'button', title: t('fix.copyAiTitle'), onclick: () => copyText(prompt, t('fix.promptShown')) }, icon('copy'), t('fix.copyAi')) : null,
        prompt && !BOOT.readOnly ? h('button', { class: 'btn', type: 'button', title: t('ask.fixTitle'), onclick: () => openAsk({ task: 'fix', context: { findings: taskFindings(forAi(findings)), version: BOOT.version } }) }, icon('bot'), t('ask.title.fix')) : null,
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

  // Context tuning (spec §3.18, ADR-0012). The setting lives in one settings file, which Accounts often share, so
  // there is one card per file: what is suggested, one button that does it (after saying what it changes), one size
  // menu, and the way back. Each account's own numbers sit behind a click.
  const tuneState = { ref: null, family: null, loading: false, data: null, error: null }
  // The one change being made right now: step is asking (fetching the plan), confirm, busy, done or undone.
  let useUi = null
  // What each card's size menu shows while the user is choosing, by group id; dropped once a change is made.
  const tuneSel = {}
  const tp = { data: null, loading: false, error: null, at: 0 }
  function pageFromHash() { return location.hash === '#tuning' ? 'tuning' : location.hash === '#handoff' ? 'handoff' : 'accounts' }
  let curPage = pageFromHash()
  function tuneSize(n) { return n === null || n === undefined ? t('tune.hostDefault') : tokens(n) }
  function tuneRedraw() {
    if (dlg.kind === 'tune') renderTune()
    if (curPage === 'tuning') renderTuningPage()
  }
  async function tuneReload() {
    if (curPage === 'tuning') await loadTuningPage()
    if (dlg.kind === 'tune' && tuneState.ref) await loadTuneDialog()
  }
  async function useAsk(g, value) {
    useUi = { gid: g.id, target: g.target, value, step: 'asking', plan: null, error: null, message: '' }
    tuneRedraw()
    try {
      const r = await api('/api/tuning/apply', { account: g.target, value })
      useUi = { ...useUi, step: 'confirm', plan: r.plan }
    } catch (e) { useUi = { ...useUi, step: 'confirm', error: e } }
    tuneRedraw()
  }
  async function useConfirm() {
    const cur = useUi
    useUi = { ...cur, step: 'busy' }
    tuneRedraw()
    try {
      const r = await api('/api/tuning/apply', { account: cur.target, value: cur.value, confirm: true })
      useUi = { ...cur, step: 'done', plan: r.plan, error: null, message: r.applied ? '' : r.message, ok: r.applied }
      delete tuneSel[cur.gid]
    } catch (e) { useUi = { ...cur, step: 'confirm', error: e } }
    tuneRedraw()
    await tuneReload()
  }
  async function useUndo(g) {
    useUi = { gid: g.id, target: g.target, step: 'busy', plan: null, error: null, message: '' }
    tuneRedraw()
    try {
      const r = await api('/api/tuning/undo', { account: g.target })
      useUi = { ...useUi, step: 'undone', message: r.undone ? '' : r.message, ok: r.undone }
      delete tuneSel[g.id]
    } catch (e) { useUi = { ...useUi, step: 'undone', error: e, ok: false } }
    tuneRedraw()
    await tuneReload()
  }
  // What the change will do, in words a person can check before saying yes. ending picks the result of a finished
  // change; the rest (asking, the question, an error) is the part before it.
  function useBox(g, ending) {
    const u = useUi
    if (!u || u.gid !== g.id) return null
    const finished = u.step === 'done' || u.step === 'undone'
    if (finished !== Boolean(ending)) return null
    if (u.step === 'asking' || u.step === 'busy') return h('p', { class: 'muted small' }, spinner(), ' ', t('tune.working'))
    if (finished) {
      if (u.error) return errorNote(u.error, null)
      if (u.ok === false) return h('p', { class: 'note note-warn' }, u.message)
      return h('p', { class: 'note' }, u.step === 'done' ? t('tune.done', { size: tuneSize(u.value) }) : t('tune.undone'), ' ',
        u.step === 'done' && !BOOT.readOnly ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => useUndo(g) }, t('tune.undo')) : null)
    }
    if (u.error) return errorNote(u.error, null)
    const plan = u.plan
    if (plan.status === 'blocked') return h('p', { class: 'note note-warn' }, plan.reason)
    if (plan.status === 'unchanged') return h('p', { class: 'note' }, t('tune.already', { size: tuneSize(u.value) }))
    return h('div', { class: 'tune-confirm' },
      h('p', { class: 'small' }, h('b', null, t('tune.confirmTitle'))),
      h('ul', { class: 'small' },
        h('li', null, t('tune.change') + ': ' + tuneSize(plan.current) + ' → ' + tuneSize(plan.next)),
        h('li', null, t('tune.file') + ': ', h('code', null, plan.file + (plan.creates ? ' ' + t('tune.willCreate') : '')))),
      plan.affected.length > 1 ? h('p', { class: 'note note-warn' }, t('tune.shared', { list: plan.affected.join(', ') })) : null,
      plan.overrides && plan.overrides.length ? h('p', { class: 'note note-warn' }, t('tune.overrides', { list: plan.overrides.map((o) => o.model + ' (' + tokens(o.value) + ')').join(', ') })) : null,
      h('p', { class: 'muted small' }, t('tune.newSessions')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: useConfirm }, t('tune.confirm')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { useUi = null; tuneRedraw() } }, t('btn.cancel'))))
  }
  // The card for one settings file.
  function tuneGroupCard(g, entries) {
    const pick = g.pick
    const sizes = new Set([100000, 150000, 200000, 300000, 500000, 800000, 1000000])
    let top = 200000
    for (const e of entries) if (e.tuning.status === 'ok') for (const m of e.tuning.models) top = Math.max(top, m.contextWindow)
    for (const v of [...sizes]) if (v > top) sizes.delete(v)
    if (pick) sizes.add(pick.threshold)
    if (g.current && !g.outOfRange) sizes.add(g.current)
    const key = (v) => (v === null ? 'default' : String(v))
    const chosen = tuneSel[g.id] !== undefined ? tuneSel[g.id] : key(g.current)
    const sel = h('select', { 'aria-label': t('tune.setting') },
      h('option', { value: 'default' }, t('tune.hostDefaultLong')),
      [...sizes].sort((x, y) => x - y).map((v) => h('option', { value: String(v) }, tokens(v) + (pick && v === pick.threshold ? ' (' + t('tune.suggestedTag') + ')' : ''))))
    sel.value = chosen
    sel.addEventListener('change', () => { tuneSel[g.id] = sel.value; tuneRedraw() })
    const value = chosen === 'default' ? null : Number(chosen)
    const mine = useUi && useUi.gid === g.id
    const busy = mine && (useUi.step === 'asking' || useUi.step === 'busy')
    const asking = mine && (useUi.step === 'confirm' || busy)
    const rows = [h('p', { class: 'small' }, g.members.length > 1 ? t('tune.groupShared', { list: g.members.join(', ') }) : h('b', { class: 'mono' }, g.members[0]))]
    rows.push(h('div', { class: 'tune-vals' },
      h('div', null, h('span', { class: 'muted small' }, t('tune.now')), h('div', { class: 'tune-num' }, tuneSize(g.current))),
      pick ? h('div', null, h('span', { class: 'muted small' }, t('tune.best')), h('div', { class: 'tune-num tune-best' }, tokens(pick.threshold))) : null))
    if (pick && pick.savedPercent !== null) rows.push(h('p', { class: 'small' }, t('tune.saved', { n: Math.round(pick.savedPercent) })))
    if (pick) rows.push(h('p', { class: 'muted small' }, t('tune.basis', { model: pick.model, ref: pick.ref })))
    if (pick) {
      const seen = entries.find((e) => e.ref === pick.ref)
      const stats = seen && seen.tuning.status === 'ok' ? seen.tuning.models.find((m) => m.model === pick.model) : null
      if (stats && stats.compactions.idle > 0) rows.push(h('p', { class: 'muted small' }, t('tune.idle', { n: stats.compactions.idle, total: stats.compactions.total })))
    } else {
      // Say why there is no suggestion: when a model is already at its cheapest, that is the news, not "not enough use".
      const why = entries.flatMap((e) => (e.tuning.status === 'ok' ? e.tuning.models : [])).some((m) => m.reason === 'already-best') ? t('tune.reason.already-best') : t('tune.groupNone')
      rows.push(h('p', { class: 'note' }, why))
    }
    if (g.overrides && g.overrides.length) rows.push(h('p', { class: 'note note-warn' }, t('tune.overrides', { list: g.overrides.map((o) => o.model + ' (' + tokens(o.value) + ')').join(', ') })))
    if (g.outOfRange) rows.push(h('p', { class: 'note note-warn' }, t('tune.outOfRange', { size: tokens(g.current) })))
    if (!BOOT.readOnly) {
      if (pick && !asking) rows.push(h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => useAsk(g, pick.threshold) }, t('tune.use', { size: tokens(pick.threshold) }))))
      // With a suggestion there is one main button; choosing a size by hand waits behind a click.
      const custom = h('div', { class: 'tune-setting' },
        h('b', { class: 'small' }, t('tune.setting')),
        h('div', { class: 'row-actions' }, sel,
          h('button', { class: 'btn btn-sm', type: 'button', disabled: Boolean(busy) || value === g.current, onclick: () => useAsk(g, value) }, t('tune.useThis'))))
      rows.push(pick ? h('details', { class: 'tune-custom', open: value !== (pick ? pick.threshold : null) && value !== g.current ? true : undefined }, h('summary', null, t('tune.custom')), custom) : custom)
      rows.push(useBox(g, false))
      if (g.undo && !(mine && (useUi.step === 'done' || useUi.step === 'undone')))
        rows.push(h('p', { class: 'small tune-undo' }, t('tune.applied', { prev: tuneSize(g.undo.previous) }), ' ',
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => useUndo(g) }, t('tune.undo'))))
      rows.push(useBox(g, true))
    }
    return h('div', { class: 'tune-model tune-group' }, rows)
  }
  // What was seen for one model: information only, behind a click.
  function tuneModel(m, minCalls) {
    const rows = [h('div', { class: 'tune-head' }, h('b', { class: 'mono' }, m.model), h('span', { class: 'muted small' }, t('tune.calls', { n: m.calls })))]
    rows.push(h('div', { class: 'tune-vals' },
      h('div', null, h('span', { class: 'muted small' }, t('tune.now')), h('div', { class: 'small' }, tuneSize(m.configured))),
      m.suggestion ? h('div', null, h('span', { class: 'muted small' }, t('tune.best')), h('div', { class: 'small' }, tokens(m.suggestion.threshold))) : null))
    if (!m.suggestion) rows.push(h('p', { class: 'muted small' }, t('tune.reason.' + m.reason, { min: minCalls })))
    rows.push(h('p', { class: 'muted small' }, m.compactions.total ? tn('tune.compactions', m.compactions.total, { size: tokens(m.compactions.preTokensP50 || 0) }) : t('tune.noCompactions')))
    if (m.compactions.idle > 0) rows.push(h('p', { class: 'muted small' }, t('tune.idle', { n: m.compactions.idle, total: m.compactions.total })))
    return h('div', { class: 'tune-detail' }, rows)
  }
  function tuneDetails(entries, minCalls, label) {
    const kids = []
    for (const e of entries) {
      if (e.tuning.status !== 'ok' || !e.tuning.models.length) continue
      kids.push(h('div', { class: 'tune-acct-head title-logo' }, badge(e.family, 'sm'), h('b', { class: 'mono' }, e.ref)))
      for (const m of e.tuning.models) kids.push(tuneModel(m, minCalls))
    }
    return kids.length ? h('details', { class: 'tune-details' }, h('summary', null, label), kids) : null
  }
  // Everything for a response: a card per settings file, then what Codex accounts show (it only observes).
  function tuneBody(data) {
    const out = []
    const byRef = {}
    for (const e of data.accounts) byRef[e.ref] = e
    for (const g of data.groups) {
      const entries = g.members.map((r) => byRef[r]).filter(Boolean)
      out.push(h('div', { class: 'tune-acct' }, tuneGroupCard(g, entries), tuneDetails(entries, data.minCalls, t('tune.details'))))
    }
    const rest = data.accounts.filter((e) => !data.groups.some((g) => g.members.includes(e.ref)))
    const seen = rest.filter((e) => e.tuning.status === 'ok' && e.tuning.models.length)
    if (seen.length) out.push(h('div', { class: 'tune-acct' }, tuneDetails(seen, data.minCalls, t('tune.detailsObserved'))))
    return out
  }
  async function openTune(a) {
    tuneState.ref = a.ref; tuneState.family = a.family; tuneState.data = null; tuneState.error = null
    // A finished change is not shown again when the dialog opens next time.
    if (useUi && (useUi.step === 'done' || useUi.step === 'undone')) useUi = null
    showDialog('tune')
    await loadTuneDialog()
  }
  async function loadTuneDialog() {
    const ref = tuneState.ref
    tuneState.loading = true
    renderTune()
    try {
      const r = await api('/api/tuning', { account: ref })
      if (tuneState.ref === ref) { tuneState.data = r; tuneState.error = null }
    } catch (e) { if (tuneState.ref === ref) tuneState.error = e }
    tuneState.loading = false
    if (dlg.kind === 'tune' && tuneState.ref === ref) renderTune()
  }
  function renderTune() {
    if (!tuneState.ref) return
    const body = [h('p', { class: 'muted small' }, t('tune.intro', { days: BOOT.usageDays }))]
    const d = tuneState.data
    const one = d && d.accounts[0]
    if (tuneState.loading && !d) body.push(h('p', { class: 'muted' }, spinner(), ' ', t('tune.loading')))
    else if (tuneState.error) body.push(errorNote(tuneState.error, loadTuneDialog))
    else if (d && d.groups.length) body.push(tuneBody(d))
    else if (one && one.tuning.status === 'ok') body.push(tuneBody(d))
    else if (one) body.push(h('p', { class: 'note', title: one.tuning.detail || null }, t(one.tuning.reason === 'no-session' ? 'tune.none' : one.tuning.reason === 'no-source' ? 'tune.noSource' : 'tune.unreadable')))
    const foot = [h('button', { class: 'btn', type: 'button', onclick: () => dlg.el.close() }, t('btn.close'))]
    setKids(dlg.el, dialogFrame(t('tune.title') + ' · ' + tuneState.ref, tuneState.family, body, foot))
  }

  // The page: every account that can tune, on a page of its own. The address ending in #tuning opens it.
  function tuningAvailable() { return Boolean(S.state && S.state.families.some((f) => f.tuning)) }
  function setPage(next) {
    curPage = next
    try { history.replaceState(null, '', next === 'accounts' ? location.pathname + location.search : '#' + next) } catch {}
    renderPageChrome()
  }
  // The page tabs, and which sections show; runs with every render, so a reload or a language switch keeps them.
  function renderPageChrome() {
    const nav = $('pages')
    const canTune = tuningAvailable()
    const canHandoff = Boolean(ahState())
    if (S.state && ((curPage === 'tuning' && !canTune) || (curPage === 'handoff' && !canHandoff))) curPage = 'accounts'
    const tabs = [['accounts', t('page.accounts')]]
    if (canTune) tabs.push(['tuning', t('page.tuning')])
    if (canHandoff) tabs.push(['handoff', t('page.handoff')])
    nav.hidden = tabs.length < 2
    setKids(nav, h('div', { class: 'seg', role: 'presentation' }, tabs.map(([id, label]) =>
      h('button', { class: 'seg-btn', type: 'button', role: 'tab', 'aria-selected': curPage === id ? 'true' : 'false', onclick: () => setPage(id) }, label))))
    const away = curPage !== 'accounts' && tabs.some(([id]) => id === curPage)
    // With no account yet the empty state is the whole page: no summary, no health check.
    const none = Boolean(S.state && !S.state.accounts.length)
    for (const id of ['summary', 'accounts-page', 'checkup']) $(id).hidden = away || (none && id !== 'accounts-page')
    const onTune = away && curPage === 'tuning'
    const onHandoff = away && curPage === 'handoff'
    $('tuning-page').hidden = !onTune
    $('handoff-page').hidden = !onHandoff
    if (onTune) {
      if (!tp.data && !tp.loading && !tp.error) loadTuningPage()
      else renderTuningPage()
    }
    if (onHandoff) {
      // A change made elsewhere (Advanced settings, the CLI) makes what the page loaded out of date.
      const stale = hp.data && (hp.data.settings.auto !== ahState().settings.auto || hp.data.settings.sameFamily !== ahState().settings.sameFamily)
      if ((!hp.data || stale) && !hp.loading && !hp.error) loadHandoffPage()
      else renderHandoffPage()
    }
  }
  async function loadTuningPage() {
    tp.loading = true
    tp.error = null
    renderTuningPage()
    try { tp.data = await api('/api/tuning', {}); tp.at = Date.now() } catch (e) { tp.error = e }
    tp.loading = false
    renderTuningPage()
  }
  function renderTuningPage() {
    const box = $('tuning-page')
    if (box.hidden) return
    const kids = [h('div', { class: 'section-head' },
      h('h2', { id: 'h-tuning' }, t('tpage.title')),
      h('button', { class: 'btn btn-sm', type: 'button', disabled: tp.loading, onclick: loadTuningPage }, tp.loading ? spinner() : icon('refresh'), t('top.refresh')))]
    kids.push(h('p', { class: 'muted small' }, t('tune.intro', { days: BOOT.usageDays })))
    const d = tp.data
    if (tp.loading && !d) kids.push(h('p', { class: 'muted' }, spinner(), ' ', t('tune.loading')))
    if (tp.error) kids.push(errorNote(tp.error, loadTuningPage))
    if (d) {
      const seen = d.accounts.filter((a) => a.tuning.status === 'ok' && a.tuning.models.length)
      const idle = d.accounts.filter((a) => !seen.includes(a) && a.tuning.status === 'unavailable' && a.tuning.reason !== 'unrecognized').map((a) => a.ref)
      const broken = d.accounts.filter((a) => a.tuning.status === 'unavailable' && a.tuning.reason === 'unrecognized')
      if (!seen.length && !d.groups.length) kids.push(h('p', { class: 'small' }, t('tpage.none')))
      kids.push(tuneBody(d))
      for (const a of broken) kids.push(h('p', { class: 'note note-fail' }, h('b', { class: 'mono' }, a.ref), ' ', a.tuning.detail || t('tune.unreadable')))
      if (idle.length) kids.push(h('p', { class: 'muted small' }, t('tpage.idle', { list: idle.join(', ') })))
    }
    setKids(box, kids)
  }
  window.addEventListener('hashchange', () => { curPage = pageFromHash(); renderPageChrome() })

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
      const sub = st === 'ready' ? tn('nf.accounts', n) : st === 'no-main' ? tx('nf.runOnce', { bin: h('code', null, f.bin) }) : t(f.brokenBin ? 'nf.broken' : 'nf.notInstalled')
      return h('label', { class: 'fam-card' + (st === 'ready' ? '' : ' is-off') }, input, badge(f.id, 'sm'),
        h('span', { class: 'fam-text' }, h('span', { class: 'fam-title' }, f.title), h('span', { class: 'fam-sub' }, sub)))
    })
    const body = h('form', { id: 'nf-form', class: 'form', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); create() } },
      h('p', { class: 'muted small' }, t('nf.intro')),
      h('fieldset', { class: 'field fam-field' }, h('legend', null, t('nf.tool')), h('div', { class: 'fam-grid' }, cards,
        h('button', { class: 'fam-card fam-other', type: 'button', onclick: () => openAsk({ task: 'host', context: { version: BOOT.version } }) }, h('span', { class: 'badge badge-sm badge-logo', 'aria-hidden': 'true' }, icon('plus')),
          h('span', { class: 'fam-text' }, h('span', { class: 'fam-title' }, t('ask.otherTool')), h('span', { class: 'fam-sub' }, t('ask.otherToolSub')))))),
      h('div', { class: 'field' }, h('label', { class: 'field', for: 'nf-name' }, h('span', null, t('nf.name')), e.name), e.suggest),
      // The first screen asks only for the tool and a name; the rest waits behind "More options".
      h('details', { class: 'more-opts', open: nf.api || Boolean(nf.alias) || Boolean(nf.error) || undefined },
        h('summary', null, t('nf.more')),
        h('div', { class: 'field' }, h('label', { class: 'field', for: 'nf-alias' }, h('span', null, t('nf.alias'), ' ', h('span', { class: 'muted small' }, t('nf.optional'))), e.alias), e.aliasHint, e.aliasErr),
        h('div', { class: 'check-row' }, h('label', { class: 'check' }, e.api, h('span', null, h('b', null, t('nf.api')), h('span', { class: 'muted small' }, t('nf.apiHint')))), tip('api')),
        e.preview),
      e.error,
      e.errNote = nf.error ? errorNote(nf.error, create, nf.error.code === 'create-refused' && !nf.api ? t('nf.refusedApi') : null) : null,
      h('p', { class: 'small ask-setup' }, h('button', { class: 'link-btn', type: 'button', onclick: () => openAsk({ task: 'account', context: nf.family ? { family: nf.family, version: BOOT.version } : { version: BOOT.version } }) }, icon('bot'), t('ask.setUp'))))
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
    const made = S.state && S.state.accounts.find((x) => x.ref === r.account.ref)
    const keyNow = r.account.kind === 'api' || (made && keyable(made)) ? { ref: r.account.ref, family: r.account.family, kind: r.account.kind } : null
    return dialogFrame(t('nf.title'), r.account.family, body, [
      h('button', { class: 'btn', type: 'button', onclick: () => openCreate({ family: r.account.family, api: nf.api }) }, t('nf.another')),
      keyNow ? h('button', { class: 'btn', type: 'button', onclick: () => openKey(keyNow) }, icon('key'), t('menu.enterKey')) : null,
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

  // ---------- auto handoff ----------
  // Settings come with /api/state; readiness (which runs a check of the sideby on PATH) only when the dialog opens.
  let ah = null
  const HINT_QUIET_MS = 24 * 3600000
  function ahState() { return S.state && S.state.autoHandoff }
  function handoffHint() {
    const st = ahState()
    if (!st || BOOT.readOnly) return null
    if (prefs.ahHintAt && Date.now() - prefs.ahHintAt < HINT_QUIET_MS) return null
    return handoffHintAccount(S.state.accounts, st.settings, st.starters, Date.now())
  }
  function handoffForm() {
    const st = ahState()
    const s = st.settings
    const orders = {}
    for (const f of st.starters) {
      const cur = s.families[f]
      orders[f] = { policy: cur && cur.policy === 'order' ? 'order' : 'pressure', order: cur ? cur.order.slice() : [] }
    }
    return { auto: s.auto, sameFamily: s.sameFamily, prepareAt: s.prepareAt, threshold: s.threshold, wait: s.waitIfResetWithinMinutes, countdown: s.countdownSeconds, orders }
  }
  // "Let AI tune it" (spec §3.29): the AI gets the facts of sideby handoff status --json, as far as the page has them.
  function askHandoff() {
    const st = ahState()
    if (!st) return
    const status = ah && ah.status ? ah.status : null
    openAsk({ task: 'handoff', context: { handoff: handoffTaskFacts(st.settings, st.starters, S.state.accounts, Date.now(), status), version: BOOT.version } })
  }
  async function openHandoff() {
    if (!ahState()) return
    ah = { form: handoffForm(), loading: true }
    showDialog('handoff')
    renderHandoff()
    await loadHandoffStatus()
  }
  async function loadHandoffStatus() {
    const mine = ah
    try {
      const st = await api('/api/handoff/status', {})
      if (ah === mine) { ah.status = st; ah.loading = false; ah.error = null }
    } catch (e) { if (ah === mine) { ah.error = e; ah.loading = false } }
    if (dlg.kind === 'handoff') renderHandoff()
  }
  function ahEdit(fn) {
    fn(ah.form)
    ah.preview = null
    ah.nothing = false
    ah.saved = null
    renderHandoff()
  }
  function ahNumber(key, label, min, max) {
    const id = 'ah-' + key
    const input = h('input', { id, type: 'number', min: String(min), max: String(max), step: '1', value: String(ah.form[key]), disabled: BOOT.readOnly })
    input.addEventListener('change', () => {
      const n = Math.round(Number(input.value))
      if (Number.isFinite(n)) ahEdit((f) => { f[key] = Math.min(max, Math.max(min, n)) })
    })
    return h('label', { class: 'field', for: id }, h('span', null, label), input)
  }
  function ahCheck(key, label, hintText) {
    const input = h('input', { type: 'checkbox', disabled: BOOT.readOnly })
    input.checked = Boolean(ah.form[key])
    input.addEventListener('change', () => ahEdit((f) => { f[key] = input.checked }))
    return h('div', { class: 'check-row' }, h('label', { class: 'check' }, input, h('span', null, h('b', null, label), hintText ? h('span', { class: 'muted small' }, hintText) : null)))
  }
  function accountLabel(ref) {
    const a = S.state.accounts.find((x) => x.ref === ref || (x.aliases || []).includes(ref))
    const alias = a && a.aliases && a.aliases[0]
    return a ? (alias && alias !== ref ? ref + ' (' + alias + ')' : a.ref) : ref
  }
  function ahFamily(fam) {
    const o = ah.form.orders[fam]
    const f = family(fam)
    const policy = h('select', { 'aria-label': t('ah.order', { host: f.title }), disabled: BOOT.readOnly },
      h('option', { value: 'pressure' }, t('ah.byQuota')), h('option', { value: 'order' }, t('ah.myOrder')))
    policy.value = o.policy
    policy.addEventListener('change', () => ahEdit((form) => { form.orders[fam].policy = policy.value }))
    const kids = [h('div', { class: 'ah-fam-head' }, h('b', { class: 'title-logo' }, badge(fam, 'sm'), t('ah.order', { host: f.title })), h('span', null, policy))]
    if (o.policy === 'order') {
      const move = (i, d) => ahEdit((form) => { const l = form.orders[fam].order; const x = l[i]; l[i] = l[i + d]; l[i + d] = x })
      kids.push(h('ol', { class: 'ah-order' }, o.order.map((ref, i) => h('li', null,
        h('span', { class: 'mono' }, (i + 1) + '. ' + accountLabel(ref)),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: BOOT.readOnly || i === 0, 'aria-label': t('ah.up'), onclick: () => move(i, -1) }, '↑'),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: BOOT.readOnly || i === o.order.length - 1, 'aria-label': t('ah.down'), onclick: () => move(i, 1) }, '↓'),
        h('button', { class: 'icon-btn', type: 'button', disabled: BOOT.readOnly, 'aria-label': t('ah.remove'), onclick: () => ahEdit((form) => { form.orders[fam].order.splice(i, 1) }) }, icon('x'))))))
      const taken = new Set(o.order)
      const free = S.state.accounts.filter((a) => !taken.has(a.ref) && !(a.aliases || []).some((n) => taken.has(n)))
      if (!o.order.length) kids.push(h('p', { class: 'note note-warn' }, t('ah.emptyOrder')))
      if (free.length && !BOOT.readOnly) {
        const pick = h('select', { 'aria-label': t('ah.add') }, h('option', { value: '' }, t('ah.add') + '…'), free.map((a) => h('option', { value: a.ref }, accountLabel(a.ref))))
        pick.addEventListener('change', () => { if (pick.value) ahEdit((form) => { form.orders[fam].order.push(pick.value) }) })
        kids.push(h('div', { class: 'ah-add' }, pick))
      }
    } else kids.push(h('p', { class: 'muted small' }, t('ah.byQuotaHint')))
    return h('div', { class: 'ah-fam' }, kids)
  }
  function ahReadiness() {
    if (ah.loading) return h('p', { class: 'muted' }, spinner(), ' ', t('ah.checking'))
    if (ah.error) return errorNote(ah.error, loadHandoffStatus)
    const st = ah.status
    if (!st) return null
    const rows = []
    if (st.sideby.problem) rows.push(h('p', { class: 'note note-fail' }, st.sideby.problem))
    for (const f of st.families) {
      const state = f.starts.length ? (f.ready ? h('span', { class: 'chip chip-sm chip-ok' }, t('ah.ready')) : h('span', { class: 'chip chip-sm chip-warn' }, t('ah.notYet'))) : h('span', { class: 'chip chip-sm' }, t('ah.takesOver'))
      rows.push(h('div', { class: 'ah-fam' }, h('div', { class: 'ah-fam-head' }, h('b', { class: 'title-logo' }, badge(f.family, 'sm'), family(f.family).title), state),
        f.problems.map((p) => h('p', { class: 'note note-warn' }, p)),
        f.notes.map((n) => h('p', { class: 'muted small' }, n))))
    }
    if (st.nextSteps.length) rows.push(h('p', { class: 'small' }, h('b', null, t('ah.steps'))), h('ol', { class: 'ah-steps' }, st.nextSteps.map((s) => h('li', null, codeCopy(s)))))
    return rows
  }
  function renderHandoff() {
    const st = ahState()
    if (!st || !ah) return
    const f = ah.form
    const body = [h('p', { class: 'muted small' }, t('ah.intro'), ' ',
      h('button', { class: 'link-btn', type: 'button', onclick: askHandoff }, icon('bot'), t('ask.title.handoff')))]
    if (BOOT.readOnly) body.push(h('p', { class: 'note' }, t('banner.readOnly')))
    body.push(ahCheck('auto', t('ah.auto'), null))
    body.push(ahCheck('sameFamily', t('ah.sameFamily'), t('ah.sameFamilyWarn')))
    body.push(h('div', { class: 'ah-grid' },
      ahNumber('prepareAt', t('ah.prepareAt'), 1, 99),
      ahNumber('threshold', t('ah.threshold'), 2, 100),
      ahNumber('wait', t('ah.wait'), 0, 300),
      ahNumber('countdown', t('ah.countdown'), 0, 60)))
    if (f.prepareAt >= f.threshold) body.push(h('p', { class: 'note note-warn' }, t('ah.badLevels')))
    for (const fam of st.starters) body.push(ahFamily(fam))
    // The result of Review or Apply sits right under the form, where the button that made it is.
    if (ah.applyError) body.push(errorNote(ah.applyError, null))
    if (ah.saved) body.push(h('p', { class: 'note' }, t('ah.saved', { file: ah.saved })))
    if (ah.nothing) body.push(h('p', { class: 'muted small' }, t('ah.nothing')))
    if (ah.preview) body.push(h('p', { class: 'small' }, tx('ah.changes', { file: h('code', null, ah.preview.file) })), diffView(ah.preview.diff))
    body.push(h('h3', { class: 'small' }, t('ah.readiness')))
    body.push(ahReadiness())
    const foot = [h('button', { class: 'btn', type: 'button', disabled: ah.applying, onclick: () => dlg.el.close() }, t('btn.close'))]
    if (!BOOT.readOnly) {
      const bad = f.prepareAt >= f.threshold
      if (ah.preview) foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: ah.applying, 'aria-busy': ah.applying ? 'true' : null, onclick: applyHandoff }, ah.applying ? spinner() : null, ah.applying ? t('ah.applying') : t('ah.apply')))
      else foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: bad || ah.reviewing, onclick: reviewHandoff }, ah.reviewing ? spinner() : null, t('ah.review')))
    }
    setKids(dlg.el, dialogFrame(t('ah.title'), null, body, foot))
  }
  async function reviewHandoff() {
    const change = handoffChangeOf(ahState().settings, ah.form)
    if (!Object.keys(change).length) { ah.nothing = true; renderHandoff(); return }
    ah.reviewing = true
    ah.applyError = null
    renderHandoff()
    try {
      const r = await api('/api/handoff/configure', { change })
      ah.preview = r.changed ? { change, file: r.file, diff: r.diff } : null
      ah.nothing = !r.changed
    } catch (e) { ah.applyError = e }
    ah.reviewing = false
    renderHandoff()
  }
  async function applyHandoff() {
    ah.applying = true
    dlg.busy = true
    renderHandoff()
    try {
      const r = await api('/api/handoff/configure', { change: ah.preview.change, confirm: true })
      ah.saved = r.file
      ah.preview = null
      toast(r.settings.auto ? t('toast.ahOn') : t('toast.ahOff'))
      await load({ silent: true })
      if (ahState()) ah.form = handoffForm()
      ah.loading = true
      ah.status = null
    } catch (e) { ah.applyError = e }
    ah.applying = false
    dlg.busy = false
    renderHandoff()
    if (ah.loading) loadHandoffStatus()
  }

  // ---------- model and effort (spec §3.19) ----------
  // Shown under the account name; the dialog changes what sideby starts this account with, never the Host's files.
  let md = null
  function modelFrom(a, from) { return t('md.from.' + from, { host: family(a.family).title }) }
  function modelChip(a) {
    const mi = a.modelInfo
    if (!mi || (!mi.model && !mi.effort)) return null
    // The row has little room; the hover text keeps the full model id.
    const text = [mi.model && mi.model.value.replace(/^claude-/, ''), mi.effort && mi.effort.value].filter(Boolean).join(' · ')
    // A value from the last session may differ from what a new session starts with; say both.
    const line = (label, v, key) => {
      if (!v) return null
      const out = label + ': ' + v.value + ' (' + modelFrom(a, v.from) + ')'
      const host = mi.host && mi.host[key]
      // 'opus' and 'claude-opus-5-5' name the same model: only a real difference is worth a line.
      return v.from === 'last' && host && !v.value.includes(host)
        ? out + '; ' + t('md.newDefault', { value: host, from: modelFrom(a, 'host') })
        : out
    }
    const title = [
      line(t('md.model'), mi.model, 'model'),
      line(t('md.effort'), mi.effort, 'effort'),
      mi.settable ? t('md.click') : null,
    ].filter(Boolean).join('\n')
    if (!mi.settable) return h('span', { class: 'mono', title }, text)
    return h('button', { class: 'mono model-btn' + (mi.model && mi.model.from === 'sideby' ? ' model-set' : ''), type: 'button', title, 'aria-label': t('menu.model') + ' ' + a.ref + ': ' + text, onclick: (e) => { e.stopPropagation(); openModel(a) } }, text)
  }
  function mdAccount() { return S.state && S.state.accounts.find((x) => x.ref === md.ref) }
  function openModel(a) {
    md = { ref: a.ref, family: a.family, preview: null, busy: false, error: null, form: null }
    showDialog('model')
    renderModel()
  }
  // The inputs are built once per opening, so typing keeps focus; everything else re-renders around them.
  function mdForm(a) {
    if (md.form) return md.form
    const mi = a.modelInfo
    const host = family(a.family).title
    const list = h('datalist', { id: 'md-models' }, mi.models.map((m) => h('option', { value: m })))
    const model = h('input', { type: 'text', list: 'md-models', autocomplete: 'off', spellcheck: 'false', placeholder: t('md.default') + ' (' + t('md.decides', { host }) + ')', disabled: BOOT.readOnly })
    model.value = mi.sideby.model || ''
    const effort = h('select', { disabled: BOOT.readOnly }, h('option', { value: '' }, t('md.default') + ' (' + t('md.decides', { host }) + ')'), mi.efforts.map((e) => h('option', { value: e }, e)))
    effort.value = mi.sideby.effort || ''
    const changed = () => { md.preview = null; md.error = null; renderModel() }
    model.addEventListener('input', () => { if (md.preview) changed() })
    effort.addEventListener('change', changed)
    md.form = { model, effort, list }
    return md.form
  }
  function mdChange(a, reset) {
    const mi = a.modelInfo
    if (reset) return { model: mi.sideby.model ? null : undefined, effort: mi.sideby.effort ? null : undefined }
    const f = md.form
    const m = f.model.value.trim()
    const ch = {}
    if (m !== (mi.sideby.model || '')) ch.model = m || null
    if (f.effort.value !== (mi.sideby.effort || '')) ch.effort = f.effort.value || null
    return ch
  }
  async function mdReview(reset) {
    const a = mdAccount()
    if (!a) return
    const change = mdChange(a, reset)
    for (const k of Object.keys(change)) if (change[k] === undefined) delete change[k]
    md.error = null
    if (!Object.keys(change).length) { md.preview = { nothing: true }; renderModel(); return }
    md.busy = true
    renderModel()
    try {
      const r = await api('/api/account/model', Object.assign({ account: a.ref }, change))
      md.preview = r.changed ? { change, diff: r.diff } : { nothing: true }
    } catch (e) { md.error = e }
    md.busy = false
    renderModel()
  }
  async function mdApply() {
    const a = mdAccount()
    if (!a || !md.preview || !md.preview.change) return
    md.busy = true
    dlg.busy = true
    renderModel()
    try {
      await api('/api/account/model', Object.assign({ account: a.ref, confirm: true }, md.preview.change))
      dlg.busy = false
      toast(t('md.saved', { ref: a.ref }))
      dlg.el.close()
      await load({ silent: true })
      return
    } catch (e) { md.error = e }
    md.busy = false
    dlg.busy = false
    renderModel()
  }
  function renderModel() {
    if (!md || dlg.kind !== 'model') return
    const a = mdAccount()
    if (!a || !a.modelInfo) { dlg.el.close(); return }
    const mi = a.modelInfo
    const host = family(a.family).title
    const f = mdForm(a)
    const now = (key) => mi[key] ? h('span', null, h('b', { class: 'mono' }, mi[key].value), ' ', h('span', { class: 'muted small' }, '(' + modelFrom(a, mi[key].from) + ')')) : h('span', { class: 'muted' }, t('md.none'))
    const body = [h('p', { class: 'muted small' }, t('md.intro', { ref: a.ref, host }))]
    if (BOOT.readOnly) body.push(h('p', { class: 'note' }, t('banner.readOnly')))
    body.push(h('div', { class: 'md-now' },
      h('div', null, h('span', { class: 'muted' }, t('md.model') + ': '), now('model')),
      h('div', null, h('span', { class: 'muted' }, t('md.effort') + ': '), now('effort'))))
    body.push(h('div', { class: 'ah-grid' },
      h('label', { class: 'field' }, h('span', null, t('md.model')), f.model, f.list),
      h('label', { class: 'field' }, h('span', null, t('md.effort')), f.effort)))
    if (a.family === 'claude') body.push(h('p', { class: 'muted small' }, t('md.envNote')))
    if (md.error) body.push(errorNote(md.error, null))
    if (md.preview && md.preview.nothing) body.push(h('p', { class: 'muted small' }, t('md.nothing')))
    if (md.preview && md.preview.diff) body.push(h('p', { class: 'small' }, t('md.changes')), diffView(md.preview.diff))
    const foot = [h('button', { class: 'btn', type: 'button', disabled: md.busy, onclick: () => dlg.el.close() }, t('btn.close'))]
    if (!BOOT.readOnly) {
      if (mi.sideby.model || mi.sideby.effort) foot.push(h('button', { class: 'btn', type: 'button', disabled: md.busy, onclick: () => mdReview(true) }, t('md.reset')))
      if (md.preview && md.preview.change) foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: md.busy, 'aria-busy': md.busy ? 'true' : null, onclick: mdApply }, md.busy ? spinner() : null, t('md.apply')))
      else foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: md.busy, onclick: () => mdReview(false) }, md.busy ? spinner() : null, t('md.review')))
    }
    setKids(dlg.el, dialogFrame(t('md.title') + ' · ' + a.ref, a.family, body, foot))
  }

  // ---------- the Auto Handoff page ----------
  // Off: one sentence and one button. On: where each account's work would go next, the last hand-overs and what is
  // still missing. Turning on is one plan shown first (hp.preview) and one confirmation; no commands to copy.
  const hp = { data: null, plan: null, loading: false, error: null, preview: null, previewing: false, applying: false, failed: null, changed: false, sameFamily: false, sameTouched: false, busyOff: false, askSame: false }
  async function loadHandoffPage() {
    hp.loading = true
    hp.error = null
    renderHandoffPage()
    try {
      // What is missing is only worth the check once it is on; while off the button shows the whole plan.
      const [data, plan] = await Promise.all([api('/api/handoff/overview', {}), ahState().settings.auto ? api('/api/handoff/enable', {}) : Promise.resolve(null)])
      hp.data = data
      hp.plan = plan
    } catch (e) { hp.error = e }
    hp.loading = false
    renderHandoffPage()
  }
  // Off, the box on this page decides; on, "finish setting up" keeps whatever is set.
  function hpBody() { return ahState().settings.auto ? {} : { sameFamily: hp.sameFamily } }
  async function hpPreview() {
    hp.previewing = true
    hp.failed = null
    hp.changed = false
    renderHandoffPage()
    try { hp.preview = await api('/api/handoff/enable', hpBody()) } catch (e) { hp.failed = { error: e } }
    hp.previewing = false
    renderHandoffPage()
  }
  async function hpApply() {
    hp.applying = true
    hp.failed = null
    renderHandoffPage()
    try {
      const r = await api('/api/handoff/enable', Object.assign(hpBody(), { confirm: true, expect: hp.preview && hp.preview.key }))
      const bad = r.results.find((x) => !x.ok)
      // A plan that changed since it was shown is shown again; one with nothing left to do means it is already on.
      hp.changed = Boolean(r.changed) && !r.plan.alreadyOn
      if (hp.changed || r.plan.blocked) hp.preview = r.plan
      else if (bad) hp.failed = { step: bad, plan: r.plan }
      else { hp.preview = null; toast(t('toast.ahOn')) }
      await load({ silent: true })
      await loadHandoffPage()
    } catch (e) { hp.failed = { error: e } }
    hp.applying = false
    renderHandoffPage()
  }
  async function hpChange(change, message) {
    hp.busyOff = true
    renderHandoffPage()
    try {
      await api('/api/handoff/configure', { change, confirm: true })
      hp.preview = null
      hp.askSame = false
      toast(message)
      await load({ silent: true })
      await loadHandoffPage()
    } catch (e) { hp.failed = { error: e } }
    hp.busyOff = false
    renderHandoffPage()
  }
  function hpStepTitle(step) {
    const host = step.family ? family(step.family).title : ''
    return t('hp.step.' + step.id, { host, accounts: (step.accounts || []).join(', ') })
  }
  function hpSteps(plan) {
    return h('ul', { class: 'hp-steps' }, plan.steps.map((step) => h('li', null, h('div', null,
      h('div', null, hpStepTitle(step)),
      step.diff ? h('details', { class: 'small' }, h('summary', null, t('hp.showChange')), h('p', { class: 'muted small' }, tx('ah.changes', { file: h('code', null, step.file) })), diffView(step.diff)) : null))))
  }
  function hpManual(plan) {
    return plan.manual.map((m) => h('p', { class: 'note' }, m.id === 'codex-trust' ? t('hp.manual.codexTrust') : (family(m.family).title + ': ' + (m.message || ''))))
  }
  function hpPreviewCard() {
    const p = hp.preview
    const kids = [h('h3', { class: 'small' }, t('hp.willDo'))]
    if (hp.changed) kids.push(h('p', { class: 'note note-warn', role: 'status' }, t('hp.planChanged')))
    if (p.blocked) kids.push(h('p', { class: 'note note-fail' }, t('hp.blocked', { why: p.blocked })), codeCopy('npm i -g sideby'))
    else {
      kids.push(hpSteps(p), ...hpManual(p))
      kids.push(p.sameFamily ? h('p', { class: 'note note-warn' }, t('ah.sameFamilyWarn')) : h('p', { class: 'muted small' }, t('hp.sameFamilyOffNote')))
    }
    const foot = [h('button', { class: 'btn', type: 'button', disabled: hp.applying, onclick: () => { hp.preview = null; hp.failed = null; hp.changed = false; renderHandoffPage() } }, t('btn.cancel'))]
    if (!p.blocked) foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: hp.applying, 'aria-busy': hp.applying ? 'true' : null, onclick: hpApply }, hp.applying ? spinner() : null, hp.applying ? t('hp.applying') : t('hp.confirmOn')))
    kids.push(h('div', { class: 'row-actions' }, foot))
    return h('div', { class: 'ah-fam' }, kids)
  }
  function hpFailed() {
    const f = hp.failed
    if (!f) return null
    if (f.error) return errorNote(f.error, null)
    return h('p', { class: 'note note-fail', role: 'alert' }, t('hp.stepFailed', { step: hpStepTitle(f.step), why: f.step.message || '' }) + ' ' + t('hp.tryAgain'))
  }
  function hpDecision(d, starts) {
    const thr = ahState().settings.threshold
    if (d.kind === 'pick') return starts.includes('quota') ? t('hp.goesTo', { to: accountLabel(d.ref), p: thr }) : t('hp.goesToLimit', { to: accountLabel(d.ref) })
    if (d.kind === 'wait') return t('hp.waits', { at: clock(d.until) })
    return d.earliestReset ? t('hp.noneBack', { ref: accountLabel(d.earliestReset.ref), at: clock(d.earliestReset.at) }) : t('hp.none')
  }
  // The one case where reaching the threshold does not switch (spec §3.17 "选号" 1); none when waiting is off.
  function hpWaitRule(st) {
    const w = st.settings.waitIfResetWithinMinutes
    return w > 0 ? ' ' + t('hp.waitRule', { w }) : null
  }
  function hpRows(d) {
    if (!d.takeover.length) return h('p', { class: 'muted small' }, t('hp.noAccounts'))
    return h('ul', { class: 'hp-rows' }, d.takeover.map((r) => {
      const a = S.state.accounts.find((x) => x.ref === r.ref)
      const p = a ? quotaPressure(a, Date.now()) : -1
      return h('li', null,
        h('span', { class: 'title-logo' }, badge(r.family, 'sm'), h('b', { class: 'mono' }, accountLabel(r.ref))),
        h('span', { class: 'muted' }, p >= 0 ? t('hp.used', { p: Math.round(p) }) : t('hp.noQuota')),
        h('span', null, hpDecision(r.decision, r.starts)))
    }))
  }
  function hpRecent(d) {
    if (!d.recent.length) return h('p', { class: 'muted small' }, t('hp.noneYet'))
    return h('ul', { class: 'hp-rows' }, d.recent.map((r) => h('li', null,
      h('span', { class: 'mono' }, accountLabel(r.from) + ' → ' + accountLabel(r.to)),
      h('span', { class: 'muted' }, clock(r.at) + ' · ' + ago(r.at)),
      h('span', { class: 'muted' }, r.trigger ? t('hp.why.' + r.trigger) : ''))))
  }
  function hpSameFamilyBox(checked, onchange) {
    const input = h('input', { type: 'checkbox', disabled: BOOT.readOnly || hp.busyOff || hp.applying })
    input.checked = checked
    input.addEventListener('change', () => onchange(input.checked))
    return h('div', { class: 'check-row' }, h('label', { class: 'check' }, input, h('span', null, h('b', null, t('hp.sameFamily')), h('span', { class: 'muted small' }, t('ah.sameFamilyWarn')))))
  }
  function renderHandoffPage() {
    const box = $('handoff-page')
    if (box.hidden || !S.state) return
    const st = ahState()
    if (!st) return
    const kids = [h('div', { class: 'section-head' },
      h('h2', { id: 'h-handoff' }, t('hp.title')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: askHandoff }, icon('bot'), t('ask.title.handoff')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: openHandoff }, t('hp.advanced')),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: hp.loading, onclick: loadHandoffPage }, hp.loading ? spinner() : icon('refresh'), t('top.refresh'))))]
    const on = st.settings.auto
    if (hp.loading && !hp.data) kids.push(h('p', { class: 'muted' }, spinner(), ' ', t('hp.loading')))
    if (hp.error) kids.push(errorNote(hp.error, loadHandoffPage))
    if (BOOT.readOnly) kids.push(h('p', { class: 'note' }, t('banner.readOnly')))
    if (!on) {
      kids.push(h('p', null, t('hp.intro')))
      kids.push(h('ol', { class: 'hp-how' }, h('li', null, t('hp.how1')), h('li', null, t('hp.how2', { p: st.settings.threshold }), hpWaitRule(st)), h('li', null, t('hp.how3', { s: st.settings.countdownSeconds }))))
      if (!S.state.accounts.some((a) => a.kind !== 'api' && st.starters.includes(a.family))) kids.push(h('p', { class: 'note' }, t('hp.noStarters')))
      else {
        if (!hp.preview) {
          // Until the person touches the box it shows what is set now, so turning on again keeps an earlier choice.
          if (!hp.sameTouched) hp.sameFamily = st.settings.sameFamily
          kids.push(hpSameFamilyBox(hp.sameFamily, (v) => { hp.sameFamily = v; hp.sameTouched = true }))
          kids.push(h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'button', disabled: BOOT.readOnly || hp.previewing, 'aria-busy': hp.previewing ? 'true' : null, onclick: hpPreview }, hp.previewing ? spinner() : null, t('hp.turnOn'))))
        } else kids.push(hpPreviewCard())
      }
    } else {
      kids.push(h('p', null, h('span', { class: 'chip chip-ok' }, t('ah.on')), ' ', t('hp.onNote', { p: st.settings.threshold }), hpWaitRule(st)))
      const d = hp.data
      if (d) {
        kids.push(h('h3', { class: 'small' }, t('hp.takeover')), hpRows(d))
        kids.push(h('h3', { class: 'small' }, t('hp.recent')), hpRecent(d))
      }
      const plan = hp.plan
      if (plan && (plan.blocked || plan.steps.length)) {
        kids.push(h('h3', { class: 'small' }, t('hp.missing')))
        if (!hp.preview) {
          if (plan.blocked) kids.push(h('p', { class: 'note note-fail' }, t('hp.blocked', { why: plan.blocked })), codeCopy('npm i -g sideby'))
          else {
            kids.push(hpSteps(plan))
            kids.push(h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'button', disabled: BOOT.readOnly || hp.previewing, onclick: hpPreview }, hp.previewing ? spinner() : null, t('hp.complete'))))
          }
        } else kids.push(hpPreviewCard())
      } else if (plan) kids.push(...hpManual(plan))
      kids.push(h('p', { class: 'muted small' }, t('hp.onlySideby')))
      kids.push(hpSameFamilyBox(st.settings.sameFamily, (v) => {
        if (v) { hp.askSame = true; renderHandoffPage() } else { hp.askSame = false; hpChange({ sameFamily: false }, t('hp.sameOff')) }
      }))
      if (hp.askSame && !st.settings.sameFamily) kids.push(h('div', { class: 'ah-fam' },
        h('p', { class: 'note note-warn' }, t('ah.sameFamilyWarn')),
        h('div', { class: 'row-actions' },
          h('button', { class: 'btn', type: 'button', disabled: hp.busyOff, onclick: () => { hp.askSame = false; renderHandoffPage() } }, t('btn.cancel')),
          h('button', { class: 'btn btn-primary', type: 'button', disabled: BOOT.readOnly || hp.busyOff, onclick: () => { hp.askSame = false; hpChange({ sameFamily: true }, t('hp.sameOn')) } }, t('hp.sameConfirm')))))
      kids.push(h('div', { class: 'row-actions' }, h('button', { class: 'btn', type: 'button', disabled: BOOT.readOnly || hp.busyOff, onclick: () => hpChange({ auto: false }, t('toast.ahOff')) }, hp.busyOff ? spinner() : null, t('hp.turnOff'))))
    }
    kids.push(hpFailed())
    setKids(box, kids)
  }

  // ---------- Remote Control (spec §3.22) ----------
  // Shown while some Claude settings file turns Remote Control on. "Turn all off" first lists each file, the change
  // and the accounts it reaches, in the banner itself; the toast after it carries the undo.
  // target: the side the dialog's switch was moved to, waiting for its confirmation; null while nothing is chosen.
  const rc = { confirm: false, busy: false, target: null }
  const shortRef = (ref) => ref.replace(/^claude:/, '')
  function remoteControlBanner() {
    const groups = S.state.remoteControl || []
    // API Accounts never sign in to claude.ai, so Remote Control cannot reach their sessions.
    const api = new Set(S.state.accounts.filter((a) => a.kind === 'api').map((a) => a.ref))
    const refs = groups.filter((g) => g.state === 'on').flatMap((g) => g.accounts).filter((r) => !api.has(r)).map(shortRef)
    if (!refs.length || prefs.rcHide) return null
    const todo = groups.filter((g) => g.state === 'on' || g.state === 'default')
    const text = h('div', null, h('b', null, t('rc.title') + ' '), tn('rc.body', refs.length, { refs: refs.join(', ') }))
    if (BOOT.readOnly) return h('div', { class: 'banner banner-warn', role: 'status' }, h('div', null, text, ' ', t('rc.readOnly')))
    if (!rc.confirm)
      return h('div', { class: 'banner banner-warn', role: 'status' }, text,
        h('div', { class: 'banner-actions' },
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { rc.confirm = true; renderBanners() } }, t('rc.turnOff')),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { prefs.rcHide = true; savePrefs(); renderBanners(); toast(t('rc.hidden')) } }, t('rc.keep'))))
    const lines = todo.map((g) => h('li', null, h('code', null, g.file), ' ',
      t('rc.change', { from: g.state === 'on' ? 'true' : t('rc.notSet'), to: 'false' }), ' ',
      h('span', { class: 'muted' }, t('rc.usedBy', { refs: g.accounts.map(shortRef).join(', ') }))))
    return h('div', { class: 'banner banner-warn', role: 'status' },
      h('div', null, h('b', null, t('rc.confirmTitle')), h('ul', null, lines), h('div', { class: 'small' }, t('rc.confirmNote'))),
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: rc.busy, onclick: () => setRemoteControl('off') }, rc.busy ? spinner() : null, t('rc.confirm')),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: rc.busy, onclick: () => { rc.confirm = false; renderBanners() } }, t('btn.cancel'))))
  }
  async function setRemoteControl(to) {
    rc.busy = true
    renderBanners()
    if (dlg.kind === 'rc') renderRc()
    const fail = to === 'on' ? 'rc.failedOn' : 'rc.failed'
    try {
      const r = await api('/api/remote-control/' + to, {})
      if (r.ok) {
        // Show the new state now; the reload that follows confirms it.
        const changed = new Set(remoteControlTodo(S.state.remoteControl || [], to).map((g) => g.file))
        S.state.remoteControl = (S.state.remoteControl || []).map((g) => changed.has(g.file) ? { ...g, state: to, undo: true } : g)
        toast(t(to === 'on' ? 'rc.doneOn' : 'rc.done'), { action: { label: t('toast.undo'), run: remoteControlUndo }, duration: 12000 })
      }
      else toast(t(fail, { msg: r.message }), { kind: 'fail' })
    } catch (e) { toast(t(fail, { msg: e.message }), { kind: 'fail' }) }
    rc.busy = false
    rc.confirm = false
    rc.target = null
    renderBanners()
    if (dlg.kind === 'rc') renderRc()
    await load({ silent: true })
  }
  async function remoteControlUndo() {
    try {
      const r = await api('/api/remote-control/undo', {})
      toast(r.ok ? t('rc.undone') : r.message, { kind: r.ok ? 'ok' : 'fail' })
    } catch (e) { toast(t('toast.undoFailed', { msg: e.message }), { kind: 'fail' }) }
    await load({ silent: true })
  }
  // The header button keeps the setting in reach after the banner is gone (turned off, or "Keep it on").
  function rcSummary() {
    const api = S.state.accounts.filter((a) => a.kind === 'api').map((a) => a.ref)
    return remoteControlSummary(S.state.remoteControl || [], api)
  }
  // The refresh button reads everything again; Families that ask their Host for Quota (Grok, spec §3.26) are asked
  // again first, so the numbers are new and not the kept ones.
  function asking() { return !BOOT.readOnly && S.state && (S.state.quotaChecks || []).some((c) => c.on && !c.blocked) }
  async function refreshAll() {
    if (asking()) {
      const btn = $('refresh')
      btn.disabled = true
      btn.classList.add('is-spinning')
      try { await api('/api/quota/refresh', {}) } catch (e) { toast(t('quota.refreshFailed', { msg: e.message }), { kind: 'fail' }) }
      btn.classList.remove('is-spinning')
      btn.disabled = false
    }
    load({ check: true, announce: true })
  }
  function checkOf(fam) { return S.state && (S.state.quotaChecks || []).find((c) => c.family === fam) }
  async function setCheck(fam, on) {
    try {
      await api('/api/quota/check', { family: fam, on })
      toast(t(on ? 'quota.checkOnToast' : 'quota.checkOffToast', { host: famTitleOf(fam) }))
    } catch (e) { toast(t('quota.checkFailed', { msg: e.message }), { kind: 'fail' }) }
    load({ silent: true })
  }
  function famTitleOf(fam) { const f = S.state && S.state.families.find((x) => x.id === fam); return f ? f.title : fam }
  // ---------- settings ----------
  // One header button holds what is set once and rarely changed: language, theme, Remote Control and Auto Handoff.
  // A dot on it says Remote Control starts by itself, so that state stays visible after its banner is gone.
  function settingsSections() {
    const out = []
    if (!LANG_FIXED) out.push('lang')
    if (BOOT.colorScheme === 'auto') out.push('theme')
    out.push('startup')
    if (S.state && S.state.accounts.length && !BOOT.readOnly) out.push('order')
    out.push('ai')
    if (S.state && rcSummary()) out.push('rc')
    if (S.state && ahState()) out.push('ah')
    if (S.state && (S.state.quotaChecks || []).length) out.push('checks')
    return out
  }
  function renderSettingsButton() {
    const b = $('settings')
    const secs = settingsSections()
    b.hidden = !secs.length
    const warn = secs.includes('rc') && rcSummary() === 'on'
    setKids(b, [icon('gear'), h('span', { class: 'hide-sm' }, t('set.button')), warn ? h('span', { class: 'dot set-dot', 'aria-hidden': 'true' }) : null])
    b.setAttribute('aria-label', t('set.button') + (warn ? ': ' + t('set.rcOn') : ''))
    refreshSettings()
    if (dlg.kind === 'rc') renderRc()
  }
  // The popover and the full settings dialog show the same groups (spec §3.29), top to bottom: Appearance, Startup,
  // Accounts and quota, Let AI help. leave() closes whichever holds them before a link goes elsewhere; a link that
  // opens a dialog keeps the dialog element open (opens: true), since one dialog element is shared.
  function settingsGroups(leave) {
    const secs = settingsSections()
    const seg = (label, opts, cur, pick) => h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, label),
      h('div', { class: 'seg', role: 'group', 'aria-label': label }, opts.map(([v, text]) =>
        h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(v === cur), onclick: () => pick(v) }, text))))
    const link = (label, state, cls, run, opens) => h('button', { class: 'menu-item set-link', type: 'button', onclick: () => { leave(opens); run() } },
      h('span', { class: 'menu-label' }, label), state ? h('span', { class: 'chip chip-sm ' + cls }, state) : null, icon('chevron'))
    const look = []
    if (secs.includes('lang')) look.push(seg(t('set.lang'), [['en', 'English'], ['zh', '中文']], lang, setLang))
    if (secs.includes('theme')) look.push(seg(t('set.theme'), CHOICES.theme.map((v) => [v, t('set.theme.' + v)]), viewPrefs().theme, setTheme))
    const start = [autostartRow('autostart')]
    // The menu bar switch shows only where it works (macOS); while its state loads it waits, unseen.
    if (li.menubar.status && li.menubar.status.supported) start.push(autostartRow('menubar'))
    if (!BOOT.readOnly) start.push(link(t('term.title'), '', '', openTerminals, true))
    const acct = []
    // The arrange mode (spec §3.25) has a place here too, where people look for "how do I change this".
    if (secs.includes('order')) {
      const pins = Object.values(displayOf().pinned || {}).some((x) => x.length)
      acct.push(link(t('set.order'), t(ordered() || pins ? 'set.orderMine' : 'set.orderDefault'), '', () => {
        setPage('accounts')
        startArrange()
        const bar = document.querySelector('#accounts .arrange-bar')
        if (bar) bar.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' })
      }))
    }
    // Quota checks that ask the Host (spec §3.26): one switch per Family, with what it does in plain words.
    if (secs.includes('checks')) {
      for (const c of S.state.quotaChecks) {
        const label = t('set.quotaCheck', { host: c.title })
        acct.push(h('div', { class: 'set-row set-check' },
          h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, label), h('span', { class: 'set-hint' }, c.blocked ? c.blocked : t('set.quotaCheckHint', { host: c.title, n: c.everyMinutes }))),
          BOOT.readOnly ? h('span', { class: 'chip chip-sm' + (c.on ? ' chip-ok' : '') }, c.on ? t('ah.on') : t('ah.off'))
            : h('div', { class: 'seg', role: 'group', 'aria-label': label }, [[true, t('ah.on')], [false, t('ah.off')]].map(([v, text]) =>
              h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(v === c.on), onclick: () => { if (v !== c.on) { leave(false); setCheck(c.family, v) } } }, text)))))
      }
    }
    if (secs.includes('rc')) {
      const sum = rcSummary()
      acct.push(link(t('rc.button'), t('rc.state.' + sum), sum === 'on' ? 'chip-warn' : sum === 'off' ? 'chip-ok' : '', openRc, true))
    }
    if (secs.includes('ah')) {
      const on = ahState().settings.auto
      acct.push(link(t('ah.button'), on ? t('ah.on') : t('ah.off'), on ? 'chip-ok' : '', () => setPage('handoff')))
    }
    // Everything here can also be asked of an AI assistant through the sideby skill (spec §3.8).
    const ai = [
      link(t('ai.title'), t(skillInstalled() ? 'ai.installed' : 'ai.notInstalled'), skillInstalled() ? 'chip-ok' : '', () => openAsk(), true),
      link(t('ask.plugin'), '', '', () => openAsk({ task: 'plugin', context: { version: BOOT.version } }), true),
    ]
    return [
      { title: t('set.g.look'), items: look },
      { title: t('set.g.start'), items: start },
      { title: t('set.g.accounts'), items: acct },
      { title: t('set.g.ai'), items: ai },
    ].filter((g) => g.items.length)
  }
  function settingsBody(leave) {
    const out = []
    settingsGroups(leave).forEach((g, i) => {
      if (i) out.push(h('div', { class: 'menu-sep set-sep', role: 'separator' }))
      out.push(h('div', { class: 'set-group', role: 'group', 'aria-label': g.title }, h('div', { class: 'set-group-title', 'aria-hidden': 'true' }, g.title), g.items))
    })
    return out
  }
  // Taller than the window, the popover scrolls inside and ends with "More settings…", the same groups in a dialog.
  function settingsPop() {
    loadAutostart()
    return [...settingsBody(() => closeMenu()),
      h('button', { class: 'menu-item set-more', type: 'button', hidden: true, onclick: () => { closeMenu(); openSettingsDialog() } }, h('span', { class: 'menu-label' }, t('set.more')), icon('chevron'))]
  }
  function settingsFit() {
    const el = menu.el
    const more = el && el.querySelector('.set-more')
    if (!more) return
    more.hidden = true
    more.hidden = !(el.scrollHeight > el.clientHeight + 1)
  }
  function openSettingsDialog() {
    loadAutostart()
    showDialog('settings')
    renderSettingsDialog()
  }
  function renderSettingsDialog() {
    const leave = (opens) => { if (!opens && dlg.kind === 'settings') dlg.el.close() }
    setKids(dlg.el, dialogFrame(t('set.title'), null, h('div', { class: 'set-dialog' }, settingsBody(leave)),
      [h('button', { class: 'btn', type: 'button', onclick: () => dlg.el.close() }, t('btn.close'))]))
  }
  function refreshSettings() {
    refreshPopover('settings')
    if (dlg.kind === 'settings') renderSettingsDialog()
  }

  // ---------- start at login (spec §3.29, ADR-0029) and the Menu Bar Item (spec §3.31, ADR-0034) ----------
  // Each switch reads its state when the settings open; moving it shows the file and what will run, and only the
  // confirmation writes. A read-only Panel shows the state only. mb.* words override as.* for the menu bar.
  const liState = () => ({ status: null, loading: false, error: null, want: null, plan: null, planning: false, planError: null, busy: false })
  const li = { autostart: liState(), menubar: liState() }
  let liKind = 'autostart'
  function lt(k, key, vars) {
    const own = (k === 'menubar' ? 'mb.' : 'as.') + key
    return t(Object.hasOwn(MESSAGES.en, own) ? own : 'as.' + key, vars)
  }
  function loadAutostart() {
    // A failed read is not retried here: the settings re-render after every read, so a retry would loop.
    for (const k of Object.keys(li)) if (!li[k].status && !li[k].loading && !li[k].error) loadLoginItem(k)
  }
  async function loadLoginItem(k) {
    const st = li[k]
    st.loading = true
    try { st.status = await api('/api/' + k); st.error = null } catch (e) { st.error = e }
    st.loading = false
    refreshSettings()
    if (k === 'menubar') renderAll()
  }
  function autostartRow(k) {
    const st = li[k]
    const s = st.status
    const n = autostartNote(s, BOOT.readOnly)
    const label = lt(k, 'label')
    const hint = [st.error ? lt(k, 'failed', { msg: st.error.message }) : lt(k, n.key.slice(3))]
    if (n.action === 'fix') hint.push(' ', h('button', { class: 'link-btn small', type: 'button', onclick: () => autostartAsk(true, k) }, lt(k, 'fix')))
    if (s && s.state === 'foreign') hint.push(' ', h('button', { class: 'link-btn small', type: 'button', title: s.path, onclick: () => copyText(s.path) }, lt(k, 'copyPath')))
    let ctl = null
    if (!s) ctl = st.loading ? spinner() : null
    else if (n.toggle) ctl = h('div', { class: 'seg', role: 'group', 'aria-label': label }, [[true, t('ah.on')], [false, t('ah.off')]].map(([v, text]) =>
      h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(v === n.on), onclick: () => { if (v !== n.on) autostartAsk(v, k) } }, text)))
    else if (s.supported && s.state !== 'foreign') ctl = h('span', { class: 'chip chip-sm' + (n.on ? ' chip-ok' : '') }, n.on ? t('ah.on') : t('ah.off'))
    return h('div', { class: 'set-row set-check' },
      h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, label), h('span', { class: 'set-hint' }, hint)), ctl)
  }
  async function autostartAsk(on, k) {
    if (menu.kind === 'settings') closeMenu()
    liKind = k
    const st = li[k]
    st.want = on
    st.plan = null
    st.planError = null
    st.planning = true
    showDialog('autostart')
    renderAutostart()
    try { st.plan = (await api('/api/' + k, { on })).plan } catch (e) { st.planError = e }
    st.planning = false
    if (dlg.kind === 'autostart' && liKind === k) renderAutostart()
  }
  function renderAutostart() {
    const k = liKind
    const st = li[k]
    const p = st.plan
    const on = st.want
    const body = []
    if (st.planning) body.push(h('p', { class: 'muted' }, spinner(), ' ', lt(k, 'planning')))
    else if (st.planError) body.push(errorNote(st.planError, () => autostartAsk(on, k)))
    else if (p && p.blocked) {
      const own = 'as.block.' + p.blocked.code
      body.push(h('p', { class: 'note note-fail' }, Object.hasOwn(MESSAGES.en, own) ? t(own) : p.blocked.message))
      if (['npx-cache', 'temp-dir', 'unsafe-path'].includes(p.blocked.code)) body.push(codeCopy('npm i -g sideby'))
      if (p.blocked.code === 'foreign') body.push(codeCopy(p.path))
    } else if (p && !p.changed) body.push(h('p', null, lt(k, on ? 'alreadyOn' : 'alreadyOff')))
    else if (p && on) {
      body.push(h('p', null, lt(k, 'writes')), h('code', { class: 'as-code' }, p.path))
      body.push(h('p', null, lt(k, 'runs')), h('code', { class: 'as-code' }, (p.programArguments || []).join(' ')))
      body.push(h('p', { class: 'muted small' }, lt(k, 'noWindow')))
    } else if (p) {
      body.push(h('p', null, lt(k, 'removes')), h('code', { class: 'as-code' }, p.path))
      body.push(h('p', { class: 'muted small' }, lt(k, 'offNote')))
    }
    const foot = [h('button', { class: 'btn', type: 'button', disabled: st.busy, onclick: () => dlg.el.close() }, t(p && p.changed && !p.blocked ? 'btn.cancel' : 'btn.close'))]
    if (p && p.changed && !p.blocked)
      foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: st.busy, 'aria-busy': st.busy ? 'true' : null, onclick: autostartApply }, st.busy ? spinner() : null, lt(k, on ? 'turnOn' : 'turnOff')))
    setKids(dlg.el, dialogFrame(lt(k, on ? 'onTitle' : 'offTitle'), null, body, foot))
  }
  async function autostartApply() {
    const k = liKind
    const st = li[k]
    const on = st.want
    st.busy = true
    dlg.busy = true
    renderAutostart()
    let r = null
    try { r = await api('/api/' + k, { on, confirm: true, programArguments: st.plan.programArguments || [] }) } catch (e) { st.planError = e }
    st.busy = false
    dlg.busy = false
    if (r && r.applied) {
      st.status = r.status
      if (dlg.kind === 'autostart') dlg.el.close()
      toast(lt(k, on ? 'doneOn' : 'doneOff') + (on && !r.loaded ? ' ' + lt(k, 'nextLogin') : ''))
      refreshSettings()
      if (k === 'menubar') renderAll()
      return
    }
    if (r) { st.plan = r.plan; if (r.changedSince) toast(lt(k, 'changedSince')) }
    if (dlg.kind === 'autostart') renderAutostart()
  }
  function setLang(v) {
    if (LANG_FIXED || v === lang) return
    if (CFG) { cfgPanel.language = v; saveCfg({ language: v }) } else { prefs.lang = v; savePrefs() }
    showLang(v)
  }
  // Writes config panel.* (spec §3.29). A failure says so; the next state read then shows what config holds.
  async function saveCfg(patch, quiet) {
    cfgSaving++
    try { await api('/api/panel/settings', patch); return true }
    catch (e) { if (!quiet) toast(t('set.saveFailed', { msg: e.message }), { kind: 'fail' }); return false }
    finally { cfgSaving-- }
  }
  // A theme or language changed elsewhere (the CLI, an AI assistant) shows at the next state read.
  function adoptPanel(next) {
    if (!CFG || cfgSaving) return
    next = next || {}
    if (next.theme === cfgPanel.theme && next.language === cfgPanel.language) return
    cfgPanel = Object.assign({}, next)
    applyTheme()
    const l = panelLang(BOOT.lang, viewPrefs().language, navigator.language)
    if (l !== lang) showLang(l)
    else refreshSettings()
  }
  function showLang(v) {
    lang = v
    renderStatic()
    buildToolbar()
    renderAll()
    if (dlg.kind === 'create' && nf && !nf.creating) renderCreate()
    else if (dlg.kind === 'setup' && qs) renderSetup()
    else if (dlg.kind === 'tune' && tuneState) renderTune()
    else if (dlg.kind === 'model' && md) { md.form = null; renderModel() }
    else if (dlg.kind === 'browser') renderBrowser()
    else if (dlg.kind === 'update' && up) renderUpdate()
    else if (dlg.kind === 'rc') renderRc()
    else if (dlg.kind === 'ask' && ak) { if (ak.els.text) ak.text = ak.els.text.value; renderAsk() }
    else if (dlg.kind === 'key' && ky && ky.step !== 'enter') renderKey()
    else if (dlg.kind === 'terminal' && tm) renderTerminals()
    else if (dlg.kind === 'autostart') renderAutostart()
  }
  function setTheme(v) {
    if (CFG) { cfgPanel.theme = v; saveCfg({ theme: v }) } else { prefs.theme = v; savePrefs() }
    applyTheme()
    refreshSettings()
  }
  // The sideby Agent Skill: what to say to an AI assistant instead of clicking, and how to install it when needed.
  function skillInstalled() {
    const u = S.state && S.state.update
    return Boolean(u && u.skillUpdate && u.skillUpdate.installed && u.skillUpdate.installed.length)
  }
  // Example phrases: a click puts one in the Let AI do it box (spec §3.28).
  const AI_ASKS = ['ai.ask.quota', 'ai.ask.new', 'ai.ask.api', 'ai.ask.pin', 'ai.ask.fix', 'ai.ask.handoff', 'ai.ask.menubar', 'ai.ask.rc', 'ai.ask.tool']
  function openRc() {
    if (!S.state || !rcSummary()) return
    rc.target = null
    showDialog('rc')
    renderRc()
  }
  // One switch for every Claude settings file: moving it lists what changes, and only the confirmation writes.
  function renderRc() {
    const groups = S.state.remoteControl || []
    const sum = rcSummary()
    const to = rc.target
    const todo = to ? remoteControlTodo(groups, to) : []
    const changing = new Set(todo.map((g) => g.file))
    const undo = groups.some((g) => g.undo)
    const pick = (v) => { rc.target = v === sum ? null : v; renderRc() }
    const sw = h('div', { class: 'set-row rc-switch' }, h('span', null, t('rc.switch')),
      h('div', { class: 'seg', role: 'group', 'aria-label': t('rc.switch') }, ['on', 'off'].map((v) =>
        h('button', { class: 'seg-btn', type: 'button', disabled: BOOT.readOnly || rc.busy, 'aria-pressed': String((to || sum) === v), onclick: () => pick(v) }, t('rc.state.' + v)))))
    const fromOf = (g) => g.state === 'on' ? 'true' : g.state === 'off' ? 'false' : t('rc.notSet')
    const rows = groups.map((g) => h('li', { class: 'rc-row' },
      h('div', null, h('code', null, g.file), ' ', h('span', { class: 'chip chip-sm ' + (g.state === 'on' ? 'chip-warn' : g.state === 'off' ? 'chip-ok' : g.state === 'blocked' ? 'chip-fail' : '') }, t('rc.state.' + g.state))),
      h('div', { class: 'muted small' }, t('rc.usedBy', { refs: g.accounts.map(shortRef).join(', ') })),
      g.reason ? h('div', { class: 'muted small' }, g.reason) : null,
      changing.has(g.file) ? h('div', { class: 'small rc-change' }, t('rc.change', { from: fromOf(g), to: to === 'on' ? 'true' : 'false' })) : null))
    const body = [h('p', { class: 'small' }, t('rc.explain')), sw, h('ul', { class: 'rc-list' }, rows)]
    if (to === 'on') body.push(h('div', { class: 'note note-warn small' }, t('rc.onWarn')))
    else if (to === 'off') body.push(h('p', { class: 'small muted' }, t('rc.confirmNote')))
    else if (sum === 'off') body.push(h('p', { class: 'small muted' }, t('rc.allOff')))
    if (BOOT.readOnly) body.push(h('p', { class: 'small' }, t('rc.readOnlyBoth')))
    const foot = [h('button', { class: 'btn', type: 'button', disabled: rc.busy, onclick: () => to ? pick(sum) : dlg.el.close() }, t(to ? 'btn.cancel' : 'btn.close'))]
    if (!BOOT.readOnly && !to && undo) foot.push(h('button', { class: 'btn', type: 'button', disabled: rc.busy, onclick: async () => { rc.busy = true; renderRc(); await remoteControlUndo(); rc.busy = false; if (dlg.kind === 'rc') renderRc() } }, t('rc.undo')))
    if (!BOOT.readOnly && to) foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: rc.busy || !todo.length, 'aria-busy': rc.busy ? 'true' : null, onclick: () => setRemoteControl(to) }, rc.busy ? spinner() : null, t(to === 'on' ? 'rc.confirmOn' : 'rc.confirm')))
    setKids(dlg.el, dialogFrame(t('rc.dialogTitle'), null, body, foot))
  }

  // ---------- AI Tasks (spec §3.28) ----------
  // One dialog for every "let AI do it" entry: what to do, then the account and the terminal it will use, then one
  // button. When nothing can run it, or the panel is read-only, it copies the prompt instead.
  let ak = null
  const TERM_NAMES = { terminal: 'Terminal', iterm2: 'iTerm2', ghostty: 'Ghostty', orca: 'Orca', wezterm: 'WezTerm', kitty: 'kitty', alacritty: 'Alacritty', 'windows-terminal': 'Windows Terminal', custom: 'Custom' }
  function termName(id) {
    const list = ak && ak.terms ? ak.terms.terminals : []
    const f = list.find((x) => x.id === id)
    return f ? f.name : TERM_NAMES[id] || id
  }
  function askBody() {
    const body = { task: ak.task, lang }
    const text = ak.els && ak.els.text ? ak.els.text.value.trim() : ak.text
    if (text) body.text = text
    if (ak.context) body.context = ak.context
    if (ak.account && ak.accountChanged) body.account = ak.account
    if (ak.terminal && ak.terminalChanged) body.terminal = ak.terminal
    const ids = ak.files.filter((f) => f.status === 'ready').map((f) => f.id)
    if (ids.length) body.attachments = ids
    return body
  }
  function openAsk(opts) {
    opts = opts || {}
    closeMenu()
    // In a Portal that offers AI Tasks itself (createPanelHandler's ask bridge), the task goes to its dialog.
    if (askBridge(BOOT, opts, window)) return
    ak = { task: opts.task || 'free', text: opts.text || '', context: opts.context || null, account: null, accountChanged: false, terminal: null, terminalChanged: false, pick: null, reason: null, terms: null, loading: true, busy: false, result: null, error: null, removed: false, files: [], els: {} }
    showDialog('ask')
    hookAskDrops()
    const mine = ak
    // Uploads still running when the dialog closes are stopped; the server drops staged files it never received.
    dlg.onClose = () => { mine.files.forEach((f) => { if (f.xhr) f.xhr.abort() }) }
    renderAsk()
    if (ak.els.text) ak.els.text.focus()
    askLoad()
  }
  async function askLoad() {
    const mine = ak
    const body = askBody()
    delete body.account
    try {
      const [pick, terms] = await Promise.all([
        api('/api/ask/prompt', body),
        BOOT.readOnly ? Promise.resolve(null) : api('/api/terminals').catch(() => null),
      ])
      if (ak !== mine) return
      ak.pick = pick.account
      ak.reason = pick.reason || null
      if (!ak.accountChanged) ak.account = pick.account
      ak.terms = terms
      if (terms && !ak.terminalChanged) ak.terminal = terms.guess.id
    } catch (e) { if (ak === mine) ak.error = e }
    if (ak !== mine) return
    ak.loading = false
    if (dlg.kind === 'ask') renderAsk()
  }
  // Title, placeholder and examples of the dialog for its task (spec §3.28 "每个入口的提示").
  function askStrings() { return askCopy(ak.task, (k) => Object.hasOwn(MESSAGES.en, k), AI_ASKS) }
  function askChoices() { return aiTaskAccounts((S.state && S.state.accounts) || []) }
  function askTaskLine() {
    if (ak.task === 'free') return null
    const ctx = ak.context || {}
    return h('p', { class: 'note' }, t('ask.task.' + ak.task, { n: (ctx.findings || []).length, ref: ctx.account || '' }))
  }
  function askTextField() {
    const e = ak.els
    const copy = askStrings()
    e.text = h('textarea', { id: 'ak-text', class: 'ask-text', rows: ak.task === 'free' ? '3' : '2', maxlength: '8000', placeholder: t(copy.placeholder), 'aria-describedby': 'ak-warn' })
    e.text.value = ak.text
    e.warn = h('p', { class: 'field-error field-note', id: 'ak-warn', role: 'status' })
    const warnNow = () => { e.warn.textContent = stripSecrets(e.text.value).removed ? t('ask.keyWarn') : '' }
    e.text.addEventListener('input', () => { ak.text = e.text.value; warnNow() })
    warnNow()
    const label = h('label', { class: 'field', for: 'ak-text' }, h('span', null, t(ak.task === 'free' ? 'ask.what' : 'ask.whatMore')), e.text)
    const chips = h('div', { class: 'field' }, h('p', { class: 'small muted' }, t('ask.examples')),
      h('div', { class: 'ask-chips' }, copy.chips.map((k) => h('button', { class: 'chip chip-btn', type: 'button', onclick: () => { e.text.value = t(k); ak.text = e.text.value; warnNow(); e.text.focus() } }, t(k)))))
    return [h('div', { class: 'field' }, label, e.warn), askAttachField(), chips]
  }

  // Attachments (spec §3.28 "附件"): pasted, dropped or picked files upload at once, one request each, so a wrong
  // type or a file that is too big is named right away. The page shows image thumbnails from the file itself as a
  // data: URL (the CSP allows no blob:); the server decides the type from the first bytes.
  const ATTACH_MAX = 5
  const ATTACH_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp,video/mp4,video/quicktime,video/webm'
  let askHooked = false
  function hookAskDrops() {
    if (askHooked) return
    askHooked = true
    const el = dlg.el
    const active = () => dlg.kind === 'ask' && ak && !ak.result && !BOOT.readOnly
    const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0
    el.addEventListener('paste', (e) => {
      const files = e.clipboardData ? Array.from(e.clipboardData.files || []) : []
      if (!active() || !files.length) return
      // A file copied in Finder also carries its name as text; only the file is wanted.
      e.preventDefault()
      askAddFiles(files)
    })
    el.addEventListener('dragover', (e) => {
      if (!active() || !hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
      el.classList.add('drop-on')
    })
    el.addEventListener('dragleave', (e) => { if (e.target === el || !el.contains(e.relatedTarget)) el.classList.remove('drop-on') })
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-on')
      if (!active() || !hasFiles(e)) return
      e.preventDefault()
      askAddFiles(Array.from(e.dataTransfer.files || []))
    })
  }
  function askAttachField() {
    if (BOOT.readOnly) return null
    const input = h('input', { type: 'file', multiple: true, accept: ATTACH_ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' })
    input.addEventListener('change', () => { askAddFiles(Array.from(input.files || [])); input.value = '' })
    ak.els.files = h('div', { class: 'ask-files-wrap' })
    renderAskFiles()
    return h('div', { class: 'field ask-attach' },
      h('div', { class: 'ask-attach-row' },
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => input.click() }, icon('image'), t('ask.attach')),
        h('span', { class: 'small muted' }, t('ask.attachHint')), input),
      ak.els.files)
  }
  function renderAskFiles() {
    const box = ak && ak.els.files
    if (!box) return
    const files = ak.files
    const tiles = files.map((f) => {
      const remove = h('button', { class: 'icon-btn ask-file-x', type: 'button', 'aria-label': t('ask.attachRemove', { name: f.name }), onclick: () => askRemoveFile(f) }, icon('x'))
      let face
      if (f.status === 'uploading') {
        f.pctEl = h('span', { class: 'small' }, t('ask.attachUploading', { pct: Math.round(f.progress * 100) }))
        face = h('div', { class: 'ask-file-face' }, spinner(), f.pctEl)
      } else if (f.status === 'error') face = h('div', { class: 'ask-file-face' }, icon('x'))
      else if (f.thumb) face = h('img', { class: 'ask-file-img', src: f.thumb, alt: f.name })
      else face = h('div', { class: 'ask-file-face' }, icon(f.kind === 'video' ? 'film' : 'image'), f.kind === 'video' ? h('span', { class: 'small' }, t('ask.attachVideo')) : null)
      return h('li', { class: 'ask-file' + (f.status === 'error' ? ' is-error' : '') },
        face,
        h('span', { class: 'ask-file-name small', title: f.name }, f.name),
        h('span', { class: 'small muted' }, fileSize(f.bytes || f.size)),
        remove)
    })
    const errors = files.filter((f) => f.status === 'error').map((f) => h('p', { class: 'field-error' }, f.error))
    const live = files.some((f) => f.status !== 'error')
    setKids(box, [
      tiles.length ? h('ul', { class: 'ask-files', 'aria-label': t('ask.attach') }, tiles) : null,
      errors,
      ak.attachFull ? h('p', { class: 'field-error' }, t('ask.attachMax')) : null,
      live ? h('p', { class: 'note note-warn small' }, t('ask.attachWarn')) : null,
    ])
  }
  function askAddFiles(list) {
    if (!ak || !list.length) return
    ak.attachFull = false
    for (const file of list) {
      if (ak.files.filter((f) => f.status !== 'error').length >= ATTACH_MAX) { ak.attachFull = true; break }
      const f = { key: Math.random(), name: file.name || 'file', size: file.size, bytes: 0, kind: '', status: 'uploading', progress: 0, id: null, thumb: null, error: '', xhr: null, done: null }
      ak.files.push(f)
      // Over the largest limit there is no point uploading: the server would refuse it.
      if (file.size > 200 * 1024 * 1024) { f.status = 'error'; f.error = t('ask.attachTooBig', { name: f.name }); continue }
      f.done = askUpload(f, file, ak)
    }
    renderAskFiles()
  }
  function askRemoveFile(f) {
    if (f.xhr) f.xhr.abort()
    // Free the staged copy now; if this fails the server clears it after a day anyway.
    if (f.id) api('/api/ask/attach/remove', { ids: [f.id] }).catch(() => {})
    ak.files = ak.files.filter((x) => x !== f)
    ak.attachFull = false
    renderAskFiles()
  }
  function askPost(file, onProgress, xhrOut) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhrOut(xhr)
      xhr.open('POST', BOOT.basePath + '/api/ask/attach')
      xhr.setRequestHeader('x-sideby-token', token)
      xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total) }
      xhr.onload = () => { let data = null; try { data = JSON.parse(xhr.responseText) } catch {} resolve({ status: xhr.status, data }) }
      xhr.onerror = () => resolve({ status: 0, data: null })
      xhr.onabort = () => resolve({ status: -1, data: null })
      xhr.send(file)
    })
  }
  async function askUpload(f, file, mine) {
    const progress = (p) => { f.progress = p; if (f.pctEl) f.pctEl.textContent = t('ask.attachUploading', { pct: Math.round(p * 100) }) }
    let r = await askPost(file, progress, (x) => { f.xhr = x })
    if (r.status === 403 && r.data && r.data.code === 'bad-token') {
      try { await refreshToken(); r = await askPost(file, progress, (x) => { f.xhr = x }) } catch {}
    }
    f.xhr = null
    if (r.status === -1 || ak !== mine) return
    if (r.status === 200 && r.data && r.data.id) {
      f.id = r.data.id
      f.kind = r.data.kind
      f.bytes = r.data.bytes
      if (f.kind === 'image') f.thumb = await thumbnail(file)
      f.status = 'ready'
    } else {
      f.status = 'error'
      f.error = t(r.status === 413 ? 'ask.attachTooBig' : r.status === 415 ? 'ask.attachType' : r.status === 507 ? 'ask.attachFull' : 'ask.attachFailed', { name: f.name })
    }
    if (ak === mine && dlg.kind === 'ask') renderAskFiles()
  }
  // A small JPEG data: URL of an image, drawn on a canvas so a 20 MB screenshot is not kept in the page.
  function thumbnail(file) {
    return new Promise((resolve) => {
      const reader = new FileReader()
      reader.onerror = () => resolve(null)
      reader.onload = () => {
        const img = new Image()
        img.onerror = () => resolve(null)
        img.onload = () => {
          try {
            const scale = Math.min(1, 192 / Math.max(img.width, img.height))
            const c = document.createElement('canvas')
            c.width = Math.max(1, Math.round(img.width * scale))
            c.height = Math.max(1, Math.round(img.height * scale))
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
            resolve(c.toDataURL('image/jpeg', 0.8))
          } catch { resolve(null) }
        }
        img.src = String(reader.result)
      }
      reader.readAsDataURL(file)
    })
  }
  // Open and Copy prompt wait for uploads still running, so the task carries every file the person added.
  async function askUploadsDone() {
    const pending = ak.files.filter((f) => f.status === 'uploading' && f.done).map((f) => f.done)
    if (pending.length) await Promise.all(pending)
  }
  function askConfirm() {
    if (BOOT.readOnly) return h('p', { class: 'note' }, t('ask.readOnly'))
    if (ak.loading) return h('p', { class: 'muted small' }, spinner(), ' ', t('ask.loading'))
    if (ak.error) return errorNote(ak.error, () => { ak.error = null; ak.loading = true; renderAsk(); askLoad() })
    const choices = askChoices()
    const out = []
    if (!ak.account) {
      out.push(h('div', { class: 'note note-warn' }, h('span', null, t('ask.noAccount.' + (ak.reason || 'no-accounts'))), h('span', { class: 'note-line' }, t('ask.noAccountHint'))))
      const main = ak.reason === 'none-signed-in' && S.state ? S.state.accounts.find((a) => a.isMain && a.kind !== 'api') : null
      if (main) out.push(h('div', null, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => signIn(main) }, icon('key'), t('ask.signInMain', { ref: main.ref }))))
    }
    const rows = []
    if (choices.length) {
      const sel = h('select', { id: 'ak-account', 'aria-label': t('ask.account') },
        ak.account ? null : h('option', { value: '' }, t('ask.chooseAccount')),
        choices.map((a) => h('option', { value: a.ref }, a.ref + (a.kind === 'api' ? ' · API' : ''))))
      sel.value = ak.account || ''
      sel.addEventListener('change', () => { ak.account = sel.value || null; ak.accountChanged = Boolean(sel.value); renderAsk() })
      rows.push(h('label', { class: 'field', for: 'ak-account' }, h('span', null, t('ask.account')), sel))
    }
    const installed = ak.terms ? ak.terms.installed : []
    if (installed.length && ak.account) {
      const sel = h('select', { id: 'ak-term', 'aria-label': t('ask.terminal') }, installed.map((id) => h('option', { value: id }, termName(id))))
      sel.value = ak.terminal || installed[0]
      sel.addEventListener('change', () => { ak.terminal = sel.value; ak.terminalChanged = true; renderAsk() })
      rows.push(h('label', { class: 'field', for: 'ak-term' }, h('span', null, t('ask.terminal')), sel))
    }
    if (rows.length) out.push(h('div', { class: 'ask-pick' }, rows))
    if (ak.account) {
      // Families whose AI Tasks start with permission checks on (ADR-0031) say so after the confirm line.
      const acct = S.state && S.state.accounts.find((x) => x.ref === ak.account)
      const safe = acct && family(acct.family).aiTaskSafe
      out.push(h('p', { class: 'small' }, t('ask.confirm', { terminal: termName(ak.terminal || 'terminal'), ref: ak.account }) + (safe ? ' ' + t('ask.safe') : '')))
    }
    return out
  }
  function askResult() {
    const r = ak.result
    const term = termName(r.terminal || ak.terminal || 'terminal')
    return [
      h('div', { class: 'note note-warn' }, h('b', null, t('ask.failed', { terminal: term })), h('span', { class: 'note-line' }, t('ask.paste'))),
      codeCopy(r.command),
      r.automation ? h('p', { class: 'small' }, t('ask.automation', { terminal: term })) : null,
      r.reason === 'not-installed' ? h('p', { class: 'small muted' }, t('ask.notInstalled')) : null,
      !r.automation && r.reason !== 'not-installed' && r.detail ? h('p', { class: 'small muted' }, r.detail) : null,
    ]
  }
  function askYourself() {
    return h('details', { class: 'more-opts' }, h('summary', null, t('ask.yourself')),
      h('p', { class: 'small' }, t('ai.intro')),
      skillInstalled() ? h('p', { class: 'note' }, t('ai.ready')) : h('div', { class: 'field' }, h('p', { class: 'small' }, t('ai.install')), codeCopy(BOOT.skillInstall)))
  }
  function renderAsk() {
    if (!ak) return
    const el = dlg.el
    const body = [h('p', { class: 'muted small' }, t('ask.intro')), askTaskLine()]
    const foot = [h('button', { class: 'btn', type: 'button', disabled: ak.busy, onclick: () => el.close() }, t(ak.result ? 'btn.close' : 'btn.cancel'))]
    if (ak.result) {
      body.push(askResult())
      if (ak.result.removedSecrets) body.push(h('p', { class: 'small muted' }, t('ask.keyRemoved')))
    } else {
      body.push(askTextField(), askConfirm(), askYourself())
      const canOpen = !BOOT.readOnly && !ak.loading && !ak.error && ak.account
      if (canOpen) {
        const term = termName(ak.terminal || 'terminal')
        foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: ak.busy, 'aria-busy': ak.busy ? 'true' : null, onclick: askOpen }, ak.busy ? spinner() : icon('terminal'), ak.busy ? t(ak.files.some((f) => f.status === 'uploading') ? 'ask.attachWaiting' : 'ask.opening') : t('ask.open', { terminal: term })))
      } else if (!ak.loading || BOOT.readOnly) {
        foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: ak.busy, onclick: askCopyPrompt }, icon('copy'), t('ask.copyPrompt')))
      }
    }
    setKids(el, dialogFrame(t(askStrings().title), null, body, foot))
  }
  async function askCopyPrompt() {
    const mine = ak
    ak.busy = true
    renderAsk()
    try {
      await askUploadsDone()
      const r = await api('/api/ask/prompt', askBody())
      await copyText(r.prompt, t('ask.promptShown'))
      if (r.removedSecrets) toast(t('ask.keyRemoved'), { kind: 'info' })
    } catch (e) { toast(e.message, { kind: 'fail' }) }
    if (ak !== mine) return
    ak.busy = false
    if (dlg.kind === 'ask') renderAsk()
  }
  async function askOpen() {
    const mine = ak
    ak.busy = true
    renderAsk()
    try {
      await askUploadsDone()
      if (ak !== mine) return
      renderAsk()
      const r = await api('/api/ask', askBody())
      if (ak !== mine) return
      ak.busy = false
      if (r.opened) {
        toast(t('ask.opened', { terminal: termName(r.terminal), ref: r.account }))
        if (r.removedSecrets) toast(t('ask.keyRemoved'), { kind: 'info' })
        dlg.el.close()
        return
      }
      if (!r.command) {
        // No account can run it after all: the dialog turns into Copy prompt.
        ak.account = null
        ak.reason = r.reason || null
        renderAsk()
        return
      }
      ak.result = r
      renderAsk()
      copyText(r.command, t('ask.copiedCmd'))
    } catch (e) {
      if (ak !== mine) return
      ak.busy = false
      toast(e.message, { kind: 'fail' })
      renderAsk()
    }
  }

  // Sign in: "sideby login <ref>" in the person's terminal, no AI involved; the command is copied when it cannot open.
  async function signIn(a) {
    const cmd = 'sideby login ' + a.ref
    if (BOOT.readOnly) { copyText(cmd); return }
    try {
      const r = await api('/api/login', { account: a.ref })
      if (r.opened) { toast(t('login.opened', { terminal: TERM_NAMES[r.terminal] || r.terminal, ref: a.ref })); return }
      await copyText(cmd, cmd)
      toast(r.automation ? t('login.automation', { terminal: TERM_NAMES[r.terminal] || r.terminal }) : t('login.failed'), { kind: 'info' })
    } catch (e) {
      await copyText(cmd, cmd)
      toast(e.message, { kind: 'fail' })
    }
  }
  function keyable(a) { return !BOOT.readOnly && (a.kind === 'api' || Boolean(family(a.family).keyAlways)) }

  // Enter key (spec §3.28): a password field, saved into the account's proxy.env; then an optional "Try it" that says
  // what it runs and that it spends a few tokens before it runs.
  let ky = null
  function openKey(a) {
    if (!keyable(a)) return
    const fam = family(a.family)
    ky = { ref: a.ref, family: a.family, var: fam.keyVar || '', step: 'enter', busy: false, error: null, saved: null, tried: null, els: {} }
    showDialog('key')
    renderKey()
    if (ky.els.value) ky.els.value.focus()
  }
  function renderKey() {
    if (!ky) return
    const el = dlg.el
    const fam = family(ky.family)
    const body = []
    const foot = [h('button', { class: 'btn', type: 'button', disabled: ky.busy, onclick: () => el.close() }, t(ky.step === 'enter' ? 'btn.cancel' : 'btn.close'))]
    if (ky.step === 'enter') {
      const e = ky.els
      e.value = h('input', { id: 'ky-value', type: 'password', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'ky-err' })
      e.varInput = h('input', { id: 'ky-var', type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', maxlength: '64' })
      e.varInput.value = ky.var
      e.err = h('p', { class: 'field-error', id: 'ky-err', role: 'alert' }, ky.error ? ky.error.message : '')
      e.varInput.addEventListener('input', () => { ky.var = e.varInput.value.trim(); e.label.textContent = t('key.label', { var: ky.var || '?' }) })
      e.label = h('span', null, t('key.label', { var: ky.var || '?' }))
      body.push(h('p', { class: 'muted small' }, t('key.intro')),
        h('form', { id: 'ky-form', class: 'form', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); keySave() } },
          h('label', { class: 'field', for: 'ky-value' }, e.label, e.value),
          fam.keyVar ? h('details', { class: 'more-opts' }, h('summary', null, t('key.otherVar')),
            h('label', { class: 'field', for: 'ky-var' }, h('span', null, t('key.varLabel')), e.varInput), h('p', { class: 'field-hint' }, t('key.varHint')))
            : h('div', { class: 'field' }, h('p', { class: 'field-hint' }, t('key.noVar')), h('label', { class: 'field', for: 'ky-var' }, h('span', null, t('key.varLabel')), e.varInput)),
          e.err))
      foot.push(h('button', { class: 'btn btn-primary', type: 'submit', form: 'ky-form', disabled: ky.busy, 'aria-busy': ky.busy ? 'true' : null }, ky.busy ? spinner() : null, ky.busy ? t('key.saving') : t('key.save')))
    } else {
      body.push(h('div', { class: 'created-head', role: 'status' }, h('span', { class: 'check-icon', 'aria-hidden': 'true' }, '✓'), h('span', null, t('key.saved', { var: ky.saved.var, file: ky.saved.path }))))
      const cmd = fam.tryCommand
      if (!cmd) body.push(h('p', { class: 'small muted' }, tx('key.cannotTry', { cmd: h('code', null, 'sideby run ' + ky.ref) })))
      else if (ky.step === 'saved') {
        body.push(h('p', { class: 'small' }, t('key.tryLead')))
        foot.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { ky.step = 'confirm'; renderKey() } }, t('key.try')))
      } else if (ky.step === 'confirm' || ky.step === 'trying') {
        body.push(h('p', { class: 'small' }, t('key.tryCost')), h('pre', { class: 'diff' }, cmd.map((v) => /^[A-Za-z0-9_./:=-]+$/.test(v) ? v : JSON.stringify(v)).join(' ')))
        if (ky.step === 'trying') body.push(h('p', { class: 'muted small' }, spinner(), ' ', t('key.trying')))
        foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: ky.step === 'trying', 'aria-busy': ky.step === 'trying' ? 'true' : null, onclick: keyTry }, ky.step === 'trying' ? spinner() : null, t('key.tryRun')))
      } else if (ky.step === 'tried') {
        const r = ky.tried
        if (r.ok) body.push(h('div', { class: 'note' }, t('key.tryOk', { ref: ky.ref })))
        else {
          body.push(h('div', { class: 'note note-fail' }, t(r.timedOut ? 'key.tryTimeout' : 'key.tryFail')),
            h('p', { class: 'small muted' }, t('key.output')),
            h('pre', { class: 'diff' }, r.output || t('key.noOutput')))
          foot.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { const ref = ky.ref; const fam = ky.family; openAsk({ task: 'account', context: { account: ref, family: fam }, text: t('key.explainText', { ref, output: r.output || t('key.noOutput') }) }) } }, icon('bot'), t('key.explain')))
        }
      }
      if (ky.error) body.push(errorNote(ky.error, null))
    }
    setKids(el, dialogFrame(t('key.title', { ref: ky.ref }), ky.family, body, foot))
  }
  async function keySave() {
    const value = ky.els.value.value
    const name = ky.var.trim()
    if (!value.trim()) { ky.els.err.textContent = t('key.empty'); ky.els.value.focus(); return }
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) { ky.els.err.textContent = t('key.badVar'); return }
    const mine = ky
    ky.busy = true
    dlg.busy = true
    ky.error = null
    renderKey()
    try {
      ky.saved = await api('/api/key', { account: ky.ref, var: name, value })
      ky.step = 'saved'
    } catch (e) { ky.error = e }
    dlg.busy = false
    if (ky !== mine) return
    ky.busy = false
    renderKey()
    if (ky.step === 'enter' && ky.els.value) ky.els.value.focus()
  }
  async function keyTry() {
    const mine = ky
    ky.step = 'trying'
    ky.error = null
    renderKey()
    try {
      ky.tried = await api('/api/try', { account: ky.ref })
      ky.step = 'tried'
    } catch (e) { ky.error = e; ky.step = 'confirm' }
    if (ky !== mine || dlg.kind !== 'key') return
    renderKey()
  }

  // Preferred terminal and the custom command (spec §3.28): the installed list, "Guess for me" with where the guess
  // comes from, and a template for any other terminal.
  let tm = null
  function openTerminals() {
    closeMenu()
    tm = { data: null, busy: false, error: null, draft: null, customOpen: false }
    showDialog('terminal')
    renderTerminals()
    api('/api/terminals').then((d) => { if (tm) { tm.data = d; renderTerminals() } }, (e) => { if (tm) { tm.error = e; renderTerminals() } })
  }
  async function termSave(body) {
    tm.busy = true
    tm.error = null
    renderTerminals()
    try { tm.data = await api('/api/terminal', body); tm.draft = null; toast(t('term.saved')) } catch (e) { tm.error = e }
    tm.busy = false
    if (dlg.kind === 'terminal') renderTerminals()
  }
  // "Not sure how?": AI writes the custom command, starting from what is typed or saved and what is installed.
  function termAskAi(d) {
    const name = (id) => { const f = d.terminals.find((x) => x.id === id); return f ? f.name : id }
    const typed = tm.draft !== null ? tm.draft.trim() : ''
    const custom = typed || d.custom || ''
    const context = { terminals: d.installed.filter((id) => id !== 'custom').map(name), version: BOOT.version }
    if (custom) context.terminalCustom = custom
    openAsk({ task: 'terminal', context })
  }
  function renderTerminals() {
    if (!tm) return
    const body = [h('p', { class: 'muted small' }, t('term.intro'))]
    const d = tm.data
    if (!d && !tm.error) body.push(h('p', { class: 'muted small' }, spinner(), ' ', t('term.loading')))
    if (d) {
      const name = (id) => { const f = d.terminals.find((x) => x.id === id); return f ? f.name : id }
      if (!d.installed.length) body.push(h('p', { class: 'note' }, t('term.none')))
      else {
        const sel = h('select', { id: 'tm-pick', disabled: tm.busy, 'aria-label': t('term.pick') },
          h('option', { value: '' }, t('term.auto')),
          d.installed.map((id) => h('option', { value: id }, name(id))))
        sel.value = d.preferred && d.installed.includes(d.preferred) ? d.preferred : ''
        sel.addEventListener('change', () => termSave(sel.value ? { id: sel.value } : {}))
        body.push(h('label', { class: 'field', for: 'tm-pick' }, h('span', null, t('term.pick')), sel),
          h('p', { class: 'field-hint' }, t('term.guess.' + d.guess.source, { name: name(d.guess.id) })))
      }
      const input = h('input', { id: 'tm-custom', type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'myterm --cwd {cwd} -e {cmd}', disabled: tm.busy })
      // What was typed stays after a refusal, and so does the open section.
      input.value = tm.draft !== null ? tm.draft : d.custom || ''
      input.addEventListener('input', () => { tm.draft = input.value })
      const more = h('details', { class: 'more-opts', open: tm.customOpen || d.custom ? true : undefined }, h('summary', null, t('term.custom')),
        h('label', { class: 'field', for: 'tm-custom' }, h('span', null, t('term.custom')), input),
        h('p', { class: 'field-hint' }, t('term.customHint')),
        BOOT.readOnly ? null : h('p', { class: 'small' }, h('button', { class: 'link-btn', type: 'button', onclick: () => termAskAi(d) }, icon('bot'), t('term.askAi'))),
        h('div', { class: 'actions' },
          h('button', { class: 'btn btn-sm', type: 'button', disabled: tm.busy, onclick: () => termSave({ custom: input.value.trim() }) }, t('term.customSave')),
          d.custom ? h('button', { class: 'btn btn-sm', type: 'button', disabled: tm.busy, onclick: () => termSave({ custom: '' }) }, t('term.customClear')) : null))
      more.addEventListener('toggle', () => { tm.customOpen = more.open })
      body.push(more)
    }
    if (tm.error) body.push(errorNote(tm.error, null))
    setKids(dlg.el, dialogFrame(t('term.title'), null, body, [h('button', { class: 'btn', type: 'button', onclick: () => dlg.el.close() }, t('btn.close'))]))
  }

  // ---------- banners ----------
  // Offered once on macOS (spec §3.31), when quota shows and the menu bar item is off; "No thanks" is for good.
  function menubarHint() {
    if (BOOT.readOnly || prefs.mbHintDone) return null
    const st = li.menubar
    if (!st.status) {
      if (!st.loading && !st.error) loadLoginItem('menubar')
      return null
    }
    if (!st.status.supported || st.status.state !== 'off') return null
    if (!S.state.accounts.some((a) => a.quota && a.quota.status === 'ok')) return null
    const done = () => { prefs.mbHintDone = true; savePrefs(); renderBanners() }
    return h('div', { class: 'banner', role: 'status' },
      h('div', null, h('b', null, t('mb.hintTitle') + ' '), t('mb.hintBody')),
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { done(); autostartAsk(true, 'menubar') } }, t('mb.hintYes')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: done }, t('mb.hintNo'))))
  }
  function renderBanners() {
    const out = []
    if (S.loadError && S.state) out.push(h('div', { class: 'banner banner-fail', role: 'alert' },
      h('div', null, h('b', null, t('load.failedShort') + ' '), S.loadError.message),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => load({ check: !S.report }) }, t('btn.retry'))))
    if (S.state) {
      if (BOOT.readOnly) out.push(h('div', { class: 'banner banner-quiet' }, h('div', { class: 'muted small' }, t('banner.readOnly'))))
      const hint = handoffHint()
      if (hint) out.push(h('div', { class: 'banner', role: 'status' },
        h('div', null, t('ah.hint', { ref: hint.ref, p: hint.pressure })),
        h('div', { class: 'banner-actions' },
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => setPage('handoff') }, t('ah.setUp')),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { prefs.ahHintAt = Date.now(); savePrefs(); renderBanners() } }, t('ah.dismiss')))))
      else {
        const mb = menubarHint()
        if (mb) out.push(mb)
      }
      const rcBanner = remoteControlBanner()
      if (rcBanner) out.push(rcBanner)
      const errs = S.state.pluginErrors
      if (errs.length) out.push(h('div', { class: 'banner banner-warn', role: 'status' }, h('div', null,
        h('b', null, tn('banner.plugins', errs.length) + ' '), t('banner.pluginsHint'),
        h('ul', null, errs.map((e) => h('li', null, h('code', null, e.where), ': ', e.message))))))
    }
    patch($('banners'), out)
  }

  // ---------- loading ----------
  function renderAll() { renderTop(); renderBanners(); renderSummary(); renderFamilyFilter(); renderAccounts(); renderCheckup(); renderPageChrome() }
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
        // The server now runs another build (sideby was reinstalled and restarted): this page's script is old.
        if (state.build && BOOT.build && state.build !== BOOT.build && !S.newBuild) {
          S.newBuild = true
          if (uiBusy()) toast(t('toast.updated'))
        }
        // A read-only Panel never records checks, so keep the result of its own last check over the disk.
        if (!BOOT.readOnly || !S.history) S.history = state.history || null
        adoptPanel(state.panel)
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
    reloadForNewBuild()
  }
  // Reloads into the new build once the viewer is not in the middle of something (a dialog, a form, a selection).
  function reloadForNewBuild() {
    if (S.newBuild && !uiBusy() && !S.fixing && !S.checking && !dlg.busy) location.reload()
  }
  // Once a second: the "Updated" age ticks, a deferred render lands once the viewer is done, and the state
  // reloads on schedule while the page is visible.
  function tick() {
    renderUpdated()
    reloadForNewBuild()
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

  // ---------- updates (spec §3.23, ADR-0021) ----------
  // A label in the header only when a newer sideby exists; the footer version opens the same dialog any time, with
  // the Auto Update switch. Updating is one plan shown first and one click; afterwards the page waits for the new
  // build and reloads (a background Panel restarts itself, a Portal loads the new code by itself).
  let up = null
  function updState() { return BOOT.updates && S.state ? S.state.update || null : null }
  // The skill agents read is part of the version (spec §3.23): behind a current CLI it is the one thing to update.
  const isLocal = (u) => u.method.kind === 'local'
  // A Local Build the Panel can leave for npm itself (ADR-0024): then that switch is the update, not a command.
  const leavesLocal = (u) => canLeaveLocal(u, BOOT.readOnly)
  const skillOld = (u) => !!(u && !u.available && !isLocal(u) && u.skillUpdate && u.skillUpdate.outdated)
  const skillDue = (u) => skillOld(u) && u.skillUpdate.canRun
  function skillFor(u) {
    const v = u.skillUpdate.installed.find((x) => x !== u.current)
    return v ? v : t('upd.skillNoVer')
  }
  // Why sideby cannot do something itself, in the viewer's language; the English reason when the code is unknown.
  const why = (o) => (o && o.reasonCode ? t('why.' + o.reasonCode, { at: o.reasonAt || '' }) : (o && o.reason) || '')
  const offText = (u) => (u.checksOffCode ? t('off.' + u.checksOffCode, { why: u.checksOff }) : t('upd.checksOff', { why: u.checksOff }))
  function renderUpdateButton() {
    const b = $('update')
    const u = updState()
    // The version the page runs, a pill after the name; it opens the same dialog (with "Check for updates"), and
    // takes a dot while a newer version waits.
    const v = $('ver-top')
    v.hidden = !BOOT.version
    if (!v.hidden) {
      const newer = !!(u && (u.available || skillDue(u)))
      v.textContent = verLabel()
      v.classList.toggle('has-update', newer)
      v.disabled = !BOOT.updates
      const tip = !BOOT.updates ? '' : u && u.available ? t('upd.labelLong', { v: u.latest, cur: u.current })
        : skillDue(u) ? t('upd.skillLabelLong', { s: skillFor(u), cur: u.current }) : t('upd.verTitle', { v: BOOT.version })
      v.title = tip
      if (tip) v.setAttribute('aria-label', tip)
      else v.removeAttribute('aria-label')
    }
    b.hidden = !(u && (u.available || skillDue(u)))
    if (!b.hidden) {
      const long = u.available ? t('upd.labelLong', { v: u.latest, cur: u.current }) : t('upd.skillLabelLong', { s: skillFor(u), cur: u.current })
      setKids(b, [icon('arrowUp'), h('span', null, u.available ? t('upd.label', { v: u.latest }) : t('upd.skillLabel'))])
      b.setAttribute('aria-label', long)
      b.title = long
    }
    if (dlg.kind === 'update' && up && !up.busy) renderUpdate()
    if (!vp.checking) renderVerPop()
  }
  function openUpdate() {
    if (!BOOT.updates) return
    up = { busy: false, error: null, done: null, confirming: null, unknown: null, changed: false, skillDone: false, skillChanged: false, autoPlan: null, autoBusy: false, waitUntil: 0, checking: false, checked: false }
    showDialog('update')
    renderUpdate()
  }
  async function updRun() {
    const u = updState()
    if (!u) return
    up.busy = true
    dlg.busy = true
    up.error = null
    up.unknown = null
    renderUpdate()
    const target = u.latest
    const free = () => { up.busy = false; dlg.busy = false }
    await codeSwap({
      send: () => api('/api/update', { confirm: true, version: target }),
      landed: () => { const now = updState(); return now ? now.current === target : null },
      // The answer was cut: say only that it is being confirmed, never "updated", until the state shows it.
      confirming: () => { free(); up.confirming = target; renderUpdate() },
      done: (r) => {
        free()
        up.confirming = null
        if (r && !r.updated) {
          // The registry names another version than the dialog showed: show the new plan and let the person look again.
          Object.assign(S.state.update, { latest: r.latest, available: r.available, command: r.command, canRun: r.canRun, releaseNotes: r.releaseNotes, method: r.method })
          up.changed = true
          renderUpdate()
          return false
        }
        up.done = r || { updated: true, latest: target }
        up.waitUntil = Date.now() + 20000
        renderUpdate()
        return true
      },
      stuck: () => { up.waitUntil = 0; renderUpdate() },
      fail: (e) => { free(); up.confirming = null; up.error = e; renderUpdate() },
      unknown: () => { free(); up.confirming = null; up.unknown = target; renderUpdate() },
    })
  }
  // The CLI is current and the skill is behind: update the skill alone, as sideby update --skill --yes does.
  async function updSkillRun() {
    up.busy = true
    dlg.busy = true
    up.error = null
    up.skillChanged = false
    renderUpdate()
    try {
      const r = await api('/api/update', { confirm: true, skill: true })
      if (r.skillUpdated) {
        up.skillDone = true
        toast(t('upd.skillDoneOnly'))
        // The health check still lists the old skill: check again so its Findings go.
        if ((findingsNow() || []).some((f) => f.code === 'skill.outdated')) runCheck()
      } else up.skillChanged = true
      await load({ silent: true })
    } catch (e) { up.error = e }
    up.busy = false
    dlg.busy = false
    renderUpdate()
  }
  // The version pill opens a small popover, not the dialog: the version, whether it is the newest, "Check for
  // updates" in place, and the way into the dialog when there is something to do (update, Auto Update).
  const vp = { checking: false, checked: false, error: null }
  function openVerPop(anchor) {
    if (!BOOT.updates) return
    vp.checked = false
    vp.error = null
    openPopover(anchor, 'version', t('upd.title'), verPopKids)
  }
  function renderVerPop() { refreshPopover('version') }
  // A Local Build (ADR-0024) names its commit, with + when the working tree had changes, so the viewer can tell
  // which code they are looking at.
  function verLabel() {
    const l = BOOT.local
    return 'v' + BOOT.version + (l ? '-dev' + (l.commit ? ' · ' + l.commit + (l.dirty ? '+' : '') : '') : '')
  }
  function verPopKids() {
    const u = updState()
    const toDialog = () => { closeMenu(); openUpdate() }
    const kids = [h('b', null, 'sideby ' + verLabel())]
    if (BOOT.local) kids.push(h('p', { class: 'muted small' }, t(BOOT.local.dirty ? 'upd.localDirty' : 'upd.local', { at: BOOT.local.builtAt ? clock(BOOT.local.builtAt) : '' })))
    let status
    if (!u) status = t('upd.loading')
    else if (u.available || skillOld(u)) status = null
    else if (vp.checked && u.latest) status = t('upd.latestNow')
    else if (u.checksOff) status = offText(u)
    else if (u.latest) status = t('upd.latest') + (u.checkedAt ? ' · ' + t('upd.checked', { ago: ago(u.checkedAt) }) : '')
    else status = t('upd.notYet')
    if (status) kids.push(h('p', { class: 'muted small' }, status))
    if (u && u.available) {
      kids.push(h('p', { class: 'small' }, t('upd.available', { v: u.latest }), ' ',
        h('a', { href: u.releaseNotes, target: '_blank', rel: 'noopener noreferrer' }, t('upd.notes'))))
      if (!(isLocal(u) && leavesLocal(u)))
        kids.push(h('div', { class: 'popover-actions' }, h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: toDialog }, t('upd.open'))))
    } else if (skillOld(u)) {
      kids.push(h('p', { class: 'small' }, t('upd.skillBehind', { s: skillFor(u) })))
      kids.push(h('div', { class: 'popover-actions' }, h('button', { class: 'btn btn-sm' + (skillDue(u) ? ' btn-primary' : ''), type: 'button', onclick: toDialog }, t('upd.open'))))
    } else if (!BOOT.readOnly) {
      kids.push(h('div', { class: 'popover-actions' }, h('button', { class: 'btn btn-sm', type: 'button', disabled: vp.checking, 'aria-busy': vp.checking ? 'true' : null, onclick: verPopCheck },
        vp.checking ? spinner() : icon('refresh'), vp.checking ? t('upd.checking') : t('upd.check'))))
    }
    if (vp.error) kids.push(errorNote(vp.error, null))
    const sw = localSwitchKids(u)
    if (sw) kids.push(sw)
    if (u && !BOOT.readOnly && !isLocal(u))
      kids.push(h('p', { class: 'muted small popover-foot' }, t(u.auto ? 'upd.autoIsOn' : 'upd.autoIsOff'), ' · ',
        h('button', { class: 'link-btn', type: 'button', onclick: toDialog }, t('upd.settings'))))
    return kids
  }
  // The switch between a Local Build and the npm package (ADR-0024), only where the state offers it: the other side,
  // one button. After the switch the page waits for the server to run the new build and reloads into it.
  const vs = { busy: false, to: null, stuck: false, unknown: false, error: null }
  function localSwitchKids(u) {
    const ls = u && u.localSwitch
    if (!ls || BOOT.readOnly) return null
    // While it switches the state already shows the other side; keep the words of the side clicked.
    const toNpm = vs.busy ? vs.to === 'npm' : ls.running === 'local'
    if (!toNpm && !ls.local) return null
    const l = ls.local
    const build = l ? l.version + '-dev · ' + (l.commit || '?') + (l.dirty ? '+' : '') : ''
    const kids = [h('p', { class: 'muted small' }, toNpm ? t('loc.toNpmHint') : t('loc.toLocalHint', { b: build, at: l.builtAt ? clock(l.builtAt) : '' }))]
    if (vs.stuck || vs.unknown) {
      kids.push(h('p', { class: 'small' }, t(vs.stuck ? 'loc.stuck' : 'loc.unconfirmed')))
      kids.push(h('div', { class: 'popover-actions' }, h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => location.reload() }, icon('refresh'), t('loc.reload'))))
    } else {
      const newer = toNpm && u.available && u.latest
      kids.push(h('div', { class: 'popover-actions' }, h('button', { class: 'btn btn-sm' + (newer ? ' btn-primary' : ''), type: 'button', disabled: vs.busy, 'aria-busy': vs.busy ? 'true' : null, onclick: () => localSwitchTo(toNpm ? 'npm' : 'local') },
        vs.busy ? spinner() : icon('swap'), vs.busy ? t('loc.switching') : newer ? t('loc.toNpmV', { v: u.latest }) : t(toNpm ? 'loc.toNpm' : 'loc.toLocal'))))
    }
    if (vs.error) kids.push(errorNote(vs.error, null))
    return h('div', { class: 'popover-foot' }, kids)
  }
  function renderSwitch() {
    renderVerPop()
    if (dlg.kind === 'update' && up) renderUpdate()
  }
  async function localSwitchTo(to) {
    vs.busy = true
    vs.to = to
    vs.error = null
    vs.stuck = false
    vs.unknown = false
    renderSwitch()
    await codeSwap({
      send: () => api('/api/local', { to, confirm: true }),
      landed: () => { const now = updState(); return now && now.localSwitch ? now.localSwitch.running === to : null },
      confirming: () => {},
      done: () => true,
      stuck: () => { vs.busy = false; vs.stuck = true; renderSwitch() },
      fail: (e) => { vs.busy = false; vs.error = e; renderSwitch() },
      unknown: () => { vs.busy = false; vs.unknown = true; renderSwitch() },
    })
  }
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // Reads the state; true when this read answered (a cut connection or a load already running leaves the old state).
  async function readState() {
    const before = S.loadedAt
    try { await load({ silent: true }) } catch {}
    return S.loadedAt !== before
  }
  // A request that may swap the server's code (runCodeSwap): each wait is 20 s, read every 1.5 s.
  function codeSwap(o) {
    return runCodeSwap(Object.assign({
      readState,
      newBuild: () => !!S.newBuild,
      reload: () => location.reload(),
      now: () => Date.now(),
      pause,
      windowMs: 20000,
      pollMs: 1500,
    }, o))
  }
  async function verPopCheck() {
    vp.checking = true
    vp.error = null
    renderVerPop()
    try {
      await api('/api/update', {})
      await load({ silent: true })
      vp.checked = true
    } catch (e) { vp.error = e }
    vp.checking = false
    renderVerPop()
    const b = menu.el && menu.el.querySelector('.popover-actions button')
    if (b) b.focus()
  }
  // "Check for updates": asks the registry now (the daily check only runs once a day), then shows the answer.
  async function updCheck() {
    up.checking = true
    up.error = null
    renderUpdate()
    try {
      await api('/api/update', {})
      await load({ silent: true })
      up.checked = true
    } catch (e) { up.error = e }
    up.checking = false
    renderUpdate()
  }
  async function updAuto(on) {
    up.autoBusy = true
    up.error = null
    renderUpdate()
    try {
      const r = await api('/api/update/settings', { auto: on })
      up.autoPlan = r.changed ? { auto: on, file: r.file } : null
    } catch (e) { up.error = e }
    up.autoBusy = false
    renderUpdate()
  }
  async function updAutoSave() {
    if (!up.autoPlan) return
    up.autoBusy = true
    renderUpdate()
    try {
      await api('/api/update/settings', { auto: up.autoPlan.auto, confirm: true })
      toast(t(up.autoPlan.auto ? 'upd.autoOnSaved' : 'upd.autoOffSaved'))
      up.autoPlan = null
      await load({ silent: true })
    } catch (e) { up.error = e }
    up.autoBusy = false
    renderUpdate()
  }
  // The installed sideby skill follows the CLI (spec §3.23): one quiet line when the Update brings it along, the
  // reason and the command only when sideby may not.
  function updSkill(u) {
    const s = u.skillUpdate
    if (!s || !s.outdated) return []
    if (s.canRun) return [h('p', { class: 'muted small' }, t('upd.skillToo'))]
    return [h('p', { class: 'small' }, t('upd.skillManaged', { why: why(s) })), codeCopy(s.command)]
  }
  // What a person runs by hand, behind a click: the default path is the button.
  function updManual(cmds) {
    return h('details', { class: 'tune-details' }, h('summary', null, t('upd.manual')), cmds)
  }
  function renderUpdate() {
    if (!up || dlg.kind !== 'update') return
    const u = updState()
    const body = []
    if (!u) {
      body.push(h('p', { class: 'muted' }, spinner(), ' ', t('upd.loading')))
      setKids(dlg.el, dialogFrame(t('upd.title'), null, body, null))
      return
    }
    body.push(h('p', null, t('upd.current', { v: u.current })))
    // While an Update runs, is being confirmed or could not be, the dialog offers nothing else to start.
    const swapping = Boolean(up.done || up.confirming || up.unknown)
    if (up.confirming) {
      body.push(h('p', { class: 'muted small' }, spinner(), ' ', t('upd.confirming', { v: up.confirming })))
    } else if (up.unknown) {
      body.push(h('p', { class: 'note note-warn' }, t('upd.unconfirmed', { v: up.unknown })))
    } else if (up.done) {
      body.push(h('p', { class: 'note' }, t('upd.done', { v: up.done.latest })))
      body.push(h('p', { class: 'muted small' }, Date.now() > up.waitUntil ? t('upd.restartHint') : [spinner(), ' ', t('upd.reloading')]))
      if (up.done.skillUpdated) body.push(h('p', { class: 'small' }, t('upd.skillDone')))
      else if (up.done.skillSyncStarted) body.push(h('p', { class: 'muted small' }, t('upd.skillSyncing')))
      else body.push(...updSkill(u))
    } else if (up.skillDone && !skillOld(u)) {
      body.push(h('p', { class: 'note' }, t('upd.skillDoneOnly')))
    } else if (u.available && isLocal(u) && (leavesLocal(u) || vs.busy || vs.stuck || vs.unknown)) {
      // A Local Build the Panel can leave (ADR-0024): switching to the release is the update, and brings the skill.
      body.push(h('p', null, t('upd.localSwitch', { v: u.latest }), ' ',
        h('a', { href: u.releaseNotes, target: '_blank', rel: 'noopener noreferrer' }, t('upd.notes'))))
      if (vs.busy) body.push(h('p', { class: 'muted small' }, spinner(), ' ', t('upd.reloading')))
      if (vs.stuck) body.push(h('p', { class: 'note' }, t('loc.stuck')))
      if (vs.unknown) body.push(h('p', { class: 'note note-warn' }, t('loc.unconfirmed')))
      if (vs.error) body.push(errorNote(vs.error, null))
      body.push(updManual([h('p', { class: 'small' }, t('upd.localManual')), codeCopy(u.command)]))
    } else if (u.available && isLocal(u)) {
      // A Local Build (ADR-0024): one way back to npm, which brings the skill along.
      body.push(h('p', null, t('upd.localAvail', { v: u.latest }), ' ',
        h('a', { href: u.releaseNotes, target: '_blank', rel: 'noopener noreferrer' }, t('upd.notes'))))
      body.push(codeCopy(u.command))
    } else if (u.available) {
      if (up.changed) body.push(h('p', { class: 'note note-warn' }, t('upd.changed', { v: u.latest })))
      body.push(h('p', null, h('b', null, t('upd.available', { v: u.latest })), ' ',
        h('a', { href: u.releaseNotes, target: '_blank', rel: 'noopener noreferrer' }, t('upd.notes'))))
      if (u.canRun) {
        body.push(...updSkill(u))
        body.push(h('p', { class: 'muted small' }, t('upd.after')))
        body.push(updManual([h('p', { class: 'small' }, t('upd.runs')), codeCopy(u.command)]))
      } else {
        body.push(h('p', { class: 'note note-warn' }, t('upd.cannot', { why: why(u.method) || u.method.kind })))
        body.push(codeCopy(u.command))
        // An install by hand leaves the skill behind; sideby update (or Auto Update) brings it along afterwards.
        const s = u.skillUpdate
        if (s && s.outdated && s.canRun) body.push(h('p', { class: 'muted small' }, t('upd.skillLater')))
        else body.push(...updSkill(u))
      }
    } else if (skillOld(u)) {
      if (up.skillChanged) body.push(h('p', { class: 'note note-warn' }, t('upd.skillChanged')))
      const s = u.skillUpdate
      body.push(h('p', null, h('b', null, t('upd.skillBehind', { s: skillFor(u) }))))
      if (s.canRun) {
        body.push(h('p', { class: 'muted small' }, t('upd.skillWhat', { cur: u.current })))
        body.push(updManual([codeCopy(s.command)]))
      } else body.push(h('p', { class: 'small' }, t('upd.skillManaged', { why: why(s) })), codeCopy(s.command))
    } else if (up.checked && u.latest) {
      body.push(h('p', { class: 'note' }, t('upd.latestNow')))
    } else if (u.checksOff) {
      body.push(h('p', { class: 'muted small' }, offText(u)))
    } else if (u.latest) {
      body.push(h('p', { class: 'muted small' }, t('upd.latest') + (u.checkedAt ? ' · ' + t('upd.checked', { ago: ago(u.checkedAt) }) : '')))
    } else body.push(h('p', { class: 'muted small' }, t('upd.notYet')))
    // A read-only Panel sends no request and writes nothing, so it cannot check (spec §3.23).
    if (!BOOT.readOnly && !swapping && !u.available && !skillDue(u))
      body.push(h('p', null, h('button', { class: 'btn btn-sm', type: 'button', disabled: up.checking || up.busy, 'aria-busy': up.checking ? 'true' : null, onclick: updCheck },
        up.checking ? spinner() : icon('refresh'), up.checking ? t('upd.checking') : t('upd.check'))))
    if (!BOOT.readOnly && !swapping && isLocal(u)) body.push(h('p', { class: 'muted small' }, t('upd.autoLocal')))
    else if (!BOOT.readOnly && !swapping) {
      const box = h('input', { type: 'checkbox', disabled: up.autoBusy || !u.method.canUpdate })
      box.checked = up.autoPlan ? up.autoPlan.auto : u.auto
      box.addEventListener('change', () => updAuto(box.checked))
      body.push(h('div', { class: 'check-row' }, h('label', { class: 'check' }, box,
        h('span', null, h('b', null, t('upd.auto')), h('span', { class: 'muted small' }, u.method.canUpdate ? t('upd.autoHint') : t('upd.autoNo'))))))
      if (up.autoPlan) body.push(h('p', { class: 'small' }, t('upd.autoChange', { file: up.autoPlan.file, value: String(up.autoPlan.auto) }), ' ',
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: up.autoBusy, onclick: updAutoSave }, t('upd.save'))))
    }
    if (BOOT.readOnly) body.push(h('p', { class: 'note' }, t('banner.readOnly')))
    if (up.error) body.push(errorNote(up.error, null))
    const foot = [h('button', { class: 'btn', type: 'button', disabled: up.busy, onclick: () => dlg.el.close() }, t('btn.close'))]
    const primary = (label, run) => h('button', { class: 'btn btn-primary', type: 'button', disabled: up.busy, 'aria-busy': up.busy ? 'true' : null, onclick: run }, up.busy ? spinner() : null, up.busy ? t('upd.updating') : label)
    if (up.unknown || (u.available && isLocal(u) && (vs.stuck || vs.unknown))) foot.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => location.reload() }, icon('refresh'), t('loc.reload')))
    else if (u.available && isLocal(u) && (leavesLocal(u) || vs.busy))
      foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: vs.busy, 'aria-busy': vs.busy ? 'true' : null, onclick: () => localSwitchTo('npm') },
        vs.busy ? spinner() : icon('swap'), vs.busy ? t('loc.switching') : t('loc.toNpmV', { v: u.latest })))
    else if (u.available && u.canRun && !BOOT.readOnly && !swapping) foot.push(primary(t('upd.now', { v: u.latest }), updRun))
    else if (skillDue(u) && !BOOT.readOnly && !swapping) foot.push(primary(t('upd.skillNow'), updSkillRun))
    setKids(dlg.el, dialogFrame(t('upd.title'), null, body, foot))
  }

  // ---------- start ----------
  $('ver').textContent = BOOT.version ? 'sideby v' + BOOT.version : 'sideby'
  $('ver').disabled = !BOOT.updates
  $('ver').addEventListener('click', () => openVerPop($('ver')))
  $('update').addEventListener('click', openUpdate)
  $('ver-top').addEventListener('click', () => openVerPop($('ver-top')))
  $('refresh').addEventListener('click', refreshAll)
  $('ask-ai').addEventListener('click', () => openAsk())
  // In a Portal that offers AI Tasks itself the Portal has the button; opened on its own, the Panel keeps it.
  $('ask-ai').hidden = askBridged(BOOT, window)
  $('accounts').addEventListener('dragover', onDragOver)
  $('accounts').addEventListener('drop', onDrop)
  // Escape leaves the arrange mode, as "Done" does, unless a menu or dialog takes it first.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || !ui.arrange || menu.el || (dlg.el && dlg.el.open) || e.target.closest('input, select, textarea')) return
    endArrange()
  })
  $('settings').addEventListener('click', () => openPopover($('settings'), 'settings', t('set.button'), settingsPop, 'end'))
  document.addEventListener('contextmenu', onContextMenu)
  document.addEventListener('keydown', onMenuKey)
  // The first load of this version writes this browser's earlier theme and language into config, once (spec §3.29).
  if (CFG && !prefs.cfgDone) {
    if (!cfgMigrate) { prefs.cfgDone = true; savePrefs() }
    else saveCfg(cfgMigrate, true).then((ok) => { if (ok) { prefs.cfgDone = true; savePrefs() } })
  }
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
