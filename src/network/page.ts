// Self-contained Network Panel document, using the existing Panel tokens and Content Security Policy.
import { MARK_IMG } from '../core/brand-mark.ts'
import { FAVICON_VERSION, jsonForScript } from '../panel/page.ts'
import { pageStyles } from '../panel/page-styles.ts'
import { type ResolvedTheme, resolveTheme } from '../panel/theme.ts'
import { NETWORK_PAGE_SCRIPT } from './page-script.ts'

const MESSAGES = {
  en: {
    title: 'Network connection',
    tagline: 'Routes and local listeners visible to this Panel.',
    intro:
      'See the selected direct or redacted proxy route, its loopback TCP listener, and the cached Network Guard result for each target.',
    scope:
      'These facts come from this Panel process environment. Older sessions keep their own environment; run the sideby CLI in that terminal to diagnose them.',
    notCovered:
      'This Panel does not read or change WARP, DNS, macOS system proxy, or any other network setting.',
    diagnose: 'Diagnose connection',
    diagnoseAgain: 'Diagnose again',
    diagnosing: 'Diagnosing…',
    loading:
      'Running an offline diagnosis. No online trace is sent; a slow local TCP probe may take a moment.',
    diagnoseFailed: 'Diagnosis failed: {message}',
    checkedAt: 'Offline diagnosis at {when}. Cached Guard results have their own timestamps below.',
    empty: 'No guarded targets were found. Add or sign in to an account before diagnosing its route.',
    route: 'Selected route',
    direct: 'Direct connection; there is no proxy listener to test.',
    noListener:
      'No loopback TCP probe: the proxy is remote, invalid, or has no explicit port for this protocol.',
    listenerUp: 'Loopback TCP listener reachable at {host}:{port}.',
    listenerDown: 'Loopback TCP listener not reachable at {host}:{port} ({error}).',
    failed: 'failed',
    tcpLimit:
      'A reachable TCP listener does not prove that HTTP CONNECT, SOCKS, TLS, or upstream connectivity works.',
    'support.direct': 'Direct',
    'support.http-connect': 'HTTP CONNECT',
    'support.unsupported': 'Unsupported proxy',
    'support.invalid': 'Invalid proxy',
    unsupported:
      'Network Guard does not support this SOCKS or non-HTTP proxy route. Use HTTP CONNECT or direct before an online Guard check.',
    invalid: 'The proxy address is invalid. Correct the environment and start a new session.',
    'guard.ok': 'Cached Guard: allowed',
    'guard.blocked': 'Cached Guard: blocked',
    'guard.unknown': 'Cached Guard: unknown',
    'guard.not-checked': 'Cached Guard: not checked',
    guardChecked: 'Guard checked {when}',
    guardNever: 'Guard has no cached check',
    ask: 'Let AI diagnose',
    fixedOnly:
      'This fixed task contains only the current diagnostic facts above. No free text, attachments, account details, or other context is included.',
    actualPrompt: 'Exact prompt to send',
    promptLoading: 'Preparing the actual prompt…',
    promptChanged: 'The prompt changed. Review the new prompt and confirm again; nothing was opened.',
    confirm: 'Open in Orca',
    checkingPrompt: 'Checking prompt again…',
    cancel: 'Cancel',
    close: 'Close',
    opened: 'Orca was asked to open the diagnosis.',
    copyFallback: 'Orca could not be opened. Copy this command and run it in a terminal.',
    copy: 'Copy command',
    command: 'AI diagnosis command',
    requestFailed: 'Request failed ({status})',
  },
  zh: {
    title: '网络连接',
    tagline: '查看此 Panel 能读取的路由和本地 listener。',
    intro: '逐个 target 查看直连或脱敏代理路由、loopback TCP listener，以及缓存的 Network Guard 结果。',
    scope: '这些信息来自当前 Panel 进程的环境。旧会话保留自己的环境；请在对应终端运行 sideby CLI 诊断。',
    notCovered: '此 Panel 不读取或修改 WARP、DNS、macOS 系统代理及任何其他网络设置。',
    diagnose: '诊断连接',
    diagnoseAgain: '重新诊断',
    diagnosing: '正在诊断…',
    loading: '正在离线诊断，不会发送在线 trace。本地 TCP 探测较慢时需要稍等。',
    diagnoseFailed: '诊断失败：{message}',
    checkedAt: '离线诊断时间：{when}。缓存的 Guard 结果在下方单独标注时间。',
    empty: '没有找到受 Guard 管理的 target。请先添加或登录账号，再诊断它的路由。',
    route: '本次选择的路由',
    direct: '直连，没有代理 listener 要测试。',
    noListener: '未探测 loopback TCP：代理在远程、地址无效，或该协议没有明确端口。',
    listenerUp: 'loopback TCP listener 可连接：{host}:{port}。',
    listenerDown: 'loopback TCP listener 连不上：{host}:{port}（{error}）。',
    failed: '失败',
    tcpLimit: 'TCP 能连接不代表 HTTP CONNECT、SOCKS、TLS 或上游网络可用。',
    'support.direct': '直连',
    'support.http-connect': 'HTTP CONNECT',
    'support.unsupported': '不支持的代理',
    'support.invalid': '代理地址无效',
    unsupported:
      'Network Guard 不支持此 SOCKS 或非 HTTP 代理路由。在线 Guard 检查前，请改用 HTTP CONNECT 或直连。',
    invalid: '代理地址无效。请修正环境变量，再新开会话。',
    'guard.ok': '缓存 Guard：允许',
    'guard.blocked': '缓存 Guard：阻止',
    'guard.unknown': '缓存 Guard：未知',
    'guard.not-checked': '缓存 Guard：未检查',
    guardChecked: 'Guard 检查于 {when}',
    guardNever: 'Guard 没有缓存检查',
    ask: '让 AI 诊断',
    fixedOnly: '固定任务只包含上方当前诊断 facts，不含自由文本、附件、账号详情或其他 context。',
    actualPrompt: '将发送的完整提示词',
    promptLoading: '正在生成实际提示词…',
    promptChanged: '提示词有变化。请查看新提示词后再次确认；这次没有打开终端。',
    confirm: '在 Orca 中打开',
    checkingPrompt: '正在再次核对提示词…',
    cancel: '取消',
    close: '关闭',
    opened: '已请求 Orca 打开诊断任务。',
    copyFallback: '无法打开 Orca。请复制此命令到终端运行。',
    copy: '复制命令',
    command: 'AI 诊断命令',
    requestFailed: '请求失败（{status}）',
  },
}

export interface NetworkPageOptions {
  basePath: string
  token: string
  nonce?: string
  version?: string
  theme?: ResolvedTheme
  lang?: 'auto' | 'en' | 'zh'
}

const CSS = `
.network-main { min-width: 0; }
.network-hero { margin-bottom: 20px; }
.network-hero h2 { font-size: var(--title-size); font-weight: var(--title-weight); margin-bottom: 8px; }
.network-hero p { max-width: 760px; color: var(--muted); overflow-wrap: anywhere; }
.network-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 12px; }
.network-notes { display: grid; gap: 8px; margin: 16px 0 20px; }
.network-notes p { overflow-wrap: anywhere; }
#targets { display: grid; gap: 12px; min-width: 0; }
.net-target { min-width: 0; display: grid; gap: 10px; overflow: hidden; }
.net-target-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
.net-target h3 { min-width: 0; font-size: var(--heading-size); overflow-wrap: anywhere; }
.net-target .chip { flex: none; max-width: 100%; white-space: normal; text-align: center; }
.net-route { min-width: 0; overflow-wrap: anywhere; }
.net-route code { overflow-wrap: anywhere; }
.net-ok { color: var(--ok); }
.net-target .note { display: block; overflow-wrap: anywhere; }
.net-placeholder { min-height: 120px; }
.net-empty { color: var(--muted); }
.net-prompt { white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 100%; max-height: 320px; overflow: auto; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2); font: 12px/1.55 var(--mono); }
.net-command { width: 100%; min-height: 64px; resize: vertical; background: var(--surface); color: var(--text); border: 1px solid var(--border-strong); border-radius: var(--radius-md); font: 12px var(--mono); }
@media (max-width: 520px) {
  :root { --gutter: 16px; }
  .network-top .top-in { padding-top: 20px; }
  .network-top .tagline { font-size: var(--small); }
  .net-target { padding: 16px; }
  .net-target-head { flex-direction: column; gap: 8px; }
  .network-actions .btn { flex: 1 1 auto; white-space: normal; min-height: var(--ctl-h); height: auto; padding-top: 8px; padding-bottom: 8px; }
  .dlg-head, .dlg-body { padding-left: 16px; padding-right: 16px; }
  .dlg-foot { padding-left: 16px; padding-right: 16px; flex-wrap: wrap; }
}
`

/** The network view never embeds account state; the browser obtains only its token and fixed UI metadata. */
export function renderNetworkPage(opts: NetworkPageOptions): string {
  const nonce = opts.nonce
    ? ` nonce="${opts.nonce.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`
    : ''
  const theme = opts.theme ?? resolveTheme(undefined)
  const scheme = theme.colorScheme === 'auto' ? 'light dark' : theme.colorScheme
  const lang = opts.lang ?? 'auto'
  const boot = jsonForScript({
    basePath: opts.basePath,
    token: opts.token,
    version: opts.version ?? '',
    lang,
  })
  return `<!doctype html>
<html lang="${lang === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="${scheme}">
<meta name="referrer" content="no-referrer">
<title>Network connection</title>
<link rel="icon" type="image/svg+xml" href="${opts.basePath}/favicon.svg?v=${FAVICON_VERSION}">
<style${nonce}>${pageStyles(theme)}${CSS}</style>
</head>
<body${theme.header === 'bar' ? ' class="header-bar"' : ''}>
<header class="top network-top">
  <div class="top-in">
    <div class="brand"><span class="logo" aria-hidden="true">${MARK_IMG}</span><div><h1>sideby</h1><p id="tagline" class="tagline">Routes and local listeners visible to this Panel.</p></div></div>
    <div class="top-actions"><button id="language" class="btn" type="button"${lang === 'auto' ? '' : ' hidden'}>中文</button></div>
  </div>
</header>
<main class="wrap network-main">
  <section class="network-hero" aria-labelledby="title">
    <h2 id="title">Network connection</h2>
    <p id="intro">See the selected direct or redacted proxy route, its loopback TCP listener, and the cached Network Guard result for each target.</p>
    <div class="network-actions"><button id="diagnose" class="btn btn-primary" type="button" aria-busy="true">Diagnosing…</button><button id="ask-open" class="btn" type="button" aria-haspopup="dialog" hidden>Let AI diagnose</button></div>
    <div id="status"><p class="note" role="status">Running an offline diagnosis. No online trace is sent.</p></div>
  </section>
  <section class="network-notes" aria-label="Scope"><p id="scope" class="note"></p><p id="not-covered" class="small muted"></p></section>
  <div id="targets" aria-live="polite" aria-busy="true"><div class="panel net-placeholder"><span class="sk sk-line w70"></span><span class="sk sk-line w50"></span></div></div>
  <p id="tcp-limit" class="small muted network-notes"></p>
  <footer class="foot muted small">sideby</footer>
</main>
<dialog id="ask-dialog" class="dialog dialog-wide" aria-labelledby="ask-title">
  <div class="dlg-head"><h2 id="ask-title">Let AI diagnose</h2></div>
  <div id="ask-body" class="dlg-body"></div>
  <div class="dlg-foot"><button id="ask-cancel" class="btn" type="button">Cancel</button><button id="ask-confirm" class="btn btn-primary" type="button" disabled>Open in Orca</button></div>
</dialog>
<script type="application/json" id="sideby-boot"${nonce}>${boot}</script>
<script type="application/json" id="network-i18n"${nonce}>${jsonForScript(MESSAGES)}</script>
<script${nonce}>const BOOT = JSON.parse(document.getElementById('sideby-boot').textContent); const MESSAGES = JSON.parse(document.getElementById('network-i18n').textContent);${NETWORK_PAGE_SCRIPT}</script>
</body>
</html>`
}
