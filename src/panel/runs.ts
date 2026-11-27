// WHY: Live Run Board HTTP routes and self-contained HTML UI for `/runs`, `/runs/<id>`, and `/api/runs*`.
// Keeps `handler.ts` minimal while reusing sideby's theme tokens, CSP headers, and `createChangeFeed`.
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LiveSession, LiveSessionsResult } from '../core/live-sessions.ts'
import { findRunSummary, isValidRunId, listRuns, readLiveRun, runWatchTargets } from '../core/run-board.ts'
import type { Runtime } from '../runtime.ts'
import { createChangeFeed, IDLE_MS } from './changes.ts'
import { tokenStyles } from './page-styles.ts'
import type { ResolvedTheme } from './theme.ts'

const LIVE_SESSIONS_TIMEOUT_MS = 1500

export interface RunsRouteDeps {
  getRuntime: () => Promise<Runtime>
  liveSessions: (rt: Runtime) => Promise<LiveSessionsResult>
  basePath: string
  lang: 'auto' | 'en' | 'zh'
  resolvePageTheme: (
    req: IncomingMessage,
    method: string,
  ) => Promise<{ pageTheme: ResolvedTheme; panelTheme?: string; panelLang?: string }>
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
  onHttpError: (status: number, message: string, code?: string) => never
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

function htmlHeaders(nonce: string): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ].join('; '),
  }
}

const RUNS_CSS = `
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: var(--font); font-size: 13px; line-height: 1.5; font-variant-numeric: tabular-nums; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: var(--mono); font-size: 12px; }
pre { margin: 8px 0 0; padding: 10px 12px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--border); overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
.wrap { max-width: 960px; margin: 0 auto; padding: 24px 20px 56px; }
.topbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.nav-links { display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--muted); }
.nav-links a { color: var(--muted); font-weight: 500; }
.nav-links a:hover { color: var(--accent); }
.live-pill { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: var(--radius-pill); border: 1px solid var(--border); background: var(--surface); font-size: 12px; color: var(--muted); transition: background var(--duration-base) var(--ease-out), border-color var(--duration-base) var(--ease-out); }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--muted); }
.live-pill.is-live { color: var(--text); border-color: var(--ok-bar); }
.live-pill.is-live .live-dot { background: var(--ok-bar); }
.live-pill.is-poll .live-dot { background: var(--warn-bar); }
.live-pill.is-closed .live-dot { background: var(--faint); }
.header-block { margin-bottom: 20px; }
.eyebrow { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 4px; }
h1 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.35; letter-spacing: -0.02em; }
h2 { margin: 0 0 10px; font-size: 15px; font-weight: 600; }
.meta { font-size: 12px; color: var(--muted); }
.hero { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
@media (max-width: 680px) { .hero { grid-template-columns: 1fr; } }
.tile { padding: 14px 16px; border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); transition: border-color var(--duration-fast) var(--ease-out); }
.tile.tone-ask { border-color: var(--warn-bar); background: color-mix(in srgb, var(--warn-bar) 8%, var(--surface)); }
.tile.tone-ok { border-color: color-mix(in srgb, var(--ok-bar) 45%, var(--border)); }
.tile-k { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.tile-v { font-size: 18px; font-weight: 600; line-height: 1.3; }
.tile-s { font-size: 12px; color: var(--muted); margin-top: 4px; }
.section { margin-bottom: 20px; }
.card { border-radius: var(--radius); background: var(--surface); border: 1px solid var(--border); overflow: hidden; }
.row { padding: 14px 16px; border-top: 1px solid var(--border); }
.row:first-child { border-top: 0; }
.banner { padding: 10px 14px; border-radius: var(--radius-md); background: color-mix(in srgb, var(--warn-bar) 12%, var(--surface)); border: 1px solid var(--warn-bar); margin-bottom: 16px; font-size: 13px; }
.ask-row { background: color-mix(in srgb, var(--warn-bar) 6%, var(--surface)); }
.ask-q { font-size: 14px; font-weight: 600; margin-bottom: 6px; }
.ask-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 10px; }
.btn { display: inline-flex; align-items: center; gap: 6px; height: var(--ctl-h-sm); padding: 0 12px; border-radius: var(--ctl-radius); border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-family: var(--font); font-size: 12px; font-weight: 500; cursor: pointer; transition: background var(--duration-fast) var(--ease-out), border-color var(--duration-fast) var(--ease-out); }
.btn:hover { border-color: var(--accent); color: var(--accent); }
.btn:disabled { opacity: 0.45; cursor: not-allowed; }
.btn:disabled:hover { border-color: var(--border); color: var(--text); }
.btn-primary { background: var(--primary); color: var(--on-primary); border-color: var(--primary); }
.btn-primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: var(--on-primary); }
.btn-primary:disabled:hover { background: var(--primary); border-color: var(--primary); color: var(--on-primary); }
.outward-meta { margin-top: 6px; padding: 8px 10px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--border); font-size: 12px; }
.ask-warn { color: var(--warn-bar); font-size: 12px; font-weight: 500; }
.step-row { display: grid; grid-template-columns: 24px 1fr auto; gap: 10px; align-items: start; padding: 10px 16px; border-top: 1px solid var(--border); }
.step-row:first-child { border-top: 0; }
.step-badge { width: 22px; height: 22px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 600; background: var(--surface-2); color: var(--muted); border: 1px solid var(--border); }
.step-badge.is-done { background: color-mix(in srgb, var(--ok-bar) 18%, var(--surface)); color: var(--ok-bar); border-color: var(--ok-bar); }
.step-badge.is-working { background: var(--accent-soft); color: var(--accent); border-color: var(--accent); }
.step-badge.is-blocked { background: color-mix(in srgb, var(--err-bar) 18%, var(--surface)); color: var(--err-bar); border-color: var(--err-bar); }
.subhead { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 16px; background: var(--surface-2); border-top: 1px solid var(--border); font-size: 12px; font-weight: 600; color: var(--muted); }
.subhead:first-child { border-top: 0; }
.sync-tag { display: inline-flex; align-items: center; gap: 5px; padding: 1px 8px; border-radius: var(--radius-pill); background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 500; }
.lane-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; }
.lane-title { font-size: 14px; font-weight: 600; }
.pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.pill { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: var(--radius-pill); font-size: 11px; font-weight: 500; border: 1px solid var(--border); background: var(--surface-2); color: var(--muted); }
.pill.s-working, .pill.s-busy { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.pill.s-done, .pill.s-finished { color: var(--ok-bar); border-color: var(--ok-bar); background: color-mix(in srgb, var(--ok-bar) 12%, var(--surface)); }
.pill.s-needs-you, .pill.s-attention { color: var(--warn-bar); border-color: var(--warn-bar); background: color-mix(in srgb, var(--warn-bar) 14%, var(--surface)); }
.pill.s-failed { color: var(--err-bar); border-color: var(--err-bar); background: color-mix(in srgb, var(--err-bar) 14%, var(--surface)); }
.activity { margin: 4px 0 6px; color: var(--text); word-break: break-word; }
.activity-label { color: var(--muted); margin-right: 6px; font-size: 12px; }
details { margin-top: 8px; }
summary { cursor: pointer; font-size: 12px; color: var(--muted); user-select: none; }
summary:hover { color: var(--accent); }
.facts { display: grid; grid-template-columns: 110px 1fr; gap: 4px 12px; margin: 8px 0 0; font-size: 12px; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; word-break: break-word; }
.run-card { display: block; padding: 14px 16px; border-top: 1px solid var(--border); color: inherit; transition: background var(--duration-fast) var(--ease-out); }
.run-card:first-child { border-top: 0; }
.run-card:hover { background: var(--surface-2); text-decoration: none; }
.run-card-top { display: flex; flex-wrap: nowrap; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 4px; }
.run-card-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--text); }
.run-card-top .pill { flex: none; white-space: nowrap; }
.empty { padding: 32px 20px; text-align: center; color: var(--muted); }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
`

const RUNS_CLIENT_SCRIPT = `
(() => {
  const cfg = window.__SIDEBY_RUNS__ || {};
  const base = cfg.basePath || '';
  const runId = cfg.runId || null;
  const pickLang = () => {
    const fixed = cfg.lang && cfg.lang !== 'auto' ? cfg.lang : cfg.panelLang;
    if (fixed === 'zh' || fixed === 'en') return fixed;
    return (navigator.language || '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
  };
  const lang = pickLang();
  const zh = lang === 'zh';
  const T = zh ? {
    backPanel: '← 面板', backRuns: '← 所有任务', runsTitle: '实时任务看板', runsSub: '自动同步每个任务的最新进度，无需手动刷新。',
    activeRuns: '进行中', closedRuns: '最近已结束', emptyRuns: '当前没有任务记录', emptyHint: '派发多 Agent 任务后，这里会自动出现实时看板。',
    live: '实时连接', poll: '轮询刷新', closed: '已结束', paused: '已叫停：主控 AI 正在收尾当前任务。',
    needsYou: '需要你吗', noAction: '不用管', noActionSub: 'AI 正在推进，有事会喊你', asksWait: (n) => n + ' 件事等你', asksWaitSub: '查看下方问题并回复主对话',
    activeTasks: '正在做', tasksCount: (n) => n + ' 个任务', noQueue: '没有排队或等待', queued: (n) => n + ' 个排队', waits: (n) => n + ' 项等待',
    timeCost: '时间 · 花费', startedAt: '开始于 ', costUnknown: '花费未知',
    openAsks: '等你回答', recommend: '建议：', reason: '理由：', impact: '影响：', copyReply: '复制推荐答复', copied: '已复制',
    toLabel: '发给：', channelLabel: '渠道：', missingField: '（缺失）',
    outwardIncomplete: '外发信息不完整（缺少收件人、渠道或完整草稿），请回主对话补全后再确认',
    steps: '进度步骤', ledgerSteps: '账本步骤', autoSteps: '实时同步自会话',
    activeLanes: '现在在做', runningWaits: '外部等待', outputs: '阶段产出', decisions: '已做决定',
    finishedLanes: (n) => '已完成任务（' + n + ' 个）', grants: '长期授权',
    doing: '正在', result: '结果', details: '技术细节', logTail: '查看日志尾行',
    notFound: '找不到这个任务', loadError: '读取失败，稍后自动重试', updated: '更新于 ',
    states: { done: '完成', failed: '失败', stopped: '已停', 'needs-you': '等你', attention: '待处理', finished: '待验收', queued: '排队', working: '进行中', blocked: '受阻', busy: '运行中', idle: '空闲', unknown: '未知' },
    lanesSummary: (a, t) => a + '/' + t + ' 任务活跃', stepsSummary: (d, t) => '步骤 ' + d + '/' + t, asksSummary: (n) => n + ' 个待回答'
  } : {
    backPanel: '← Panel', backRuns: '← All runs', runsTitle: 'Live Run Board', runsSub: 'Progress updates automatically from run files and session transcripts.',
    activeRuns: 'Active runs', closedRuns: 'Recent closed', emptyRuns: 'No active runs yet', emptyHint: 'Dispatched multi-agent runs appear here automatically.',
    live: 'Live', poll: 'Polling', closed: 'Closed', paused: 'Paused: no new lanes will start while current work wraps up.',
    needsYou: 'Needs you', noAction: 'All clear', noActionSub: 'Agents are progressing; asks appear here', asksWait: (n) => n + ' waiting', asksWaitSub: 'Review open asks below and reply in your chat',
    activeTasks: 'Active', tasksCount: (n) => n + ' lane' + (n === 1 ? '' : 's'), noQueue: 'No queued lanes or waits', queued: (n) => n + ' queued', waits: (n) => n + ' waiting',
    timeCost: 'Time · Cost', startedAt: 'Started ', costUnknown: 'Cost unknown',
    openAsks: 'Open asks', recommend: 'Recommended: ', reason: 'Reason: ', impact: 'Blocks: ', copyReply: 'Copy recommended reply', copied: 'Copied',
    toLabel: 'To: ', channelLabel: 'Channel: ', missingField: '(missing)',
    outwardIncomplete: 'Outward details incomplete (missing recipient, channel, or full draft); complete them in your chat before approving',
    steps: 'Progress steps', ledgerSteps: 'Ledger steps', autoSteps: 'Auto-synced from session',
    activeLanes: 'Active lanes', runningWaits: 'Running waits', outputs: 'Produced outputs', decisions: 'Decisions',
    finishedLanes: (n) => 'Finished lanes (' + n + ')', grants: 'Standing grants',
    doing: 'Now', result: 'Result', details: 'Technical details', logTail: 'Log tail',
    notFound: 'Run not found', loadError: 'Could not load run; retrying automatically', updated: 'Updated ',
    states: { done: 'Done', failed: 'Failed', stopped: 'Stopped', 'needs-you': 'Needs you', attention: 'Attention', finished: 'Finished', queued: 'Queued', working: 'Working', blocked: 'Blocked', busy: 'Busy', idle: 'Idle', unknown: 'Unknown' },
    lanesSummary: (a, t) => a + '/' + t + ' active', stepsSummary: (d, t) => 'Steps ' + d + '/' + t, asksSummary: (n) => n + ' ask' + (n === 1 ? '' : 's')
  };

  const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  const fmtClock = (iso) => {
    if (!iso) return '-';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '-';
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const fmtDuration = (ms) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '-';
    const mins = Math.max(0, Math.floor(ms / 60000));
    if (mins < 1) return zh ? '不到 1 分钟' : '<1m';
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? (zh ? h + ' 小时 ' + m + ' 分' : h + 'h ' + m + 'm') : (zh ? m + ' 分钟' : m + 'm');
  };
  const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
  const stateLabel = (s) => T.states[s] || s || '';
  const root = document.getElementById('app');

  const patchRoot = (html) => {
    const openIds = new Set();
    root.querySelectorAll('details[id]').forEach((d) => { if (d.open) openIds.add(d.id); });
    const activeId = document.activeElement && document.activeElement.id ? document.activeElement.id : null;
    const scrollY = window.scrollY;
    root.innerHTML = html;
    openIds.forEach((id) => { const el = document.getElementById(id); if (el && el.tagName === 'DETAILS') el.open = true; });
    if (activeId) { const el = document.getElementById(activeId); if (el && typeof el.focus === 'function') el.focus({ preventScroll: true }); }
    window.scrollTo(window.scrollX, scrollY);
  };

  root.addEventListener('click', async (ev) => {
    const btn = ev.target && ev.target.closest ? ev.target.closest('[data-copy]') : null;
    if (!btn || btn.disabled) return;
    const text = btn.getAttribute('data-copy') || '';
    try {
      await navigator.clipboard.writeText(text);
      const prev = btn.textContent;
      btn.textContent = T.copied;
      setTimeout(() => { btn.textContent = prev; }, 1500);
    } catch {}
  });

  if (!runId) {
    let lastSig = '';
    const renderIndex = (runs) => {
      const sig = JSON.stringify(runs);
      if (sig === lastSig) return;
      lastSig = sig;
      const active = runs.filter((r) => r.state === 'active');
      const closed = runs.filter((r) => r.state === 'closed');
      const card = (r) => {
        const meta = [T.lanesSummary(r.activeLanes, r.totalLanes)];
        if (r.stepsTotal) meta.push(T.stepsSummary(r.stepsDone, r.stepsTotal));
        if (r.openAsks) meta.push(T.asksSummary(r.openAsks));
        if (r.updatedAt) meta.push(fmtClock(r.updatedAt));
        return '<a class="run-card" href="' + esc(base + '/runs/' + encodeURIComponent(r.id)) + '">' +
          '<div class="run-card-top"><span class="run-card-title">' + esc(r.objective) + '</span>' +
          '<span class="pill ' + (r.state === 'active' ? 's-working' : 's-done') + '">' + esc(r.state === 'active' ? T.activeRuns : T.closed) + '</span></div>' +
          '<div class="meta">' + esc(r.id + ' · ' + meta.join(' · ')) + '</div></a>';
      };
      let html = '<div class="topbar"><div class="nav-links"><a href="' + esc(base || '/') + '">' + esc(T.backPanel) + '</a></div>' +
        '<span class="live-pill is-live"><span class="live-dot"></span>' + esc(T.live) + '</span></div>' +
        '<div class="header-block"><h1>' + esc(T.runsTitle) + '</h1><div class="meta">' + esc(T.runsSub) + '</div></div>';
      if (!runs.length) {
        html += '<div class="card empty"><div>' + esc(T.emptyRuns) + '</div><div class="meta" style="margin-top:6px">' + esc(T.emptyHint) + '</div></div>';
      } else {
        if (active.length) html += '<div class="section"><h2>' + esc(T.activeRuns) + ' (' + active.length + ')</h2><div class="card">' + active.map(card).join('') + '</div></div>';
        if (closed.length) html += '<div class="section"><h2>' + esc(T.closedRuns) + ' (' + closed.length + ')</h2><div class="card">' + closed.map(card).join('') + '</div></div>';
      }
      patchRoot(html);
    };
    const loadIndex = async () => {
      try {
        const res = await fetch(base + '/api/runs', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        renderIndex(Array.isArray(data.runs) ? data.runs : []);
      } catch {}
    };
    void loadIndex();
    setInterval(loadIndex, 5000);
    return;
  }

  let lastFp = '';
  let watching = true;
  let lastData = null;

  const renderStepList = (items) => items.map((s, i) => {
    const cls = s.state === 'done' ? 'is-done' : s.state === 'working' ? 'is-working' : s.state === 'blocked' ? 'is-blocked' : '';
    const icon = s.state === 'done' ? '✓' : String(i + 1);
    return '<div class="step-row"><span class="step-badge ' + cls + '">' + esc(icon) + '</span>' +
      '<div><div>' + esc(s.title) + '</div>' + (s.note ? '<div class="meta">' + esc(s.note) + '</div>' : '') + '</div>' +
      '<span class="pill s-' + esc(s.state) + '">' + esc(stateLabel(s.state)) + '</span></div>';
  }).join('');

  const renderLane = (l) => {
    const ended = l.liveState === 'done' || l.liveState === 'failed' || l.liveState === 'stopped';
    const actText = ended ? (l.summary || l.note || l.activity || '-') : (l.activity || l.note || (l.waitingOn.length ? (zh ? '等待：' : 'Waiting: ') + l.waitingOn.join(', ') : '-'));
    const facts = [];
    const addFact = (k, v) => { if (v) facts.push('<dt>' + esc(k) + '</dt><dd><code>' + esc(v) + '</code></dd>'); };
    addFact('ID', l.id);
    addFact(zh ? '账号' : 'Account', l.account);
    addFact(zh ? '角色' : 'Role', l.role);
    addFact(zh ? '分支' : 'Branch', l.branch);
    addFact(zh ? '目录' : 'Worktree', l.worktree);
    addFact(zh ? '会话' : 'Session', l.sessionLabel || l.sessionId);
    addFact(zh ? '轮次' : 'Round', String(l.round));
    if (l.tokens) addFact('Tokens', 'in ' + fmtTok(l.tokens.input) + ' / out ' + fmtTok(l.tokens.output));
    const meta = [];
    if (l.elapsedMs !== undefined) meta.push(fmtDuration(l.elapsedMs));
    if (typeof l.costUsd === 'number') meta.push('$' + l.costUsd.toFixed(2));
    return '<div class="row" id="lane-' + esc(l.id) + '">' +
      '<div class="lane-head"><span class="lane-title">' + esc(l.title) + '</span><span class="pills">' +
      (l.sessionStatus ? '<span class="pill s-' + esc(l.sessionStatus) + '">' + esc(stateLabel(l.sessionStatus)) + '</span>' : '') +
      '<span class="pill s-' + esc(l.liveState) + '">' + esc(stateLabel(l.liveState)) + '</span></span></div>' +
      '<div class="activity"><span class="activity-label">' + esc(ended ? T.result : T.doing) + '</span>' + esc(actText) + '</div>' +
      (meta.length ? '<div class="meta">' + esc(meta.join(' · ')) + '</div>' : '') +
      '<details id="lane-details-' + esc(l.id) + '"><summary>' + esc(T.details) + '</summary><dl class="facts">' + facts.join('') + '</dl></details></div>';
  };

  const renderRun = (d) => {
    lastData = d;
    const closed = d.state === 'closed';
    const endedSet = new Set(['done', 'failed', 'stopped']);
    const activeLanes = d.lanes.filter((l) => !endedSet.has(l.liveState));
    const finishedLanes = d.lanes.filter((l) => endedSet.has(l.liveState));
    const openAsks = d.asks.filter((a) => a.state === 'open');
    const runningWaits = d.waits.filter((w) => !endedSet.has(w.state));
    const needs = openAsks.length + activeLanes.filter((l) => l.liveState === 'needs-you' && !l.openAsks.length).length;
    const queuedCount = activeLanes.filter((l) => l.liveState === 'queued').length;
    const costSum = d.lanes.reduce((acc, l) => typeof l.costUsd === 'number' ? acc + l.costUsd : acc, 0);
    const hasCost = d.lanes.some((l) => typeof l.costUsd === 'number');
    const badgeCls = closed ? 'is-closed' : watching ? 'is-live' : 'is-poll';
    const badgeTxt = closed ? T.closed : watching ? T.live : T.poll;

    const busyParts = [];
    if (queuedCount) busyParts.push(T.queued(queuedCount));
    if (runningWaits.length) busyParts.push(T.waits(runningWaits.length));

    let html = '<div class="topbar"><div class="nav-links">' +
      '<a href="' + esc(base + '/runs') + '">' + esc(T.backRuns) + '</a><span>·</span>' +
      '<a href="' + esc(base || '/') + '">' + esc(T.backPanel) + '</a></div>' +
      '<span class="live-pill ' + badgeCls + '"><span class="live-dot"></span>' + esc(badgeTxt) +
      ' · ' + esc(T.updated + fmtClock(d.updatedAt || d.createdAt || new Date().toISOString())) + '</span></div>';

    html += '<div class="header-block"><div class="eyebrow">' + esc(d.id) + (d.coordinator ? ' · ' + esc(d.coordinator) : '') + '</div>' +
      '<h1>' + esc(d.objective) + '</h1></div>';

    if (d.paused) html += '<div class="banner">' + esc(T.paused) + '</div>';

    html += '<div class="hero">' +
      '<div class="tile ' + (needs ? 'tone-ask' : 'tone-ok') + '"><div class="tile-k">' + esc(T.needsYou) + '</div><div class="tile-v">' + esc(needs ? T.asksWait(needs) : T.noAction) + '</div><div class="tile-s">' + esc(needs ? T.asksWaitSub : T.noActionSub) + '</div></div>' +
      '<div class="tile"><div class="tile-k">' + esc(T.activeTasks) + '</div><div class="tile-v">' + esc(T.tasksCount(activeLanes.length)) + '</div><div class="tile-s">' + esc(busyParts.join(' · ') || T.noQueue) + '</div></div>' +
      '<div class="tile"><div class="tile-k">' + esc(T.timeCost) + '</div><div class="tile-v">' + esc(T.startedAt + fmtClock(d.createdAt)) + '</div><div class="tile-s">' + esc(hasCost ? '$' + costSum.toFixed(2) : T.costUnknown) + '</div></div></div>';

    if (openAsks.length) {
      html += '<div class="section"><h2>' + esc(T.openAsks) + '</h2><div class="card">' +
        openAsks.map((a) => {
          const reply = a.id + (zh ? '：按推荐办' : ': go with recommendation');
          const outward = Boolean(a.outward);
          const incomplete = outward && (!a.recipient || !a.channel || !a.draft || Boolean(a.recipientTruncated) || Boolean(a.channelTruncated) || Boolean(a.draftTruncated));
          const outwardHtml = outward
            ? '<div class="outward-meta">' +
                '<div><strong>' + esc(T.toLabel) + '</strong>' + esc(a.recipient || T.missingField) + '</div>' +
                '<div><strong>' + esc(T.channelLabel) + '</strong>' + esc(a.channel || T.missingField) + '</div>' +
              '</div>'
            : '';
          return '<div class="row ask-row" id="ask-' + esc(a.id) + '"><div class="ask-q">' + esc(a.id + ' · ' + a.question) + '</div>' +
            (a.recommend ? '<div>' + esc(T.recommend + a.recommend) + '</div>' : '') +
            (a.evidence ? '<div class="meta">' + esc(T.reason + a.evidence) + '</div>' : '') +
            (a.blocks ? '<div class="meta">' + esc(T.impact + a.blocks) + '</div>' : '') +
            outwardHtml +
            (a.draft ? '<pre class="ask-draft">' + esc(a.draft) + '</pre>' : '') +
            '<div class="ask-actions"><button type="button" class="btn btn-primary" id="copy-ask-' + esc(a.id) + '" data-copy="' + esc(reply) + '"' + (incomplete ? ' disabled aria-disabled="true"' : '') + '>' + esc(T.copyReply) + '</button>' +
            (incomplete ? '<span class="ask-warn">' + esc(T.outwardIncomplete) + '</span>' : '') +
            '</div></div>';
        }).join('') + '</div></div>';
    }

    const hasSteps = d.steps.length > 0;
    const hasAuto = d.autoSteps && Array.isArray(d.autoSteps.items) && d.autoSteps.items.length > 0;
    if (hasSteps || hasAuto) {
      html += '<div class="section"><h2>' + esc(T.steps) + '</h2><div class="card">';
      if (hasAuto) {
        html += '<div class="subhead"><span>' + esc(T.autoSteps) + '</span><span class="sync-tag">' + esc(d.autoSteps.source) + (d.autoSteps.updatedAt ? ' · ' + esc(fmtClock(d.autoSteps.updatedAt)) : '') + '</span></div>' +
          renderStepList(d.autoSteps.items);
      }
      if (hasSteps) {
        if (hasAuto) html += '<div class="subhead"><span>' + esc(T.ledgerSteps) + '</span></div>';
        html += renderStepList(d.steps);
      }
      html += '</div></div>';
    }

    if (activeLanes.length) {
      html += '<div class="section"><h2>' + esc(T.activeLanes) + '</h2><div class="card">' + activeLanes.map(renderLane).join('') + '</div></div>';
    }

    if (runningWaits.length) {
      html += '<div class="section"><h2>' + esc(T.runningWaits) + '</h2><div class="card">' +
        runningWaits.map((w) => '<div class="row"><div><strong>' + esc(w.title) + '</strong> <span class="pill s-working">' + esc(w.state) + '</span></div>' +
          (w.stage ? '<div class="meta">' + esc(w.stage) + '</div>' : '') +
          (w.lastLine || w.log ? '<details id="wait-' + esc(w.id) + '"><summary>' + esc(T.logTail) + '</summary><pre>' + esc([w.lastLine, w.log].filter(Boolean).join('\\n')) + '</pre></details>' : '') +
          '</div>').join('') + '</div></div>';
    }

    if (d.outputs.length) {
      html += '<div class="section"><h2>' + esc(T.outputs) + '</h2><div class="card">' +
        d.outputs.map((o) => '<div class="row"><div><strong>' + esc(o.title) + '</strong></div>' +
          (o.summary ? '<div>' + esc(o.summary) + '</div>' : '') +
          (o.evidence || o.meta || o.path ? '<div class="meta">' + esc(o.evidence || o.meta || o.path) + '</div>' : '') + '</div>').join('') + '</div></div>';
    }

    if (d.decisions.length) {
      html += '<div class="section"><h2>' + esc(T.decisions) + '</h2><div class="card">' +
        d.decisions.map((dec, i) => '<div class="row"><div><strong>' + esc(dec.what) + '</strong>: ' + esc(dec.choice) + '</div>' +
          (dec.why ? '<div class="meta">' + esc(dec.why) + '</div>' : '') +
          (dec.options ? '<details id="decision-' + i + '"><summary>' + esc(zh ? '备选方案' : 'Alternatives') + '</summary><pre>' + esc(dec.options) + '</pre></details>' : '') + '</div>').join('') + '</div></div>';
    }

    if (finishedLanes.length) {
      html += '<div class="section"><div class="card"><div class="row"><details id="finished-lanes"><summary>' + esc(T.finishedLanes(finishedLanes.length)) + '</summary>' +
        finishedLanes.map(renderLane).join('') + '</details></div></div></div>';
    }

    if (d.grants.length) {
      html += '<div class="section"><h2>' + esc(T.grants) + '</h2><div class="card">' +
        d.grants.map((g) => '<div class="row"><div>' + esc(g.scope) + '</div>' + (g.words ? '<div class="meta">' + esc(g.words) + '</div>' : '') + '</div>').join('') + '</div></div>';
    }

    patchRoot(html);
  };

  let fetchInFlight = null;
  const fetchRun = async () => {
    if (fetchInFlight) return fetchInFlight;
    fetchInFlight = (async () => {
      try {
        const res = await fetch(base + '/api/runs/' + encodeURIComponent(runId), { cache: 'no-store' });
        if (res.status === 404) {
          lastFp = '';
          lastData = null;
          patchRoot('<div class="topbar"><div class="nav-links"><a href="' + esc(base + '/runs') + '">' + esc(T.backRuns) + '</a></div></div><div class="card empty">' + esc(T.notFound) + '</div>');
          return false;
        }
        if (!res.ok) return false;
        const data = await res.json();
        if (data.fingerprint !== lastFp) {
          lastFp = data.fingerprint || '';
          renderRun(data);
        }
        return true;
      } catch {
        if (!lastData) {
          lastFp = '';
          patchRoot('<div class="card empty">' + esc(T.loadError) + '</div>');
        }
        return false;
      } finally {
        fetchInFlight = null;
      }
    })();
    return fetchInFlight;
  };

  const resyncMs = typeof cfg.resyncMs === 'number' && cfg.resyncMs > 0 ? cfg.resyncMs : 6000;
  let stopped = false;
  const resyncTimer = setInterval(() => {
    if (stopped) return;
    if (document.visibilityState === 'hidden') return;
    if (lastData && lastData.state === 'closed') return;
    void fetchRun();
  }, resyncMs);
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (!stopped && document.visibilityState !== 'hidden' && (!lastData || lastData.state !== 'closed')) {
        void fetchRun();
      }
    });
  }
  window.__SIDEBY_RUNS_STOP__ = () => {
    stopped = true;
    clearInterval(resyncTimer);
  };

  const watchLoop = async () => {
    let seq = null;
    while (!stopped) {
      const firstSub = seq === null;
      const url = base + '/api/runs/' + encodeURIComponent(runId) + '/changes' + (firstSub ? '' : '?since=' + seq);
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) {
          watching = false;
          await new Promise((r) => setTimeout(r, resyncMs));
          await fetchRun();
          continue;
        }
        const ans = await res.json();
        const wasWatching = watching;
        watching = Boolean(ans.watching);
        if (wasWatching !== watching && lastData) renderRun(lastData);
        seq = typeof ans.seq === 'number' ? ans.seq : seq;
        if (firstSub || ans.changed) await fetchRun();
        if (!watching) {
          await new Promise((r) => setTimeout(r, resyncMs));
          await fetchRun();
        }
      } catch {
        watching = false;
        await new Promise((r) => setTimeout(r, resyncMs));
        await fetchRun();
      }
    }
  };

  void fetchRun().then(() => watchLoop());
})();
`

export function renderRunsPage(opts: {
  basePath: string
  runId?: string
  nonce: string
  theme: ResolvedTheme
  lang: 'auto' | 'en' | 'zh'
  panelTheme?: string
  panelLang?: string
}): string {
  const dataTheme =
    opts.panelTheme === 'light' || opts.panelTheme === 'dark' ? ` data-theme="${opts.panelTheme}"` : ''
  const title = opts.runId ? `Run ${opts.runId} · sideby` : 'Live Runs · sideby'
  const boot = jsonForScript({
    basePath: opts.basePath,
    runId: opts.runId ?? null,
    lang: opts.lang,
    panelLang: opts.panelLang ?? null,
  })
  return `<!doctype html>
<html lang="${opts.lang === 'zh' ? 'zh-CN' : 'en'}"${dataTheme}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="icon" href="${escapeHtml(opts.basePath)}/favicon.svg" type="image/svg+xml">
<style nonce="${escapeHtml(opts.nonce)}">${tokenStyles(opts.theme)}${RUNS_CSS}</style>
</head>
<body>
<main class="wrap" id="app"></main>
<script nonce="${escapeHtml(opts.nonce)}">window.__SIDEBY_RUNS__=${boot};${RUNS_CLIENT_SCRIPT}</script>
</body>
</html>`
}

async function liveSessionsBounded(
  rt: Runtime,
  fetchSessions: (rt: Runtime) => Promise<LiveSessionsResult>,
): Promise<LiveSession[]> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<LiveSession[]>((resolve) => {
    timer = setTimeout(() => resolve([]), LIVE_SESSIONS_TIMEOUT_MS).unref()
  })
  try {
    return await Promise.race([
      fetchSessions(rt).then(
        (r) => r.sessions,
        () => [] as LiveSession[],
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
  }
}

export function createRunsRoutes(deps: RunsRouteDeps) {
  const feeds = new Map<string, { feed: ReturnType<typeof createChangeFeed>; lastAsk: number }>()
  let sweep: NodeJS.Timeout | undefined

  const ensureSweep = () => {
    if (sweep) return
    sweep = setInterval(() => {
      const now = Date.now()
      for (const [id, entry] of feeds) {
        if (now - entry.lastAsk > IDLE_MS + 10_000) {
          entry.feed.close()
          feeds.delete(id)
        }
      }
      if (!feeds.size && sweep) {
        clearInterval(sweep)
        sweep = undefined
      }
    }, 15_000).unref()
  }

  const feedFor = (runId: string) => {
    let entry = feeds.get(runId)
    if (!entry) {
      entry = {
        feed: createChangeFeed({
          dirs: async () => {
            const rt = await deps.getRuntime()
            return runWatchTargets(rt.env, rt.paths.home, runId)
          },
        }),
        lastAsk: Date.now(),
      }
      feeds.set(runId, entry)
      ensureSweep()
    }
    entry.lastAsk = Date.now()
    return entry.feed
  }

  const checkSameSite = (req: IncomingMessage) => {
    if (req.headers['sec-fetch-site'] === 'cross-site') deps.onHttpError(403, 'origin not allowed')
  }

  const decodeId = (raw: string): string => {
    let decoded: string
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      deps.onHttpError(400, 'invalid run id', 'invalid-run-id')
    }
    if (!isValidRunId(decoded)) deps.onHttpError(400, 'invalid run id', 'invalid-run-id')
    return decoded
  }

  return {
    async handleGet(
      req: IncomingMessage,
      res: ServerResponse,
      sub: string,
      method: string,
    ): Promise<boolean> {
      if (sub === '/api/runs') {
        checkSameSite(req)
        const rt = await deps.getRuntime()
        const runs = await listRuns(rt.env, rt.paths.home)
        deps.sendJson(res, 200, { runs })
        return true
      }

      if (sub.startsWith('/api/runs/')) {
        checkSameSite(req)
        const rest = sub.slice('/api/runs/'.length)
        if (rest.endsWith('/changes')) {
          const rawId = rest.slice(0, -'/changes'.length)
          if (rawId.includes('/')) deps.onHttpError(400, 'invalid run id', 'invalid-run-id')
          const runId = decodeId(rawId)
          const rawSince = new URL(req.url ?? '/', 'http://x').searchParams.get('since')
          const since =
            method === 'GET' && rawSince !== null && /^\d{1,15}$/.test(rawSince) ? Number(rawSince) : null
          const gone = new Promise((done) => res.once('close', done))
          const answer = await feedFor(runId).wait(since, gone)
          if (!res.destroyed) deps.sendJson(res, 200, answer)
          return true
        }
        if (rest.includes('/')) deps.onHttpError(404, 'not found')
        const runId = decodeId(rest)
        const rt = await deps.getRuntime()
        const sessions = await liveSessionsBounded(rt, deps.liveSessions)
        const view = await readLiveRun(rt.env, rt.paths.home, runId, { sessions })
        if (!view) deps.onHttpError(404, 'run not found', 'not-found')
        deps.sendJson(res, 200, view)
        return true
      }

      if (sub === '/runs' || sub === '/runs/') {
        const nonce = randomBytes(16).toString('base64')
        const { pageTheme, panelTheme, panelLang } = await deps.resolvePageTheme(req, method)
        res.writeHead(200, htmlHeaders(nonce))
        res.end(
          method === 'HEAD'
            ? undefined
            : renderRunsPage({
                basePath: deps.basePath,
                nonce,
                theme: pageTheme,
                lang: deps.lang,
                panelTheme,
                panelLang,
              }),
        )
        return true
      }

      if (sub.startsWith('/runs/')) {
        const rest = sub.slice('/runs/'.length)
        if (rest.includes('/')) deps.onHttpError(404, 'not found')
        const runId = decodeId(rest)
        const rt = await deps.getRuntime()
        const found = await findRunSummary(rt.env, rt.paths.home, runId)
        const status = found ? 200 : 404
        const nonce = randomBytes(16).toString('base64')
        const { pageTheme, panelTheme, panelLang } = await deps.resolvePageTheme(req, method)
        res.writeHead(status, htmlHeaders(nonce))
        res.end(
          method === 'HEAD'
            ? undefined
            : renderRunsPage({
                basePath: deps.basePath,
                runId,
                nonce,
                theme: pageTheme,
                lang: deps.lang,
                panelTheme,
                panelLang,
              }),
        )
        return true
      }

      return false
    },
    close(): void {
      for (const entry of feeds.values()) entry.feed.close()
      feeds.clear()
      if (sweep) {
        clearInterval(sweep)
        sweep = undefined
      }
    },
  }
}
