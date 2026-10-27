// The Panel page's inline script. Plain browser JavaScript in a string (no template literals inside, so String.raw
// keeps it verbatim); the pure helpers from page-logic.ts are prepended so the tested code is the code that runs.
import { groupsToAccept } from '../core/inbound.ts'
import { quotaIsStale } from '../core/quota-levels.ts'
import { remoteControlTodo } from '../core/remote-control.ts'
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
  bindingWindow,
  cacheHitRate,
  canLeaveLocal,
  categoryOrder,
  codeSwapOutcome,
  dotsKeepKeyboard,
  enableOutcome,
  fileSize,
  fixPrompt,
  foldSkips,
  foldToolCalls,
  formatDuration,
  handoffChangeOf,
  handoffHintAccount,
  handoffTaskFacts,
  hiddenIn,
  highlightParts,
  histFilters,
  historyEmpty,
  historyWhen,
  hotkeyFromKey,
  hotkeyPressKind,
  inDisplayOrder,
  loginClusters,
  loginKey,
  maskEmail,
  matchesQuery,
  mdBlocks,
  mdInline,
  menuPlacement,
  mergeDaily,
  mergeUsage,
  messageChip,
  messageNews,
  networkTaskFacts,
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
  quotaHighLevel,
  quotaPressure,
  radioStep,
  remoteControlSummary,
  reorder,
  rowBadge,
  runCodeSwap,
  saveHandoffChange,
  sendBlock,
  sendFileProblem,
  sendResultView,
  sessionAge,
  sessionLabelParts,
  shortCwd,
  shortSessionLabel,
  sortAccounts,
  sortSessions,
  steadyOrder,
  stripSecrets,
  suggestAlias,
  suggestName,
  switchFailure,
  tailInView,
  taskFindings,
  updatedAge,
  widthFollower,
  widthTier,
  windowState,
  withPinned,
} from './page-logic.ts'

const LOGIC = [
  quotaIsStale,
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
  quotaHighLevel,
  autostartNote,
  hotkeyFromKey,
  hotkeyPressKind,
  cacheHitRate,
  categoryOrder,
  fileSize,
  fixPrompt,
  foldSkips,
  formatDuration,
  foldToolCalls,
  highlightParts,
  historyEmpty,
  historyWhen,
  handoffChangeOf,
  handoffHintAccount,
  handoffTaskFacts,
  networkTaskFacts,
  inDisplayOrder,
  loginClusters,
  loginKey,
  maskEmail,
  matchesQuery,
  menuPlacement,
  radioStep,
  dotsKeepKeyboard,
  mergeDaily,
  mergeUsage,
  messageChip,
  messageNews,
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
  groupsToAccept,
  saveHandoffChange,
  enableOutcome,
  reorder,
  rowBadge,
  sendBlock,
  sendFileProblem,
  sendResultView,
  sessionAge,
  sessionLabelParts,
  shortCwd,
  shortSessionLabel,
  sortAccounts,
  sortSessions,
  steadyOrder,
  histFilters,
  mdBlocks,
  mdInline,
  suggestAlias,
  suggestName,
  tailInView,
  updatedAge,
  pinnedIn,
  hiddenIn,
  widthFollower,
  widthTier,
  windowState,
  bindingWindow,
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
  // Findings listed before the rest fold behind a button.
  const FINDINGS_SHOWN = 5
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
  const SVG_NS = 'http://www.w3.org/2000/svg'
  // Follows the system setting live, so turning on "Reduce motion" with the page open stops the scripted motion too.
  const REDUCED_MQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  let REDUCED = Boolean(REDUCED_MQ && REDUCED_MQ.matches)
  if (REDUCED_MQ && REDUCED_MQ.addEventListener) REDUCED_MQ.addEventListener('change', (e) => { REDUCED = e.matches })
  // Auto refresh: the state reloads every AUTO_MS while the page is visible, and every FAST_MS for FAST_FOR_MS after
  // quota is turned on, so the first numbers show up soon after a status line reports them.
  const AUTO_MS = 20000
  const FAST_MS = 5000
  const PENDING_MS = 1500
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
  const ui = { query: '', attention: false, allFindings: false, healthRef: null, checkingRef: null, desktopRef: null, browserRef: null, appBusy: null, appRemove: null, copied: null, appNew: null, highlight: null, fade: true, loginRefs: new Map(), order: { families: [], units: {} }, drag: null, arrange: null }
  const $ = (id) => document.getElementById(id)

  // ---------- preferences ----------
  // Kept in localStorage, which can be missing or throw (private windows, blocked storage): every access is guarded
  // and the defaults apply.
  const PREFS_KEY = 'sideby.panel.v2'
  const HIST_GROUPS = ['project', 'category', 'day', 'account', 'family', 'none']
  const HIST_FOLD_MAX = 200
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
    if (raw.inbHide === true) p.inbHide = true
    if (raw.mbHintDone === true) p.mbHintDone = true
    if (raw.cfgDone === true) p.cfgDone = true
    if (typeof raw.setSec === 'string') p.setSec = raw.setSec
    if (typeof raw.family === 'string') p.family = raw.family
    if (raw.collapsed && typeof raw.collapsed === 'object')
      for (const k of Object.keys(raw.collapsed)) if (raw.collapsed[k] === true) p.collapsed[k] = true
    if (raw.open && typeof raw.open === 'object')
      for (const k of Object.keys(raw.open)) if (raw.open[k] === true) p.open[k] = true
    // History: how the list is grouped, and per grouping the groups the user folded.
    if (HIST_GROUPS.includes(raw.histGroup)) p.histGroup = raw.histGroup
    p.histFold = {}
    if (raw.histFold && typeof raw.histFold === 'object')
      for (const g of HIST_GROUPS) {
        const keys = raw.histFold[g] && typeof raw.histFold[g] === 'object' ? Object.keys(raw.histFold[g]).filter((k) => raw.histFold[g][k] === true).slice(0, HIST_FOLD_MAX) : []
        if (keys.length) { p.histFold[g] = {}; for (const k of keys) p.histFold[g][k] = true }
      }
    // The categories of the side list, in the order the user dragged them to.
    p.histCatOrder = Array.isArray(raw.histCatOrder) ? raw.histCatOrder.filter((c) => typeof c === 'string' && c).slice(0, HIST_FOLD_MAX) : []
    // The categories folded in the side list.
    p.histCatFold = {}
    if (raw.histCatFold && typeof raw.histCatFold === 'object')
      for (const k of Object.keys(raw.histCatFold).filter((k) => raw.histCatFold[k] === true).slice(0, HIST_FOLD_MAX)) p.histCatFold[k] = true
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
  function colon() { return t('punct.colon') }
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
  // The toast stack (raiseToasts) may live in the open dialog; redrawing the dialog leaves it where it is.
  const keepsToasts = (n) => n.nodeType === 1 && n.id === 'toasts'
  function setKids(el, kids) {
    for (const n of Array.from(el.childNodes)) if (!keepsToasts(n)) n.remove()
    const stack = el.lastChild
    if (!stack) return add(el, kids)
    // New content goes before the stack, so a later patch finds it in place and moves nothing (moving loses focus).
    const box = document.createDocumentFragment()
    add(box, kids)
    el.insertBefore(box, stack)
  }
  // Re-renders el without the jolt of a rebuild: the focused control keeps focus (matched by data-key), and an element
  // marked data-enter that was not there before grows in, so a row that appears does not snap the layout open.
  // A first render (el empty) animates nothing; the container itself has its own entrance.
  function swapKids(el, kids) {
    const before = new Set([...el.querySelectorAll('[data-enter]')].map((x) => x.getAttribute('data-enter')))
    const shown = Array.from(el.childNodes).some((n) => !keepsToasts(n))
    const active = document.activeElement
    const focusKey = active && el.contains(active) ? active.getAttribute('data-key') : null
    setKids(el, kids)
    if (shown && !REDUCED)
      for (const x of el.querySelectorAll('[data-enter]')) if (!before.has(x.getAttribute('data-enter'))) x.classList.add('enter')
    if (focusKey) { const again = el.querySelector('[data-key="' + CSS.escape(focusKey) + '"]'); if (again) again.focus() }
  }
  // swapKids for a view that refreshes while open: unchanged elements stay (see patch), so a refresh that brings the
  // same answer redraws nothing; new data-enter elements still grow in.
  function patchEnter(el, kids) {
    const before = new Set([...el.querySelectorAll('[data-enter]')].map((x) => x.getAttribute('data-enter')))
    const shown = Array.from(el.childNodes).some((n) => !keepsToasts(n))
    patch(el, kids)
    if (shown && !REDUCED)
      for (const x of el.querySelectorAll('[data-enter]'))
        if (!before.has(x.getAttribute('data-enter'))) {
          x.classList.add('enter')
          // Gone once it has grown in, so the next refresh sees the same markup and keeps the element.
          x.addEventListener('animationend', () => x.classList.remove('enter'), { once: true })
        }
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
    const old = Array.from(box.childNodes).filter((n) => !keepsToasts(n))
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
    // Lucide "users-round", "messages-square", "gauge" and "route" for the page tabs (ISC license)
    tabAccounts: 'M18 21a8 8 0 0 0-16 0M5 8a5 5 0 1 0 10 0 5 5 0 1 0-10 0M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3',
    tabSessions: 'M16 10a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 14.286V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2zM20 9a2 2 0 0 1 2 2v10.286a.71.71 0 0 1-1.212.502l-2.202-2.202A2 2 0 0 0 17.172 19H10a2 2 0 0 1-2-2v-1',
    tabTuning: 'm12 14 4-4M3.34 19a10 10 0 1 1 17.32 0',
    tabHandoff: 'M3 19a3 3 0 1 0 6 0 3 3 0 1 0-6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M15 5a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
    refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4.2-4.2',
    chevron: 'M9 6l6 6-6 6',
    chevronLeft: 'M15 6l-6 6 6 6',
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
    tick: 'M5 12.5l4.5 4.5L19 7.5',
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
    // Lucide "users" and "message-square" (ISC license)
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
    messages: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    mail: 'M3 6h18v12H3zM3 7l9 6 9-6',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.8 5.5 3.8 9s-1.3 6.5-3.8 9c-2.5-2.5-3.8-5.5-3.8-9S9.5 5.5 12 3z',
    image: 'M3 5h18v14H3zM3 16l5-5 4 4 3-3 6 6M15 9h.01',
    // Lucide "send" (ISC license)
    send: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11zM21.854 2.147l-10.94 10.939',
    film: 'M3 5h18v14H3zM7 5v14M17 5v14M3 9h4M3 15h4M17 9h4M17 15h4',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8v5M12 16h.01',
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
  // opens keeps toasts above that dialog's backdrop. A modal dialog makes everything outside it inert, a popover
  // above it included, so while one is open the stack moves into it and an Undo stays clickable; it moves back
  // when the dialog closes. Without popover support it stays a fixed element.
  function raiseToasts() {
    const el = $('toasts')
    const home = dlg.el && dlg.el.open ? dlg.el : document.body
    if (el.parentNode !== home) home.append(el)
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
      // "keep": a toast that asks the user to act; three newer ones push out the others first.
      item = { text, ms, key: opts.key || null, keep: Boolean(opts.keep) }
      const action = opts.action ? h('button', { class: 'toast-action', type: 'button', onclick: () => { dismiss(item); opts.action.run() } }, opts.action.label) : null
      item.el = h('div', { class: 'toast toast-' + kind, role: kind === 'fail' ? 'alert' : null },
        h('span', { class: 'toast-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'toast-text' }, text),
        action,
        h('button', { class: 'toast-x', type: 'button', 'aria-label': t('toast.dismiss'), onclick: () => dismiss(item) }, icon('x')))
      // Hovering holds the toast; leaving gives back the time it had left, and at least 2.5 s to move away.
      item.el.addEventListener('mouseenter', () => { clearTimeout(item.timer); item.left = Math.max(0, item.until - Date.now()) })
      item.el.addEventListener('mouseleave', () => { if (!item.gone) { item.until = Date.now() + Math.max(2500, item.left || 0); item.timer = setTimeout(() => dismiss(item), item.until - Date.now()) } })
      toasts.push(item)
      $('toasts').append(item.el)
      if (dlg.el && dlg.el.open) raiseToasts()
      while (toasts.length > 3) dismiss(toasts.find((x) => !x.keep && x !== item) || toasts[0])
    }
    item.until = Date.now() + ms
    item.timer = setTimeout(() => dismiss(item), ms)
  }
  function dismiss(item) {
    if (item.gone) return
    item.gone = true
    clearTimeout(item.timer)
    const i = toasts.indexOf(item)
    if (i >= 0) toasts.splice(i, 1)
    if (REDUCED || document.hidden) { item.el.remove(); return }
    // It folds away as it fades, so the toasts beside it slide into place instead of jumping.
    item.el.style.height = item.el.getBoundingClientRect().height + 'px'
    item.el.classList.add('toast-out')
    item.el.style.setProperty('pointer-events', 'none')
    // Removed once the fold has played, even when the browser starts it late; the timer covers one that never ends.
    const done = () => item.el.remove()
    item.el.addEventListener('animationend', (e) => { if (e.animationName === 'toast-out') done() })
    setTimeout(done, 1000)
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

  function family(id) { return (S.state && S.state.families.find((f) => f.id === id)) || { id, title: id, bin: id, installUrl: '', installed: false } }
  function famTitle(a) { return a.familyTitle || family(a.family).title }
  // The email as the page shows it: masked everywhere while "Hide emails" is on (copying still gives the real one).
  function emailText(email) { return prefs.hideEmail ? maskEmail(email) : email }
  let logoWashes = 0
  // A Family's mark: the logo its FamilyDef sets (checked by the loader), or its initials on a color derived from the id.
  // size: '' (cards), 'sm' (rows, groups, dialogs) or 'xs' (inside a chip; no initials fallback there).
  function badge(id, size) {
    const logo = family(id).logo
    const cls = 'badge' + (size ? ' badge-' + size : '')
    if (logo) {
      const svg = document.createElementNS(SVG_NS, 'svg')
      svg.setAttribute('viewBox', '0 0 24 24')
      svg.setAttribute('focusable', 'false')
      const shape = (fill) => {
        const path = document.createElementNS(SVG_NS, 'path')
        path.setAttribute('d', logo.path)
        if (logo.fillRule) path.setAttribute('fill-rule', logo.fillRule)
        if (fill) path.setAttribute('fill', fill)
        return path
      }
      svg.append(shape(null))
      // A multicoloured mark: each wash is the shape again, filled with a gradient that fades out (ids unique per page).
      if (Array.isArray(logo.gradients) && logo.gradients.length) {
        const defs = document.createElementNS(SVG_NS, 'defs')
        svg.prepend(defs)
        for (const g of logo.gradients) {
          const id = 'logo-wash-' + (++logoWashes)
          const lg = document.createElementNS(SVG_NS, 'linearGradient')
          lg.setAttribute('id', id)
          lg.setAttribute('gradientUnits', 'userSpaceOnUse')
          lg.setAttribute('x1', String(g.from[0])); lg.setAttribute('y1', String(g.from[1]))
          lg.setAttribute('x2', String(g.to[0])); lg.setAttribute('y2', String(g.to[1]))
          for (const [offset, opacity] of [['0', '1'], ['1', '0']]) {
            const stop = document.createElementNS(SVG_NS, 'stop')
            stop.setAttribute('offset', offset)
            stop.setAttribute('stop-color', g.color)
            stop.setAttribute('stop-opacity', opacity)
            lg.append(stop)
          }
          defs.append(lg)
          svg.append(shape('url(#' + id + ')'))
        }
      }
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
    placeTip(body, btn.getBoundingClientRect())
  }
  function hideTip(btn) { if (btn.parentElement) btn.parentElement.classList.remove('is-open') }
  document.addEventListener('pointerover', (e) => { const b = e.target.closest && e.target.closest('.tip-btn'); if (b) showTip(b) })
  document.addEventListener('pointerout', (e) => { const b = e.target.closest && e.target.closest('.tip-btn'); if (b && !b.contains(e.relatedTarget)) hideTip(b) })
  document.addEventListener('focusin', (e) => { if (e.target.classList && e.target.classList.contains('tip-btn')) showTip(e.target) })
  document.addEventListener('focusout', (e) => { if (e.target.classList && e.target.classList.contains('tip-btn')) hideTip(e.target) })
  // An icon button with data-tip shows its text at once on hover and keyboard focus, in the same bubble as a "?"
  // (a title shows only after a delay, and not on focus). One bubble serves all of them; it never takes a click.
  let hoverTip = null
  function placeTip(body, r) {
    const w = body.offsetWidth
    const hgt = body.offsetHeight
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))
    const top = r.top - hgt - 8 >= 8 ? r.top - hgt - 8 : r.bottom + 8
    body.style.setProperty('left', left + 'px')
    body.style.setProperty('top', top + 'px')
  }
  function showDataTip(el) {
    const text = el.getAttribute('data-tip')
    if (!text || el === menu.anchor) return
    if (!hoverTip) { hoverTip = h('span', { class: 'tip-body tip-float', role: 'tooltip', 'aria-hidden': 'true' }); document.body.append(hoverTip) }
    hoverTip.textContent = text
    hoverTip.classList.add('is-shown')
    placeTip(hoverTip, el.getBoundingClientRect())
  }
  function hideDataTip() { if (hoverTip) hoverTip.classList.remove('is-shown') }
  // Any other target hides it, also after a refresh replaced the button under the pointer.
  document.addEventListener('pointerover', (e) => { const b = e.target.closest && e.target.closest('[data-tip]'); if (b) showDataTip(b); else hideDataTip() })
  document.addEventListener('pointerout', (e) => { const b = e.target.closest && e.target.closest('[data-tip]'); if (b && !b.contains(e.relatedTarget)) hideDataTip() })
  document.addEventListener('focusin', (e) => { if (e.target.matches && e.target.matches('[data-tip]:focus-visible')) showDataTip(e.target) })
  document.addEventListener('focusout', (e) => { if (e.target.matches && e.target.matches('[data-tip]')) hideDataTip() })
  document.addEventListener('pointerdown', hideDataTip, true)
  window.addEventListener('scroll', hideDataTip, true)

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
  // An item with sub (a list of items) shows that list in the same menu, with a way back, so a long group such as
  // the copy commands takes one line until it is wanted.
  function menuKids(el, items, from) {
    return items.filter(Boolean).map((it) => it === '-' ? h('div', { class: 'menu-sep', role: 'separator' })
      : it.header ? h('div', { class: 'menu-head', role: 'presentation' }, it.header)
      : h('button', { class: 'menu-item' + (it.back ? ' menu-back' : it.sub ? ' menu-sub' : ''), type: 'button', role: 'menuitem', tabindex: '-1', disabled: it.disabled, 'aria-haspopup': it.sub && !it.back ? 'true' : null, 'data-from': it === from ? '' : null, onclick: () => {
        if (it.sub) {
          // Back lands on the item that opened the list; a list opens on its first item.
          swapKids(el, menuKids(el, it.sub, it.back ? it.from : null))
          el.scrollTop = 0
          placeFloat()
          menuScrollHint(el)
          const next = el.querySelector('[data-from]') || el.querySelector('.menu-item:not(:disabled)')
          if (next) next.focus()
          return
        }
        closeMenu(true)
        it.run()
      } },
      icon(it.icon), h('span', { class: 'menu-label' }, it.label), it.hint ? h('code', { class: 'menu-hint', title: it.hint }, it.hint.length > 24 ? '…' + it.hint.slice(-23) : it.hint) : null, it.sub && !it.back ? icon('chevron') : null))
  }
  // A menu taller than its room fades at the edge that has more, so it is plain that it scrolls.
  function menuScrollHint(el) {
    const set = () => {
      el.classList.toggle('more-below', el.scrollTop + el.clientHeight < el.scrollHeight - 1)
      el.classList.toggle('more-above', el.scrollTop > 1)
    }
    set()
    if (!el._hint) { el._hint = true; el.addEventListener('scroll', set, { passive: true }) }
  }
  function openMenu(anchor, items, label) {
    const el = h('div', { class: 'menu', role: 'menu', 'aria-label': label })
    setKids(el, menuKids(el, items, null))
    el.addEventListener('keydown', menuKeys)
    openFloat(anchor, el, 'menu', 'end')
    menuScrollHint(el)
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
    // A list of choices opens on the one in use, as a native menu does.
    const first = el.querySelector('button[aria-pressed="true"]:not(:disabled)') || el.querySelector('button:not(:disabled), a[href]')
    if (first) first.focus()
  }
  function refreshPopover(kind) {
    if (menu.el && menu.kind === kind && menu.render) { swapKids(menu.el, menu.render()); placeFloat() }
  }
  function closeMenu(restore) {
    if (!menu.el) return
    // It fades out rather than vanishing; it takes no clicks meanwhile, and the next menu does not wait for it.
    const gone = menu.el
    if (REDUCED) gone.remove()
    else { gone.classList.add('float-out'); gone.style.setProperty('pointer-events', 'none'); setTimeout(() => gone.remove(), 120) }
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
  // Right-click on an account row or card, or a Session row (spec §3.27) opens the row's "…" menu at the pointer; the ContextMenu key
  // and Shift+F10 open it at the focused element in the row. Inputs, links, buttons and selected text keep the
  // browser's own menu. Each row carries its opener as el.sidebyMenu(anchor).
  let kbMenuAt = 0
  function menuTarget(node) {
    const rows = '.row, .card, .login-dir, .hist-row, .sess-row'
    let el = node && node.closest ? node.closest(rows) : null
    while (el && !el.sidebyMenu) el = el.parentElement ? el.parentElement.closest(rows) : null
    return el && ($('accounts').contains(el) || $('sessions-page').contains(el)) ? el : null
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
    // In a sub list, Left and Escape go back; on an item that opens one, Right opens it.
    else if ((e.key === 'ArrowLeft' || e.key === 'Escape') && menu.el.querySelector('.menu-back')) menu.el.querySelector('.menu-back').click()
    else if (e.key === 'ArrowRight' && document.activeElement && document.activeElement.classList.contains('menu-sub')) document.activeElement.click()
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
      a.kind !== 'api' && !BOOT.readOnly ? { icon: 'terminal', label: t(a.login === 'logged-in' ? 'menu.signInAgain' : 'menu.signIn'), run: () => signIn(a) } : null,
      a.kind !== 'api' ? { icon: 'key', label: t('menu.copyLogin'), hint: 'sideby login ' + a.ref, run: () => copyText('sideby login ' + a.ref) } : null,
      keyable(a) ? { icon: 'key', label: t('menu.enterKey'), run: () => openKey(a) } : null,
      a.identity && a.identity.email ? { icon: 'mail', label: t('menu.copyEmail'), hint: emailText(a.identity.email), run: () => copyText(a.identity.email) } : null,
    ]
  }
  // A Main-only Family (ADR-0047) has no other Account to create.
  function likeItem(a) { return BOOT.readOnly || family(a.family).mainOnly ? null : { icon: 'userPlus', label: t('menu.like'), run: () => openCreate({ family: a.family, api: a.kind === 'api' }) } }
  // Grouped by what the user wants to do: open, copy, manage. A Same Login row (ADR-0026) passes its other
  // directories: the menu is the one of the directory the row is named after, and each other directory is one item
  // that opens its own actions in the same menu, so the shared actions appear once.
  function accountMenu(a, anchor, others) {
    const [browser, signInItem, login, key, email] = loginItems(a)
    const opens = [deskItem(a), browser].filter(Boolean)
    // Up to six copy commands: past two they fold into "Copy…", which opens them in the same menu, with "Back".
    // The start command stays one click away (a phone has it only here); the other copies fold when there are many.
    const [run, ...more] = [...dirCopies(a), login, email].filter(Boolean)
    const back = { icon: 'chevronLeft', label: t('menu.back'), back: true, sub: null, from: null }
    const fold = more.length > 2 ? { icon: 'copy', label: t('menu.copyMore'), hint: String(more.length), sub: [back, '-', { header: t('menu.groupCopy') }, ...more] } : null
    back.from = fold
    const dirs = (others || []).map((m) => {
      const up = { icon: 'chevronLeft', label: t('menu.back'), back: true, sub: null, from: null }
      const item = { icon: 'folder', label: m.name, hint: (m.aliases || [])[0], sub: [up, '-', { header: m.name + ((m.aliases || []).length ? ' · ' + m.aliases[0] : '') }, ...dirItems(m), ...dirTools(m)] }
      up.from = item
      return { up, item }
    })
    const items = [pinItem(a), ...hideItems(a),
      opens.length ? '-' : null, opens.length ? { header: t('menu.groupOpen') } : null, ...opens,
      '-', { header: t('menu.groupCopy') }, run, ...(fold ? [fold] : more),
      '-', { header: t('menu.groupManage') }, signInItem, key, ...dirTools(a), likeItem(a),
      ...(dirs.length ? ['-', { header: t('menu.groupOtherDirs') }, ...dirs.map((d) => d.item)] : [])]
    back.sub = items
    for (const d of dirs) d.up.sub = items
    openMenu(anchor, items, others ? t('login.label', { names: [a, ...others].map((m) => m.name).join(', ') }) : t('menu.label', { ref: a.ref }))
  }
  function loginMenu(ms, anchor) { accountMenu(ms[0], anchor, ms.slice(1)) }
  function loginMoreButton(ms) {
    const b = h('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': t('login.label', { names: ms.map((m) => m.name).join(', ') }), 'data-tip': t('menu.title') }, icon('more'))
    b.addEventListener('click', () => { if (menu.anchor === b) closeMenu(); else loginMenu(ms, b) })
    return b
  }
  // Next to the terminal button: open this account's desktop app (spec §3.20), or bring it to the front when it runs.
  // A Same Login row is one login, so one click is enough: it brings forward a window that already runs, or opens the
  // directory the row is named after.
  function deskButton(a, ms) {
    const can = (ms || [a]).filter((m) => deskItem(m))
    if (!can.length) return null
    const m = can.find((x) => x.desktopApp.running) || can[0]
    const d = m.desktopApp
    const text = t(d.running ? 'desk.showHint' : 'desk.openHint', { app: d.app, ref: m.ref })
    return h('button', { class: 'icon-btn row-run row-desk' + (d.running ? ' is-open' : ''), type: 'button', disabled: Boolean(ui.desktopRef), 'aria-label': text, 'data-tip': text, onclick: (e) => { e.stopPropagation(); openDesktop(m) } },
      can.some((x) => ui.desktopRef === x.ref) ? spinner() : icon('monitor'))
  }
  // The most used action, on the row itself: copy the command that starts this account (its short command when it
  // has one, which is shorter to type).
  function runButton(a) {
    const cmd = (a.aliases || [])[0] || 'sideby run ' + a.ref
    // Without its tool the command would not start: the button says so and points at installing it instead.
    if (a.hostInstalled === false) {
      const why = t('row.installFirst', { host: famTitle(a) })
      return h('button', { class: 'icon-btn row-run is-off', type: 'button', 'aria-disabled': 'true', 'aria-label': why, 'data-tip': why, onclick: (e) => { e.stopPropagation(); toast(why, { kind: 'info' }) } }, icon('terminal'))
    }
    const text = t('row.copyRun', { cmd })
    const done = ui.copied === a.ref
    // A copy shows a tick on the button for a moment, where the eye already is; it lives in ui, so a refresh keeps it.
    return h('button', { class: 'icon-btn row-run' + (done ? ' is-done' : ''), type: 'button', 'aria-label': text, 'data-tip': text, onclick: (e) => {
      e.stopPropagation()
      copyText(cmd)
      clearTimeout(ui.copiedTimer)
      ui.copied = a.ref
      renderAccounts()
      ui.copiedTimer = setTimeout(() => { ui.copied = null; renderAccounts() }, 1200)
    } }, icon(done ? 'tick' : 'terminal'))
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
    const b = h('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': t('menu.label', { ref: a.ref }), 'data-tip': t('menu.title') }, icon('more'))
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
        return h('i', { class: (i === daily.length - 1 ? 'today' : '') + (v ? '' : ' zero') || null, title: day + colon() + tokens(v) },
          h('b', { css: { height: v && max ? Math.max(10, Math.round((v / max) * 100)) + '%' : null } }))
      }))
  }
  function renderSummary() {
    const box = $('summary')
    if (!S.state) { if (S.loadError) box.hidden = true; return }
    // Hidden Accounts (spec §3.25) stay out of the counts and the attention card; the list's last line counts them.
    const list = visibleAccounts()
    // Another page keeps it hidden: a refresh while there must not push that page down (renderPageChrome shows it).
    box.hidden = !list.length || curPage !== 'accounts'
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
    // Who needs a look, by name: counting reasons beside a count of accounts made numbers that did not add up. One name
    // and a count, as two names did not fit the card.
    const needing = list.filter((a) => reasonsOf(a, now).length)
    const needSub = need ? t(needing.length > 1 ? 'stat.needWhoMore' : 'stat.needWho', { names: needing[0].ref, n: needing.length - 1 }) : t('stat.allClear')
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
    const list = S.state ? listedAccounts() : []
    const fams = S.state ? S.state.families.filter((f) => list.some((a) => a.family === f.id)) : []
    tb.family.replaceChildren(h('option', { value: '' }, t('tb.allFamilies')),
      ...fams.map((f) => h('option', { value: f.id }, f.title + ' (' + list.filter((a) => a.family === f.id).length + ')')))
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
  function winShort(k) { return k === '5h' || k === '7d' ? t('win.' + k + '.short') : k }
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
  function meter(w, now, stale, observedAt, withLength) {
    const st = windowState(w, now, WARN, FAIL)
    const passed = passedWindow(w, observedAt, now)
    const left = prefs.quota === 'left'
    const shown = left ? 100 - st.pct : st.pct
    const asOf = stale ? t('quota.asOf', { ago: ago(observedAt) }) : ''
    const reset = passed ? t('quota.resetShort') : t('quota.resetsIn', { d: formatDuration(Date.parse(w.resetsAt) - now, lang) })
    // The wide list's column says only the model group, so the hover names which of its limits this is.
    const title = [withLength ? winTitle(w.label) : '', passed ? t('quota.resetNoData', { date: day(passed.since) }) : t('quota.resetsAt', { at: clock(w.resetsAt) }), asOf].filter(Boolean).join(' · ')
    return h('div', { class: 'meter lvl-' + st.level + (stale || passed ? ' lvl-stale' : ''), title },
      h('div', { class: 'm-top' },
        // Cards show the short window name ("5 小时"); the list and its column titles keep the full one.
        // withLength: the group has other limits too, so name which one this is ("Gemini Models · 5-hour").
        h('span', { class: 'm-label' }, h('span', { class: 'm-full' }, winTitle(winKey(w)) + (withLength ? ' · ' + winTitle(w.label) : '')), h('span', { class: 'm-short' }, winShort(winKey(w)) + (withLength ? ' · ' + winShort(w.label) : ''))),
        h('span', { class: 'm-pct' }, shown + '%', h('span', { class: 'm-unit' }, ' ' + t(left ? 'quota.unitLeft' : 'quota.unitUsed')),
          null),
        h('span', { class: 'm-reset' + (passed ? ' m-passed' : '') }, Number.isFinite(Date.parse(w.resetsAt)) || passed ? reset : '?')),
      h('div', { class: 'bar', role: 'meter', 'aria-label': t(left ? 'quota.meterLeft' : 'quota.meterUsed', { label: winTitle(winKey(w)) }), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(shown), 'aria-valuetext': t(left ? 'quota.pctLeft' : 'quota.pctUsed', { n: shown }) }, h('span', { css: { width: shown + '%' } })))
  }
  // A column whose window this account does not report right now, such as a 5h window that has not started.
  function noMeter(label, short) {
    return h('div', { class: 'meter meter-none', title: t('quota.missing', { label }) },
      h('div', { class: 'm-top' }, h('span', { class: 'm-label' }, h('span', { class: 'm-full' }, label), h('span', { class: 'm-short' }, short || label)), h('span', { class: 'm-none', 'aria-label': t('quota.missing', { label }) }, '—')))
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
  // The newest session of this login on this computer: the Account's own and its Same Login's (spec §3.31).
  function lastUseOf(a) {
    const refs = [a.ref, ...(a.sameLogin || [])]
    const times = (S.state ? S.state.accounts : []).filter((x) => refs.includes(x.ref) && x.usage && x.usage.status === 'ok' && x.usage.lastActivityAt).map((x) => Date.parse(x.usage.lastActivityAt)).filter(Number.isFinite)
    return times.length ? new Date(Math.max(...times)).toISOString() : null
  }
  function quotaBlock(a, now, cols) {
    // Still reading (a slow plugin or Host): say so where its numbers will appear; the page asks again soon.
    if (a.pending) return h('div', { class: 'quota' }, h('div', { class: 'q-note' }, spinner(), t('acct.reading', { host: famTitle(a) })))
    const q = a.quota
    if (!q) return h('div', { class: 'quota' }, h('div', { class: 'q-note' }, '—'))
    if (q.status !== 'ok') return h('div', { class: 'quota' }, quotaNote(a, q))
    const stale = quotaIsStale(q, now, lastUseOf(a))
    // Over an hour old but unused here since: the numbers stand, and the hover text says what it cannot see.
    const quiet = !stale && now - Date.parse(q.observedAt) > 3600_000
    // Old numbers of a Host that cannot be asked (Claude Code) change only when a session runs in the account.
    const waits = stale && !q.fetchError && !family(a.family).quotaRefresh ? t('quota.staleSession') : null
    const wins = q.windows || []
    // A reading borrowed from another Account of the same login says where it came from (spec §3.21).
    const from = q.from ? t('quota.sharedFrom', { name: refName(q.from), ago: ago(q.observedAt) }) : null
    // Where the numbers came from when the Host was asked (spec §3.26), and why the latest ask failed.
    const via = q.fetched ? t('quota.fetchedFrom', { host: famTitle(a), ago: ago(q.observedAt) }) : null
    const failed = q.fetchError ? t('quota.lastCheckFailed', { why: q.fetchError }) : null
    const title = [from || via || (stale ? null : t('quota.dataFrom', { ago: ago(q.observedAt) })), quiet ? t('quota.quiet') : null, failed, waits].filter(Boolean).join('\n') || null
    // --qr: this row's own number of windows, so a narrow list can split the width between them alone (--qn is the
    // widest Family's, for the wide list's shared columns).
    return h('div', { class: 'quota' + (stale ? ' is-stale' : ''), title, css: wins.length ? { '--qr': String(cols.length) } : null },
      wins.length ? cols.map((c) => {
        // A model group with several limits (Antigravity's 5-hour and weekly) shows the one that binds first.
        const same = wins.filter((x) => winKey(x) === c)
        const w = bindingWindow(same, now, WARN, FAIL)
        return w ? meter(w, now, stale, q.observedAt, same.length > 1) : noMeter(winTitle(c), winShort(c))
      }) : h('div', { class: 'q-note' }, t('quota.noWindows')),
      // Old numbers keep their colours and say their age once, under the bars.
      stale && wins.length ? h('div', { class: 'q-asof', title: failed || [t('quota.asOf', { ago: ago(q.observedAt) }), waits].filter(Boolean).join('\n') }, icon('clock'), q.fetchError ? t('quota.fetchFailed') + ' · ' : '', t('quota.staleShort', { ago: agoShort(now - Date.parse(q.observedAt)) })) : null)
  }
  function usageBlock(a) {
    const u = a.usage
    if (!u) return h('div', { class: 'usage' })
    if (u.status !== 'ok') {
      const key = u.reason === 'no-session' ? 'usage.none' : u.reason === 'no-source' ? 'usage.noSource' : 'usage.unreadable'
      return h('div', { class: 'usage' }, h('span', { class: 'u-note', title: u.detail || null }, t(key, { n: BOOT.usageDays })))
    }
    const rate = cacheHitRate(u)
    // A tool whose records name sessions but not tokens (Cursor CLI): say how many, not "0 tokens".
    if (!u.totalTokens && u.sessions > 0) {
      return h('div', { class: 'usage', title: t('usage.noTokens', { days: u.days, sessions: u.sessions }) },
        h('div', { class: 'u-text' },
          h('span', { class: 'u-num' }, tn('usage.sessions', u.sessions)),
          h('div', { class: 'u-sub' }, t('usage.noTokenCounts'))))
    }
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
    const lvl = reason === 'health-fail' ? 'fail' : reason === 'quota-high' ? quotaHighLevel(subject, Date.now(), FAIL) : 'warn'
    const why = whyOf(subject, Date.now())
    const word = reason === 'health-fail' ? t('att.fix') : reason === 'quota-high' ? t('att.quota') : t('att.check')
    const dot = h('span', { class: 'dot dot-' + lvl, 'aria-hidden': 'true' })
    // A health label opens the account's findings, as the health chip of the details does.
    if (reason !== 'quota-high') return h('button', { class: 'tag tag-' + lvl + ' tag-btn att-tag', type: 'button', title: why + '\n' + t('health.filterHint'), 'aria-label': why, onclick: (e) => { e.stopPropagation(); filterHealth(subject.ref) } }, dot, word)
    return h('span', { class: 'tag tag-' + lvl + ' att-tag', title: why, 'aria-label': why }, dot, word)
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
  // opts.linked: the directories a card marks as one login without speaking for them (its badge stays its own).
  function nameLine(a, members, opts) {
    const o = opts || {}
    return h('div', { class: 'ident-name' },
      pinSlot(a),
      h('span', { class: 'name', title: a.name }, a.name),
      loginMark(o.linked || members),
      aliasText(a),
      hiddenMark(isHidden(a) && !famHidden(a.family)),
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
    if (!b) return null
    const chosen = browserChosen(a)
    return h('div', { class: 'rd-item rd-browser' }, h('span', { class: 'rd-label' }, t('row.browser')),
      h('div', { class: 'br-line' }, b,
        chosen ? h('span', { class: 'tag', title: t('br.chosenHint') }, t('br.chosen')) : null,
        h('button', { class: 'link-btn small', type: 'button', title: t('br.changeHint', { ref: a.ref }), onclick: (e) => { e.stopPropagation(); openBrowserDialog(a) } }, t('br.change'))))
  }
  // The browser user the person chose for this account themselves (config browser.choices), if any.
  function browserChosen(a) { const b = browserInfo(); return (b && b.choices && b.choices[a.ref]) || null }
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
  const siteOf = (b, family) => String((b.sites && b.sites[family]) || '').replace(/^https:\/\//, '').replace(/\/$/, '')
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
    return h('button', { class: 'email-btn br-btn', type: 'button', disabled: busy, title: t('br.hint', { url: siteOf(info.b, a.family), ref: a.ref }), 'aria-label': 'Chrome ' + label + ' (' + a.ref + ')', onclick: (e) => { e.stopPropagation(); if (info.found.length === 1) openBrowser(a, first); else openBrowserDialog(a) } },
      busy ? spinner() : icon('globe', 'br-ico'), h('span', { class: 'br-name' }, label))
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
    const chosen = browserChosen(a) === p.dir
    return h('li', { class: 'br-row' },
      h('span', null, h('b', null, profileName(p.name)), p.email ? h('span', { class: 'muted small' }, ' · ' + emailText(p.email)) : null, ' ', h('span', { class: 'muted small mono' }, p.dir), p.changedAt ? h('span', { class: 'muted small' }, ' · ' + t('br.changed', { when: ago(p.changedAt) })) : null),
      h('span', { class: 'br-acts' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: Boolean(ui.browserRef), 'aria-busy': busy ? 'true' : null, onclick: () => openBrowser(a, p) }, t('br.openIt')),
        chosen ? h('span', { class: 'tag', title: t('br.chosenHint') }, t('br.chosen'))
          : h('button', { class: 'link-btn small', type: 'button', disabled: br.busy, title: t('br.chooseHint', { ref: a.ref }), onclick: () => brChoose(a, p.dir) }, t('br.choose'))))
  }
  // Remembers the person's own choice for this account, or with null lets sideby find it again; sideby's config only.
  async function brChoose(a, dir) {
    br.busy = true
    br.error = null
    renderBrowser()
    try {
      await api('/api/browser/choose', { account: a.ref, profile: dir })
      await load({ silent: true })
      toast(dir ? t('br.chosenDone', { ref: a.ref, name: profileLabel({ dir, name: dir }) }) : t('br.autoDone', { ref: a.ref }))
    } catch (e) { br.error = e }
    br.busy = false
    renderBrowser()
  }
  function renderBrowser() {
    if (!br || dlg.kind !== 'browser') return
    const a = S.state && S.state.accounts.find((x) => x.ref === br.ref)
    const info = a && browserFor(a)
    if (!info) { dlg.el.close(); return }
    const url = siteOf(info.b, a.family)
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
      const chosen = browserChosen(a)
      body.push(h('p', { class: 'muted small' }, t(chosen ? 'br.chosenIntro' : 'br.chooseIntro', { ref: a.ref })))
      if (chosen) body.push(h('p', null, h('button', { class: 'btn btn-sm', type: 'button', disabled: br.busy, onclick: () => brChoose(a, null) }, t('br.auto'))))
      if (info.found.length) body.push(h('p', { class: 'small' }, t(chosen ? 'br.foundChosen' : 'br.found', { ref: a.ref })), h('ul', { class: 'br-list' }, info.found.map((p) => brProfileRow(a, p))))
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
    // A read error says why and what to do next: its reason is on screen, the settings file opens from here when the
    // reason names it, and an AI can fix it.
    if (a.error) {
      const item = settingsItem(a)
      const file = item && a.error.includes(family(a.family).settingsFile) ? item : null
      out.push(h('div', { class: 'note note-fail note-read' },
        h('b', null, t('acct.readError')), h('span', { class: 'mono small read-why' }, a.error), h('span', null, t('acct.readErrorNext')),
        file ? h('button', { class: 'link-btn small', type: 'button', title: file.hint, onclick: (e) => { e.stopPropagation(); file.run() } }, file.label) : null,
        BOOT.readOnly ? null : h('button', { class: 'link-btn small', type: 'button', onclick: (e) => { e.stopPropagation(); openAsk({ text: t('acct.readErrorAsk', { ref: a.ref, error: a.error }) }) } }, t('acct.readErrorAi'))))
    }
    if (a.hostInstalled === false) out.push(h('div', { class: 'note note-warn' }, hostNote(fam)))
    return out.length ? h('div', { class: 'row-notes' }, out) : null
  }
  // What a row or card shows depends on more than the account (health, view preferences, language); the
  // fingerprint covers what its click handlers use.
  function rowSig(a) { return sig([a, healthOf(a.ref), isNext(a), ui.desktopRef === a.ref, ui.browserRef === a.ref, ui.copied === a.ref, browserFor(a), prefs.hideEmail, isOpen(a), loginLead(a), isPinned(a), isHidden(a), famHidden(a.family)]) }
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
      detail = ms ? loginDetail(ms) : rowDetail(a)
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
      h('div', { class: 'row-end' }, deskButton(a), runButton(a), moreButton(a)),
      open ? rowDetail(a) : null,
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
      h('div', { class: 'row-end' }, deskButton(a, ms), runButton(a), loginMoreButton(ms)),
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
          useOtherButton(m),
          moreButton(m)), (anchor) => accountMenu(m, anchor))
      })))
  }
  // What a click on a row opens: how it runs (ref, model and effort, a shared login), its tokens and its Health.
  function sameLoginNote(a) {
    if (!a.sameLogin || !a.sameLogin.length || inLogin(a)) return null
    const names = a.sameLogin.map(refName).join(', ')
    return h('div', { class: 'rd-note', title: t('acct.sameLoginHint', { names }) }, t('acct.sameLogin', { names }), ' ', useOtherButton(a))
  }
  // Gives one directory of a Same Login a login of its own (spec §3.21 "换个账号登录"): its sign-in, in a terminal.
  function useOtherButton(a) {
    return h('button', { class: 'link-btn small ld-other', type: 'button', title: t('login.useOtherHint', { name: a.name }), onclick: (e) => { e.stopPropagation(); signIn(a) } }, t('login.useOther'))
  }
  function rowDetail(a) {
    const same = sameLoginNote(a)
    const b = browserInfo()
    const signIns = Boolean(b && b.enabled && !BOOT.readOnly)
    // One panel of four cells: how it runs, its Chrome sign-in, tokens, health. Every row has every cell, so the
    // cells line up down the list; an account without a Chrome sign-in says so with a dash.
    return h('div', { class: 'row-detail' + (signIns ? '' : ' rd-nobr') },
      h('div', { class: 'rd-item rd-run' }, h('span', { class: 'rd-label' }, t('row.runs')), h('div', { class: 'rd-val' }, subLine(a)), same),
      signIns ? browserItem(a) || h('div', { class: 'rd-item rd-browser' }, h('span', { class: 'rd-label' }, t('row.browser')),
        h('div', { class: 'br-line' }, h('span', { class: 'rd-none' }, '—'),
          browserFor(a) ? h('button', { class: 'link-btn small', type: 'button', title: t('br.changeHint', { ref: a.ref }), onclick: (e) => { e.stopPropagation(); openBrowserDialog(a) } }, t('br.pick')) : null)) : null,
      h('div', { class: 'rd-item rd-usage' }, h('span', { class: 'rd-label' }, t('col.tokens', { n: BOOT.usageDays })), h('div', { class: 'rd-val' }, usageBlock(a))),
      h('div', { class: 'rd-item rd-health' }, h('span', { class: 'rd-label' }, t('col.health')), h('div', { class: 'rd-val' }, healthChip(a))))
  }
  // A card shows everything at once; it has room for it.
  function card(a, now, cols) {
    // A Same Login shows as a link mark after the name (its note and "Use another account" are in the menu).
    const peers = a.sameLogin && a.sameLogin.length ? [a, ...a.sameLogin.map((r) => ({ name: refName(r) }))] : null
    return withMenu(h('article', { class: 'card' + (a.error ? ' card-error' : ''), 'data-ref': a.ref, 'data-key': a.ref, 'data-sig': rowSig(a), 'aria-label': a.ref },
      h('header', { class: 'card-head' }, badge(a.family, 'sm'), nameLine(a, null, { linked: peers }), h('div', { class: 'row-end' }, moreButton(a))),
      // The last use follows who it is, as in the medium list; a card without one shows nothing there.
      h('div', { class: 'card-id' }, h('div', { class: 'ident-meta' }, emailLine(a) || subLine(a), a.usage && a.usage.status === 'ok' && a.usage.lastActivityAt ? lastUsed(a, 'last-inline') : null), emailLine(a) ? subLine(a) : null),
      notes(a),
      quotaBlock(a, now, cols),
      cardBrowser(a),
      // Tokens on the left, the row's own buttons on the right. A health problem shows in the label after the name
      // (it opens the same filter), so the foot does not say it again.
      h('footer', { class: 'card-foot' }, usageBlock(a), h('div', { class: 'card-side' }, deskButton(a), runButton(a)))), (anchor) => accountMenu(a, anchor))
  }
  // A Same Login as one card (spec §3.21), as the list shows it as one row: named after its first directory, the
  // other directories listed under who it is, one quota, the tokens of all of them, one menu for all of them.
  function loginCard(members, now, cols) {
    const ms = loginMembers(members)
    const a = ms[0]
    const newest = newestOf(ms)
    const email = emailLine(a)
    const usage = Object.assign({}, a, { usage: mergeUsage(ms.map((m) => m.usage)) })
    return withMenu(h('article', { class: 'card card-login' + (a.error ? ' card-error' : ''), 'data-ref': a.ref, 'data-key': loginKey(ms.map((m) => m.ref)), 'data-sig': sig(ms.map(rowSig)), 'aria-label': t('login.label', { names: ms.map((m) => m.name).join(', ') }) },
      h('header', { class: 'card-head' }, badge(a.family, 'sm'), nameLine(a, ms), h('div', { class: 'row-end' }, loginMoreButton(ms))),
      h('div', { class: 'card-id' },
        h('div', { class: 'ident-meta' }, email || subLine(a), newest.usage && newest.usage.status === 'ok' && newest.usage.lastActivityAt ? lastUsed(newest, 'last-inline') : null),
        email ? subLine(a) : null,
        h('div', { class: 'card-dirs', title: t('login.explain') }, h('span', { class: 'cd-label' }, t('login.also')),
          ms.slice(1).map((m) => h('span', { class: 'tag tag-dir', title: 'sideby run ' + m.ref }, m.name, (m.aliases || [])[0] ? h('span', { class: 'alias' }, (m.aliases || [])[0]) : null)))),
      notes(a),
      quotaBlock(a, now, cols),
      cardBrowser(a),
      h('footer', { class: 'card-foot' }, usageBlock(usage), h('div', { class: 'card-side' }, deskButton(a, ms), runButton(a)))), (anchor) => loginMenu(ms, anchor))
  }
  // A card's Chrome sign-in: one line, the browser user as a link that opens the website, then Change.
  function cardBrowser(a) {
    const b = browserInfo()
    if (!b || !b.enabled || BOOT.readOnly || !browserFor(a)) return null
    const btn = browserButton(a)
    const chosen = browserChosen(a)
    return h('div', { class: 'card-br', title: t('row.browser') },
      btn || h('span', { class: 'br-none' }, icon('globe', 'br-ico'), h('span', null, '—')),
      chosen ? h('span', { class: 'tag', title: t('br.chosenHint') }, t('br.chosen')) : null,
      h('button', { class: 'link-btn small', type: 'button', title: t('br.changeHint', { ref: a.ref }), onclick: (e) => { e.stopPropagation(); openBrowserDialog(a) } }, t(btn ? 'br.change' : 'br.pick')))
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
    // Red when one of them needs a fix or has a red quota bar, so the tag matches what the rows show.
    const lvl = needing.some((a) => reasonsOf(a, now).includes('health-fail') || quotaHighLevel(a, now, FAIL) === 'fail') ? 'fail' : 'warn'
    if (needing.length === 1) {
      const a = needing[0]
      const label = a.name + ' · ' + whyOf(a, now)
      return h('button', { class: 'tag tag-' + lvl + ' tag-btn', type: 'button', title: t('group.attentionShow', { name: a.name }), onclick: () => flashRow(a.ref) }, label)
    }
    const list = needing.map((a) => a.name + colon() + whyOf(a, now)).join('\n')
    return h('button', { class: 'tag tag-' + lvl + ' tag-btn', type: 'button', title: list, 'aria-pressed': String(ui.attention), onclick: () => { ui.attention = !ui.attention; renderSummary(); renderAccounts() } }, tn('group.attention', needing.length))
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
        // The same screen button as an account's row end: open the window, or bring it to the front.
        h('button', { class: 'icon-btn row-run row-desk' + (p.running ? ' is-open' : ''), type: 'button', disabled: Boolean(ui.appBusy), 'data-tip': t(p.running ? 'app.showHint' : 'app.openHint', { app: p.app, ref: p.ref }), 'aria-label': (busy ? t('desk.opening', { app: p.app }) : t(p.running ? 'app.show' : 'app.openBtn')) + ' (' + p.ref + ')', 'aria-busy': busy ? 'true' : null, onclick: () => openApp(p.ref) },
          busy ? spinner() : icon('monitor')),
        p.isMain ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: p.running || Boolean(ui.appBusy), title: t(p.running ? 'app.removeRunning' : 'app.removeHint', { app: p.app }), 'aria-label': t('app.remove') + ' (' + p.ref + ')', onclick: () => { ui.appRemove = p.ref; renderAccounts() } }, t('app.remove')))
    return h('div', { class: 'app-row', role: 'listitem', 'data-ref': p.ref, 'data-key': p.ref, 'data-sig': sig([p, busy, asking, Boolean(ui.appBusy)]) },
      // A gap where an account row has its open arrow, so the marks and names line up with the accounts above.
      h('div', { class: 'ident' }, h('span', { class: 'app-gap', 'aria-hidden': 'true' }), appBadge(), h('div', { class: 'ident-text' },
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
    ui.order.units[fam] = loginClusters(list).map((x) => Array.isArray(x) ? x.map((a) => a.name) : [x.name])
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
        off && setup && setup.plan.status === 'blocked' ? h('span', { class: 'muted small label-tip' }, t('quota.blocked'), tipRaw(t('quota.blocked'), setup.plan.message)) : null,
        hiddenMark(famHidden(fam)),
        ui.arrange && !BOOT.readOnly ? hideToggle(info.title, famHidden(fam), () => toggleHideFamily(fam)) : null,
        ui.arrange ? null : pickHead(fam)))
    const body = collapsedNow ? null : cards
      ? h('div', { class: 'grid', id: bodyId, 'data-key': 'cards', 'data-patch': '' }, loginClusters(list).map((x) => Array.isArray(x) ? loginCard(x, now, cols) : card(x, now, cols)))
      : h('div', { class: 'rows', id: bodyId, role: 'list', 'data-key': ui.arrange ? 'rows-arrange' : 'rows', 'data-patch': '' }, loginClusters(list).map((x) => Array.isArray(x) ? loginRow(x, now, cols) : row(x, now, cols)))
    return h('section', { class: 'group' + (cards ? ' group-cards' : ' group-list') + (collapsedNow ? ' is-collapsed' : '') + (ui.arrange ? ' is-arranging' : '') + (famHidden(fam) ? ' is-hidden' : ''), 'aria-label': info.title, 'data-key': 'g:' + fam, 'data-fam': fam, 'data-patch': '' },
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
    return { families: d.families ? d.families.slice() : [], accounts: Object.assign({}, d.accounts || {}), pinned: Object.assign({}, d.pinned || {}),
      hiddenFamilies: d.hiddenFamilies ? d.hiddenFamilies.slice() : [], hidden: Object.assign({}, d.hidden || {}) }
  }
  // Shows next at once and writes it to the config. Writes go one at a time; a failed one puts back what the config
  // last confirmed, never another write's unsaved state.
  const displaySaves = { chain: Promise.resolve(), pending: 0, confirmed: null }
  function saveDisplay(before, next, failKey) {
    if (!displaySaves.pending) displaySaves.confirmed = before
    displaySaves.pending++
    S.state.display = next
    renderDisplayed()
    const run = displaySaves.chain.then(async () => {
      try {
        const r = await api('/api/display-order', { display: next })
        displaySaves.confirmed = r.display
        if (S.state.display === next) S.state.display = r.display
        return true
      } catch (e) {
        // A newer write already on its way settles the screen; only the latest one puts things back.
        if (S.state.display === next) { S.state.display = displaySaves.confirmed; renderDisplayed() }
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
  // What the Display Order changes on screen: the accounts, and the counts and tool filter that leave Hidden ones out.
  function renderDisplayed() { renderAccounts(); renderSummary(); renderFamilyFilter(); renderPageChrome() }

  // ---------- Hidden Families and Accounts (spec §3.25) ----------
  // Display only: a hidden Account still starts, shows in History and can be picked by a Handoff.
  function isHidden(a) { return hiddenIn(a, displayOf()) }
  function famHidden(fam) { return (displayOf().hiddenFamilies || []).includes(fam) }
  function hiddenOf(fam) { return (displayOf().hidden || {})[fam] || [] }
  function visibleAccounts() { return S.state.accounts.filter((a) => !isHidden(a)) }
  // The accounts the list shows: the arrange mode and "Show hidden" bring the hidden ones back, marked.
  function listedAccounts() { return ui.arrange || ui.showHidden ? S.state.accounts : visibleAccounts() }
  function afterHide(hide, name, undo) {
    // Hiding from the list itself makes the row go away; the toast says where it went and offers it back.
    if (hide && !ui.arrange && !ui.showHidden) toast(t('hide.done', { name }), { action: { label: t('order.undo'), run: undo } })
  }
  // Hides or shows an Account, with the other directories of its Same Login.
  function toggleHide(a) {
    const before = displayOf()
    const next = copyDisplay(before)
    const names = [a.name].concat((a.sameLogin || []).map(refName))
    const exists = (n) => S.state.accounts.some((x) => x.family === a.family && x.name === n)
    const list = hiddenOf(a.family).filter((n) => !names.includes(n) && exists(n))
    const hide = !hiddenIn(a, { hidden: displayOf().hidden })
    if (hide) list.push(...names.filter(exists))
    next.hidden[a.family] = list
    saveDisplay(before, next, 'hide.failed').then((ok) => { if (ok) afterHide(hide, a.ref, () => toggleHide(a)) })
  }
  function toggleHideFamily(fam) {
    const before = displayOf()
    const next = copyDisplay(before)
    const hide = !famHidden(fam)
    next.hiddenFamilies = hide ? next.hiddenFamilies.concat(fam) : next.hiddenFamilies.filter((x) => x !== fam)
    saveDisplay(before, next, 'hide.failed').then((ok) => { if (ok) afterHide(hide, family(fam).title, () => toggleHideFamily(fam)) })
  }
  // The row menu's items: hide this account, or all of its tool; on a hidden row, show it again.
  function hideItems(a) {
    if (BOOT.readOnly) return []
    const title = family(a.family).title
    if (famHidden(a.family)) return [{ icon: 'eye', label: t('hide.showFamily', { title }), run: () => toggleHideFamily(a.family) }]
    if (isHidden(a)) return [{ icon: 'eye', label: t('hide.showAccount'), run: () => toggleHide(a) }]
    return [{ icon: 'eyeOff', label: t('hide.account'), run: () => toggleHide(a) }, { icon: 'eyeOff', label: t('hide.family', { title }), run: () => toggleHideFamily(a.family) }]
  }
  // A hidden row or group says so while "Show hidden" or the arrange mode brings it back.
  function hiddenMark(on) {
    return on ? h('span', { class: 'chip chip-sm hidden-chip' }, icon('eyeOff'), t('hide.mark')) : null
  }
  // The eye in the arrange mode: one click hides or shows the Family or the Account (with its Same Login).
  function hideToggle(label, hidden, run) {
    const text = t(hidden ? 'hide.showName' : 'hide.hideName', { name: label })
    return h('button', { class: 'icon-btn hide-btn' + (hidden ? ' is-on' : ''), type: 'button', 'aria-pressed': String(hidden), 'aria-label': text, title: text, onclick: (e) => { e.stopPropagation(); run() } }, icon(hidden ? 'eyeOff' : 'eye'))
  }
  // Under the list: how many are hidden, a red dot when one of them needs a look, and the switch to show them.
  function hiddenBar(n) {
    const now = Date.now()
    const needs = S.state.accounts.some((a) => isHidden(a) && reasonsOf(a, now).length)
    return h('div', { class: 'hidden-bar', 'data-key': 'hidden-bar', 'data-sig': sig([n, needs, Boolean(ui.showHidden), lang]) },
      needs ? h('span', { class: 'hidden-dot', role: 'img', title: t('hide.needs'), 'aria-label': t('hide.needs') }) : null,
      h('span', { class: 'muted small' }, tn('hide.count', n)),
      h('button', { class: 'link-btn small', type: 'button', 'aria-expanded': String(Boolean(ui.showHidden)), onclick: toggleShowHidden }, t(ui.showHidden ? 'hide.collapse' : 'hide.show')))
  }
  function toggleShowHidden() { ui.showHidden = !ui.showHidden; renderFamilyFilter(); renderAccounts() }
  // Everything is hidden: say so, instead of the first-run screen that would suggest the accounts are gone.
  function allHiddenState() {
    return h('div', { class: 'empty empty-sm', 'data-key': 'all-hidden' },
      h('h3', null, t('hide.allTitle')),
      h('p', { class: 'muted' }, t('hide.allBody')),
      h('button', { class: 'btn', type: 'button', onclick: toggleShowHidden }, icon('eye'), t('hide.show')))
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
    const hidden = isHidden(a)
    return h('div', { class: 'row row-arrange' + (pinned ? ' is-pinned' : '') + (hidden ? ' is-hidden' : ''), role: 'listitem', 'data-ref': a.ref, 'data-key': 'arr:' + loginKey(ms.map((m) => m.ref)), 'data-sig': sig([ms.map(rowSig), at, lo, hi, full, hidden, famHidden(fam)]) },
      h('div', { class: 'ident' }, dragHandle('account', fam, a.name, label), badge(fam, 'sm'), h('div', { class: 'ident-text' }, h('div', { class: 'ident-name' },
        pinMark(a),
        h('span', { class: 'name', title: a.name }, a.name),
        loginMark(ms),
        aliasText(a),
        hiddenMark(hidden && !famHidden(fam))))),
      h('div', { class: 'arrange-tools' },
        // In a hidden Family the row keeps its eye, greyed, so the columns stay in line; the group's eye shows it again.
        famHidden(fam)
          ? h('button', { class: 'icon-btn hide-btn is-on', type: 'button', disabled: true, title: t('hide.inFamily', { title: family(fam).title }), 'aria-label': t('hide.inFamily', { title: family(fam).title }) }, icon('eyeOff'))
          : hideToggle(label, isHidden(a), () => toggleHide(a)),
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
    const keep = {}
    for (const k of ['pinned', 'hidden']) if (before[k] && Object.keys(before[k]).length) keep[k] = before[k]
    if (before.hiddenFamilies && before.hiddenFamilies.length) keep.hiddenFamilies = before.hiddenFamilies
    if (await saveDisplay(before, keep)) toast(t('order.reset'))
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
    const listed = listedAccounts()
    const hiddenN = all.length - visibleAccounts().length
    if (!listed.length) { setKids(count, null); patch(box, [allHiddenState()].concat(appGroups())); return }
    const shown = listed.filter((a) => (!prefs.family || a.family === prefs.family) && matchesQuery(a, ui.query, famTitle(a)) && (!ui.attention || reasonsOf(a, now).length))
    const filtered = shown.length !== listed.length
    patch(count, filtered
      ? [t('count.filtered', { n: shown.length, total: listed.length }), ' ', h('button', { class: 'link-btn', type: 'button', onclick: clearFilters }, t('filter.clear'))]
      : tn('count.accounts', listed.length))
    const apps = appGroups()
    const tail = hiddenN && !ui.arrange ? [hiddenBar(hiddenN)] : []
    if (!shown.length && !apps.length) { patch(box, [noMatch()].concat(tail)); return }
    ui.loginRefs = new Map()
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
      groups.push(group(fam, sorted, listed.filter((a) => a.family === fam).length, now, cols))
    }
    box.style.setProperty('--qn', String(width))
    patch(box, (ui.arrange ? [arrangeBar()] : []).concat(groups, tail))
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
    if (curPage !== 'accounts') box.hidden = true
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
        failed.length ? h('ul', null, failed.map((f) => h('li', null, h('b', null, f.account + ' · ' + f.item + colon()), f.message))) : null))
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
      raiseToasts()
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
    // A wide dialog is wide before it opens, so it does not open narrow and then stretch.
    el.classList.toggle('dialog-wide', kind === 'settings' ? el.classList.contains('dialog-wide') : kind === 'history')
    // A dialog that grows as the user adds to it (screenshots, its result) keeps its top edge and grows downward.
    el.classList.toggle('dialog-top', kind === 'send')
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
  function pageFromHash() { return location.hash === '#tuning' ? 'tuning' : location.hash === '#handoff' ? 'handoff' : location.hash === '#sessions' || location.hash === '#history' || location.hash === '#live' ? 'sessions' : 'accounts' }
  let curPage = pageFromHash()
  function tuneSize(n) { return n === null || n === undefined ? t('tune.hostDefault') : tokens(n) }
  // "Default" with the size it means, only where that size is documented: Claude models with a native 1M window
  // compact at about 967K (families/claude/tuning.ts cites the model documentation), which is below their window.
  // Elsewhere the effective size is the window itself, an estimate, or what was observed, so it stays "Default".
  function defaultSize(models) {
    const sizes = [...new Set(models.filter((m) => m.configured === null && m.effective && m.effective < m.contextWindow).map((m) => m.effective))].sort((x, y) => x - y)
    if (!sizes.length) return t('tune.hostDefault')
    return sizes.length === 1 ? t('tune.hostDefaultIs', { size: tokens(sizes[0]) }) : t('tune.hostDefaultRange', { lo: tokens(sizes[0]), hi: tokens(sizes[sizes.length - 1]) })
  }
  function claudeModels(entries) {
    return entries.filter((e) => e.tuning.status === 'ok' && e.ref.startsWith('claude:')).flatMap((e) => e.tuning.models)
  }
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
        h('li', null, t('tune.change') + colon() + tuneSize(plan.current) + ' → ' + tuneSize(plan.next)),
        h('li', null, t('tune.file') + colon(), h('code', null, plan.file + (plan.creates ? ' ' + t('tune.willCreate') : '')))),
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
    const rows = [h('div', { class: 'tg-head' }, badge(entries[0] ? entries[0].family : 'claude', 'sm'),
      h('p', { class: 'small' }, g.members.length > 1 ? t('tune.groupShared', { list: g.members.join(', ') }) : h('b', { class: 'mono' }, g.members[0])))]
    // Now, the suggestion and what it saves read as one strip, like the Accounts summary.
    const saved = pick && pick.savedPercent !== null ? Math.round(pick.savedPercent) : null
    rows.push(h('div', { class: 'tg-stats' },
      h('div', { class: 'tg-stat' }, h('span', { class: 'stat-label' }, t('tune.now')), h('div', { class: 'tune-num' }, g.current === null ? defaultSize(claudeModels(entries)) : tuneSize(g.current))),
      pick ? h('div', { class: 'tg-stat' }, h('span', { class: 'stat-label' }, t('tune.best')), h('div', { class: 'tune-num tune-best' }, tokens(pick.threshold))) : null,
      saved !== null ? h('div', { class: 'tg-stat', title: t('tune.saved', { n: saved }) }, h('span', { class: 'stat-label' }, t('tune.savedLabel')), h('div', { class: 'tune-num' }, t('tune.savedValue', { n: saved }))) : null))
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
  function tuneModel(m, minCalls, claude) {
    const rows = [h('div', { class: 'tune-head' }, h('b', { class: 'mono' }, m.model), h('span', { class: 'muted small' }, t('tune.calls', { n: m.calls })))]
    rows.push(h('div', { class: 'tune-vals' },
      h('div', null, h('span', { class: 'muted small' }, t('tune.now')), h('div', { class: 'small' }, m.configured === null && claude ? defaultSize([m]) : tuneSize(m.configured))),
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
      for (const m of e.tuning.models) kids.push(tuneModel(m, minCalls, e.ref.startsWith('claude:')))
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
  // Every move to a page counts, so an answer that comes in late never takes the viewer back to a page they left.
  let navSeq = 0
  function setPage(next, ready) {
    const seq = ++navSeq
    // The Sessions page opens once its first answer is in, at its final size (one read at start usually has it);
    // meanwhile its tab spins.
    const first = hs.mode === 'history' ? !hs.data && !hs.error : !sp.data && !sp.error
    if (next === 'sessions' && first && !sp.opening && !ready) {
      sp.opening = true
      renderPageChrome()
      const read = hs.mode === 'history' ? Promise.all([loadHistory(), loadProjects()]) : loadSessions()
      read.finally(() => {
        sp.opening = false
        if (seq === navSeq) setPage('sessions', true)
        else renderPageChrome()
      })
      return
    }
    if (next !== 'sessions') leaveHistory()
    curPage = next
    try { history.replaceState(null, '', next === 'accounts' ? location.pathname + location.search : '#' + (next === 'sessions' && hs.mode === 'live' ? 'live' : next)) } catch {}
    renderPageChrome()
    renderBanners()
    if (next === 'sessions' && Date.now() - ib.at >= INB_MS) loadInbound()
  }
  // The page tabs, and which sections show; runs with every render, so a reload or a language switch keeps them.
  function renderPageChrome() {
    const nav = $('pages')
    const canTune = tuningAvailable()
    const canHandoff = Boolean(ahState())
    // Always offered, so the tabs do not change when the last account goes; the page has its own empty state.
    const canSessions = Boolean(S.state)
    if (S.state && ((curPage === 'tuning' && !canTune) || (curPage === 'handoff' && !canHandoff) || (curPage === 'sessions' && !canSessions))) curPage = 'accounts'
    const tabs = [['accounts', t('page.accounts')]]
    if (canSessions) tabs.push(['sessions', t('page.sessions')])
    if (canTune) tabs.push(['tuning', t('page.tuning')])
    if (canHandoff) tabs.push(['handoff', t('page.handoff')])
    nav.hidden = tabs.length < 2
    // Underline tabs: each page has its mark, the Accounts tab its count and Auto Handoff a dot while it is on.
    const tabIcon = { accounts: 'tabAccounts', sessions: 'tabSessions', tuning: 'tabTuning', handoff: 'tabHandoff' }
    // The tab counts what the list shows: Hidden Accounts (spec §3.25) are counted on the line under it.
    const nAccounts = S.state ? visibleAccounts().length : 0
    const handoffOn = Boolean(ahState() && ahState().settings.auto)
    // Redrawn only when something on it changes, so a refresh never replays the underline.
    const navShape = JSON.stringify([lang, curPage, tabs, nAccounts, handoffOn, sp.opening, pasteCount()])
    if (nav._drawn !== navShape) {
    nav._drawn = navShape
    swapKids(nav, [h('div', { class: 'tabs', role: 'presentation' }, tabs.map(([id, label]) =>
      h('button', { class: 'tab', type: 'button', role: 'tab', 'data-key': 'tab:' + id, 'aria-selected': curPage === id ? 'true' : 'false', 'aria-busy': id === 'sessions' && sp.opening ? 'true' : null, onclick: () => setPage(id) },
        id === 'sessions' && sp.opening ? spinner() : icon(tabIcon[id]), h('span', { class: 'tab-label', 'data-label': label }, label),
        id === 'accounts' && nAccounts ? h('span', { class: 'tab-count' }, String(nAccounts)) : null,
        id === 'handoff' && handoffOn ? h('span', { class: 'tab-dot', 'aria-label': t('ah.on') }) : null,
        id === 'sessions' && pasteCount() ? h('span', { class: 'seg-badge', 'data-tip': t('msgn.badge', { n: pasteCount() }), 'aria-label': t('msgn.badge', { n: pasteCount() }) }, String(pasteCount())) : null)))])
    }
    const away = curPage !== 'accounts' && tabs.some(([id]) => id === curPage)
    // With no account yet the empty state is the whole page: no summary, no health check.
    const none = Boolean(S.state && !S.state.accounts.length)
    for (const id of ['summary', 'accounts-page', 'checkup']) $(id).hidden = away || (none && id !== 'accounts-page')
    const onTune = away && curPage === 'tuning'
    const onHandoff = away && curPage === 'handoff'
    const onSessions = away && curPage === 'sessions'
    $('tuning-page').hidden = !onTune
    $('handoff-page').hidden = !onHandoff
    $('sessions-page').hidden = !onSessions
    if (onSessions) {
      if (!sp.data && !sp.error) loadSessions()
      renderSessionsPage()
    }
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
    // One read at a time: a second refresh while one runs would end its spinner early.
    if (tp.loading) return
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
      tp.loading ? spinner() : null)]
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
  window.addEventListener('hashchange', () => {
    navSeq++
    curPage = pageFromHash()
    if (curPage === 'sessions') { const m = location.hash === '#live' ? 'live' : 'history'; if (m !== hs.mode) { hs.mode = m; sp.drawn = '' } }
    renderPageChrome()
  })

  // ---------- sessions (spec §3.32, ADR-0039) ----------
  // What every Account is running now, one row per Live Session, with "Copy for AI" and a menu for the id and the resume
  // command. Read once at start so the page opens at its final size, then every SESS_MS while it shows. An answer
  // that draws the same rows draws nothing; a new one waits while a menu or popover of the page is open, and the
  // focused button keeps focus (swapKids). The "x min ago" texts change in place every second.
  const SESS_MS = 5000
  const sp = { data: null, lang: null, loading: null, error: null, at: 0, drawn: '', pending: false, copied: {}, opening: false, msgs: {}, order: [] }
  function loadSessions() {
    if (sp.loading) return sp.loading
    sp.loading = readSessions()
    return sp.loading
  }
  async function readSessions() {
    const asked = lang
    try {
      // The chips of the latest Messages come with the list; when they cannot be read the rows keep the last ones.
      const seq = ++mn.asked
      const [data, msgs] = await Promise.all([api('/api/sessions', { lang: asked }), api('/api/sessions/messages', {}).catch(() => null)])
      sp.data = data; sp.lang = asked; sp.error = null
      if (msgs && msgs.latest) noteMessages(msgs.latest, seq)
      if (Date.now() - ib.at >= INB_MS) loadInbound()
    } catch (e) { sp.error = e }
    sp.at = Date.now()
    sp.loading = null
    renderSessionsPage()
  }
  // ---------- receiving Messages (ADR-0045) ----------
  // Whether each Claude settings file lets its sessions show a Message from another session at once, or holds it for
  // approval in that terminal (dropped after about 5 minutes). Read with the Sessions list every INB_MS and after a
  // change. The dialog lists each file, its value now and the change, and only its button writes; the toast carries
  // the undo.
  const INB_MS = 60000
  const ib = { data: null, error: null, loading: null, busy: false, at: 0, bannerEl: undefined }
  function loadInbound() {
    if (ib.loading) return ib.loading
    ib.loading = (async () => {
      try { ib.data = await api('/api/messages/inbound', {}); ib.error = null } catch (e) { ib.error = e }
      ib.at = Date.now()
      ib.loading = null
      renderBanners()
      renderSessionsPage()
      if (dlg.kind === 'inbound' && dlg.el && dlg.el.open) renderInbound()
    })()
    return ib.loading
  }
  function inboundGroups() { return (ib.data && ib.data.groups) || [] }
  function inboundTodo() { return groupsToAccept(inboundGroups()) }
  function inboundWaiting() { return inboundGroups().filter((g) => g.waits).flatMap((g) => g.accounts).map(shortRef) }
  function inboundShape() { return inboundGroups().length > 0 }
  const refList = (refs) => refs.join(lang === 'zh' ? '、' : ', ')
  // Shown above the Sessions page, in both its views. It grows from nothing to its own height when it first
  // appears and shrinks back when it goes (inboundBannerKept keeps the old one on screen while it leaves).
  function inboundBanner() {
    const refs = inboundWaiting()
    if (curPage !== 'sessions' || !refs.length || prefs.inbHide) return inboundBannerKept()
    const text = h('div', null, t('inb.banner', { refs: refList(refs) }))
    const attrs = { class: 'banner banner-warn', role: 'status', 'data-key': 'inb-banner' }
    if (BOOT.readOnly) return h('div', attrs, text)
    return h('div', attrs, text,
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: openInbound }, t('inb.go')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { prefs.inbHide = true; savePrefs(); renderBanners(); toast(t('inb.hidden')) } }, t('inb.keep'))))
  }
  function inboundBannerKept() {
    const old = $('banners').querySelector('[data-key="inb-banner"]')
    if (!old || old.dataset.leaving || matchMedia('(prefers-reduced-motion: reduce)').matches) return null
    old.dataset.leaving = '1'
    old.style.pointerEvents = 'none'
    old.animate(bannerFrames(old).reverse(), { duration: 180, easing: 'ease-in-out', fill: 'forwards' })
    setTimeout(renderBanners, 180)
    return old
  }
  // From nothing to the banner's measured height, padding, border and margin, so nothing below it jumps.
  function bannerFrames(el) {
    const cs = getComputedStyle(el)
    const full = { height: el.offsetHeight + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, marginBottom: cs.marginBottom, borderTopWidth: cs.borderTopWidth, borderBottomWidth: cs.borderBottomWidth, opacity: 1, boxSizing: 'border-box', overflow: 'hidden' }
    const none = { ...full, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0 }
    return [none, full]
  }
  function growInboundBanner() {
    const el = $('banners').querySelector('[data-key="inb-banner"]:not([data-leaving])')
    if (el === ib.bannerEl) return
    // A banner already there when the page opened just shows; one that arrives later grows in.
    if (el && ib.bannerEl !== undefined && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      el.animate(bannerFrames(el), { duration: 180, easing: 'ease-out' })
    ib.bannerEl = el
  }
  // Opens at its final size: the files are read first when they are not in yet.
  async function openInbound() {
    if (!ib.data) await loadInbound()
    showDialog('inbound')
    renderInbound()
    if (Date.now() - ib.at >= 5000) loadInbound()
  }
  function inboundChip(g) {
    if (g.state === 'accept') return ['ok', 'inb.state.accept']
    if (g.state === 'hold') return ['warn', 'inb.state.hold']
    if (g.state === 'default') return g.waits ? ['warn', 'inb.state.defaultWaits'] : ['', 'inb.state.default']
    if (g.state === 'refuse') return ['', 'inb.state.refuse']
    return ['fail', 'inb.state.cannot']
  }
  function renderInbound() {
    const groups = inboundGroups()
    const todo = inboundTodo()
    const body = [h('p', { class: 'small' }, t('inb.explain'))]
    if (!ib.data) body.push(errorNote(ib.error || new Error(t('inb.none')), () => loadInbound()))
    else if (!groups.length) body.push(h('p', { class: 'muted small' }, t('inb.none')))
    else {
      body.push(h('ul', { class: 'rc-list' }, groups.map((g) => {
        const [tone, key] = inboundChip(g)
        return h('li', { class: 'rc-row' },
          h('div', null, h('code', null, g.file), ' ', h('span', { class: 'chip chip-sm' + (tone ? ' chip-' + tone : '') }, t(key))),
          h('div', { class: 'muted small' }, t('rc.usedBy', { refs: refList(g.accounts.map(shortRef)) })),
          g.reason ? h('div', { class: 'muted small' }, g.why ? t('settings.why.' + g.why) : g.reason) : null,
          !BOOT.readOnly && todo.includes(g) ? h('div', { class: 'small rc-change' }, keyChange('crossSessionInbound', g.state === 'hold' ? '"hold"' : null, '"accept"')) : null)
      })))
      if (BOOT.readOnly) body.push(h('p', { class: 'small' }, t('inb.readOnly')))
      else if (todo.length) body.push(h('p', { class: 'small muted' }, t('inb.confirmNote')))
      else if (groups.every((g) => g.state === 'accept')) body.push(h('p', { class: 'small muted' }, t('inb.allSet')))
    }
    const foot = [h('button', { class: 'btn', type: 'button', disabled: ib.busy, onclick: () => dlg.el.close() }, t('btn.close'))]
    if (!BOOT.readOnly && groups.some((g) => g.undo)) foot.push(h('button', { class: 'btn', type: 'button', disabled: ib.busy, onclick: inboundUndo }, t('inb.undo')))
    if (!BOOT.readOnly && todo.length) foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: ib.busy, 'aria-busy': ib.busy ? 'true' : null, onclick: inboundAccept }, ib.busy ? spinner() : null, t('inb.accept')))
    setKids(dlg.el, dialogFrame(t('inb.title'), null, body, foot))
  }
  function inboundBusy(v) {
    ib.busy = v
    if (dlg.kind === 'inbound' && dlg.el && dlg.el.open) renderInbound()
  }
  async function inboundAccept() {
    inboundBusy(true)
    try {
      const r = await api('/api/messages/inbound/accept', { confirm: true, files: inboundTodo().map((g) => g.file) })
      if (r.changedSince) toast(t('as.changedSince'), { kind: 'fail' })
      else if (r.ok) {
        if (dlg.kind === 'inbound' && dlg.el.open) dlg.el.close()
        toast(t('inb.done'), { kind: 'ok', key: 'inb', action: { label: t('toast.undo'), run: inboundUndo }, duration: 12000 })
      } else toast(t('inb.failed', { msg: r.message }), { kind: 'fail' })
    } catch (e) { toast(t('inb.failed', { msg: e.message }), { kind: 'fail' }) }
    inboundBusy(false)
    await loadInbound()
  }
  async function inboundUndo() {
    inboundBusy(true)
    try {
      const r = await api('/api/messages/inbound/undo', { confirm: true })
      if (r.ok && dlg.kind === 'inbound' && dlg.el.open) dlg.el.close()
      toast(r.ok ? t('inb.undone') : r.message, { kind: r.ok ? 'ok' : 'fail', key: 'inb' })
    } catch (e) { toast(t('toast.undoFailed', { msg: e.message }), { kind: 'fail' }) }
    inboundBusy(false)
    await loadInbound()
  }
  // ---------- message notices (spec §3.32) ----------
  // A Message that reaches a Session, is read there, or waits for a paste shows as a toast on every page, with "Show"
  // leading to the Sessions page. The Sessions list reads the Messages with every refresh; any other page reads them
  // every MSG_MS while it shows. The first answer is only the baseline, so opening the Panel announces nothing old.
  const MSG_MS = 10000
  // "asked" numbers each reading and "applied" is the newest one used, so an answer that comes back late never
  // replaces a newer one; "own" holds the ids this Panel sent, never announced.
  const mn = { base: null, at: 0, loading: false, asked: 0, applied: 0, own: new Set() }
  // Running Sessions whose latest Message waits for a paste, for the count on the Sessions tab.
  function pasteCount() {
    if (!sp.data) return 0
    return sp.data.sessions.filter((s) => sp.msgs[s.sessionId] && sp.msgs[s.sessionId].status === 'paste-needed').length
  }
  function noteMessages(latest, seq) {
    if (seq < mn.applied) return
    mn.applied = seq
    const news = messageNews(mn.base, latest)
    const count = pasteCount()
    mn.base = latest
    mn.at = Date.now()
    sp.msgs = latest
    if (pasteCount() !== count) renderPageChrome()
    sendSeen()
    // The send dialog already says what happened to the Message it shows.
    const shown = sd && sd.result && dlg.kind === 'send' && dlg.el && dlg.el.open ? sd.result.message.id : null
    for (const n of news) {
      if (n.id === shown || (n.kind === 'new' && mn.own.has(n.id))) continue
      if (n.kind === 'approve') {
        // Held until the user approves it in that terminal; the way out is to receive directly from now on.
        toast(t('msgn.approve', { to: n.to || t('msgn.aSession') }), { kind: 'info', key: 'msg-' + n.sessionId, keep: true, duration: 12000, action: BOOT.readOnly ? null : { label: t('inb.go'), run: openInbound } })
        continue
      }
      const key = n.kind === 'read' ? 'msgn.read' : n.kind === 'paste' ? 'msgn.paste' : n.from ? 'msgn.newFrom' : 'msgn.new'
      const there = curPage === 'sessions' && hs.mode !== 'history'
      const line = n.kind === 'paste' ? latest[n.sessionId].pasteText : null
      toast(t(key, { to: n.to || t('msgn.aSession'), from: n.from }), {
        kind: n.kind === 'read' ? 'ok' : n.kind === 'paste' ? 'info' : 'accent',
        key: 'msg-' + n.sessionId,
        keep: n.kind === 'paste',
        // Long enough to reach the button; hovering holds it. A paste waits for the user on every page.
        duration: there && !line ? 0 : 12000,
        action: line ? { label: t('send.copyLine'), run: () => copyPasteLine(n.sessionId, line) } : there ? null : { label: t('msgn.show'), run: () => showSession(n.sessionId) },
      })
    }
  }
  // A browser that refuses the clipboard gets the Session's row instead, with the line selected in its popover.
  function copyPasteLine(sessionId, line) {
    navigator.clipboard.writeText(line).then(() => toast(t('toast.copied', { text: line })), () => showSession(sessionId, true))
  }
  // "Show": the Sessions page, scrolled to the Session's row, which lights up once. A list still loading is
  // waited for; "paste" also opens the row's paste popover.
  function showSession(sessionId, paste) {
    mn.show = { sessionId, paste: Boolean(paste) }
    if (curPage === 'sessions') setSessMode('live'); else { hs.mode = 'live'; setPage('sessions') }
    revealSession()
  }
  function revealSession() {
    const want = mn.show
    if (!want || curPage !== 'sessions' || hs.mode === 'history') return
    const row = $('sessions-page').querySelector('[data-session="' + CSS.escape(want.sessionId) + '"]')
    if (!row) { if (sp.data && !sp.loading) mn.show = null; return }
    mn.show = null
    row.scrollIntoView({ block: 'center', behavior: REDUCED ? 'auto' : 'smooth' })
    row.classList.remove('flash')
    void row.offsetWidth
    row.classList.add('flash')
    const chip = want.paste ? row.querySelector('.sess-msg-paste') : null
    if (chip) chip.click()
  }
  // A Message this Panel sent is known before the next reading, so it is not announced as a new one.
  function ownMessage(sessionId, m) {
    mn.own.add(m.id)
    const count = pasteCount()
    sp.msgs = Object.assign({}, sp.msgs, { [sessionId]: m })
    if (pasteCount() !== count) renderPageChrome()
    if (mn.base) mn.base = Object.assign({}, mn.base, { [sessionId]: m })
  }
  function messagesTick() {
    if (document.visibilityState !== 'visible' || !S.state || conn.lost || mn.loading || Date.now() - mn.at < MSG_MS) return
    // The Sessions list reads them itself.
    if (curPage === 'sessions' && hs.mode !== 'history' && !$('sessions-page').hidden) return
    mn.loading = true
    const seq = ++mn.asked
    api('/api/sessions/messages', {})
      .then((r) => { if (r && r.latest) noteMessages(r.latest, seq) })
      .catch(() => {})
      .finally(() => { mn.loading = false; mn.at = Date.now() })
  }
  function sessionsMenuOpen() { return Boolean(menu.el && menu.anchor && $('sessions-page').contains(menu.returnTo || menu.anchor)) }
  function sessAgeText(s) {
    const a = sessionAge(s, Date.now())
    return a ? t(a.key, { n: a.n }) : ''
  }
  function renderSessionAges() {
    if (!sp.data || $('sessions-page').hidden) return
    const byId = {}
    for (const s of sp.data.sessions) byId[s.sessionId] = s
    for (const el of $('sessions-page').querySelectorAll('[data-age]')) {
      const s = byId[el.getAttribute('data-age')]
      const text = s ? sessAgeText(s) : ''
      if (el.textContent !== text) el.textContent = text
    }
  }
  // Copies, then says so where the click was; a browser that refuses gets the text selected in a popover to copy by hand.
  async function sessCopy(anchor, text, done) {
    let ok = true
    try { await navigator.clipboard.writeText(text) } catch {
      const ta = h('textarea', { css: { position: 'fixed', opacity: '0' } })
      ta.value = text
      document.body.append(ta)
      ta.select()
      try { ok = document.execCommand('copy') } catch { ok = false }
      ta.remove()
    }
    if (ok) { done(); return }
    const keys = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘C' : 'Ctrl+C'
    openPopover(anchor, 'sess-copy', t('spage.copyFailTitle'), () => {
      const area = h('textarea', { class: 'sess-copy-text mono', readonly: true, rows: '4', 'aria-label': t('spage.copyFailTitle') })
      area.value = text
      setTimeout(() => { if (area.isConnected) { area.focus(); area.select() } }, 0)
      return [h('p', { class: 'small' }, t('spage.copyFail', { keys })), area]
    })
  }
  function copyForAi(btn, s) {
    sessCopy(btn, s.copy.reference, () => {
      sp.copied[s.sessionId] = Date.now() + 2000
      btn.classList.add('is-copied')
      btn.replaceChildren(icon('check'), h('span', null, t('spage.copied')))
      toast(t('spage.copiedToast'), { key: 'sess-copy' })
      // The row may have been drawn again meanwhile: put back whichever button stands for this Session now.
      setTimeout(() => {
        delete sp.copied[s.sessionId]
        const now = document.querySelector('[data-key="sess-copy-' + s.sessionId + '"]')
        if (!now) return
        now.classList.remove('is-copied')
        now.replaceChildren(icon('copy'), h('span', null, t('spage.copyAi')))
      }, 2000)
    })
  }
  // Orca brings the tab forward itself; only a refusal needs words here.
  async function jumpToOrca(s) {
    try { await api('/api/sessions/orca', { sessionId: s.sessionId }) } catch (e) {
      toast(e.message, { kind: 'fail' })
      loadSessions()
    }
  }
  // The Run an orchestrator ties the Session to (spec §3.32 step 2b). A page cannot open a file:// board, so the
  // server opens it: the page sends only the Session id. Opening starts a program, so a read-only Panel hides it.
  async function openRunBoard(s) {
    try { await api('/api/sessions/run', { sessionId: s.sessionId }) } catch (e) {
      toast(e.message, { kind: 'fail' })
      loadSessions()
    }
  }
  function runChip(s) {
    const run = s.run
    if (!run || !run.title || BOOT.readOnly) return null
    const others = run.others || []
    const tip = [run.laneTitle ? t('spage.runTipLane', { lane: run.laneTitle }) : t('spage.runTip')]
    if (others.length) tip.push(t('spage.runOthers', { runs: others.map((o) => o.title + (o.laneTitle ? ' · ' + o.laneTitle : '')).join('; ') }))
    return h('button', { class: 'chip chip-btn chip-accent sess-run', type: 'button', 'data-key': 'sess-run-' + s.sessionId, 'data-tip': tip.join(' '), onclick: () => openRunBoard(s) },
      h('span', { class: 'sess-run-title' }, t('spage.run', { title: run.title })),
      others.length ? h('span', { class: 'sess-run-more' }, '+' + others.length) : null)
  }
  function sessionRow(s) {
    const p = sessionLabelParts(s)
    const copied = (sp.copied[s.sessionId] || 0) > Date.now()
    const status = ['needs-you', 'busy', 'idle'].includes(s.status) ? s.status : 'unknown'
    const more = h('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-key': 'sess-more-' + s.sessionId, 'aria-label': t('spage.more', { label: s.label || p.account }), 'data-tip': t('menu.title') }, icon('more'))
    const liveMenu = (a) => openMenu(a, [
      s.orca && !BOOT.readOnly ? { icon: 'link', label: t('spage.jump'), run: () => jumpToOrca(s) } : null,
      s.orca && !BOOT.readOnly ? '-' : null,
      { icon: 'copy', label: t('spage.copyAi'), run: () => copyForAi(copyBtn, s) },
      BOOT.readOnly ? null : { icon: 'send', label: t('spage.send'), run: () => openSend(s) },
      '-',
      { icon: 'copy', label: t('spage.copyId'), hint: p.id, run: () => sessCopy(more, s.copy.id, () => toast(t('toast.copied', { text: p.id }))) },
      { icon: 'terminal', label: t('spage.copyResume'), run: () => sessCopy(more, s.copy.resume, () => toast(t('toast.copied', { text: s.copy.resume }))) },
    ], t('spage.more', { label: s.label || p.account }))
    more.addEventListener('click', () => liveMenu(more))
    const copyBtn = h('button', { class: 'btn btn-sm btn-primary sess-copy' + (copied ? ' is-copied' : ''), type: 'button', 'data-key': 'sess-copy-' + s.sessionId },
      icon(copied ? 'check' : 'copy'), h('span', null, t(copied ? 'spage.copied' : 'spage.copyAi')))
    copyBtn.addEventListener('click', () => copyForAi(copyBtn, s))
    const sendBtn = BOOT.readOnly ? null : h('button', { class: 'btn btn-sm sess-send', type: 'button', 'data-key': 'sess-send-' + s.sessionId, 'aria-label': t('spage.sendTo', { label: s.label || p.account }), onclick: () => openSend(s) }, icon('send'), h('span', null, t('spage.send')))
    const msg = sp.msgs[s.sessionId]
    const chip = messageChip(msg && msg.status, msg && msg.needsApproval)
    const cwd = shortCwd(s.cwd)
    return withMenu(h('div', { class: 'sess-row sess-' + status, 'data-enter': s.sessionId, 'data-session': s.sessionId },
      badge(s.family, 'sm'),
      h('div', { class: 'sess-main' },
        h('div', { class: 'sess-label' },
          h('b', null, p.account),
          p.title ? h('span', { class: 'sess-title' }, p.title) : null,
          h('span', { class: 'mono sess-id' }, p.id)),
        h('div', { class: 'sess-sub muted small' },
          h('span', { class: 'sess-status' }, h('span', { class: 'dot sess-dot', 'aria-hidden': 'true' }), t('spage.status.' + status)),
          chip ? msgChip(chip, msg, s) : null,
          s.guessed ? h('span', { class: 'chip sess-guessed', tabindex: '0', 'data-tip': t('spage.guessedTip') }, t('spage.guessed')) : null,
          runChip(s),
          h('span', { class: 'sess-cwd' + (cwd ? ' mono' : ''), title: s.cwd && cwd !== s.cwd ? s.cwd : null }, cwd || t('spage.noCwd')),
          h('span', { class: 'sess-age', 'data-age': s.sessionId }, sessAgeText(s)))),
      h('div', { class: 'sess-actions' }, copyBtn, sendBtn, more)), liveMenu)
  }
  // The latest Message's state on a row. One that waits for a paste opens what to paste and why, so the line is never
  // only in the dialog that sent it.
  function msgChip(chip, msg, s) {
    const cls = 'chip chip-sm chip-' + chip.tone + ' sess-msg'
    // Waiting for approval: why, and the way to receive the next ones directly (ADR-0045).
    if (chip.key === 'send.chip.approve') {
      const btn = h('button', { class: cls + ' sess-msg-paste', type: 'button', 'aria-haspopup': 'dialog', 'data-key': 'sess-msg-' + s.sessionId }, t(chip.key), icon('chevron'))
      btn.addEventListener('click', () => openPopover(btn, 'sess-paste', t(chip.key), () => {
        const go = h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: BOOT.readOnly }, t('inb.go'))
        go.addEventListener('click', () => { closeMenu(false); openInbound() })
        return [msg.note ? h('p', { class: 'small muted' }, msg.note) : null, h('div', { class: 'pop-actions' }, go)]
      }))
      return btn
    }
    if (chip.tone !== 'warn' || !msg.pasteText) return h('span', { class: cls, tabindex: '0', 'data-tip': t('send.chipTip') }, t(chip.key))
    const btn = h('button', { class: cls + ' sess-msg-paste', type: 'button', 'aria-haspopup': 'dialog', 'data-key': 'sess-msg-' + s.sessionId }, t(chip.key), icon('chevron'))
    btn.addEventListener('click', () => openPopover(btn, 'sess-paste', t('send.chip.paste'), () => {
      const area = h('textarea', { class: 'sess-copy-text mono', readonly: true, rows: '3', 'aria-label': t('send.copyLine') })
      area.value = msg.pasteText
      const copy = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, icon('copy'), h('span', null, t('send.copyLine')))
      copy.addEventListener('click', () => sessCopy(copy, msg.pasteText, () => { closeMenu(true); toast(t('toast.copied', { text: msg.pasteText })) }))
      return [msg.note ? h('p', { class: 'small muted' }, msg.note) : null, area, h('div', { class: 'pop-actions' }, copy)]
    }))
    return btn
  }
  function renderSessionsPage() {
    const box = $('sessions-page')
    if (box.hidden) return
    if (hs.mode === 'history') { renderHistoryPage(); return }
    // The copy texts come in the Panel's language: a switch reads them again.
    if (sp.data && sp.lang !== lang && !sp.loading) { loadSessions(); return }
    const d = sp.data
    // Rows already on screen keep their places; only a Session that needs the user moves up.
    const list = d ? steadyOrder(sp.order || [], d.sessions) : []
    sp.order = list.map((s) => s.sessionId)
    // Everything a row shows except its age, which renderSessionAges keeps current in place.
    const shape = JSON.stringify([lang, hs.opening, !d && !sp.error, sp.error ? sp.error.message : '', d ? d.problems : [],
      list.map((s) => [s.sessionId, s.account, s.accountLabel, s.family, s.title, s.label, s.status, s.cwd, s.guessed, s.copy, Boolean(s.orca), s.run || null, sp.msgs[s.sessionId] ? sp.msgs[s.sessionId].status + (sp.msgs[s.sessionId].needsApproval ? '+approve' : '') : '']), inboundShape()])
    if (shape === sp.drawn) { sp.pending = false; renderSessionAges(); revealSession(); return }
    if (sessionsMenuOpen()) { sp.pending = true; return }
    sp.pending = false
    sp.drawn = shape
    // No Refresh of its own: the list renews itself every few seconds, and the header's Refresh reads it too.
    const kids = [h('div', { class: 'section-head' }, h('h2', { id: 'h-sessions' }, t('spage.title')), modeSeg())]
    kids.push(h('p', { class: 'muted small' }, t('spage.intro')))
    if (sp.error) kids.push(errorNote(sp.error, () => loadSessions()))
    if (!d && !sp.error) kids.push(h('div', { class: 'group-list sess-list', 'aria-busy': 'true' }, [0, 1, 2].map(() => h('div', { class: 'sk-row' }, h('span', { class: 'sk sk-badge' }), h('span', { class: 'sk sk-title' }), h('span', { class: 'sk sk-bar' })))))
    // With no account yet the way to a session is to add one first.
    if (d && !list.length && !sp.error) kids.push(h('div', { class: 'empty empty-sm sess-empty' }, S.state && !S.state.accounts.length
      ? [h('p', null, t('spage.emptyNoAccounts')), BOOT.readOnly ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openCreate(null) }, icon('plus'), t('empty.create'))]
      : h('p', null, t('spage.empty'))))
    if (list.length) kids.push(h('div', { class: 'group-list sess-list', role: 'list' }, list.map((s) => { const r = sessionRow(s); r.setAttribute('role', 'listitem'); return r })))
    if (d) for (const problem of d.problems) kids.push(h('p', { class: 'note note-warn small' }, t('spage.problem', { problem })))
    // The example names an Account that is on the list, the one at the top; with none, it asks in general.
    const example = list.length ? t('spage.askOne', { name: sessionLabelParts(list[0]).account }) : t('spage.askAny')
    kids.push(h('p', { class: 'muted small sess-ask' }, t('spage.askHint', { example }),
      inboundGroups().length ? [' ', h('button', { class: 'link-btn small', type: 'button', onclick: openInbound }, t('inb.link'))] : null))
    swapKids(box, kids)
    revealSession()
  }
  // While the page shows: a new answer every SESS_MS, a held one once its menu closed, and the ages every second.
  function sessionsTick() {
    if (curPage !== 'sessions' || $('sessions-page').hidden || document.visibilityState !== 'visible') return
    if (hs.mode === 'history') { historyTick(); return }
    if (sp.pending && !sessionsMenuOpen()) renderSessionsPage()
    else renderSessionAges()
    if (!sp.loading && !conn.lost && Date.now() - sp.at >= SESS_MS) loadSessions()
  }

  // ---------- session history (spec §3.33, ADR-0042) ----------
  // Every past Session of every Account, from the History Index the server builds in the background; read the first
  // time "History" is picked, which waits on its tab until the first answer is in so the view opens at its final
  // size. The search box and filters are made once and kept, so typing (and an input method) is never interrupted;
  // each part under them is drawn again only when what it shows changed. A newer request makes older answers be
  // ignored. While the index is still being built the list renews every HIST_TICK_MS, then every HIST_IDLE_MS.
  const HIST_PAGE = 50
  const HIST_TICK_MS = 2000
  const HIST_IDLE_MS = 30000
  const HIST_CLIP = 3000
  const HIST_KEEP = 500
  // The filters live in this tab's session storage, so a reload keeps them and a new tab starts clean.
  const HIST_FILTERS_KEY = 'sideby.historyFilters'
  function savedHistFilters() { try { return histFilters(JSON.parse(sessionStorage.getItem(HIST_FILTERS_KEY) || 'null')) } catch { return histFilters(null) } }
  function saveHistFilters() {
    try { sessionStorage.setItem(HIST_FILTERS_KEY, JSON.stringify({ q: hs.q, since: hs.since, family: hs.family, account: hs.account, project: hs.project, category: hs.category, scripts: hs.scripts })) } catch {}
  }
  const hs = Object.assign({ mode: location.hash === '#live' ? 'live' : 'history', opening: false, group: prefs.histGroup || 'project', cats: null, tools: false,
    data: null, error: null, loading: false, more: false, moreFailed: false, seq: 0, at: 0, projects: null, projError: null, projSeq: 0, tool: null, els: null, srcOpen: false, debounce: 0, clearing: false }, savedHistFilters())
  function histWords() { return hs.q.split(/\s+/).filter(Boolean) }
  function histParams(extra) {
    return Object.assign({ q: hs.q, since: hs.since, family: hs.family, account: hs.account || undefined, project: hs.project, category: hs.category || undefined, scripts: hs.scripts, lang }, extra || {})
  }
  function histKey() { return JSON.stringify([hs.q, hs.since, hs.family, hs.account, hs.project, hs.category, hs.scripts]) }
  // The grouping the list is asked for: one picked Project needs no project headers, and the categories only
  // group when a plugin gives them (a category picked on the side is grouped by its Projects).
  function histGroupNow() {
    const g = hs.group
    if (g === 'category') return hs.category || !hs.cats ? 'project' : 'category'
    if (g === 'project' && hs.project) return 'none'
    if ((g === 'family' && histFamilies().length < 2) || (g === 'account' && histAccounts().length < 2)) return 'project'
    return g
  }
  function histFamilies() { return S.state ? S.state.families.filter((f) => S.state.accounts.some((a) => a.family === f.id)) : [] }
  function histAccounts() { return S.state ? S.state.accounts.filter((a) => !hs.family || a.family === hs.family) : [] }
  function histFold(by) { return prefs.histFold[by] || (prefs.histFold[by] = {}) }
  function fullWhen(iso) {
    const d = new Date(iso)
    return Number.isFinite(d.getTime()) ? d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : ''
  }
  function whenText(iso) {
    const w = historyWhen(iso, Date.now())
    if (!w) return ''
    if (w.key !== 'time.on') return t(w.key, { n: w.n })
    const d = new Date(iso)
    const date = d.toLocaleDateString(locale(), d.getFullYear() === new Date().getFullYear() ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' })
    return t(w.key, { date })
  }
  // A snippet that only repeats the title (ellipses and spacing aside) adds nothing under it.
  function sameText(a, b) {
    const norm = (x) => String(x || '').replace(/…/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
    return norm(a) === norm(b) || (norm(b).length > 0 && norm(b).startsWith(norm(a)))
  }
  function highlighted(text, words) {
    return words.length ? highlightParts(text, words).map((p) => p.hit ? h('mark', null, p.text) : p.text) : text
  }
  // quiet: a renewal the user did not ask for: the list stays as it is (not dimmed, not busy) until the answer.
  // after: the rows already loaded past an unfolded group, kept when the answer stops short of them (a page has at
  // most HIST_KEEP rows), so folding or opening a group never drops the groups below it back behind "Show more".
  // With a key, only once the answer holds all of that group's rows; the rest then follow in the same order.
  async function loadHistory(more, keep, quiet, after) {
    if (more && (hs.more || hs.loading || !hs.data)) return
    const seq = ++hs.seq
    if (more) hs.more = true
    else if (quiet) hs.bg = true
    else hs.loading = true
    if (!quiet) renderHistoryParts()
    const offset = more ? hs.data.sessions.length : 0
    const limit = more ? HIST_PAGE : Math.max(HIST_PAGE, Math.min(HIST_KEEP, keep || 0))
    try {
      const by = more ? hs.data._by : histGroupNow()
      const folded = Object.keys(histFold(by))
      const r = await api('/api/history', histParams({ offset, limit, group: by, collapsed: by === 'none' || !folded.length ? undefined : folded }))
      if (seq !== hs.seq) return
      r._by = by
      // Sessions that moved up while paging (one was updated) are not shown twice.
      if (more) {
        const seen = new Set(hs.data.sessions.map((x) => x.account + '\0' + x.sessionId))
        r.sessions = hs.data.sessions.concat(r.sessions.filter((x) => !seen.has(x.account + '\0' + x.sessionId)))
      }
      if (after && r.groups) {
        const g = after.key === undefined ? null : r.groups.find((x) => x.key === after.key)
        if (!g || r.sessions.filter((x) => (x.group || '') === after.key).length >= g.sessions) {
          const seen = new Set(r.sessions.map((x) => x.account + '\0' + x.sessionId))
          r.sessions = r.sessions.concat(after.rows.filter((x) => !seen.has(x.account + '\0' + x.sessionId)))
        }
      }
      hs.data = r
      hs.error = null
      hs.moreFailed = false
    } catch (e) {
      if (seq !== hs.seq) return
      // A renewal that failed keeps what is shown; the next one tries again.
      if (quiet) {
        hs.bg = false
        hs.at = Date.now()
        // A group that was opening stays folded, and says why.
        const opening = hs.data && hs.data.groups ? hs.data.groups.filter((g) => g.opening) : []
        if (opening.length) {
          for (const g of opening) { g.opening = false; g.collapsed = true; histFold(hs.data._by)[g.key] = true }
          savePrefs()
          toast(e.message, { kind: 'fail' })
          renderHistoryParts()
        }
        return
      }
      // A page that failed is not asked again by itself: the button at the end tries again.
      if (more) { hs.moreFailed = true; toast(e.message, { kind: 'fail' }) } else hs.error = e
    }
    hs.loading = false
    hs.more = false
    hs.bg = false
    hs.at = Date.now()
    renderHistoryParts()
    const grow = hs.growing
    if (grow && hs.data && hs.data._by === grow.by && !(hs.data.groups || []).some((x) => x.key === grow.key && (x.collapsed || x.opening))) {
      hs.growing = null
      growOpened(grow.by, grow.key)
    }
    if (!more && !quiet && hs.tools && hs.q && curPage === 'sessions' && hs.mode === 'history') startToolScan()
    moreIfTailShows()
  }
  async function loadProjects() {
    const seq = ++hs.projSeq
    try {
      const r = await api('/api/history/projects', { since: hs.since, family: hs.family, account: hs.account || undefined, scripts: hs.scripts })
      if (seq !== hs.projSeq) return
      hs.projects = r.projects.filter((p) => p.project)
      const had = Boolean(hs.cats)
      hs.cats = r.categories || null
      hs.projError = null
      // A grouping that waited for the categories asks again once it knows whether there are any.
      if (had !== Boolean(hs.cats) && hs.group === 'category' && hs.data && hs.data._by !== histGroupNow()) historyChanged(false)
    } catch (e) { if (seq === hs.projSeq) hs.projError = e }
    renderHistorySide()
  }
  // A filter changed: the list starts again from the top; the projects only follow the filters they depend on.
  function historyChanged(projectsToo) {
    stopToolScan()
    // The next answer replaces the whole list: it fades in at its own height instead of each row growing in.
    hs.swap = true
    saveHistFilters()
    loadHistory()
    if (projectsToo) loadProjects()
    if (hs.els) hs.els.main.scrollTop = 0
  }

  // "Also search tool output" (ADR-0042): the server reads the session files at that moment and keeps nothing.
  // One scan at a time; a change of words or filters stops it, and so does leaving History.
  async function startToolScan() {
    const key = histKey()
    if (hs.tool && hs.tool.key === key) return
    stopToolScan()
    if (!hs.tools || !hs.q) { renderHistoryParts(); return }
    const skip = hs.data ? hs.data.sessions.map((s) => s.account + '\u0000' + s.sessionId) : []
    const tool = { key, job: null, hits: [], done: 0, total: 0, finished: false, error: null, timer: 0 }
    hs.tool = tool
    renderHistoryParts()
    try {
      const r = await api('/api/history/tools', histParams({ skip }))
      if (hs.tool !== tool) { api('/api/history/tools', { job: r.job, cancel: true }).catch(() => {}); return }
      tool.job = r.job
      pollToolScan(tool)
    } catch (e) {
      if (hs.tool !== tool) return
      tool.error = e
      tool.finished = true
      renderHistoryParts()
    }
  }
  async function pollToolScan(tool) {
    if (hs.tool !== tool) return
    try {
      const r = await api('/api/history/tools', { job: tool.job, lang })
      if (hs.tool !== tool) return
      tool.hits = r.hits
      tool.done = r.done
      tool.total = r.total
      tool.finished = r.finished
      if (r.error) tool.error = { message: r.error }
    } catch (e) {
      if (hs.tool !== tool) return
      tool.error = e
      tool.finished = true
    }
    renderHistoryParts()
    if (curPage !== 'sessions' || hs.mode !== 'history') { stopToolScan(); return }
    if (!tool.finished) tool.timer = setTimeout(() => pollToolScan(tool), 600)
  }
  // Leaving History: answers still on their way are dropped, a typed search waiting to start does not start.
  function leaveHistory() {
    stopToolScan()
    clearTimeout(hs.debounce)
    if (hs.loading || hs.more || hs.bg) { hs.seq++; hs.loading = false; hs.more = false; hs.bg = false }
    hs.projSeq++
  }
  function stopToolScan() {
    const tool = hs.tool
    hs.tool = null
    if (!tool) return
    clearTimeout(tool.timer)
    if (tool.job && !tool.finished) api('/api/history/tools', { job: tool.job, cancel: true }).catch(() => {})
  }

  // History / Running, at the head of the Sessions page; History is the one it opens on.
  function modeSeg() {
    return h('div', { class: 'seg sess-mode', role: 'tablist', 'aria-label': t('hist.modeLabel') }, [['history', t('hist.mode.history')], ['live', t('hist.mode.live')]].map(([id, label]) =>
      h('button', { class: 'seg-btn', type: 'button', role: 'tab', 'data-key': 'sess-mode-' + id, 'aria-selected': hs.mode === id ? 'true' : 'false', 'aria-busy': id === 'history' && hs.opening ? 'true' : null, onclick: () => setSessMode(id) },
        id === 'history' && hs.opening ? [spinner(), ' '] : null, label)))
  }
  function setSessMode(m) {
    if (hs.mode === m || hs.opening) return
    if (m === 'history' && !hs.data && !hs.error) {
      hs.opening = true
      sp.drawn = ''
      renderSessionsPage()
      Promise.all([loadHistory(), loadProjects()]).finally(() => {
        hs.opening = false
        sp.drawn = ''
        if (curPage === 'sessions') setSessMode('history')
        else renderSessionsPage()
      })
      return
    }
    hs.mode = m
    sp.drawn = ''
    try { history.replaceState(null, '', '#' + (m === 'live' ? 'live' : 'sessions')) } catch {}
    if (m === 'live') { leaveHistory(); loadSessions() }
    renderSessionsPage()
    if (m === 'history' && hs.els) hs.els.q.focus()
  }

  // The parts made once: the toolbar, the project list and the places the lists are drawn into.
  function historyEls() {
    if (hs.els) return hs.els
    const e = {}
    e.q = h('input', { type: 'search', class: 'search-input', autocomplete: 'off', spellcheck: 'false', 'data-key': 'hist-q', value: hs.q || null })
    e.q.addEventListener('input', () => {
      clearTimeout(hs.debounce)
      hs.debounce = setTimeout(() => {
        const q = e.q.value.trim()
        if (q === hs.q) return
        hs.q = q
        historyChanged(false)
      }, 150)
    })
    e.q.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      if (e.q.value) { e.q.value = ''; clearTimeout(hs.debounce); hs.q = ''; historyChanged(false) } else e.q.blur()
    })
    e.since = h('select', { class: 'tb-select' })
    e.since.addEventListener('change', () => { hs.since = e.since.value; historyChanged(true) })
    e.family = h('select', { class: 'tb-select' })
    e.family.addEventListener('change', () => {
      hs.family = e.family.value
      // An Account of another AI would match nothing: it is dropped before the lists are asked for again.
      if (hs.account && S.state && !S.state.accounts.some((a) => a.ref === hs.account && (!hs.family || a.family === hs.family))) hs.account = ''
      relabelHistory(e)
      historyChanged(true)
    })
    e.account = h('select', { class: 'tb-select' })
    e.account.addEventListener('change', () => { hs.account = e.account.value; historyChanged(true) })
    e.tools = h('input', { type: 'checkbox' })
    e.tools.addEventListener('change', () => {
      hs.tools = e.tools.checked
      if (hs.tools) startToolScan()
      else { stopToolScan(); renderHistoryParts() }
    })
    e.scripts = h('input', { type: 'checkbox' })
    e.scripts.addEventListener('change', () => { hs.scripts = e.scripts.checked; historyChanged(true) })
    e.toolsText = h('span')
    e.scriptsText = h('span')
    e.displayText = h('span')
    e.display = h('button', { class: 'btn btn-sm hist-display', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-key': 'hist-display' }, icon('sliders'), e.displayText)
    e.display.addEventListener('click', () => openPopover(e.display, 'hist-display', t('hist.display'), displayKids, 'end'))
    e.toolsLabel = h('label', { class: 'hist-check', tabindex: null }, e.tools, e.toolsText)
    e.scriptsLabel = h('label', { class: 'hist-check' }, e.scripts, e.scriptsText)
    e.search = h('label', { class: 'search hist-search' }, icon('search', 'search-ic'), e.q)
    e.head = h('div', { class: 'section-head' })
    e.intro = h('p', { class: 'muted small' })
    e.side = h('nav', { class: 'hist-side', ondragover: onCatDragOver, ondrop: onCatDrop })
    e.status = h('div', { class: 'hist-status' })
    e.list = h('div', { class: 'hist-list' })
    e.tail = h('div', { class: 'hist-tail' })
    e.toolBox = h('div', { class: 'hist-toolbox' })
    e.sources = h('div', { class: 'hist-sources-box' })
    e.ask = h('p', { class: 'muted small sess-ask' })
    e.main = h('div', { class: 'hist-main' }, e.status, e.list, e.tail, e.toolBox)
    e.root = h('div', { class: 'hist' },
      h('div', { class: 'toolbar hist-bar' }, e.search, h('div', { class: 'tools' }, e.since, e.family, e.account), h('div', { class: 'hist-checks' }, e.toolsLabel, e.scriptsLabel, e.display)),
      h('div', { class: 'hist-grid' }, e.side, e.main))
    // The list loads its next page when its end scrolls into view; the button is there for keyboards.
    if ('IntersectionObserver' in window) new IntersectionObserver((xs) => { if (xs.some((x) => x.isIntersecting)) moreIfTailShows() }, { rootMargin: '200px' }).observe(e.tail)
    hs.els = e
    return e
  }
  function hasMore() { return Boolean(hs.data && hs.data.sessions.length < hs.data.total) }
  function moreIfTailShows() {
    const e = hs.els
    if (!e || !hasMore() || hs.loading || hs.more || hs.moreFailed || !e.tail.isConnected) return
    const box = e.main.getBoundingClientRect()
    const at = e.tail.getBoundingClientRect()
    if (tailInView(at.top, box.bottom, window.innerHeight || document.documentElement.clientHeight)) loadHistory(true)
  }
  // Texts and choices that follow the Panel's language and the accounts there are; set only when they changed.
  function relabelHistory(e) {
    const set = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v) }
    set(e.q, 'placeholder', t('hist.searchPh'))
    set(e.q, 'aria-label', t('hist.search'))
    set(e.since, 'aria-label', t('hist.since'))
    set(e.family, 'aria-label', t('hist.family'))
    set(e.toolsLabel, 'data-tip', t('hist.toolsTip'))
    set(e.scriptsLabel, 'data-tip', t('hist.scriptsTip'))
    if (e.toolsText.textContent !== t('hist.tools')) e.toolsText.textContent = t('hist.tools')
    if (e.scriptsText.textContent !== t('hist.scripts')) e.scriptsText.textContent = t('hist.scripts')
    const shown = t('hist.display') + (hs.group === 'none' ? '' : colon() + groupName(hs.group))
    if (e.displayText.textContent !== shown) e.displayText.textContent = shown
    const sinceKey = lang + hs.since
    if (e.since._k !== sinceKey) {
      e.since._k = sinceKey
      e.since.replaceChildren(...['today', '7d', '30d', 'all'].map((v) => h('option', { value: v }, t('hist.since.' + v, { n: parseInt(v, 10) }))))
      e.since.value = hs.since
    }
    const fams = S.state ? S.state.families.filter((f) => S.state.accounts.some((a) => a.family === f.id)) : []
    const famKey = lang + fams.map((f) => f.id).join(',')
    if (e.family._k !== famKey) {
      e.family._k = famKey
      e.family.replaceChildren(h('option', { value: '' }, t('hist.allFamilies')), ...fams.map((f) => h('option', { value: f.id }, f.title)))
      if (hs.family && !fams.some((f) => f.id === hs.family)) hs.family = ''
      e.family.value = hs.family
    }
    e.family.hidden = fams.length < 2 && !hs.family
    set(e.account, 'aria-label', t('hist.account'))
    const accts = S.state ? S.state.accounts.filter((a) => !hs.family || a.family === hs.family) : []
    const acctKey = lang + accts.map((a) => a.ref + ' ' + (a.aliases || [])[0]).join(',')
    if (e.account._k !== acctKey) {
      e.account._k = acctKey
      e.account.replaceChildren(h('option', { value: '' }, t('hist.allAccounts')), ...accts.map((a) => h('option', { value: a.ref }, (a.aliases || [])[0] ? a.aliases[0] + ' · ' + a.ref : a.ref)))
      if (hs.account && !accts.some((a) => a.ref === hs.account)) hs.account = ''
      e.account.value = hs.account
    }
    e.account.hidden = accts.length < 2 && !hs.account
    e.tools.checked = hs.tools
    e.scripts.checked = hs.scripts
  }
  // Draws el again only when what it shows changed, so a renewal with the same answer redraws nothing.
  function drawIf(el, key, kids) {
    if (el._drawn === key) return
    el._drawn = key
    swapKids(el, kids())
  }
  // drawIf for a long list: groups and rows that did not change stay the same elements, so folding one group or a
  // quiet renewal does not rebuild thousands of rows; a row that was not there before grows in.
  function patchIf(el, key, kids) {
    if (el._drawn === key) return
    el._drawn = key
    const shown = el.childNodes.length > 0
    const before = new Set([...el.querySelectorAll('[data-enter]')].map((x) => x.getAttribute('data-enter')))
    for (const x of el.querySelectorAll('.enter')) x.classList.remove('enter')
    for (const x of el.querySelectorAll('.fade-in')) x.classList.remove('fade-in')
    patch(el, kids())
    if (!shown || REDUCED) return
    const fresh = [...el.querySelectorAll('[data-enter]')].filter((x) => !before.has(x.getAttribute('data-enter')))
    // A few new rows grow in; a batch fades in at once, since many small motions in a row stutter.
    for (const x of fresh) x.classList.add(fresh.length > 6 ? 'fade-in' : 'enter')
  }
  function renderHistoryPage() {
    const box = $('sessions-page')
    const e = historyEls()
    relabelHistory(e)
    if (!box.contains(e.root)) {
      setKids(box, [e.head, e.intro, e.root, e.sources, e.ask])
      e.head._drawn = null
    }
    drawIf(e.head, JSON.stringify([lang, hs.mode, hs.opening]), () => [h('h2', { id: 'h-sessions' }, t('spage.title')), modeSeg()])
    if (e.intro.textContent !== t('hist.intro')) e.intro.textContent = t('hist.intro')
    const ask = t('spage.askHint', { example: t('hist.askEx') })
    if (e.ask.textContent !== ask) e.ask.textContent = ask
    // With no Account there is nothing to search or filter: only the note saying how to start is shown.
    const none = Boolean(S.state && !S.state.accounts.length)
    e.root.classList.toggle('hist-none', none)
    e.ask.hidden = none
    if (!hs.data && !hs.loading && !hs.error) { hs.swap = true; loadHistory(); loadProjects() }
    renderHistorySide()
    renderHistoryParts()
  }
  function renderHistorySide() {
    const e = hs.els
    if (!e || !e.root.isConnected) return
    const list = hs.projects
    const shown = list && list.map((p) => [p.project, p.name, p.sessions, p.gone, p.category])
    drawIf(e.side, JSON.stringify([lang, hs.project, hs.category, shown, hs.cats, prefs.histCatOrder, hs.projError ? hs.projError.message : '']), () => {
      const total = list ? list.reduce((n, p) => n + p.sessions, 0) : 0
      const item = (project, name, count, gone, tip) => h('button', { class: 'hist-proj', type: 'button', 'data-key': 'hist-p-' + project, 'aria-pressed': hs.project === project && !(project === '' && hs.category) ? 'true' : 'false', title: tip || null, onclick: () => pickProject(project) },
        h('span', { class: 'hist-proj-name' }, name),
        gone ? h('span', { class: 'hist-proj-gone', 'aria-label': t('hist.gone'), title: t('hist.goneTip') }, icon('folder')) : null,
        h('span', { class: 'hist-proj-n' }, count === null ? '' : String(count)))
      if (hs.projError) return [h('h3', { class: 'hist-side-h' }, t('hist.projects')), errorNote(hs.projError, loadProjects)]
      if (!list) return [h('h3', { class: 'hist-side-h' }, t('hist.projects')), [0, 1, 2, 3].map(() => h('span', { class: 'sk sk-title hist-sk' }))]
      const proj = (p) => item(p.project, p.name, p.sessions, p.gone, p.project + (p.gone ? ' · ' + t('hist.gone') : ''))
      const all = item('', t('hist.allProjects'), total)
      if (!hs.cats) return [h('h3', { class: 'hist-side-h' }, t('hist.projects')), h('div', { class: 'hist-projs' }, all, list.map(proj))]
      // With a plugin's categories: each category heads its Projects, in the order the user dragged them to, else
      // of their latest Session; a category heading folds them. Projects without one come last.
      const cats = new Map()
      for (const p of list) { const c = p.category || ''; if (!cats.has(c)) cats.set(c, []); cats.get(c).push(p) }
      const order = categoryOrder([...cats.keys()], prefs.histCatOrder)
      hs.catNames = order.filter(Boolean)
      return [h('h3', { class: 'hist-side-h' }, groupName('category')), h('div', { class: 'hist-projs' }, all,
        order.map((c) => {
          const ps = cats.get(c)
          const n = ps.reduce((x, p) => x + p.sessions, 0)
          const name = c || t('hist.noCategory')
          const folded = Boolean(prefs.histCatFold[c])
          const bodyId = 'hcat-' + order.indexOf(c)
          // The whole heading folds the category, so a click anywhere on it opens or closes its Projects.
          // A named category also moves: dragged, or with Alt and the arrow keys. Projects without one stay last.
          const head = h('button', { class: 'hist-proj hist-cat', type: 'button', 'data-key': 'hist-cf-' + c, 'aria-expanded': String(!folded), 'aria-controls': bodyId,
            'aria-label': t('group.toggle', { title: name, count: String(n), action: t(folded ? 'hist.unfoldOne' : 'hist.fold') }),
            draggable: c ? 'true' : null, title: c ? t('hist.catMove') : null,
            ondragstart: c ? (ev) => {
              hs.catDrag = { from: hs.catNames.indexOf(c), to: null }
              ev.dataTransfer.effectAllowed = 'move'
              try { ev.dataTransfer.setData('text/plain', c) } catch {}
              requestAnimationFrame(() => grp.classList.add('is-dragging'))
            } : null,
            ondragend: c ? () => endCatDrag() : null,
            onkeydown: c ? (ev) => {
              const step = { ArrowUp: -1, ArrowDown: 1 }[ev.key]
              if (!ev.altKey || !step) return
              ev.preventDefault()
              const from = hs.catNames.indexOf(c)
              moveCategory(from, Math.max(0, Math.min(hs.catNames.length - 1, from + step)), c)
            } : null },
            icon('chevron', 'chev'), h('span', { class: 'hist-proj-name' }, name), h('span', { class: 'hist-proj-n' }, String(n)))
          const grp = h('div', { class: 'hist-catgrp' + (folded ? ' is-folded' : ''), role: 'group', 'aria-label': name, 'data-cat': c },
            h('div', { class: 'hist-cathead' }, head),
            h('div', { class: 'hist-catbody', id: bodyId }, h('div', { class: 'hist-catps' }, ps.map(proj))))
          head.addEventListener('click', () => foldCategory(c, grp, head, name, n))
          return grp
        }))]
    })
  }
  // Dragging a category over the side list marks where it would land: before the category under the pointer, or after
  // it past its middle. Projects without a category stay last, so nothing lands after them.
  function onCatDragOver(ev) {
    const d = hs.catDrag
    const grp = d && ev.target.closest && ev.target.closest('.hist-catgrp[data-cat]')
    if (!grp) return
    ev.preventDefault()
    ev.dataTransfer.dropEffect = 'move'
    const c = grp.getAttribute('data-cat')
    const r = grp.getBoundingClientRect()
    const after = c !== '' && ev.clientY > r.top + r.height / 2
    const at = (c === '' ? hs.catNames.length : hs.catNames.indexOf(c)) + (after ? 1 : 0)
    clearDropMarks()
    grp.classList.add(after ? 'drop-after' : 'drop-before')
    // Dropped after itself means one place earlier once it is taken out.
    d.to = Math.min(hs.catNames.length - 1, at > d.from ? at - 1 : at)
  }
  function onCatDrop(ev) {
    const d = hs.catDrag
    if (!d || d.to === null) return
    ev.preventDefault()
    endCatDrag()
    moveCategory(d.from, d.to)
  }
  function endCatDrag() {
    hs.catDrag = null
    clearDropMarks()
    for (const el of document.querySelectorAll('.hist-catgrp.is-dragging')) el.classList.remove('is-dragging')
  }
  // The new order is kept in this browser, with the other preferences; the focus follows a category moved by keys.
  function moveCategory(from, to, focus) {
    if (from < 0 || from === to) return
    prefs.histCatOrder = reorder(hs.catNames, hs.catNames.map((c) => [c]), from, to).slice(0, HIST_FOLD_MAX)
    savePrefs()
    renderHistorySide()
    const el = focus && hs.els && hs.els.side.querySelector('[data-key="' + CSS.escape('hist-cf-' + focus) + '"]')
    if (el) el.focus()
  }
  // A category in the side list folds in place (CSS eases its height); the list is not drawn again for it.
  function foldCategory(c, grp, chev, name, n) {
    const folded = !prefs.histCatFold[c]
    if (folded) {
      if (Object.keys(prefs.histCatFold).length >= HIST_FOLD_MAX) delete prefs.histCatFold[Object.keys(prefs.histCatFold)[0]]
      prefs.histCatFold[c] = true
    } else delete prefs.histCatFold[c]
    savePrefs()
    grp.classList.toggle('is-folded', folded)
    chev.setAttribute('aria-expanded', String(!folded))
    chev.setAttribute('aria-label', t('group.toggle', { title: name, count: String(n), action: t(folded ? 'hist.unfoldOne' : 'hist.fold') }))
  }
  function pickProject(p) {
    if (hs.project === p && !hs.category) return
    hs.project = p
    hs.category = ''
    renderHistorySide()
    historyChanged(false)
  }
  // ---------- grouping the list ----------
  // A "Display" popover by the filters picks how the list is grouped; a group folds from its header and stays
  // folded in this browser. The server pages through the groups in order and counts folded ones without their rows.
  function groupName(by) {
    return by === 'category' && hs.cats && hs.cats.label ? hs.cats.label : t('hist.by.' + by)
  }
  function groupChoices() {
    return HIST_GROUPS.filter((g) => (g !== 'category' || hs.cats) && (g !== 'family' || histFamilies().length > 1) && (g !== 'account' || histAccounts().length > 1))
  }
  function displayKids() {
    const fold = histFold(histGroupNow())
    const folded = Object.keys(fold).length
    return [
      h('b', null, t('hist.groupBy')),
      h('div', { class: 'hist-opts', role: 'group', 'aria-label': t('hist.groupBy') }, groupChoices().map((g) =>
        h('button', { class: 'hist-opt', type: 'button', 'aria-pressed': String(hs.group === g), 'data-key': 'hist-by-' + g, onclick: () => setHistGroup(g) },
          h('span', { class: 'hist-opt-ck', 'aria-hidden': 'true' }, hs.group === g ? icon('check') : null),
          h('span', null, groupName(g))))),
      hs.cats ? h('p', { class: 'muted small' }, t('hist.catsFrom', { label: groupName('category'), plugin: hs.cats.from })) : null,
      folded && histGroupNow() !== 'none' ? h('div', { class: 'popover-actions' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: unfoldAll }, t('hist.unfold', { n: folded }))) : null,
    ]
  }
  function setHistGroup(g) {
    if (hs.group === g) return
    hs.group = g
    prefs.histGroup = g
    savePrefs()
    refreshPopover('hist-display')
    if (hs.els) relabelHistory(hs.els)
    historyChanged(false)
  }
  function unfoldAll() {
    prefs.histFold[histGroupNow()] = {}
    savePrefs()
    refreshPopover('hist-display')
    historyChanged(false)
  }
  function groupTitle(by, g) {
    if (by === 'day') return t('hist.day.' + g.key, { n: g.key === 'week' ? 7 : 30 })
    if (!g.key) return t(by === 'project' ? 'hist.noProject' : by === 'category' ? 'hist.noCategory' : 'hist.other')
    return g.label
  }
  // The groups as headers over their rows. A group shows once a row of it is loaded; a folded one shows in its
  // place among them (or at the end once everything is loaded), so paging never shuffles the headers.
  function historyGroups(d, words) {
    const by = d._by
    const rows = new Map()
    for (const s of d.sessions) { const k = s.group || ''; if (!rows.has(k)) rows.set(k, []); rows.get(k).push(s) }
    let last = -1
    d.groups.forEach((g, i) => { if (rows.has(g.key)) last = i })
    const all = !hasMore()
    return d.groups.filter((g, i) => rows.has(g.key) || g.opening || (g.collapsed && (all || i < last))).map((g, i) => {
      const open = !g.collapsed
      const title = groupTitle(by, g)
      const bodyId = 'hg-' + i
      const list = rows.get(g.key) || []
      const btn = h('button', { class: 'group-toggle hist-gtoggle', type: 'button', 'data-key': 'hist-g-' + by + '-' + g.key, 'aria-expanded': String(open), 'aria-controls': open && list.length ? bodyId : null,
        'aria-label': t('group.toggle', { title, count: String(g.sessions), action: t(open ? 'hist.fold' : 'hist.unfoldOne') }), title: by === 'project' && g.key ? g.key : null },
        icon('chevron', 'chev'), by === 'family' && g.key ? badge(g.key, 'sm') : null,
        h('span', { class: 'hist-gtitle' }, title),
        g.opening ? spinner() : h('span', { class: 'group-count' }, String(g.sessions)))
      // patch keeps this button across redraws, so the group is looked up when clicked, never kept from this draw.
      btn.addEventListener('click', () => {
        const cur = hs.data && hs.data._by === by && hs.data.groups.find((x) => x.key === g.key)
        if (cur) toggleHistGroup(by, cur, btn)
      })
      return h('section', { class: 'hist-group' + (open ? '' : ' is-folded'), 'data-key': 'hg-' + by + '-' + g.key, 'aria-label': title, 'data-patch': '' },
        h('div', { class: 'hist-ghead', 'data-key': 'hgh' }, btn),
        open && list.length ? h('div', { class: 'group-list hist-rows', role: 'list', id: bodyId, 'data-key': 'hgr', 'data-patch': '' }, list.map((s) => historyRow(s, words, by === 'project' || Boolean(hs.project)))) : null)
    })
  }
  // Folding eases the group's rows away and drops them from the list at once; the list is then asked again quietly,
  // so the next page starts at the right place. Unfolding asks for the group's rows, with a spinner in its header.
  function toggleHistGroup(by, g, btn) {
    const d = hs.data
    if (!d || d._by !== by) return
    const fold = histFold(by)
    if (g.collapsed) {
      delete fold[g.key]
      savePrefs()
      g.collapsed = false
      g.opening = true
      hs.growing = { by, key: g.key }
      renderHistoryParts()
      loadHistory(false, d.sessions.length + g.sessions, true, { key: g.key, rows: d.sessions })
      return
    }
    if (Object.keys(fold).length >= HIST_FOLD_MAX) delete fold[Object.keys(fold)[0]]
    fold[g.key] = true
    savePrefs()
    const done = () => {
      if (hs.data !== d) return
      d.sessions = d.sessions.filter((s) => (s.group || '') !== g.key)
      d.total = Math.max(0, d.total - g.sessions)
      g.collapsed = true
      renderHistoryParts()
      loadHistory(false, d.sessions.length, true, { rows: d.sessions })
    }
    const sec = btn.closest('.hist-group')
    const body = sec && sec.querySelector('.hist-rows')
    const head = sec && sec.querySelector('.hist-ghead')
    if (!body || !head || !moving()) { done(); return }
    btn.setAttribute('aria-expanded', 'false')
    const from = sec.getBoundingClientRect().height
    const to = head.getBoundingClientRect().height
    sec.style.overflow = 'hidden'
    const a = sec.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: FOLD_MS, easing: EASE, fill: 'forwards' })
    body.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FOLD_MS * 0.7, easing: 'ease-out', fill: 'forwards' })
    a.finished.then(() => {
      body.remove()
      a.cancel()
      sec.style.overflow = ''
      done()
    }, () => {})
  }
  // An opened group grows from its header to its rows once they are drawn, as one motion; its rows do not grow
  // in one by one (125 small motions stutter).
  function growOpened(by, key) {
    const e = hs.els
    const sec = e && e.list.querySelector('.hist-group[data-key="' + CSS.escape('hg-' + by + '-' + key) + '"]')
    const body = sec && sec.querySelector('.hist-rows')
    const head = sec && sec.querySelector('.hist-ghead')
    if (!body || !head || !moving()) return
    for (const x of body.querySelectorAll('.enter')) x.classList.remove('enter')
    const from = head.getBoundingClientRect().height
    const to = sec.getBoundingClientRect().height
    sec.style.overflow = 'hidden'
    const a = sec.animate([{ height: from + 'px' }, { height: to + 'px' }], { duration: FOLD_MS, easing: EASE })
    body.animate([{ opacity: 0 }, { opacity: 1 }], { duration: FOLD_MS, easing: 'ease-out' })
    a.finished.then(() => { sec.style.overflow = '' }, () => {})
  }
  // One list for the row's "…" button and its right-click menu (spec §3.27), in the order of how often each is used.
  // at is the row's own "…" button: a right-click menu opens at a point that is gone once the menu closes.
  function historyItems(at, s) {
    return [
      { icon: 'eye', label: t('hist.open'), run: () => openHistoryView(s, at) },
      { icon: 'terminal', label: t('hist.continue'), run: () => sessCopy(at, s.continueCommand, () => toast(t('hist.copiedContinue'), { key: 'hist-copy' })) },
      '-',
      { icon: 'copy', label: t('spage.copyAi'), run: () => sessCopy(at, s.reference, () => toast(t('spage.copiedToast'))) },
      { icon: 'copy', label: t('spage.copyId'), hint: s.sessionId.slice(0, 8), run: () => sessCopy(at, s.sessionId, () => toast(t('toast.copied', { text: s.sessionId.slice(0, 8) }))) },
    ]
  }
  function historyMenu(anchor, s, at) {
    openMenu(anchor, historyItems(at || anchor, s), t('hist.more', { title: s.title || t('hist.untitled') }))
  }
  // The button itself says it copied; a toast would only repeat it far from where the user looks.
  function copyContinue(btn, s) {
    sessCopy(btn, s.continueCommand, () => {
      toast(t('hist.copiedContinue'), { key: 'hist-copy' })
      btn.classList.add('is-copied')
      setKids(btn, [icon('check'), h('span', null, t('spage.copied'))])
      setTimeout(() => { btn.classList.remove('is-copied'); setKids(btn, [icon('terminal'), h('span', null, t('hist.continueShort'))]) }, 1500)
    })
  }
  // The project name is left out where the group heading or the picked project already says it (noProject).
  function historyRow(s, words, noProject) {
    const title = s.title || t('hist.untitled')
    const k = s.account + '-' + s.sessionId
    const open = h('button', { class: 'hist-open', type: 'button', tabindex: '-1', 'data-key': 'hist-open-' + k, 'aria-label': t('hist.openLabel', { title }) }, highlighted(title, words))
    open.addEventListener('click', () => openHistoryView(s, open))
    const more = h('button', { class: 'icon-btn more', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-key': 'hist-more-' + k, 'aria-label': t('hist.more', { title }), 'data-tip': t('menu.title') }, icon('more'))
    more.addEventListener('click', () => historyMenu(more, s))
    const view = h('button', { class: 'icon-btn hist-view', type: 'button', 'data-key': 'hist-view-' + k, 'aria-label': t('hist.openLabel', { title }), 'data-tip': t('hist.viewShort') }, icon('eye'))
    view.addEventListener('click', () => openHistoryView(s, view))
    const cont = h('button', { class: 'btn btn-sm hist-cont', type: 'button', 'data-key': 'hist-cont-' + k, 'aria-label': t('hist.continueFor', { title }), 'data-tip': t(s.cwdGone ? 'hist.continueGoneTip' : 'hist.continueTip') }, icon('terminal'), h('span', null, t('hist.continueShort')))
    cont.addEventListener('click', () => copyContinue(cont, s))
    const row = h('div', { class: 'hist-row' + (s.live ? ' is-live' : ''), role: 'listitem', 'data-key': 'hr-' + k, 'data-sig': sig([s.continueCommand, s.reference, s.cwd, s.updatedAt, Boolean(noProject)]), 'data-enter': 'h-' + k },
      badge(s.family, 'sm'),
      h('div', { class: 'hist-body' },
        h('div', { class: 'hist-line' }, open,
          s.live ? h('span', { class: 'hist-live', tabindex: '0', 'data-tip': t('hist.liveTip') }, h('span', { class: 'hist-dot', 'aria-hidden': 'true' }), t('hist.live')) : null),
        h('div', { class: 'hist-meta muted small' }, h('div', { class: 'hist-mi-wrap' }, metaItems([
          h('b', null, s.accountLabel),
          s.projectName && !noProject ? h('span', { class: 'hist-pname', title: s.cwd || s.project }, s.projectName) : null,
          s.cwdGone ? h('span', { class: 'chip chip-sm hist-gone', tabindex: '0', 'data-tip': t('hist.goneTip') }, t('hist.gone')) : null,
          s.branch ? h('span', { class: 'mono hist-branch' }, s.branch) : null,
          tn('hist.msgs', s.messages),
          s.children ? h('span', { class: 'chip chip-sm', tabindex: '0', 'data-tip': t('hist.kidsTip') }, tn('hist.kids', s.children)) : null,
          s.script ? h('span', { class: 'chip chip-sm' }, t('hist.script')) : null,
          h('span', { class: 'hist-age', 'data-hage': s.updatedAt, title: fullWhen(s.updatedAt) }, whenText(s.updatedAt)),
        ]))),
        s.snippet && !sameText(s.snippet, s.title) ? h('div', { class: 'hist-snip' }, highlighted(s.snippet, words))
          : s.preview ? h('div', { class: 'hist-snip' }, s.preview) : null),
      h('div', { class: 'sess-actions' }, view, cont, more))
    // A click on the row's empty space reads the conversation too; text being selected stays a selection.
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('button, a, input, .chip, .hist-live') || String(window.getSelection ? window.getSelection() : '')) return
      openHistoryView(s, open)
    })
    return withMenu(row, (a) => historyMenu(a, s, more))
  }
  // Each item carries its own leading dot; the dots of items that start a line fall outside the box and are clipped.
  function metaItems(parts) {
    return parts.filter((p) => p !== null && p !== undefined && p !== false && p !== '').map((p) => h('span', { class: 'hist-mi' }, p))
  }
  function rowsShape(list) {
    return list.map((s) => [s.account, s.sessionId, s.title, s.updatedAt, s.messages, s.children, s.live, s.snippet, s.preview, s.projectName, s.cwdGone, s.branch, s.script])
  }
  // Everything under the toolbar: the count and index state, the rows, the end of the list, tool output and sources.
  function renderHistoryParts() {
    const e = hs.els
    if (!e || !e.root.isConnected) return
    // A row's menu stays open: the redraw waits until it closes (historyTick draws it then).
    if (menu.el && menu.anchor && menu.kind !== 'hist-display' && e.root.contains(menu.returnTo || menu.anchor)) { hs.pending = true; return }
    hs.pending = false
    const d = hs.data
    if (d && d.state !== 'building') hs.indexed = true
    const words = histWords()
    e.list.classList.toggle('is-loading', Boolean(hs.loading && d))
    e.list.classList.toggle('is-long', Boolean(d && d.sessions.length > 60))
    if (hs.loading && d) { if (!e.list.style.minHeight) e.list.style.minHeight = e.list.offsetHeight + 'px' }
    else e.list.style.minHeight = ''
    e.list.setAttribute('aria-busy', hs.loading ? 'true' : 'false')
    drawIf(e.status, JSON.stringify([lang, d ? [d.sessions.length, d.total, d.state, d.progress, d.problems] : null, hs.error ? hs.error.message : '']), () => {
      const out = []
      if (hs.error) out.push(errorNote(hs.error, () => loadHistory()))
      if (!d) return out
      if (d.total) out.push(h('p', { class: 'muted small hist-count' }, tn('hist.shown', d.total, { shown: d.sessions.length })))
      // Only the first build gets the note: a later renewal that reads a few changed files would make the list jump.
      if (d.state === 'building' && !hs.indexed) out.push(h('p', { class: 'note small hist-building' }, spinner(), ' ', d.progress.total ? t('hist.building', { done: d.progress.done, total: d.progress.total }) : t('hist.buildingStart')))
      if (d.state === 'off') out.push(h('p', { class: 'note small' }, t('hist.indexOff')))
      for (const p of d.problems) out.push(h('p', { class: 'note note-warn small' }, p))
      return out
    })
    patchIf(e.list, JSON.stringify([lang, words, d ? rowsShape(d.sessions) : null, d ? [d.total, d.state, d.sources.length, d.sources.reduce((n, x) => n + x.sessions, 0), d._by, d.groups || null, hasMore()] : null, hs.since, hs.tools, hs.project, hs.category, Boolean(hs.error)]), () => {
      if (!d) return hs.error ? [] : h('div', { class: 'group-list', 'aria-busy': 'true' }, [0, 1, 2, 3, 4].map(() => h('div', { class: 'sk-row' }, h('span', { class: 'sk sk-badge' }), h('span', { class: 'sk sk-title' }), h('span', { class: 'sk sk-bar' }))))
      const empty = historyEmpty({ q: hs.q, since: hs.since, state: d.state, total: d.total, tools: hs.tools, project: hs.project || hs.category, accounts: d.sources.length, stored: d.sources.reduce((n, x) => n + x.sessions, 0), unreadable: !!hs.family && d.sources.some((x) => x.family === hs.family) && d.sources.filter((x) => x.family === hs.family).every((x) => x.reason === 'unsupported') })
      // Every match in a folded group: the folded headers are the list.
      if (empty && !(d.groups && d.groups.length)) return h('div', { class: 'empty empty-sm hist-empty' },
        h('p', null, t(empty.key, { q: hs.q })),
        empty.widen || empty.tools || empty.accounts || empty.everywhere ? h('div', { class: 'hist-ways' },
          empty.everywhere ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => pickProject('') }, t('hist.everywhere')) : null,
          empty.accounts ? h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { location.hash = '' } }, t('hist.goAccounts')) : null,
          empty.widen ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { hs.since = 'all'; e.since.value = 'all'; historyChanged(true) } }, t('hist.widen')) : null,
          empty.tools ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { hs.tools = true; e.tools.checked = true; startToolScan() } }, t('hist.tools')) : null) : null)
      if (d.groups && d.groups.length) return historyGroups(d, words)
      return h('div', { class: 'group-list hist-rows', role: 'list', 'data-key': 'hrows', 'data-patch': '' }, d.sessions.map((s) => historyRow(s, words, Boolean(hs.project))))
    })
    if (hs.swap && !hs.loading) {
      hs.swap = false
      for (const x of e.list.querySelectorAll('.enter')) x.classList.remove('enter')
      if (!REDUCED) { e.list.classList.remove('swap-in'); void e.list.offsetWidth; e.list.classList.add('swap-in') }
    }
    drawIf(e.tail, JSON.stringify([lang, hasMore(), hs.more, hs.moreFailed, d ? d.total : 0, hs.since]), () => {
      if (!d || !d.total) return []
      if (hasMore()) return h('button', { class: 'btn btn-sm hist-more', type: 'button', 'data-key': 'hist-more-page', disabled: hs.more, onclick: () => { hs.moreFailed = false; loadHistory(true) } }, hs.more ? [spinner(), ' '] : null, t(hs.moreFailed ? 'hist.retryMore' : 'hist.loadMore'))
      const older = hs.since !== 'all' ? h('button', { class: 'btn btn-sm hist-more', type: 'button', onclick: () => { hs.since = 'all'; e.since.value = 'all'; historyChanged(true) } }, t('hist.older')) : null
      return [d.total > HIST_PAGE ? h('p', { class: 'muted small' }, t('hist.end')) : null, older].filter(Boolean)
    })
    const tool = hs.tool
    drawIf(e.toolBox, JSON.stringify([lang, words, tool ? [tool.key, rowsShape(tool.hits), tool.done, tool.total, tool.finished, tool.error ? tool.error.message : ''] : null, hs.tools, Boolean(hs.q)]), () => {
      if (!hs.tools) return []
      if (!hs.q) return h('p', { class: 'muted small' }, t('hist.toolsNeedWords'))
      if (!tool) return []
      const head = h('div', { class: 'hist-tool-head' },
        h('h3', null, t('hist.toolsHead')),
        tool.finished ? h('span', { class: 'muted small' }, tool.total ? tn('hist.toolsDone', tool.total) : '')
          : h('span', { class: 'muted small hist-tool-prog' }, spinner(), ' ', tool.total ? t('hist.toolsProgress', { done: tool.done, total: tool.total }) : t('hist.toolsStarting')),
        tool.finished ? null : h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { stopToolScan(); renderHistoryParts() } }, t('hist.toolsStop')))
      if (tool.finished && !tool.error && !tool.hits.length) return h('p', { class: 'muted small' }, t('hist.toolsNone'))
      const out = [head]
      if (tool.error) out.push(errorNote(tool.error, () => { hs.tool = null; startToolScan() }))
      if (tool.hits.length) out.push(h('div', { class: 'group-list hist-rows', role: 'list' }, tool.hits.map((s) => historyRow(s, words))))
      else if (tool.finished && !tool.error) out.push(h('p', { class: 'muted small' }, t('hist.toolsNone')))
      return out
    })
    drawIf(e.sources, JSON.stringify([lang, d ? d.sources : null, hs.clearing]), () => {
      if (!d || !d.sources.length) return []
      const sessions = d.sources.reduce((n, x) => n + x.sessions, 0)
      const details = h('details', { class: 'hist-sources', open: hs.srcOpen },
        h('summary', null, t('hist.sources'), h('span', { class: 'muted' }, ' · ' + t('hist.sourcesSum', { accounts: d.sources.length, sessions }))),
        h('table', { class: 'hist-src' },
          h('thead', null, h('tr', null, h('th', null, t('hist.src.account')), h('th', { class: 'num' }, t('hist.src.sessions')), h('th', null, t('hist.src.note')))),
          h('tbody', null, d.sources.map((x) => h('tr', null,
            h('td', null, h('span', { class: 'title-logo' }, badge(x.family, 'sm'), x.accountLabel)),
            h('td', { class: 'num' }, String(x.sessions)),
            h('td', { class: 'muted' }, [x.failed ? tn('hist.src.failed', x.failed) : null, x.note ? (x.failed ? ' · ' : '') + (x.reason && x.reason !== 'unreadable' ? t('hist.src.' + x.reason) : x.note) : null]))))),
        BOOT.readOnly ? null : h('p', { class: 'hist-clear' },
          h('button', { class: 'btn btn-sm', type: 'button', disabled: hs.clearing, 'data-tip': t('hist.clearTip'), onclick: clearHistoryIndex }, hs.clearing ? [spinner(), ' '] : null, t('hist.clear'))))
      details.addEventListener('toggle', () => { hs.srcOpen = details.open })
      return details
    })
  }
  async function clearHistoryIndex() {
    hs.clearing = true
    renderHistoryParts()
    try {
      await api('/api/history/index', { clear: true })
      toast(t('hist.cleared'))
      historyChanged(true)
    } catch (e) { toast(e.message, { kind: 'fail' }) }
    hs.clearing = false
    renderHistoryParts()
  }
  // While History shows: the ages every second, and a renewal while the index is built, then now and then.
  function historyTick() {
    const e = hs.els
    if (!e || !e.root.isConnected) return
    for (const el of e.root.querySelectorAll('[data-hage]')) {
      const text = whenText(el.getAttribute('data-hage'))
      if (el.textContent !== text) el.textContent = text
    }
    if (hs.pending) renderHistoryParts()
    const d = hs.data
    if (!d || hs.loading || hs.more || hs.bg || conn.lost) return
    const every = d.state === 'building' ? HIST_TICK_MS : HIST_IDLE_MS
    // Deep in a long list, a renewal would cut what is loaded; the filters and the search still start it again.
    if (Date.now() - hs.at < every || d.sessions.length > HIST_KEEP) return
    // The project list follows every renewal: a Session coming back into the time range changes its counts
    // without changing the total. It redraws only when what it shows changed.
    Promise.resolve(loadHistory(false, d.sessions.length, true)).then(loadProjects)
  }

  // ---------- reading one past session ----------
  // Read only. The newest 200 messages first, older ones on request; a run of tool calls is one line. The dialog
  // opens once the messages are in, at its final size, scrolled to the end.
  const hv = { data: null, open: {}, loading: false }
  async function openHistoryView(s, btn) {
    if (hv.loading) return
    hv.loading = true
    if (btn) { btn.setAttribute('aria-busy', 'true'); btn.prepend(spinner()) }
    try {
      hv.data = await api('/api/history/show', { id: s.sessionId, account: s.account, lang })
    } catch (e) {
      // A record removed since the list was read: say so plainly and drop it from the list.
      if (e.code === 'session-gone') { toast(t('hist.gonefile'), { kind: 'fail' }); loadHistory(false, hs.data ? hs.data.sessions.length : 0, true) }
      else toast(e.message, { kind: 'fail' })
      return
    } finally {
      hv.loading = false
      if (btn) { btn.removeAttribute('aria-busy'); const sp = btn.querySelector('.spin'); if (sp) sp.remove() }
    }
    hv.open = {}
    ensureDialog()
    renderHistoryView()
    showDialog('history')
    const box = dlg.el.querySelector('.hv-msgs')
    if (box) box.scrollTop = box.scrollHeight
  }
  async function historyEarlier(btn) {
    const d = hv.data
    if (!d || d.before === undefined || hv.loading) return
    hv.loading = true
    btn.disabled = true
    try {
      const r = await api('/api/history/show', {
        id: d.session.sessionId,
        account: d.session.account,
        before: d.before,
        lang,
      })
      const box = dlg.el.querySelector('.hv-msgs')
      const fromEnd = box ? box.scrollHeight - box.scrollTop : 0
      hv.data = Object.assign({}, r, { messages: r.messages.concat(d.messages) })
      if (r.before === undefined) delete hv.data.before
      renderHistoryView()
      const again = dlg.el.querySelector('.hv-msgs')
      if (again) again.scrollTop = again.scrollHeight - fromEnd
    } catch (e) { toast(e.message, { kind: 'fail' }); btn.disabled = false }
    hv.loading = false
  }
  // Markdown in a reply, built as nodes (never as HTML), so a transcript cannot add markup or scripts to the page.
  function mdSpans(text) {
    return mdInline(text).map((x) => x.t === 'text' ? x.text
      : x.t === 'code' ? h('code', null, x.text)
      : x.t === 'b' ? h('strong', null, mdSpans(x.text))
      : x.t === 'i' ? h('em', null, mdSpans(x.text))
      : h('a', { href: x.href, target: '_blank', rel: 'noopener noreferrer' }, x.text))
  }
  function mdNodes(text) {
    const cell = (tag, c, align) => h(tag, { css: align ? { 'text-align': align } : null }, mdSpans(c))
    return mdBlocks(text).map((b) => {
      if (b.type === 'code') return h('pre', { class: 'hv-code' }, h('code', null, b.text))
      if (b.type === 'h') return h('p', { class: 'hv-h' }, mdSpans(b.text))
      if (b.type === 'quote') return h('blockquote', null, mdSpans(b.text))
      if (b.type === 'list') return h(b.ordered ? 'ol' : 'ul', null, b.items.map((it) => h('li', null, mdSpans(it))))
      if (b.type === 'hr') return h('hr', null)
      if (b.type === 'table') return h('div', { class: 'hv-table' }, h('table', null,
        h('thead', null, h('tr', null, b.head.map((c, k) => cell('th', c, b.align[k])))),
        h('tbody', null, b.rows.map((r) => h('tr', null, r.map((c, k) => cell('td', c, b.align[k])))))))
      return h('p', null, mdSpans(b.text))
    })
  }
  function messageBlock(m) {
    if (m.role === 'tools') {
      const names = [...new Set(m.tools)]
      const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '')
      return h('div', { class: 'hv-tools muted small' }, icon('terminal'), h('span', null, t('hv.tools', { tools: shown })))
    }
    const long = m.text.length > HIST_CLIP && !hv.open[m.n]
    const show = long ? m.text.slice(0, HIST_CLIP) + '…' : m.text
    return h('div', { class: 'hv-msg hv-' + m.role },
      h('div', { class: 'hv-who small' }, h('b', null, m.role === 'user' ? t('hv.you') : t('hv.ai')), m.at ? h('span', { class: 'muted', title: fullWhen(m.at) }, whenText(m.at)) : null),
      m.role === 'user' ? h('div', { class: 'hv-text' }, show) : h('div', { class: 'hv-text hv-md' }, mdNodes(show)),
      long ? h('button', { class: 'btn btn-sm btn-ghost hv-all', type: 'button', onclick: () => { hv.open[m.n] = true; const box = dlg.el.querySelector('.hv-msgs'); const top = box ? box.scrollTop : 0; renderHistoryView(); const again = dlg.el.querySelector('.hv-msgs'); if (again) again.scrollTop = top } }, t('hv.showAll')) : null)
  }
  function renderHistoryView() {
    const d = hv.data
    const s = d.session
    const msgs = foldToolCalls(d.messages)
    const earlier = d.before !== undefined ? h('button', { class: 'btn btn-sm hv-earlier', type: 'button' }, t('hv.earlier')) : null
    if (earlier) earlier.addEventListener('click', () => historyEarlier(earlier))
    const body = [
      h('p', { class: 'muted small hv-meta' }, dots([
        h('b', null, s.accountLabel),
        s.projectName ? h('span', { title: s.cwd || s.project }, s.projectName) : null,
        s.cwdGone ? t('hist.gone') : null,
        s.branch ? h('span', { class: 'mono' }, s.branch) : null,
        s.model ? h('span', { class: 'mono' }, s.model) : null,
        tn('hist.msgs', s.messages),
        h('span', { title: fullWhen(s.updatedAt) }, whenText(s.updatedAt)),
      ])),
      h('div', { class: 'hv-msgs', tabindex: '0', 'aria-label': t('hv.messages') },
        earlier || h('p', { class: 'muted small hv-start' }, t('hv.firstShown')),
        msgs.length ? msgs.map(messageBlock) : h('p', { class: 'muted' }, t('hv.empty'))),
      h('p', { class: 'muted small' }, t('hv.readOnly')),
    ]
    const ai = h('button', { class: 'btn', type: 'button' }, icon('copy'), h('span', null, t('spage.copyAi')))
    ai.addEventListener('click', () => sessCopy(ai, s.reference, () => toast(t('spage.copiedToast'))))
    const cont = h('button', { class: 'btn btn-primary', type: 'button', 'data-tip': t(s.cwdGone ? 'hist.continueGoneTip' : 'hist.continueTip') }, icon('terminal'), h('span', null, t('hist.continue')))
    cont.addEventListener('click', () => copyContinue(cont, s))
    setKids(dlg.el, dialogFrame(s.title || t('hist.untitled'), s.family, body, [ai, cont]))
  }

  // ---------- send to a session (spec §3.32 step 2) ----------
  // "Send to it": a few words and up to 5 screenshots for one Live Session. The text box is made once per opening and
  // kept across every redraw of the dialog, so a language switch keeps what is typed; the Sessions list renewing behind
  // it never touches the dialog. Screenshots upload at once, images only, so a refusal is named right away.
  let sd = null
  const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl+'
  function sendName(s) { const p = sessionLabelParts(s); return p.title ? p.account + ' · ' + p.title : p.account }
  function openSend(s) {
    if (BOOT.readOnly) return
    closeMenu()
    const text = h('textarea', { id: 'sd-text', class: 'ask-text', rows: '4', maxlength: '8000', placeholder: t('send.ph'), 'aria-label': t('send.textLabel'), 'aria-describedby': 'sd-keys' })
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); sendNow() } })
    text.addEventListener('input', () => { if (sd && sd.empty) { sd.empty = false; renderSend() } })
    sd = { s, files: [], notes: [], busy: false, empty: false, result: null, error: null, els: { text, files: h('div', { class: 'ask-files-wrap' }) } }
    showDialog('send')
    hookDrops()
    const mine = sd
    dlg.onClose = () => {
      mine.files.forEach((f) => { if (f.xhr) f.xhr.abort() })
      // Screenshots never sent are freed now; the server clears any that are left after a day anyway.
      const ids = mine.files.filter((f) => f.id && !f.sent).map((f) => f.id)
      if (ids.length) api('/api/ask/attach/remove', { ids }).catch(() => {})
      if (sd === mine) sd = null
    }
    renderSend()
    text.focus()
  }
  function renderSend() {
    if (!sd || dlg.kind !== 'send') return
    const el = dlg.el
    const name = sendName(sd.s)
    const focused = document.activeElement === sd.els.text
    const body = []
    const foot = []
    if (sd.result) {
      body.push(sendResult(name))
      foot.push(h('button', { class: 'btn', type: 'button', onclick: sendAgain }, t('send.again')))
      // When a line waits to be pasted, "Copy this line" is the one primary action.
      const v = sendResultView(sd.result.message, Boolean(sd.result.orca))
      const paste = ((v.kind === 'paste' || v.kind === 'stored') && v.pasteText) || (v.kind === 'approve' && !BOOT.readOnly)
      foot.push(h('button', { class: paste ? 'btn' : 'btn btn-primary', type: 'button', onclick: () => el.close() }, t('btn.close')))
    } else {
      const uploading = sd.files.some((f) => f.status === 'uploading')
      body.push(h('p', { class: 'muted small' }, t('send.intro')))
      body.push(h('div', { class: 'field' }, sd.els.text,
        sd.empty ? h('p', { class: 'field-error', role: 'status' }, t('send.empty')) : h('p', { class: 'small muted', id: 'sd-keys' }, t('send.keys', { keys: MOD_KEY + 'Enter' }))))
      body.push(sendAttachField())
      if (sd.error) body.push(errorNote(sd.error, sd.error.retryable ? sendNow : null))
      foot.push(h('button', { class: 'btn', type: 'button', disabled: sd.busy, onclick: () => el.close() }, t('btn.cancel')))
      foot.push(h('button', { class: 'btn btn-primary send-go', type: 'button', disabled: sd.busy, 'aria-busy': sd.busy ? 'true' : null, onclick: sendNow },
        sd.busy ? spinner() : icon('send'), t(sd.busy ? (uploading ? 'send.waiting' : 'send.sending') : 'send.send')))
    }
    setKids(el, dialogFrame(t('send.title', { name }), sd.s.family, body, foot))
    if (focused) sd.els.text.focus()
  }
  function sendAttachField() {
    const input = h('input', { type: 'file', multiple: true, accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true' })
    input.addEventListener('change', () => { sendAddFiles(Array.from(input.files || [])); input.value = '' })
    renderSendFiles()
    return h('div', { class: 'field ask-attach' },
      h('div', { class: 'ask-attach-row' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: sd.busy, onclick: () => input.click() }, icon('image'), t('send.attach')),
        h('span', { class: 'small muted' }, t('send.attachHint', { keys: MOD_KEY + 'V' })), input),
      sd.els.files)
  }
  function renderSendFiles() {
    const box = sd && sd.els.files
    if (!box) return
    const tiles = sd.files.map((f) => {
      let face
      if (f.status === 'uploading') face = h('div', { class: 'ask-file-face' }, spinner())
      else if (f.status === 'error') face = h('div', { class: 'ask-file-face' }, icon('alert'))
      else if (f.thumb) face = h('img', { class: 'ask-file-img', src: f.thumb, alt: f.name })
      else face = h('div', { class: 'ask-file-face' }, icon('image'))
      return h('li', { class: 'ask-file' + (f.status === 'error' ? ' is-error' : ''), 'data-enter': 'sd-' + f.key },
        face,
        h('span', { class: 'ask-file-name small', title: f.name }, f.name),
        h('span', { class: 'small muted' }, fileSize(f.bytes || f.size)),
        f.status === 'error' && f.file ? h('button', { class: 'icon-btn ask-file-retry', type: 'button', disabled: sd.busy, 'aria-label': t('send.retry', { name: f.name }), 'data-tip': t('send.retry', { name: f.name }), onclick: () => sendRetryFile(f) }, icon('refresh')) : null,
        h('button', { class: 'icon-btn ask-file-x', type: 'button', disabled: sd.busy, 'aria-label': t('send.remove', { name: f.name }), onclick: () => sendRemoveFile(f) }, icon('x')))
    })
    swapKids(box, [
      tiles.length ? h('ul', { class: 'ask-files', 'aria-label': t('send.attach') }, tiles) : null,
      sd.files.filter((f) => f.status === 'error').map((f) => h('p', { class: 'field-error' }, f.error)),
      sd.notes.map((n) => h('p', { class: 'field-error' }, n)),
    ])
  }
  function sendAddFiles(list) {
    if (!sd || sd.result || sd.busy || !list.length) return
    sd.notes = []
    for (const file of list) {
      const name = file.name || 'image'
      // A screenshot whose upload broke still holds its place, as it can go up again.
      const why = sendFileProblem(file, sd.files.filter((f) => f.status !== 'error' || f.file).length)
      if (why === 'send.max') { sd.notes.push(t(why, { name })); continue }
      const f = { key: Math.random().toString(36).slice(2), name, size: file.size, bytes: 0, status: why ? 'error' : 'uploading', id: null, thumb: null, error: why ? t(why, { name }) : '', xhr: null, done: null, sent: false }
      sd.files.push(f)
      if (!why) f.done = sendUpload(f, file, sd)
    }
    renderSendFiles()
  }
  // A screenshot whose upload broke (not one refused for its type or size) can go up again as it is.
  function sendRetryFile(f) {
    if (!sd || sd.busy || !f.file) return
    const file = f.file
    Object.assign(f, { status: 'uploading', error: '', file: null })
    if (sd.error && sd.error.blocked) sd.error = null
    f.done = sendUpload(f, file, sd)
    renderSend()
  }
  function sendRemoveFile(f) {
    if (f.xhr) f.xhr.abort()
    if (f.id) api('/api/ask/attach/remove', { ids: [f.id] }).catch(() => {})
    sd.files = sd.files.filter((x) => x !== f)
    sd.notes = []
    // The note that held the send back goes once nothing failed is left.
    if (sd.error && sd.error.blocked && !sendBlock(sd.files)) { sd.error = null; renderSend() } else renderSendFiles()
  }
  async function sendUpload(f, file, mine) {
    const path = '/api/sessions/attach'
    let r = await askPost(file, () => {}, (x) => { f.xhr = x }, path)
    if (r.status === 403 && r.data && r.data.code === 'bad-token') {
      try { await refreshToken(); r = await askPost(file, () => {}, (x) => { f.xhr = x }, path) } catch {}
    }
    f.xhr = null
    if (r.status === -1 || sd !== mine) return
    if (r.status === 200 && r.data && r.data.id) {
      f.id = r.data.id
      f.bytes = r.data.bytes
      f.thumb = await thumbnail(file)
      f.status = 'ready'
    } else {
      f.status = 'error'
      f.error = t(r.status === 413 ? 'send.tooBig' : r.status === 415 ? 'send.notImage' : r.status === 507 ? 'send.full' : 'send.failed', { name: f.name })
      // Kept for "try again" only when sending the same file again can work.
      if (r.status !== 413 && r.status !== 415) f.file = file
    }
    if (sd === mine && dlg.kind === 'send') renderSendFiles()
  }
  async function sendNow() {
    if (!sd || sd.busy || sd.result) return
    const mine = sd
    const text = sd.els.text.value.trim()
    if (!text && !sd.files.length) { sd.empty = true; renderSend(); sd.els.text.focus(); return }
    sd.busy = true
    sd.error = null
    dlg.busy = true
    renderSend()
    try {
      // A screenshot that already failed stops the send at once; then it waits for the ones still uploading, so the
      // message carries every one the person added, and checks again.
      const early = sendBlock(mine.files)
      if (early) throw Object.assign(new Error(t(early.key, { names: early.names })), { blocked: true })
      const pending = sd.files.filter((f) => f.status === 'uploading' && f.done).map((f) => f.done)
      if (pending.length) { await Promise.all(pending); if (sd === mine) renderSend() }
      // A screenshot that failed stops the send: the text and the failed tiles stay for a retry or a removal.
      const block = sendBlock(mine.files)
      if (block) throw Object.assign(new Error(t(block.key, { names: block.names })), { blocked: true })
      const ready = mine.files.filter((f) => f.status === 'ready')
      if (!text && !ready.length) throw new Error(t('send.empty'))
      const r = await api('/api/sessions/send', { sessionId: mine.s.sessionId, text, attachments: ready.map((f) => f.id), lang })
      ready.forEach((f) => { f.sent = true })
      mine.result = r
      ownMessage(mine.s.sessionId, { id: r.message.id, status: r.message.status, sentAt: r.message.sentAt, to: r.message.to, ...(r.message.status === 'paste-needed' ? { pasteText: r.message.pasteText } : {}), ...(r.message.note ? { note: r.message.note } : {}) })
      renderSessionsPage()
    } catch (e) { mine.error = e }
    dlg.busy = false
    mine.busy = false
    if (sd === mine) renderSend()
  }
  // A newer answer about the Message the dialog shows (it was read) shows there too.
  function sendSeen() {
    if (!sd || !sd.result || dlg.kind !== 'send') return
    const m = sd.result.message
    const now = sp.msgs[sd.s.sessionId]
    if (now && now.id === m.id && (now.status !== m.status || Boolean(now.needsApproval) !== Boolean(m.needsApproval))) { m.status = now.status; m.needsApproval = now.needsApproval; m.note = now.note; renderSend() }
  }
  function sendResult(name) {
    const r = sd.result
    const v = sendResultView(r.message, Boolean(r.orca))
    const out = []
    if (v.kind === 'done') out.push(h('div', { class: 'note note-ok', role: 'status' }, icon('tick'), h('span', null, t(v.key, { name }))))
    else out.push(h('div', { class: 'note' + (v.kind === 'paste' || v.kind === 'approve' ? ' note-warn' : ''), role: 'status' }, h('b', null, t(v.key, { name })), v.reason ? h('span', { class: 'note-line' }, v.reason) : null))
    if (v.hint) out.push(h('p', { class: 'note note-warn small' }, v.hint))
    if (v.kind === 'approve' && !BOOT.readOnly)
      out.push(h('div', { class: 'pop-actions' }, h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: openInbound }, t('inb.go'))))
    if ((v.kind === 'paste' || v.kind === 'stored') && v.pasteText) {
      const copy = h('button', { class: 'btn btn-sm btn-primary', type: 'button' }, icon('copy'), t('send.copyLine'))
      copy.addEventListener('click', () => sessCopy(copy, v.pasteText, () => toast(t('send.copied', { name }))))
      out.push(h('div', { class: 'send-line' }, h('code', { class: 'send-line-text' }, v.pasteText),
        h('div', { class: 'send-line-actions' }, copy,
          v.jump ? h('button', { class: 'btn btn-sm', type: 'button', onclick: () => jumpToOrca(sd.s) }, icon('link'), t('send.jump')) : null)))
    }
    return out
  }
  function sendAgain() {
    if (!sd) return
    sd.result = null
    sd.error = null
    sd.files = []
    sd.notes = []
    sd.els.text.value = ''
    renderSend()
    sd.els.text.focus()
  }

  // New account. The form is built once per opening so typing keeps focus; only its derived parts re-render.
  let nf = null
  function familyStatus(f) {
    if (f.mainOnly) return 'main-only'
    const hasMain = S.state && S.state.accounts.some((a) => a.family === f.id && a.isMain)
    if (hasMain) return 'ready'
    return f.installed ? 'no-main' : 'missing'
  }
  function openCreate(prefill) {
    if (BOOT.readOnly || !S.state) return
    const fams = S.state.families.slice().sort((x, y) => {
      const rank = (f) => ({ ready: 0, 'no-main': 1, missing: 2, 'main-only': 3 })[familyStatus(f)]
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
      const sub = st === 'ready' ? tn('nf.accounts', n) : st === 'main-only' ? t('nf.mainOnly') : st === 'no-main' ? tx('nf.runOnce', { bin: h('code', null, f.bin) }) : t(f.brokenBin ? 'nf.broken' : 'nf.notInstalled')
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
        failed.map((s) => h('span', { class: 'small' }, s.item + colon() + (s.message || 'failed'))),
        r.hookErrors.map((e) => h('span', { class: 'small' }, 'plugin ' + e.plugin + colon() + e.message))) : null,
      r.account.dir ? h('p', { class: 'small' }, h('span', { class: 'muted' }, t('nf.dir') + ' '), h('code', null, r.account.dir)) : null,
      r.alias && r.alias.added ? h('div', { class: 'small created-alias' }, h('span', { class: 'muted' }, t('nf.alias') + ' '), codeCopy(r.alias.name), h('span', { class: 'muted' }, ' ' + t('nf.aliasNewShell'))) : null,
      r.alias && r.alias.added ? shellSetupNote() : null,
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
    return { auto: s.auto, sameFamily: s.sameFamily, prepareAt: s.prepareAt, threshold: s.threshold, wait: s.waitIfResetWithinMinutes, countdown: s.countdownSeconds, orders, crossOrganization: s.crossOrganization.slice() }
  }
  // "Let AI tune it" (spec §3.29): the AI gets the facts of sideby handoff status --json, as far as the page has them.
  function askHandoff() {
    const st = ahState()
    if (!st) return
    const status = ah && ah.status ? ah.status : null
    openAsk({ task: 'handoff', context: { handoff: handoffTaskFacts(st.settings, st.starters, S.state.accounts, Date.now(), status), version: BOOT.version } })
  }
  // focus: the field a rule's "Change…" is about, so the dialog opens at it.
  async function openHandoff(focus) {
    if (!ahState()) return
    ah = { form: handoffForm(), loading: true }
    showDialog('handoff')
    renderHandoff()
    const field = typeof focus === 'string' ? document.getElementById('ah-' + focus) : null
    if (field) field.focus()
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
  // Accounts that may take over although signed in to another organization (config handoff.crossOrganization).
  function ahCrossOrganization() {
    const list = ah.form.crossOrganization
    const accounts = S.state.accounts.filter((a) => a.kind !== 'api')
    if (!accounts.length) return null
    return h('details', { class: 'ah-fam', open: list.length > 0 },
      h('summary', null, h('b', null, t('ah.crossOrg'))),
      h('p', { class: 'muted small' }, t('ah.crossOrgHint')),
      h('div', { class: 'ah-cross' }, accounts.map((a) => {
        const input = h('input', { type: 'checkbox', disabled: BOOT.readOnly })
        input.checked = list.includes(a.ref) || (a.aliases || []).some((n) => list.includes(n))
        input.addEventListener('change', () => ahEdit((f) => {
          f.crossOrganization = f.crossOrganization.filter((r) => r !== a.ref && !(a.aliases || []).includes(r))
          if (input.checked) f.crossOrganization.push(a.ref)
        }))
        return h('label', { class: 'check' }, input, h('span', { class: 'title-logo' }, badge(a.family, 'sm'), h('span', { class: 'mono' }, accountLabel(a.ref))))
      })))
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
    body.push(ahCrossOrganization())
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
      // The Handoff Rules behind the dialog show the new settings too.
      if (curPage === 'handoff') loadHandoffPage()
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
      const out = label + colon() + v.value + ' (' + modelFrom(a, v.from) + ')'
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
    return h('button', { class: 'mono model-btn' + (mi.model && mi.model.from === 'sideby' ? ' model-set' : ''), type: 'button', title, 'aria-label': t('menu.model') + ' ' + a.ref + colon() + text, onclick: (e) => { e.stopPropagation(); openModel(a) } }, text)
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
      h('div', null, h('span', { class: 'muted' }, t('md.model') + colon()), now('model')),
      h('div', null, h('span', { class: 'muted' }, t('md.effort') + colon()), now('effort'))))
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
  const hp = { data: null, plan: null, loading: false, error: null, preview: null, previewing: false, applying: false, failed: null, changed: false, busyOff: false, askSame: false, askApi: false }
  async function loadHandoffPage() {
    // One read at a time: a second refresh while one runs would end its spinner early.
    if (hp.loading) return
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
  // The Handoff Rules on this page write each setting as it is switched, so turning on keeps whatever is set.
  function hpBody() { return {} }
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
      const out = enableOutcome(r)
      hp.changed = out.kind === 'changed'
      if (out.kind === 'changed' || out.kind === 'blocked') hp.preview = out.plan
      else if (out.kind === 'failed') hp.failed = { step: out.step, plan: out.plan }
      else { hp.preview = null; toast(t('toast.ahOn')) }
      await load({ silent: true })
      await loadHandoffPage()
    } catch (e) { hp.failed = { error: e } }
    hp.applying = false
    renderHandoffPage()
  }
  // Every change on this page applies at once and its toast carries the undo (spec §3.17 "接力规则").
  async function hpChange(change, message, opts) {
    hp.busyOff = true
    renderHandoffPage()
    try {
      const { undo } = await saveHandoffChange(api, change, opts)
      hp.preview = null
      hp.askSame = false
      hp.askApi = false
      toast(message, undo ? { action: { label: t('toast.undo'), run: () => hpChange(undo, t('hp.undone'), { noUndo: true }) }, duration: 12000 } : undefined)
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
    return plan.manual.map((m) => h('p', { class: 'note' }, m.id === 'codex-trust' ? t('hp.manual.codexTrust') : (family(m.family).title + colon() + (m.message || ''))))
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
    if (d.kind === 'pick') return starts.includes('quota') ? t('hp.goesTo', { to: accountLabel(d.ref) }) : t('hp.goesToLimit', { to: accountLabel(d.ref) })
    if (d.kind === 'wait') return t('hp.waits', { at: clock(d.until) })
    return d.earliestReset ? t('hp.noneBack', { ref: accountLabel(d.earliestReset.ref), at: clock(d.earliestReset.at) }) : t('hp.none')
  }
  function hpRows(d) {
    if (!d.takeover.length) return h('p', { class: 'muted small' }, t('hp.noAccounts'))
    return h('ul', { class: 'hp-rows' }, d.takeover.map((r) => {
      const a = S.state.accounts.find((x) => x.ref === r.ref)
      const p = a ? quotaPressure(a, Date.now()) : -1
      return h('li', null,
        // A hidden Account can still take over (spec §3.25): the mark says why it is here though the list leaves it out.
        h('span', { class: 'title-logo' }, badge(r.family, 'sm'), h('span', { class: 'mono' }, accountLabel(r.ref)), hiddenMark(Boolean(a && isHidden(a)))),
        h('span', { class: 'muted num' }, p >= 0 ? t('hp.used', { p: Math.round(p) }) : t('hp.noQuota')),
        h('span', { class: r.decision.kind === 'none' ? 'muted' : null }, hpDecision(r.decision, r.starts)))
    }))
  }
  function hpRecent(d) {
    if (!d.recent.length) return h('p', { class: 'muted small' }, t('hp.noneYet'))
    return h('ul', { class: 'hp-rows hp-recent' }, d.recent.map((r) => h('li', null,
      h('span', { class: 'mono' }, accountLabel(r.from) + ' → ' + accountLabel(r.to)),
      h('span', { class: 'muted num' }, clock(r.at) + ' · ' + ago(r.at)),
      h('span', { class: 'muted' }, r.trigger ? t('hp.why.' + r.trigger) : ''))))
  }
  // ---- Handoff Rules (spec §3.17 "接力规则"): every rule in effect, each next to the switch that changes it ----
  function hpRuleText(r) {
    const p = r.params
    const thr = ahState().settings.threshold
    switch (r.id) {
      case 'when': return p.adaptive ? t('hp.rule.whenAdaptive', { prepare: p.prepareAt, p: p.threshold, max: p.max }) : t('hp.rule.when', { prepare: p.prepareAt, p: p.threshold })
      case 'windows': return t('hp.rule.windows')
      case 'takeover': return t('hp.rule.takeover', { limit: p.limit, p: thr })
      case 'wait': return p.minutes > 0 ? t('hp.rule.wait', { w: p.minutes }) : t('hp.rule.noWait')
      case 'sameFamily': return t(p.on ? 'hp.rule.sameOn' : 'hp.rule.sameOff')
      case 'otherFamilies': return p.on ? t('hp.rule.otherOn') : t('hp.rule.otherOff')
      case 'api': return t(p.on ? 'hp.rule.apiOn' : 'hp.rule.apiOff')
      case 'organization': return p.allowed.length ? t('hp.rule.orgExcept', { refs: p.allowed.map(accountLabel).join(', ') }) : t('hp.rule.org')
      case 'order': return t('hp.rule.order', { host: family(p.family).title, order: p.order.map(accountLabel).join(' → ') })
      case 'countdown': return p.seconds > 0 ? t('hp.rule.countdown', { s: p.seconds }) : t('hp.rule.noCountdown')
    }
    return r.text
  }
  // An on/off pair like Remote Control's; onPick(true|false) runs only when the side changes.
  function hpSwitch(key, label, on, onPick) {
    return h('div', { class: 'seg', role: 'group', 'aria-label': label }, [true, false].map((v) =>
      h('button', { class: 'seg-btn', type: 'button', 'data-key': key + ':' + v, disabled: BOOT.readOnly || hp.busyOff, 'aria-pressed': String(on === v), onclick: () => { if (on !== v) onPick(v) } }, t(v ? 'hp.on' : 'hp.off'))))
  }
  function hpEditBtn(key) {
    const field = { when: 'prepareAt', wait: 'wait', countdown: 'countdown' }[key]
    return h('button', { class: 'link-btn', type: 'button', 'data-key': 'edit:' + key, onclick: () => openHandoff(field) }, t('hp.edit'))
  }
  function hpConfirm(key, warn, cancel, confirmLabel, run) {
    return h('div', { class: 'ah-fam hp-confirm', 'data-enter': key },
      h('p', { class: 'note note-warn' }, warn),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', disabled: hp.busyOff, onclick: cancel }, t('btn.cancel')),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-key': 'confirm:' + key, disabled: BOOT.readOnly || hp.busyOff, onclick: run }, confirmLabel)))
  }
  // The AIs in the order they take over; ↑↓ write familyOrder at once.
  function hpAiOrder(order) {
    const move = (i, d) => { const l = order.slice(); const x = l[i]; l[i] = l[i + d]; l[i + d] = x; hpChange({ familyOrder: l }, t('hp.aiOrderSaved')) }
    return h('ol', { class: 'ah-order hp-ai-order' }, order.map((f, i) => h('li', null,
      h('span', { class: 'title-logo' }, badge(f, 'sm'), (i + 1) + '. ' + family(f).title),
      h('button', { class: 'btn btn-sm', type: 'button', 'data-key': 'up:' + f, disabled: BOOT.readOnly || hp.busyOff || i === 0, 'aria-label': t('ah.up'), onclick: () => move(i, -1) }, '↑'),
      h('button', { class: 'btn btn-sm', type: 'button', 'data-key': 'down:' + f, disabled: BOOT.readOnly || hp.busyOff || i === order.length - 1, 'aria-label': t('ah.down'), onclick: () => move(i, 1) }, '↓'))))
  }
  // ctl sits right of the rule's text; below takes the full width under it (a sub-switch, a confirmation, the AI order).
  function hpRuleControls(r) {
    const p = r.params
    switch (r.id) {
      case 'when': return { ctl: [hpEditBtn('when')], below: [h('div', { class: 'hp-rule-sub' }, h('span', { class: 'muted small' }, t('hp.adaptive')),
        hpSwitch('adaptive', t('hp.adaptive'), p.adaptive, (v) => hpChange({ adaptive: v }, t(v ? 'hp.adaptiveOn' : 'hp.adaptiveOff'))))] }
      case 'wait': case 'countdown': case 'order': case 'organization': return { ctl: [hpEditBtn(r.id)], below: [] }
      case 'sameFamily': return { ctl: [hpSwitch('same', t('hp.sameFamily'), p.on, (v) => {
        if (v) { hp.askSame = true; renderHandoffPage() } else hpChange({ sameFamily: false }, t('hp.sameOff'))
      })], below: [hp.askSame && !p.on ? hpConfirm('same', t('ah.sameFamilyWarn'), () => { hp.askSame = false; renderHandoffPage() }, t('hp.sameConfirm'), () => hpChange({ sameFamily: true }, t('hp.sameOn'))) : null] }
      case 'otherFamilies': return { ctl: [hpSwitch('other', t('hp.otherFamilies'), p.on, (v) => hpChange({ otherFamilies: v }, t(v ? 'hp.otherOn' : 'hp.otherOff')))],
        below: [p.on && p.order.length > 1 ? hpAiOrder(p.order) : null] }
      case 'api': return { ctl: [hpSwitch('api', t('hp.api'), p.on, (v) => {
        if (v) { hp.askApi = true; renderHandoffPage() } else hpChange({ api: false }, t('hp.apiOff'))
      })], below: [!p.accounts ? h('p', { class: 'muted small' }, t('hp.noApi')) : null,
        hp.askApi && !p.on ? hpConfirm('api', t('hp.apiWarn'), () => { hp.askApi = false; renderHandoffPage() }, t('hp.apiConfirm'), () => hpChange({ api: true }, t('hp.apiOn'))) : null] }
    }
    return { ctl: [], below: [] }
  }
  function hpRules(d) {
    if (!d || !d.rules) return null
    return [h('div', { class: 'page-sec-head' }, h('h3', { class: 'page-sec' }, t('hp.rules')),
      h('p', { class: 'muted small' }, t('hp.rulesNote'))),
      h('ol', { class: 'hp-rules' }, d.rules.map((r) => {
        const c = hpRuleControls(r)
        return h('li', { 'data-rule': r.id },
          h('div', { class: 'hp-rule-text' }, hpRuleText(r)),
          h('div', { class: 'hp-rule-ctl' }, c.ctl),
          ...c.below.filter(Boolean).map((el) => h('div', { class: 'hp-rule-below' }, el)))
      }))]
  }
  // When no account could take over anywhere, say which switch opens the way instead of leaving a dead end.
  function hpNoneHint(d) {
    if (!d.takeover.length || d.takeover.some((r) => r.decision.kind !== 'none')) return null
    const st = ahState().settings
    return st.sameFamily && st.otherFamilies ? null : h('p', { class: 'note', 'data-enter': 'none-hint' }, t('hp.noneAll'))
  }
  // Up to ADR-0046 API accounts took over by themselves; this asks once, where Auto Handoff is on.
  function hpApiBanner() {
    const st = ahState()
    if (!st || !st.apiUndecided || BOOT.readOnly) return null
    return h('div', { class: 'banner banner-warn', role: 'status', 'data-enter': 'api-banner' },
      h('div', null, h('b', null, t('hp.apiAskTitle') + ' '), t('hp.apiAskBody')),
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: hp.busyOff, onclick: () => hpChange({ api: false }, t('hp.apiKeptOff')) }, t('hp.apiKeepOff')),
        h('button', { class: 'btn btn-sm', type: 'button', disabled: hp.busyOff, onclick: () => hpChange({ api: true }, t('hp.apiOn')) }, t('hp.apiKeepOn'))))
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
        h('button', { class: 'link-btn small', type: 'button', onclick: () => openHandoff() }, t('hp.advanced')),
        hp.loading ? spinner() : null))]
    const on = st.settings.auto
    if (hp.loading && !hp.data) kids.push(h('p', { class: 'muted' }, spinner(), ' ', t('hp.loading')))
    if (hp.error) kids.push(errorNote(hp.error, loadHandoffPage))
    if (BOOT.readOnly) kids.push(h('p', { class: 'note' }, t('banner.readOnly')))
    const d = hp.data
    // One status card on top: whether it is on, what that means, and the one action that changes it.
    const status = (text, action) => h('div', { class: 'hp-status' + (on ? ' is-on' : '') },
      h('span', { class: 'hp-status-ic' }, icon('swap')),
      h('div', { class: 'hp-status-text' }, h('b', null, on ? t('hp.statusOn') : t('hp.statusOff')), h('p', { class: 'muted' }, text)),
      action)
    if (!on) {
      const starters = S.state.accounts.some((a) => a.kind !== 'api' && st.starters.includes(a.family))
      kids.push(status(t('hp.intro'), starters && !hp.preview ? h('button', { class: 'btn btn-primary', type: 'button', 'data-key': 'turn-on', disabled: BOOT.readOnly || hp.previewing, 'aria-busy': hp.previewing ? 'true' : null, onclick: hpPreview }, hp.previewing ? spinner() : null, t('hp.turnOn')) : null))
      if (!starters) kids.push(h('p', { class: 'note' }, t('hp.noStarters')))
      else if (hp.preview) kids.push(hpPreviewCard())
      kids.push(hpRules(d))
      if (d && d.takeover.length) kids.push(h('h3', { class: 'page-sec' }, t('hp.takeoverIf')), hpRows(d), hpNoneHint(d))
    } else {
      kids.push(status(t('hp.onNote'),
        h('button', { class: 'btn', type: 'button', 'data-key': 'turn-off', disabled: BOOT.readOnly || hp.busyOff, onclick: () => hpChange({ auto: false }, t('toast.ahOff')) }, t('hp.turnOff'))))
      if (d) {
        kids.push(h('h3', { class: 'page-sec' }, t('hp.takeover')), hpRows(d), hpNoneHint(d))
        kids.push(...(hpRules(d) || []))
        kids.push(h('h3', { class: 'page-sec' }, t('hp.recent')), hpRecent(d))
      }
      const plan = hp.plan
      if (plan && (plan.blocked || plan.steps.length)) {
        kids.push(h('h3', { class: 'page-sec' }, t('hp.missing')))
        if (!hp.preview) {
          if (plan.blocked) kids.push(h('p', { class: 'note note-fail' }, t('hp.blocked', { why: plan.blocked })), codeCopy('npm i -g sideby'))
          else {
            kids.push(hpSteps(plan))
            kids.push(h('div', { class: 'row-actions' }, h('button', { class: 'btn btn-primary', type: 'button', disabled: BOOT.readOnly || hp.previewing, onclick: hpPreview }, hp.previewing ? spinner() : null, t('hp.complete'))))
          }
        } else kids.push(hpPreviewCard())
      } else if (plan) kids.push(...hpManual(plan))
      kids.push(h('p', { class: 'muted small' }, t('hp.onlySideby')))
    }
    kids.push(hpFailed())
    swapKids(box, kids)
  }

  // ---------- Remote Control (spec §3.22) ----------
  // Shown while some Claude settings file turns Remote Control on. "Turn all off" first lists each file, the change
  // and the accounts it reaches, in the banner itself; the toast after it carries the undo.
  // target: the side the dialog's switch was moved to, waiting for its confirmation; null while nothing is chosen.
  const rc = { confirm: false, busy: false, target: null }
  const shortRef = (ref) => ref.replace(/^claude:/, '')
  // One settings key's change: the key and literal values in the code font, "not set" in words.
  function keyChange(key, from, to) {
    const val = (v) => (v === null ? t('rc.notSet') : h('code', null, v))
    return h('span', { class: 'key-change' }, h('code', null, key), ' ', val(from), ' → ', val(to))
  }
  function remoteControlBanner() {
    const groups = S.state.remoteControl || []
    // API Accounts never sign in to claude.ai, so Remote Control cannot reach their sessions.
    const api = new Set(S.state.accounts.filter((a) => a.kind === 'api').map((a) => a.ref))
    const refs = groups.filter((g) => g.state === 'on').flatMap((g) => g.accounts).filter((r) => !api.has(r)).map(shortRef)
    if (!refs.length || prefs.rcHide) return null
    const todo = remoteControlTodo(groups, 'off')
    const text = h('div', null, h('b', null, t('rc.title') + ' '), tn('rc.body', refs.length, { refs: refs.join(', ') }))
    if (BOOT.readOnly) return h('div', { class: 'banner banner-warn', role: 'status' }, h('div', null, text, ' ', t('rc.readOnly')))
    if (!rc.confirm)
      return h('div', { class: 'banner banner-warn', role: 'status' }, text,
        h('div', { class: 'banner-actions' },
          h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => { rc.confirm = true; renderBanners() } }, t('rc.turnOff')),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => { prefs.rcHide = true; savePrefs(); renderBanners(); toast(t('rc.hidden')) } }, t('rc.keep'))))
    const lines = todo.map((g) => h('li', null, h('code', null, g.file), ' ',
      keyChange('remoteControlAtStartup', g.state === 'on' ? 'true' : null, 'false'), ' ',
      h('span', { class: 'muted' }, t('rc.usedBy', { refs: g.accounts.map(shortRef).join(', ') }))))
    // Files sideby cannot change stay listed, as in the dialog, so "all" never hides one.
    for (const g of groups.filter((g) => g.state === 'blocked' || g.state === 'missing'))
      lines.push(h('li', null, h('code', null, g.file), ' ',
        h('span', { class: 'chip chip-sm' + (g.state === 'blocked' ? ' chip-fail' : '') }, t('rc.state.' + g.state)), ' ',
        h('span', { class: 'muted' }, t('rc.usedBy', { refs: g.accounts.map(shortRef).join(', ') })),
        g.reason ? h('div', { class: 'muted small' }, t('rc.skipped') + (g.why ? t('settings.why.' + g.why) : g.reason)) : null))
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
      const files = remoteControlTodo(S.state.remoteControl || [], to).map((g) => g.file)
      const r = await api('/api/remote-control/' + to, { confirm: true, files })
      if (r.changedSince) toast(t('as.changedSince'), { kind: 'fail' })
      else if (r.ok) {
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
      const r = await api('/api/remote-control/undo', { confirm: true })
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
    // The page in view reads again too, so the pages need no refresh button of their own.
    if (curPage === 'sessions') loadSessions()
    else if (curPage === 'tuning') loadTuningPage()
    else if (curPage === 'handoff') loadHandoffPage()
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
    if (S.state && S.state.network) out.push('net')
    return out
  }
  function renderSettingsButton() {
    const b = $('settings')
    const secs = settingsSections()
    b.hidden = !secs.length
    const warn = secs.includes('rc') && rcSummary() === 'on'
    setKids(b, [icon('gear'), h('span', { class: 'hide-sm' }, t('set.button')), warn ? h('span', { class: 'dot set-dot', 'aria-hidden': 'true' }) : null])
    b.setAttribute('aria-label', t('set.button') + (warn ? colon() + t('set.rcOn') : ''))
    refreshSettings()
    if (dlg.kind === 'rc') renderRc()
    if (dlg.kind === 'net' && net) renderNet()
  }
  // The settings live in two places (spec §3.29, 2026-10-20). The header popover holds only what people change
  // often, one click each and no explanations: language, theme, Auto Handoff, asking an AI, and "All settings…".
  // Everything else is in the settings dialog, one section at a time, picked in a list at its side; each section
  // explains itself once. leave() closes whichever holds them before a link goes elsewhere; a link that opens a
  // dialog keeps the dialog element open (opens: true), since one dialog element is shared.
  function setSeg(label, opts, cur, pick) {
    return h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, label),
      h('div', { class: 'seg', role: 'group', 'aria-label': label }, opts.map(([v, text]) =>
        h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(v === cur), onclick: () => pick(v) }, text))))
  }
  function setLink(leave, label, state, cls, run, opens, key) {
    return h('button', { class: 'menu-item set-link', type: 'button', 'data-enter': key || null, onclick: () => { leave(opens); run() } },
      h('span', { class: 'menu-label' }, label), state ? h('span', { class: 'chip chip-sm ' + cls }, state) : null, icon('chevron'))
  }
  function lookRows() {
    const secs = settingsSections()
    const out = []
    if (secs.includes('lang')) out.push(setSeg(t('set.lang'), [['en', 'English'], ['zh', '中文']], lang, setLang))
    if (secs.includes('theme')) out.push(setSeg(t('set.theme'), CHOICES.theme.map((v) => [v, t('set.theme.' + v)]), viewPrefs().theme, setTheme))
    return out
  }
  function ahLink(leave) {
    if (!settingsSections().includes('ah')) return null
    const on = ahState().settings.auto
    return setLink(leave, t('ah.button'), on ? t('ah.on') : t('ah.off'), on ? 'chip-ok' : '', () => setPage('handoff'))
  }
  function rcLink(leave) {
    const sum = rcSummary()
    return setLink(leave, t('rc.button'), t('rc.state.' + sum), sum === 'on' ? 'chip-warn' : sum === 'off' ? 'chip-ok' : '', openRc, true)
  }
  function aiLink(leave) {
    return setLink(leave, t('ai.title'), t(skillInstalled() ? 'ai.installed' : 'ai.notInstalled'), skillInstalled() ? 'chip-ok' : '', () => openAsk(), true)
  }
  // The dialog's sections, in order: General, Menu bar, Accounts, Quota checks, Auto Handoff, Let AI help. Each is
  // { id, title, items, foot }: foot is the one line that explains the whole section.
  function settingsGroups(leave) {
    const secs = settingsSections()
    const link = (...args) => setLink(leave, ...args)
    const general = [...lookRows(), link(t('th.title'), themeLabel(), '', openThemes, true), autostartRow('autostart')]
    if (!BOOT.readOnly) general.push(link(t('term.title'), '', '', openTerminals, true))
    // The menu bar switch shows only where it works (macOS); while its state loads it waits, unseen.
    const bar = []
    if (li.menubar.status && li.menubar.status.supported) {
      bar.push(autostartRow('menubar'))
      const mbs = li.menubar.status
      if ((mbs.state === 'on' || mbs.state === 'stale') && mbs.hotkey)
        bar.push(link(t('mb.settings'), mbs.hotkey.enabled ? mbs.hotkey.label : t('hk.unset'), mbs.hotkey.registered === false ? 'chip-warn' : '', openMenubarSettings, true, 'mbset'))
    }
    const acct = []
    // The arrange mode (spec §3.25) has a place here too, where people look for "how do I change this".
    if (secs.includes('order')) {
      const d = displayOf()
      const pins = [d.pinned, d.hidden].some((r) => Object.values(r || {}).some((x) => x.length)) || Boolean(d.hiddenFamilies && d.hiddenFamilies.length)
      acct.push(link(t('set.order'), t(ordered() || pins ? 'set.orderMine' : 'set.orderDefault'), '', () => {
        setPage('accounts')
        startArrange()
        const bar = document.querySelector('#accounts .arrange-bar')
        if (bar) bar.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' })
      }))
    }
    if (pickFamilies().length) {
      const names = Object.keys(S.state.pickCommands || {})
      acct.push(link(t('pk.title'), names.length ? names.join(', ') : t('pk.noneYet'), names.length ? 'chip-ok' : '', () => openPick(null), true))
    }
    if (secs.includes('rc')) acct.push(rcLink(leave))
    // Quota checks that ask the Host (spec §3.26): one switch per Family under one shared explanation.
    const checks = []
    let every = 15
    if (secs.includes('checks')) {
      for (const c of S.state.quotaChecks) {
        every = c.everyMinutes
        const label = t('set.quotaCheck', { host: c.title })
        checks.push(h('div', { class: 'set-row' + (c.blocked ? ' set-check' : '') },
          h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, c.title), c.blocked ? h('span', { class: 'set-hint' }, c.blocked) : null),
          BOOT.readOnly ? h('span', { class: 'chip chip-sm' + (c.on ? ' chip-ok' : '') }, c.on ? t('ah.on') : t('ah.off'))
            : h('div', { class: 'seg', role: 'group', 'aria-label': label }, [[true, t('ah.on')], [false, t('ah.off')]].map(([v, text]) =>
              h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(v === c.on), onclick: () => { if (v !== c.on) { leave(false); setCheck(c.family, v) } } }, text)))))
      }
    }
    // Network Guard (spec §3.35): its own dialog, with the state on the link.
    const netItems = []
    if (secs.includes('net')) {
      const n = S.state.network
      const bad = netProblem()
      netItems.push(link(t('net.title'), bad ? t('net.blocked') : n.guard ? t('ah.on') : t('ah.off'), bad ? 'chip-fail' : n.guard ? 'chip-ok' : '', openNet, true))
    }
    // Everything here can also be asked of an AI assistant through the sideby skill (spec §3.8).
    const ai = [aiLink(leave), link(t('ask.plugin'), '', '', () => openAsk({ task: 'plugin', context: { version: BOOT.version } }), true)]
    return [
      { id: 'general', title: t('set.g.general'), items: general },
      { id: 'menubar', title: t('set.g.menubar'), items: bar },
      { id: 'accounts', title: t('set.g.accounts'), items: acct },
      { id: 'quota', title: t('set.g.quota'), items: checks, foot: t('set.quotaChecksHint', { n: every }) },
      { id: 'handoff', title: t('ah.button'), items: [ahLink(leave)].filter(Boolean), foot: t('set.ahHint') },
      { id: 'network', title: t('net.title'), items: netItems, foot: t('net.hint') },
      { id: 'ai', title: t('set.g.ai'), items: ai, foot: t('set.aiHint') },
    ].filter((g) => g.items.length)
  }
  // The popover: a few things, no scrolling, then the way to everything else.
  function settingsPop() {
    loadAutostart()
    const leave = () => closeMenu()
    const look = lookRows()
    const quick = [ahLink(leave), rcSummary() === 'on' ? rcLink(leave) : null, aiLink(leave)].filter(Boolean)
    return [
      look.length ? h('div', { class: 'set-group' }, look) : null,
      look.length ? h('div', { class: 'menu-sep set-sep', role: 'separator' }) : null,
      h('div', { class: 'set-group' }, quick),
      h('button', { class: 'menu-item set-more', type: 'button', onclick: () => { closeMenu(); openSettingsDialog() } }, h('span', { class: 'menu-label' }, t('set.more')), icon('chevron')),
    ]
  }
  function openSettingsDialog(sec) {
    loadAutostart()
    if (sec) { prefs.setSec = sec; savePrefs() }
    showDialog('settings')
    renderSettingsDialog()
  }
  // The dialog opens on the section last looked at; a list at its side (a row of tabs on a narrow screen) picks another.
  // switched: the user picked another section, so the new one slides in; a refresh redraws it in place.
  function renderSettingsDialog(switched) {
    const leave = (opens) => { if (!opens && dlg.kind === 'settings') dlg.el.close() }
    const groups = settingsGroups(leave)
    const cur = groups.find((g) => g.id === prefs.setSec) || groups[0]
    const nav = h('div', { class: 'set-nav', role: 'tablist', 'aria-label': t('set.title'), 'data-patch': '' }, groups.map((g) =>
      h('button', { class: 'set-tab', type: 'button', role: 'tab', id: 'set-tab-' + g.id, 'aria-selected': String(g === cur), 'aria-controls': 'set-pane', onclick: () => { if (prefs.setSec === g.id || g === cur) return; prefs.setSec = g.id; savePrefs(); renderSettingsDialog(true) } }, g.title)))
    const pane = h('div', { class: 'set-pane' + (switched ? ' view-in' : ''), id: 'set-pane', role: 'tabpanel', 'aria-labelledby': 'set-tab-' + cur.id, 'data-patch': '' },
      h('h3', { class: 'set-pane-title' }, cur.title),
      cur.foot ? h('p', { class: 'set-foot' }, cur.foot) : null,
      h('div', { class: 'set-group', 'data-patch': '' }, cur.items))
    // Gone once it has slid in, so the next refresh sees the same markup.
    if (switched) pane.addEventListener('animationend', () => pane.classList.remove('view-in'), { once: true })
    // It stays wide while it fades out; showDialog drops the width when another dialog takes the element.
    dlg.el.classList.add('dialog-wide')
    // Patched in place: the refresh every few seconds redraws only what changed, and a list the user has open stays.
    const frame = dialogFrame(t('set.title'), null, h('div', { class: 'set-dialog', 'data-patch': '' }, nav, pane))
    frame[1].setAttribute('data-patch', '')
    if (switched) setKids(dlg.el, frame)
    else patch(dlg.el, frame)
    // A redraw replaced the list; a section picked from it keeps the focus on its tab.
    if (switched) { const tab = document.getElementById('set-tab-' + cur.id); if (tab) tab.focus() }
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
    const was = JSON.stringify([st.status, st.error && st.error.message])
    try { st.status = await api('/api/' + k); st.error = null } catch (e) { st.error = e }
    st.loading = false
    // The same answer again (each open of a dialog reads it anew) redraws nothing: a redraw would close an open list.
    if (JSON.stringify([st.status, st.error && st.error.message]) === was) return
    refreshSettings()
    if (k === 'menubar') { renderAll(); if (!hk.recording && !hk.busy) refreshHotkey() }
  }
  function autostartRow(k) {
    const st = li[k]
    const s = st.status
    const n = autostartNote(s, BOOT.readOnly)
    const label = lt(k, 'label')
    const hint = [st.error ? lt(k, 'failed', { msg: st.error.message }) : lt(k, n.key.slice(3))]
    // The menu bar item: how to bring it back once hidden, and why a running one may not show (Rectangle, Stats).
    if (k === 'menubar' && s && s.supported && !st.error && n.key === 'as.hint') {
      if (!n.on) hint.push(' ', lt(k, 'hintOff'))
    }
    if (n.action === 'fix') hint.push(' ', h('button', { class: 'link-btn small', type: 'button', onclick: () => autostartAsk(true, k) }, lt(k, n.key === 'as.notRunning' ? 'restart' : 'fix')))
    if (s && s.state === 'foreign') hint.push(' ', h('button', { class: 'link-btn small', type: 'button', title: s.path, onclick: () => copyText(s.path) }, lt(k, 'copyPath')))
    // Running, but macOS tucked the icon behind « (a full menu bar): say where it went, whatever else the row says.
    if (k === 'menubar' && s && n.on && s.loaded !== false && s.icon && s.icon.visible === false)
      hint.push(h('span', { class: 'note-warn-line' }, t('mb.iconHidden'), ' ', BOOT.readOnly ? null : h('button', { class: 'link-btn small', type: 'button', onclick: openMenuBarSettings }, t('mb.openSettings'))))
    let ctl = null
    if (!s) ctl = st.loading ? spinner() : null
    else if (n.toggle) ctl = h('div', { class: 'seg', role: 'group', 'aria-label': label }, [[true, t('ah.on')], [false, t('ah.off')]].map(([v, text]) =>
      h('button', { class: 'seg-btn', type: 'button', 'aria-pressed': String(v === n.on), onclick: () => { if (v !== n.on) autostartAsk(v, k) } }, text)))
    else if (s.supported && s.state !== 'foreign') ctl = h('span', { class: 'chip chip-sm' + (n.on ? ' chip-ok' : '') }, n.on ? t('ah.on') : t('ah.off'))
    return h('div', { class: 'set-row set-check', 'data-enter': 'li-' + k },
      h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, label), h('span', { class: 'set-hint' }, hint)), ctl)
  }
  async function openMenuBarSettings() {
    try { await api('/api/menubar/settings', {}) } catch (e) { toast(e.message, { kind: 'fail' }) }
  }

  // The menu bar item's own dialog (spec §3.31): its shortcut, what hides its icon, and the AI Task that checks it.
  // The settings popover keeps one row for it, like Preferred terminal, so the popover stays one line per setting.
  function openMenubarSettings() {
    hk.recording = false
    hk.error = ''
    showDialog('mbset')
    dlg.onClose = () => { hk.recording = false; hk.error = ''; hk.live = ''; hk.undo = ''; hk.mods = false; hk.custom = false }
    renderMenubarSettings()
    // What the page read earlier may be old (the CLI, another tab, an update changed it): read it again now.
    loadLoginItem('menubar')
  }
  function renderMenubarSettings() {
    const s = li.menubar.status
    const v = s && s.hotkey
    const body = []
    if (v) {
      body.push(h('div', { class: 'set-row set-check' },
        h('div', { class: 'set-text' }, h('span', { class: 'set-label' }, t('hk.label')),
          h('span', { class: 'set-hint' }, hk.error ? h('span', { class: 'note-fail-text' }, hk.error)
            : hk.custom ? t('hk.customHint')
            : v.registered === false ? h('span', { class: 'note-fail-text' }, t('hk.taken', { key: v.label }))
            : v.problem ? t('hk.problem', { key: v.label })
            : v.enabled ? t('hk.hint', { key: v.label })
            : hk.undo ? [t('hk.savedOff'), ' ', h('button', { class: 'link-btn small', type: 'button', disabled: hk.busy, onclick: () => saveHotkey(hk.undo) }, t('hk.undo'))]
            : t('hk.hintOff'))),
        hotkeyPicker(v)))
      if (hk.custom) body.push(h('div', { class: 'hk-custom', 'data-enter': 'hk-custom' }, hotkeyField(v)))
      if (!BOOT.readOnly && !hk.custom) body.push(h('p', { class: 'small', 'data-enter': 'hk-ai' }, h('button', { class: 'link-btn small', type: 'button', onclick: () => { dlg.el.close(); openAsk({ task: 'hotkey', context: { version: BOOT.version } }) } }, icon('bot'), ' ', t('hk.askAi'))))
    }
    const key = v && v.enabled ? v.label : ''
    body.push(h('h3', { class: 'mb-help-title' }, t('mb.cantSee')),
      h('ol', { class: 'set-help' },
        h('li', null, t('mb.cantSeeOverflow')),
        h('li', null, t('mb.cantSeeAllow'), ' ', BOOT.readOnly ? null : h('button', { class: 'link-btn small', type: 'button', onclick: openMenuBarSettings }, t('mb.openSettings'))),
        h('li', null, t('mb.cantSeeOrganizer'))))
    if (key) body.push(h('p', { class: 'muted small' }, t('mb.cantSeeKey', { key })))
    const foot = [h('button', { class: 'btn', type: 'button', onclick: () => dlg.el.close() }, t('btn.close'))]
    if (!BOOT.readOnly) foot.push(h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { dlg.el.close(); openAsk({ task: 'menubar', context: { version: BOOT.version } }) } }, icon('bot'), t('mb.askAi')))
    swapKids(dlg.el, dialogFrame(t('mb.settings'), null, body, foot))
    if (hk.recording) focusRecorder()
  }

  // The shortcut as a choice, not a recording (spec §3.31): a few checked combinations that work, Off, and Custom…,
  // which opens the recorder. A browser never sees keys another app holds, so recording stays the exception.
  const HOTKEY_PRESETS = ['opt+x', 'opt+z', 'opt+cmd+s', 'ctrl+opt+s']
  const HOTKEY_SIGNS = { ctrl: '⌃', opt: '⌥', shift: '⇧', cmd: '⌘' }
  function hotkeyLabel(keys) {
    const parts = keys.split('+')
    const key = parts.pop()
    return parts.map((p) => HOTKEY_SIGNS[p] || '').join('') + key.toUpperCase()
  }
  function hotkeyPicker(v) {
    const now = hk.custom ? 'custom' : v.enabled ? v.keys : 'off'
    if (BOOT.readOnly) return h('span', { class: 'chip chip-sm' }, v.enabled ? v.label : t('hk.unset'))
    const opts = HOTKEY_PRESETS.map((k) => [k, hotkeyLabel(k) + (k === HOTKEY_PRESETS[0] ? t('hk.isDefault') : '')])
    if (v.enabled && HOTKEY_PRESETS.indexOf(v.keys) < 0) opts.unshift([v.keys, v.label])
    opts.push(['off', t('hk.offOption')], ['custom', t('hk.custom')])
    return h('select', { class: 'hk-select', 'data-key': 'hk-select', 'aria-label': t('hk.label'), disabled: hk.busy,
      onchange: (e) => {
        const val = e.target.value
        hk.error = ''
        if (val === 'custom') { hk.custom = true; hk.recording = true; hk.live = ''; refreshHotkey(); return }
        hk.custom = false
        saveHotkey(val)
      } },
      opts.map(([val, text]) => h('option', { value: val, selected: val === now }, text)))
  }

  // The shortcut recorder (spec §3.31), one field as in macOS Keyboard Shortcuts and KeyboardShortcuts: click it and
  // press the keys, saved at once; Esc cancels, Delete or its ✕ turns the shortcut off (with Undo). Nothing else
  // appears around it while recording; a refusal is one red line, gone at the next key.
  // undo: the shortcut before it was turned off, offered in the row itself (a toast is out of reach behind the modal).
  // mods: modifiers were held while recording and no letter came yet (see recordUp).
  // custom: the picker's Custom… is open, showing the recorder below it.
  const hk = { recording: false, busy: false, error: '', live: '', undo: '', mods: false, custom: false }
  function hotkeyField(v) {
    const shown = hk.recording ? (hk.live || t('hk.recording')) : v.enabled ? v.label : t('hk.unset')
    if (BOOT.readOnly) return h('span', { class: 'chip chip-sm' }, shown)
    const field = h('button', { class: 'hk-rec' + (hk.recording ? ' recording' : '') + (v.registered === false && !hk.recording ? ' taken' : '') + (!v.enabled && !hk.recording ? ' unset' : ''), type: 'button', 'aria-label': t('hk.label') + colon() + shown, 'aria-pressed': String(hk.recording), disabled: hk.busy,
      onclick: () => { if (!hk.recording) { hk.recording = true; hk.error = ''; hk.live = ''; refreshHotkey() } },
      onkeydown: recordKey, onkeyup: recordUp,
      onblur: () => { if (hk.recording) setTimeout(() => { if (hk.recording && !document.querySelector('.hk-rec:focus')) stopRecording() }, 150) } }, shown)
    const cancel = h('button', { class: 'link-btn small', type: 'button', onclick: () => { hk.custom = false; stopRecording() } }, t('btn.cancel'))
    return h('div', { class: 'hk-field' }, field, cancel)
  }
  function refreshHotkey() {
    if (dlg.kind === 'mbset' && dlg.el && dlg.el.open) renderMenubarSettings()
  }
  function focusRecorder() { const b = document.querySelector('.hk-rec'); if (b) b.focus() }
  function stopRecording() { hk.recording = false; hk.live = ''; hk.error = ''; refreshHotkey(); focusRecorder() }
  // The modifiers held now, as macOS writes them, while the letter is still to come.
  function hotkeyLive(e) {
    return (e.ctrlKey ? '⌃' : '') + (e.altKey ? '⌥' : '') + (e.shiftKey ? '⇧' : '') + (e.metaKey ? '⌘' : '')
  }
  function recordKey(e) {
    if (!hk.recording) return
    const mods = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey
    // Tab is how a keyboard user leaves: recording stops and focus moves on as usual.
    if (e.key === 'Tab' && !mods) { hk.recording = false; hk.live = ''; hk.error = ''; refreshHotkey(); return }
    e.preventDefault()
    // Esc stops recording only; the next Esc closes the dialog.
    e.stopPropagation()
    if (e.key === 'Escape' && !mods) { hk.custom = false; return stopRecording() }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !mods) return saveHotkey('off')
    hk.error = ''
    const keys = hotkeyFromKey(e)
    // An arrow, an F-key or Space: say at once that only a letter or digit works, rather than seem not to react.
    if (!keys && hotkeyPressKind(e.code) === 'unsupported') { hk.error = t('hk.err.key'); hk.live = ''; hk.mods = false; refreshHotkey(); return }
    if (!keys) { hk.live = hotkeyLive(e); hk.mods = Boolean(hk.live); refreshHotkey(); return }
    hk.mods = false
    saveHotkey(keys)
  }
  // The modifiers came up and no letter reached the page: either none was pressed, or macOS handed the keys to the
  // app that holds them as its own shortcut (sideby's own included) before the browser saw them. Say both.
  function recordUp(e) {
    if (!hk.recording) return
    hk.live = hotkeyLive(e)
    if (hk.mods && !hk.live) { hk.mods = false; hk.error = t('hk.err.noKey') }
    refreshHotkey()
  }
  async function saveHotkey(keys) {
    const before = li.menubar.status && li.menubar.status.hotkey
    hk.busy = true
    hk.error = ''
    refreshHotkey()
    try {
      const r = await api('/api/menubar/hotkey', { keys })
      hk.recording = false
      hk.custom = false
      hk.live = ''
      if (li.menubar.status) li.menubar.status = { ...li.menubar.status, hotkey: r.hotkey }
      // Off is one click with no question, so the row offers to undo it until something else changes.
      hk.undo = r.changed && !r.hotkey.enabled && before && before.enabled ? before.keys : ''
      if (r.changed && r.hotkey.enabled) toast(t('hk.saved', { key: r.hotkey.label }))
    } catch (e) {
      const own = 'hk.err.' + (e.code || '')
      hk.error = Object.hasOwn(MESSAGES.en, own) ? t(own) : e.message
      hk.live = ''
    }
    hk.busy = false
    refreshHotkey()
    refreshSettings()
    if (hk.recording) focusRecorder()
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
    else if (p && on && p.restartOnly) body.push(h('p', null, lt(k, 'restartBody')))
    // What happens, in one sentence; the file and the command it runs sit behind Details, for whoever wants them.
    else if (p && on) {
      body.push(h('p', null, lt(k, 'noWindow')))
      body.push(h('details', { class: 'as-details' }, h('summary', null, t('as.details')),
        h('p', null, lt(k, 'writes')), h('code', { class: 'as-code' }, p.path),
        h('p', null, lt(k, 'runs')), h('code', { class: 'as-code' }, (p.programArguments || []).join(' '))))
    } else if (p) {
      body.push(h('p', null, lt(k, 'offNote')))
      body.push(h('details', { class: 'as-details' }, h('summary', null, t('as.details')),
        h('p', null, lt(k, 'removes')), h('code', { class: 'as-code' }, p.path)))
    }
    const foot = [h('button', { class: 'btn', type: 'button', disabled: st.busy, onclick: () => dlg.el.close() }, t(p && p.changed && !p.blocked ? 'btn.cancel' : 'btn.close'))]
    if (p && p.changed && !p.blocked)
      foot.push(h('button', { class: 'btn btn-primary', type: 'button', disabled: st.busy, 'aria-busy': st.busy ? 'true' : null, onclick: autostartApply }, st.busy ? spinner() : null, lt(k, p.restartOnly ? 'restart' : on ? 'turnOn' : 'turnOff')))
    setKids(dlg.el, dialogFrame(lt(k, p && p.restartOnly ? 'restartTitle' : on ? 'onTitle' : 'offTitle'), null, body, foot))
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
      const restarted = st.plan && st.plan.restartOnly
      st.status = r.status
      if (dlg.kind === 'autostart') dlg.el.close()
      if (restarted) toast(lt(k, r.loaded ? 'doneRestart' : 'restartFailed'), r.loaded ? undefined : { kind: 'fail' })
      else toast(lt(k, on ? 'doneOn' : 'doneOff') + (on && !r.loaded ? ' ' + lt(k, 'nextLogin') : ''))
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
    if ((next.colorTheme || 'default') !== themeChosen) refreshThemeCss()
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
    else if (dlg.kind === 'inbound') renderInbound()
    else if (dlg.kind === 'ask' && ak) { if (ak.els.text) ak.text = ak.els.text.value; renderAsk() }
    else if (dlg.kind === 'key' && ky && ky.step !== 'enter') renderKey()
    else if (dlg.kind === 'terminal' && tm) renderTerminals()
    else if (dlg.kind === 'theme' && th) renderThemes()
    else if (dlg.kind === 'autostart') renderAutostart()
    else if (dlg.kind === 'mbset') renderMenubarSettings()
    else if (dlg.kind === 'pick' && pk) renderPick()
    else if (dlg.kind === 'send' && sd) renderSend()
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
  const AI_ASKS = ['ai.ask.quota', 'ai.ask.pick', 'ai.ask.new', 'ai.ask.api', 'ai.ask.pin', 'ai.ask.hide', 'ai.ask.relogin', 'ai.ask.fix', 'ai.ask.handoff', 'ai.ask.handoffRules', 'ai.ask.session', 'ai.ask.history', 'ai.ask.send', 'ai.ask.inbound', 'ai.ask.menubar', 'ai.ask.rc', 'ai.ask.network', 'ai.ask.theme', 'ai.ask.tool']
  // Network Guard (spec §3.35): one dialog with the switch, the allowed countries and the newest result per address.
  // Countries are never ticked for the user, the current one included: a wrong network would allow itself.
  const NET_COMMON = ['US', 'JP', 'SG', 'GB', 'DE', 'FR', 'NL', 'CA', 'AU', 'KR', 'TW', 'HK']
  let net = null
  function netState() { return S.state && S.state.network }
  function netProblem() {
    const n = netState()
    return n && n.active ? n.targets.find((x) => x.status === 'blocked' || x.status === 'unknown') || null : null
  }
  function netCountry(code) {
    const name = t('net.cty.' + code)
    if (name === 'net.cty.' + code) return code
    return lang === 'zh' ? name + '（' + code + '）' : name + ' (' + code + ')'
  }
  // "A, B or C" in English, "A、B、C" in Chinese.
  function netList(items) {
    if (items.length < 2) return items.join('')
    return items.slice(0, -1).join(t('net.listSep')) + t('net.listLast') + items[items.length - 1]
  }
  function openNet() {
    const n = netState()
    if (!n) return
    net = { guard: n.guard, allow: [...n.allow], checking: false }
    showDialog('net')
    renderNet()
    // Opening it answers "where am I now" at once, unless a result is fresh.
    if (!n.targets.some((x) => x.checkedAt && Date.now() - Date.parse(x.checkedAt) < 60000)) netCheck()
  }
  async function netCheck() {
    if (!net) net = { guard: false, allow: [], checking: false }
    net.checking = true
    if (dlg.kind === 'net') renderNet()
    renderBanners()
    try { S.state.network = await api('/api/network/check', {}) } catch (e) { toast(t('net.checkFailed', { msg: e.message }), { kind: 'fail' }) }
    net.checking = false
    if (dlg.kind === 'net') renderNet()
    renderBanners()
  }
  // Every change in the dialog applies at once, like a system setting, and its toast carries the undo. Changes are
  // saved one after another in the order clicked; a failed one puts the dialog back to what the config holds.
  let netSaving = Promise.resolve()
  function netApply(next, opts) {
    opts = opts || {}
    const prev = { guard: net.guard, allow: [...net.allow] }
    net.guard = next.guard
    net.allow = [...next.allow]
    renderNet()
    netSaving = netSaving.then(async () => {
      try {
        await api('/api/network/settings', { guard: next.guard, allow: next.allow, confirm: true })
        await load({ silent: true })
        const text = opts.undone ? t('net.undone')
          : next.guard !== prev.guard ? t(next.guard ? 'net.savedOn' : 'net.savedOff')
          : t('net.savedAllow', { list: next.allow.length ? netList(next.allow.map(netCountry)) : t('net.none') })
        toast(text, opts.undone ? { key: 'net' } : { key: 'net', action: { label: t('toast.undo'), run: () => netApply(prev, { undone: true }) }, duration: 10000 })
      } catch (e) {
        toast(e.message, { kind: 'fail' })
        const n = netState()
        if (n && net) { net.guard = n.guard; net.allow = [...n.allow] }
      }
      if (dlg.kind === 'net') renderNet()
    })
  }
  function renderNet() {
    const n = netState()
    if (!n || !net) return
    const here = new Set(n.targets.map((x) => x.loc).filter(Boolean))
    const list = [...new Set([...NET_COMMON, ...net.allow, ...here])]
    const toggle = (c) => netApply({ guard: net.guard, allow: net.allow.includes(c) ? net.allow.filter((x) => x !== c) : [...net.allow, c] })
    // While it is on, the last country stays: taking it away would leave nothing allowed.
    const lastOne = (c) => net.guard && net.allow.length === 1 && net.allow[0] === c
    const sw = h('div', { class: 'set-row', 'data-patch': '' }, h('span', { class: 'set-label' }, t('net.switch')),
      h('div', { class: 'seg', role: 'group', 'aria-label': t('net.switch'), 'data-patch': '' }, [[true, t('ah.on')], [false, t('ah.off')]].map(([v, text]) =>
        h('button', { class: 'seg-btn', type: 'button', 'data-key': 'net-sw-' + v, disabled: BOOT.readOnly || (v && !net.allow.length), 'aria-pressed': String(net.guard === v), onclick: () => { if (net.guard !== v) netApply({ guard: v, allow: net.allow }) } }, text))))
    const countries = h('div', { class: 'net-countries', role: 'group', 'aria-label': t('net.allow'), 'data-patch': '' }, list.map((c) =>
      h('button', { class: 'net-cty', type: 'button', 'data-key': 'net-cty-' + c, disabled: BOOT.readOnly || lastOne(c), title: lastOne(c) ? t('net.keepOne') : null, 'aria-pressed': String(net.allow.includes(c)), onclick: () => toggle(c) },
        netCountry(c), here.has(c) ? h('span', { class: 'chip chip-sm' }, t('net.current')) : null)))
    const status = (x) => x.status === 'ok' ? ['chip-ok', t('net.ok')] : x.status === 'blocked' ? ['chip-fail', t('net.blocked')] : x.status === 'unknown' ? ['chip-fail', t('net.unknown')] : ['', t('net.notChecked')]
    const rows = n.targets.map((x) => {
      const [cls, label] = n.allow.length || x.status === 'not-checked' ? status(x) : ['', t('net.seen')]
      return h('li', { class: 'rc-row', 'data-key': 'net-row-' + x.url },
        h('div', null, h('code', null, new URL(x.url).hostname), ' ', x.loc ? h('b', null, netCountry(x.loc)) : null, ' ', h('span', { class: 'chip chip-sm ' + cls }, label)),
        h('div', { class: 'muted small' }, [x.checkedAt ? t('net.checked', { when: ago(x.checkedAt) }) : null, x.error || null, x.accounts.join(', ')].filter(Boolean).join(' · ')),
        x.ipChanged ? h('div', { class: 'muted small' }, t('net.ipChanged')) : null)
    })
    const skipped = n.accounts.filter((a) => a.skip === 'third-party' || a.skip === 'at-launch')
    const body = [
      h('p', { class: 'small' }, t('net.explain')),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', 'data-key': 'net-ask', onclick: askNetwork }, icon('bot'), t('ask.title.network'))),
      sw,
      h('div', { class: 'set-label' }, t('net.allow')),
      countries,
      !net.allow.length ? h('p', { class: 'small muted', 'data-enter': 'net-pick' }, t('net.pickFirst')) : null,
      h('div', { class: 'set-row' }, h('span', { class: 'set-label' }, t('net.now')),
        h('button', { class: 'btn btn-sm', type: 'button', 'data-key': 'net-check', disabled: net.checking, 'aria-busy': net.checking ? 'true' : null, onclick: netCheck }, net.checking ? spinner() : icon('refresh'), t('net.recheck'))),
      rows.length ? h('ul', { class: 'rc-list', 'data-patch': '' }, rows) : h('p', { class: 'small muted' }, t('net.noTargets')),
      skipped.length ? h('p', { class: 'small muted' }, t('net.skipped', { refs: skipped.map((a) => a.ref).join(', ') })) : null,
      h('p', { class: 'small muted' }, t('net.notCovered')),
      BOOT.readOnly ? h('p', { class: 'small' }, t('rc.readOnlyBoth')) : null,
    ]
    const foot = [h('button', { class: 'btn', type: 'button', 'data-key': 'net-close', onclick: () => dlg.el.close() }, t('btn.close'))]
    const frame = dialogFrame(t('net.title'), null, body, foot)
    // Patched in place, so the state refreshing every few seconds redraws only what changed (a row's "checked … ago").
    frame[1].setAttribute('data-patch', '')
    patchEnter(dlg.el, frame)
  }
  // Let AI do it (spec §3.28): the AI asks which countries, shows the change and writes it after the user agrees.
  function askNetwork() {
    const n = netState()
    if (!n) return
    openAsk({ task: 'network', context: { network: networkTaskFacts(n), version: BOOT.version } })
  }
  // Where the problem shows: a banner on every page while the guard is on and the exit is wrong or unknown.
  function netBanner() {
    const x = netProblem()
    if (!x) return null
    const n = netState()
    const text = x.status === 'blocked'
      ? t('net.bannerBlocked', { cty: netCountry(x.loc), allow: netList(n.allow.map(netCountry)) })
      : t('net.bannerUnknown', { why: x.error || '' })
    return h('div', { class: 'banner banner-warn', role: 'status', 'data-enter': 'net-banner' },
      h('div', null, h('b', null, t('net.bannerTitle') + (lang === 'zh' ? '' : ' ')), text),
      h('div', { class: 'banner-actions' },
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'data-key': 'net-banner-check', disabled: Boolean(net && net.checking), 'aria-busy': net && net.checking ? 'true' : null, onclick: netCheck }, net && net.checking ? spinner() : null, t('net.recheck')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: openNet }, t('net.title')),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: askNetwork }, icon('bot'), t('ask.title.network'))))
  }
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
    const fromOf = (g) => g.state === 'on' ? 'true' : g.state === 'off' ? 'false' : null
    const rows = groups.map((g) => h('li', { class: 'rc-row' },
      h('div', null, h('code', null, g.file), ' ', h('span', { class: 'chip chip-sm ' + (g.state === 'on' ? 'chip-warn' : g.state === 'off' ? 'chip-ok' : g.state === 'blocked' ? 'chip-fail' : '') }, t('rc.state.' + g.state))),
      h('div', { class: 'muted small' }, t('rc.usedBy', { refs: g.accounts.map(shortRef).join(', ') })),
      g.reason ? h('div', { class: 'muted small' }, g.why ? t('settings.why.' + g.why) : g.reason) : null,
      changing.has(g.file) ? h('div', { class: 'small rc-change' }, keyChange('remoteControlAtStartup', fromOf(g), to === 'on' ? 'true' : 'false')) : null))
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
    hookDrops()
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
  let dropsHooked = false
  // Which open dialog takes pasted or dropped files now: the AI Task's or "Send to it"'s, until it shows its result.
  function fileDropTarget() {
    if (BOOT.readOnly) return null
    if (dlg.kind === 'ask' && ak && !ak.result) return askAddFiles
    if (dlg.kind === 'send' && sd && !sd.result) return sendAddFiles
    return null
  }
  function hookDrops() {
    if (dropsHooked) return
    dropsHooked = true
    const el = dlg.el
    const active = () => Boolean(fileDropTarget())
    const hasFiles = (e) => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0
    el.addEventListener('paste', (e) => {
      const cd = e.clipboardData
      let files = cd ? Array.from(cd.files || []) : []
      // Some browsers put a copied screenshot only among the items.
      if (cd && !files.length) files = Array.from(cd.items || []).filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean)
      if (!active() || !files.length) return
      // A file copied in Finder also carries its name as text; only the file is wanted.
      e.preventDefault()
      fileDropTarget()(files)
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
      fileDropTarget()(Array.from(e.dataTransfer.files || []))
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
  function askPost(file, onProgress, xhrOut, path) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest()
      xhrOut(xhr)
      xhr.open('POST', BOOT.basePath + (path || '/api/ask/attach'))
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

  // ---------- Themes (spec §3.34, ADR-0050) ----------
  // The Theme dialog: Built-in Themes and Theme Files as cards, the user's own color, and "Let AI pick my colors".
  // A switch swaps the page's token rules in place (a constructed sheet after the page's own), so the colors ease over
  // instead of the page reloading.
  let th = null
  let themeFetching = false
  // The Theme config names ('default' when none) and the one the page shows (inside a Portal, 'default' is its colors).
  let themeChosen = (BOOT.panel && BOOT.panel.colorTheme) || 'default'
  let themeNow = themeChosen === 'default' ? BOOT.themes.default : themeChosen
  function themeName(x) { return x.source === 'portal' ? t('th.page') : x.id === 'custom' && x.source === 'file' ? t('th.custom') : lang === 'zh' && x.nameZh ? x.nameZh : x.name }
  function themeLabel() {
    const x = th && th.data && th.data.themes.find((y) => y.id === themeNow)
    if (x) return themeName(x)
    if (themeNow === 'default') return t('th.page')
    const b = BOOT.themes.names[themeNow]
    return b ? b[lang === 'zh' ? 'zh' : 'en'] : themeNow
  }
  function applyThemeCss(css) {
    if (!css || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) { location.reload(); return }
    const root = document.documentElement
    if (!REDUCED) { root.classList.add('theme-fade'); setTimeout(() => root.classList.remove('theme-fade'), 220) }
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(css)
    document.adoptedStyleSheets = [sheet]
  }
  function refreshThemeCss() {
    if (themeFetching) return
    themeFetching = true
    api('/api/themes').then((d) => { themeFetching = false; themeData(d) }, () => { themeFetching = false })
  }
  function themeData(d) {
    themeNow = d.active
    themeChosen = d.chosen
    applyThemeCss(d.css)
    if (th) { th.data = d; if (dlg.kind === 'theme') renderThemes() }
    refreshSettings()
  }
  function openThemes() {
    closeMenu()
    th = { data: null, busy: false, error: null, accent: null, ai: '', armed: null, status: null }
    showDialog('theme')
    renderThemes()
    api('/api/themes').then((d) => { if (th) { th.data = d; themeNow = d.active; themeChosen = d.chosen; renderThemes() } }, (e) => { if (th) { th.error = e; renderThemes() } })
  }
  async function themeSend(body) {
    if (th) { th.busy = true; th.error = null; renderThemes() }
    let d = null
    try { d = await api('/api/theme', body) } catch (e) { if (th) th.error = e; else toast(e.message, { kind: 'fail' }) }
    if (th) th.busy = false
    if (d) themeData(d)
    else if (th && dlg.kind === 'theme') renderThemes()
    return d
  }
  async function useThemeBy(body) {
    const d = await themeSend(body)
    if (!d || !th) return
    const x = d.themes.find((y) => y.id === d.active)
    th.status = { text: t('th.switched', { name: x ? themeName(x) : d.active }), undo: true }
    renderThemes()
  }
  async function undoThemeSwitch() {
    const back = await themeSend({ undo: true })
    if (!back || !th) return
    const y = back.themes.find((z) => z.id === back.active)
    th.status = { text: t('th.undone', { name: y ? themeName(y) : back.active }), undo: false }
    renderThemes()
  }
  function renderThemes() {
    if (!th) return
    // Keyboard use of the dots ends once focus sits on another control (Tab to Remove, a field), so this render
    // leaves it there instead of pulling it back to the dot in use.
    const was = document.activeElement
    const at = !was || was === document.body || was === dlg.el ? 'none' : was.classList.contains('theme-dot') ? 'dot' : 'other'
    if (th.keyed && !dotsKeepKeyboard(at)) th.keyed = false
    const d = th.data
    const body = [h('p', { class: 'muted small' }, t('th.intro'))]
    // What changed, with undo, sits in the footer beside Close, so the dialog never grows when it appears.
    const st = th.status
    const status = h('p', { class: 'theme-status small', role: 'status' }, st ? [st.text, st.undo ? h('button', { class: 'link-btn', type: 'button', disabled: th.busy, onclick: undoThemeSwitch }, t('th.undo')) : null] : null)
    if (!d && !th.error) body.push(h('p', { class: 'muted small' }, spinner(), ' ', t('th.loading')))
    if (d) {
      if (d.fallback) body.push(h('p', { class: 'note note-warn' }, d.fallback))
      else if (d.adjusted) body.push(h('p', { class: 'note' }, t('th.adjusted', { n: d.adjusted })))
      // One row of color dots, a radio group: the arrows move the choice (and switch the Theme), the dot in use has a
      // ring in its own color and a check; the name is in its tooltip.
      const now = d.themes.find((y) => y.id === d.active)
      const dots = h('div', { class: 'theme-dots', role: 'radiogroup', 'aria-labelledby': 'th-dots-head', onkeydown: (e) => {
        const all = [...dots.querySelectorAll('.theme-dot')]
        const next = radioStep(all.length, all.indexOf(document.activeElement), e.key)
        if (next < 0 || all[next].disabled) return
        e.preventDefault()
        th.keyed = true
        all[next].focus()
        all[next].click()
      } }, d.themes.filter((x) => x.source === 'builtin' || !x.problems.length).map((x) => {
        const on = x.id === d.active
        return h('button', { class: 'theme-dot', type: 'button', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1', 'aria-label': themeName(x), title: themeName(x), css: { '--dot': x.swatches[2] || x.swatches[0] }, disabled: th.busy || (BOOT.readOnly && !on), onclick: (e) => {
          // A pointer click (detail > 0) ends keyboard use; the arrows click with detail 0.
          if (e.detail > 0) th.keyed = false
          if (!on && !BOOT.readOnly) useThemeBy({ use: x.id })
        } })
      }))
      body.push(h('p', { class: 'theme-head', id: 'th-dots-head' }, t('th.title')), dots)
      if (!BOOT.readOnly) {
        const cur = d.themes.find((y) => y.id === d.active)
        const pick = h('input', { id: 'th-accent', type: 'color', value: th.accent || (cur && cur.swatches[2]) || '#3f8fc4', disabled: th.busy, 'aria-label': t('th.accent') }) // design-system-ignore: a color input needs a hex start value when no Theme has one
        pick.addEventListener('input', () => { th.accent = pick.value })
        body.push(h('div', { class: 'theme-row' },
          h('label', { class: 'theme-label', for: 'th-accent' }, t('th.accent')), pick,
          h('button', { class: 'btn btn-sm', type: 'button', disabled: th.busy, onclick: () => useThemeBy({ accent: pick.value }) }, t('th.accentUse'))),
          h('p', { class: 'field-hint' }, t('th.accentHint')))
        const ai = h('input', { id: 'th-ai', type: 'text', autocomplete: 'off', placeholder: t('th.aiPh'), 'aria-label': t('th.ai') })
        ai.value = th.ai
        ai.addEventListener('input', () => { th.ai = ai.value })
        const go = () => {
          openAsk({ task: 'theme', text: th.ai.trim(), context: { theme: cur ? cur.name + ' (' + cur.id + ')' : d.active, version: BOOT.version } })
        }
        ai.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go() } })
        body.push(h('label', { class: 'field', for: 'th-ai' }, h('span', null, t('th.ai')), ai),
          h('div', { class: 'theme-row' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: go }, icon('bot'), t('th.aiGo')), h('span', { class: 'field-hint' }, t('th.aiHint'))))
        const files = d.themes.filter((x) => x.source === 'file')
        if (files.length) body.push(h('div', { class: 'theme-files' }, h('p', { class: 'set-label' }, t('th.files')), files.map((x) => {
          const sure = th.armed === x.id
          return h('div', { class: 'theme-file' },
            h('span', { class: 'theme-file-name' }, themeName(x), x.problems.length ? h('span', { class: 'theme-bad small' }, x.problems[0]) : null),
            h('button', { class: 'btn btn-sm' + (sure ? ' btn-danger' : ''), type: 'button', disabled: th.busy, onclick: async () => {
              if (!sure) { th.armed = x.id; renderThemes(); return }
              th.armed = null
              if (await themeSend({ remove: x.id })) toast(t('th.removed', { name: themeName(x) }))
            } }, t(sure ? 'th.removeSure' : 'th.remove')))
        })))
      }
    }
    if (th.error) body.push(errorNote(th.error, null))
    setKids(dlg.el, dialogFrame(t('th.title'), null, body, [status, h('button', { class: 'btn', type: 'button', onclick: () => dlg.el.close() }, t('btn.close'))]))
    // A switch made with the arrows re-renders the dialog (more than once): keep the keyboard on the dot now in use.
    if (th.keyed && !th.busy) {
      const on = dlg.el.querySelector('.theme-dot[aria-checked="true"]')
      if (on) on.focus()
    }
  }

  // ---------- pick commands (spec §3.13, ADR-0035) ----------
  // A short command per tool that starts, each time, the account with the most quota left. The dialog lists every
  // tool that has one or could have one; adding shows what the name would hide in the shell before it writes.
  let pk = null
  function pickOf(fam) { const e = Object.entries(S.state.pickCommands || {}).find(([, f]) => f === fam); return e ? e[0] : null }
  function pickFamilies() { return S.state.families.map((f) => f.id).filter((id) => pickOf(id) || (S.state.pickOffers || {})[id]) }
  function openPick(fam) {
    closeMenu()
    pk = { focus: fam || null, busy: false, drafts: {}, confirm: {}, renaming: {}, error: null }
    showDialog('pick')
    renderPick()
    const input = fam && document.getElementById('pk-name-' + fam)
    if (input) input.focus()
  }
  async function startPick(name) {
    if (BOOT.readOnly) { copyText(name, name); return }
    try {
      const r = await api('/api/pick/start', { name })
      const why = r.reason === 'most-room' ? t('pk.why.room', { n: String(r.pressure) }) : t(r.reason === 'others-full' ? 'pk.why.othersFull' : 'pk.why.noData')
      if (r.opened) { toast(t('pk.started', { terminal: TERM_NAMES[r.terminal] || r.terminal, ref: r.picked, why })); return }
      await copyText(name, name)
      toast(r.automation ? t('login.automation', { terminal: TERM_NAMES[r.terminal] || r.terminal }) : t('login.failed'), { kind: 'info' })
    } catch (e) { toast(e.message, { kind: 'fail' }) }
  }
  // The dialog is the preview: a name that hides nothing is added at once; one that hides a command on PATH shows
  // that first and needs a second click. A rename adds the new name, then removes the old one.
  async function pickAdd(fam, name, shown, replaces) {
    pk.busy = true
    pk.error = null
    renderPick()
    try {
      let r = await api('/api/pick/add', { name, family: fam, confirm: Boolean(shown) })
      if (r.status === 'confirm' && !r.shadows) r = await api('/api/pick/add', { name, family: fam, confirm: true })
      if (r.status === 'confirm') pk.confirm[fam] = { name, shadows: r.shadows }
      else {
        const old = replaces && replaces !== name ? await api('/api/pick/remove', { name: replaces }) : null
        delete pk.renaming[fam]
        delete pk.drafts[fam]
        const later = S.state.shellSetup && !S.state.shellSetup.loaded
        pickToast([r, old], t((old ? 'pk.renamed' : 'pk.added') + (later ? 'Setup' : ''), { name, old: replaces }))
        await load({ silent: true })
      }
    } catch (e) { pk.error = e }
    if (!pk) return
    pk.busy = false
    if (dlg.kind === 'pick') renderPick()
  }
  async function pickRemove(name) {
    pk.busy = true
    pk.error = null
    renderPick()
    try {
      pickToast([await api('/api/pick/remove', { name })], t('pk.removed', { name }))
      await load({ silent: true })
    } catch (e) { pk.error = e }
    if (!pk) return
    pk.busy = false
    if (dlg.kind === 'pick') renderPick()
  }
  // The config is written first; a shell-init file sideby could not rewrite is said, not hidden behind "added".
  function pickToast(results, done) {
    const failed = results.filter(Boolean).flatMap((r) => (r.shellInitFiles || []).filter((f) => !f.ok).map((f) => f.message))
    if (failed.length) toast(t('pk.fileFailed', { msg: failed.join('; ') }), { kind: 'fail', duration: 12000 })
    else toast(done)
  }
  // A name field with what it would hide and its button; typing updates them in place, so the caret stays put.
  function nameEditor(fam, info, initial, replaces) {
    const id = 'pk-name-' + fam
    const input = h('input', { id, type: 'text', class: 'mono', autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', maxlength: '64', placeholder: t('pk.namePh'), disabled: pk.busy, 'aria-describedby': id + '-hint' })
    input.value = pk.drafts[fam] !== undefined ? pk.drafts[fam] : initial || ''
    const offer = (S.state.pickOffers || {})[fam]
    const note = h('p', { class: 'note' })
    const go = h('button', { class: 'btn btn-sm btn-primary', type: 'button' })
    const shadowsOf = (n) => {
      const asked = pk.confirm[fam]
      return asked && asked.name === n ? asked.shadows : offer && n && n === offer.name ? offer.shadows : null
    }
    const sync = () => {
      const n = input.value.trim()
      const shadows = shadowsOf(n)
      note.hidden = !shadows
      note.textContent = shadows ? t('pk.shadows', { name: n, path: shadows, host: info.title }) : ''
      go.textContent = t(shadows ? 'pk.addAnyway' : replaces ? 'pk.save' : 'pk.add')
      go.disabled = pk.busy || !n || n === replaces
    }
    const add = () => { const n = input.value.trim(); if (n && n !== replaces) pickAdd(fam, n, shadowsOf(n), replaces) }
    input.addEventListener('input', () => { pk.drafts[fam] = input.value; sync() })
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add() } })
    go.addEventListener('click', add)
    sync()
    return [
      h('label', { class: 'field', for: id }, h('span', null, t('pk.nameLabel', { host: info.title })), input),
      h('p', { class: 'field-hint', id: id + '-hint' }, t('pk.hint', { host: info.title })),
      note,
      h('div', { class: 'actions' }, go,
        replaces ? h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: pk.busy, onclick: () => { delete pk.renaming[fam]; delete pk.drafts[fam]; renderPick() } }, t('btn.cancel')) : null),
    ]
  }
  function renderPick() {
    if (!pk) return
    const body = [h('p', { class: 'muted small' }, t('pk.intro'))]
    const fams = pickFamilies()
    // Once a pick command exists, the line that makes terminals load it is the next step: first, not below the fold.
    const setupFirst = Object.keys(S.state.pickCommands || {}).length ? shellSetupNote() : null
    if (setupFirst) body.push(setupFirst)
    if (!fams.length) body.push(h('p', { class: 'note' }, t('pk.none')))
    for (const fam of fams) {
      const info = family(fam)
      const name = pickOf(fam)
      const head = h('div', { class: 'title-logo' }, badge(fam, 'sm'), h('b', null, info.title))
      if (name && pk.renaming[fam] && !BOOT.readOnly) {
        body.push(h('div', { class: 'pk-row' }, head, nameEditor(fam, info, name, name)))
        continue
      }
      if (name) {
        body.push(h('div', { class: 'pk-row' }, head,
          h('p', { class: 'small' }, h('code', { class: 'mono' }, name), ' ', t('pk.exists', { host: info.title })),
          h('div', { class: 'actions' },
            h('button', { class: 'btn btn-sm', type: 'button', disabled: pk.busy, onclick: () => startPick(name) }, icon('terminal'), pickStartLabel(), h('code', { class: 'mono' }, name)),
            BOOT.readOnly ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: pk.busy, onclick: () => { pk.renaming[fam] = true; renderPick(); const el = document.getElementById('pk-name-' + fam); if (el) el.focus() } }, t('pk.rename')),
            BOOT.readOnly ? null : h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: pk.busy, onclick: () => pickRemove(name) }, t('pk.remove')))))
        continue
      }
      if (BOOT.readOnly) continue
      body.push(h('div', { class: 'pk-row' }, head, nameEditor(fam, info, S.state.pickOffers[fam].name, null)))
    }
    if (fams.length && !setupFirst) body.push(shellSetupNote() || h('p', { class: 'muted small' }, t('pk.newShell')))
    if (pk.error) body.push(errorNote(pk.error, null))
    setKids(dlg.el, dialogFrame(t('pk.title'), null, body, [h('button', { class: 'btn', type: 'button', onclick: () => dlg.el.close() }, t('btn.close'))]))
  }
  // New terminals load short commands only through one line in the shell's rc file (ADR-0036). Where a short command
  // is added and that line is missing, say so and offer to add it: the line and the file shown are the preview.
  let ssBusy = false
  async function shellSetup(undo) {
    if (ssBusy) return
    ssBusy = true
    renderShellSetupHosts()
    try {
      const r = await api('/api/shell-init/setup', undo ? { undo: true } : {})
      if (r.status === 'added') toast(t('ss.added', { rc: r.rc }), { action: { label: t('ss.undo'), run: () => shellSetup(true) } })
      else if (r.status === 'removed') toast(t('ss.removed', { rc: r.rc }))
      await load({ silent: true })
    } catch (e) { toast(e.message, { kind: 'fail' }) }
    ssBusy = false
    renderShellSetupHosts()
  }
  function renderShellSetupHosts() {
    if (dlg.kind === 'pick' && pk) renderPick()
    else if (dlg.kind === 'create' && nf && nf.result) renderCreate()
  }
  function shellSetupNote() {
    const ss = S.state.shellSetup
    if (!ss || ss.loaded || BOOT.readOnly) return null
    const line = ss.block.split('\n').find((l) => l.startsWith('eval '))
    return h('div', { class: 'note note-warn ss-note', role: 'status' },
      h('div', { class: 'note-line' }, h('b', null, t('ss.title')), ' ', t('ss.body', { rc: ss.rc })),
      h('code', { class: 'mono note-line' }, line),
      h('button', { class: 'btn btn-sm btn-primary', type: 'button', disabled: ssBusy, onclick: () => shellSetup(false) }, ssBusy ? t('ss.adding') : t('ss.add', { rc: ss.rc })))
  }
  // The label ends in a colon and the command name follows: a space after an English colon, none after a Chinese one.
  function pickStartLabel() { const l = t('pk.start'); return /[:：]$/.test(l) && lang !== 'zh' ? l + ' ' : l }
  // In a tool's group head: the button that starts the account with the most room, or the offer to add one.
  function pickHead(fam) {
    const name = pickOf(fam)
    // On a narrow screen only the icon and the name stay; the words are in the hover text and the label.
    if (name) return h('button', { class: 'btn btn-sm', type: 'button', title: t('pk.startTip', { name, host: family(fam).title }), 'aria-label': t('pk.startTip', { name, host: family(fam).title }), onclick: () => startPick(name) }, icon('terminal'), h('span', { class: 'hide-sm' }, pickStartLabel()), h('code', { class: 'mono' }, name))
    const offer = (S.state.pickOffers || {})[fam]
    if (!offer || BOOT.readOnly) return null
    // Short in the head ("Add cc"); what it does is in its hover text, so several groups do not repeat a sentence.
    const full = offer.name ? t('pk.offerShort', { name: offer.name }) + t('pk.offerMore') : t('pk.offerNoName')
    return h('button', { class: 'link-btn small', type: 'button', 'aria-label': full, 'data-tip': full, onclick: () => openPick(fam) }, offer.name ? t('pk.offerShort', { name: offer.name }) : t('pk.offerNoNameShort'))
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
        // About the accounts' quota, so it shows on the Accounts page only.
        const mb = curPage === 'accounts' ? menubarHint() : null
        if (mb) out.push(mb)
      }
      // On every page until answered: whether API accounts may still take over (ADR-0046).
      const apiBanner = hpApiBanner()
      if (apiBanner) out.push(apiBanner)
      const rcBanner = remoteControlBanner()
      if (rcBanner) out.push(rcBanner)
      const inbBanner = inboundBanner()
      if (inbBanner) out.push(inbBanner)
      const nb = netBanner()
      if (nb) out.push(nb)
      const errs = S.state.pluginErrors
      if (errs.length) out.push(h('div', { class: 'banner banner-warn', role: 'status' }, h('div', null,
        h('b', null, tn('banner.plugins', errs.length) + ' '), t('banner.pluginsHint'),
        h('ul', null, errs.map((e) => h('li', null, h('code', null, e.where), colon(), e.message))))))
    }
    patch($('banners'), out)
    growInboundBanner()
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
    sessionsTick()
    messagesTick()
    if (document.visibilityState !== 'visible' || !S.state) return
    if (S.pending && !S.loading && !uiBusy()) { S.pending = false; renderAll() }
    const now = Date.now()
    // An Account still being read is asked for again soon, so it fills in without waiting for the next round.
    // For half a minute: the server says "took too long" after a minute, which the normal round then shows.
    const pending = S.state.accounts.some((a) => a.pending)
    if (!pending) S.pendingSince = 0
    else if (!S.pendingSince) S.pendingSince = now
    const every = pending && now - S.pendingSince < 30_000 ? PENDING_MS : now < S.fastUntil ? FAST_MS : AUTO_MS
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
  // The switches' state is read now, not when Settings opens, so the popover opens at its final size.
  loadAutostart()
  // The sessions too, so the Sessions page opens with its rows already there.
  loadSessions()
  setInterval(tick, 1000)
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('focus', wake)
`

/** The page script: the tested helpers, then the page logic, in one strict-mode function. */
export const PAGE_SCRIPT = `(() => {\n  'use strict'\n${LOGIC}\n${MAIN}})()\n`
