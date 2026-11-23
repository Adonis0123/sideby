// Browser behaviour for the independent Network Panel. The controller is also run in a VM by its tests.
import type { NetworkDiagnosis } from '../core/network.ts'
import { networkDiagnoseTaskFacts } from '../panel/page-logic.ts'

type Api = (path: string, body: Record<string, unknown>) => Promise<unknown>
type AskResult = { opened: boolean; command?: string | null; reason?: string; detail?: string }
type AskState = {
  body: Record<string, unknown>
  prompt: string
  loading: boolean
  busy: boolean
  promptChanged: boolean
  error: string | null
  result: AskResult | null
}

/** One controller per document; a null Ask is a closed dialog and invalidates every pending continuation. */
export function networkPageController(opts: {
  api: Api
  facts?: typeof networkDiagnoseTaskFacts
  version: string
  lang: string
  onChange?: () => void
}) {
  const facts = opts.facts ?? networkDiagnoseTaskFacts
  const state: {
    diagnosis: NetworkDiagnosis | null
    loading: boolean
    error: string | null
    ask: AskState | null
  } = { diagnosis: null, loading: false, error: null, ask: null }
  let diagnosisRun: object | null = null
  const changed = () => opts.onChange?.()
  const message = (err: unknown) => (err as { message?: string })?.message || String(err)

  return {
    state,
    async start() {
      return this.diagnose()
    },
    async diagnose() {
      if (diagnosisRun) return
      const mine = {}
      diagnosisRun = mine
      state.loading = true
      state.error = null
      changed()
      try {
        const result = (await opts.api('/api/network/diagnose', {})) as NetworkDiagnosis
        if (diagnosisRun !== mine) return
        state.diagnosis = result
      } catch (err) {
        if (diagnosisRun !== mine) return
        state.error = message(err)
      } finally {
        if (diagnosisRun === mine) {
          diagnosisRun = null
          state.loading = false
          changed()
        }
      }
    },
    async openAsk() {
      if (!state.diagnosis || state.ask) return
      const ask: AskState = {
        body: {
          task: 'network-diagnose',
          lang: opts.lang,
          context: { networkDiagnose: facts(state.diagnosis), version: opts.version },
        },
        prompt: '',
        loading: true,
        busy: false,
        promptChanged: false,
        error: null,
        result: null,
      }
      state.ask = ask
      changed()
      try {
        const preview = (await opts.api('/api/ask/prompt', ask.body)) as { prompt: string }
        if (state.ask !== ask) return
        ask.prompt = preview.prompt
        ask.loading = false
        changed()
      } catch (err) {
        if (state.ask !== ask) return
        ask.error = message(err)
        ask.loading = false
        changed()
      }
    },
    closeAsk() {
      state.ask = null
      changed()
    },
    async confirmAsk() {
      const ask = state.ask
      if (!ask || ask.loading || ask.busy || ask.result) return
      ask.busy = true
      ask.error = null
      changed()
      try {
        // The body is identical to the preview's. A new preview always wins over this confirmation.
        const check = (await opts.api('/api/ask/prompt', ask.body)) as { prompt: string }
        if (state.ask !== ask) return
        if (check.prompt !== ask.prompt) {
          ask.prompt = check.prompt
          ask.promptChanged = true
          ask.busy = false
          changed()
          return
        }
        ask.promptChanged = false
        const result = (await opts.api('/api/ask', ask.body)) as AskResult
        if (state.ask !== ask) return
        ask.result = result
        ask.busy = false
        changed()
      } catch (err) {
        if (state.ask !== ask) return
        ask.error = message(err)
        ask.busy = false
        changed()
      }
    },
  }
}

export const NETWORK_PAGE_SCRIPT = `
const createNetworkController = ${networkPageController.toString()};
const factsForTask = ${networkDiagnoseTaskFacts.toString()};
const $ = (id) => document.getElementById(id);
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child && typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  return el;
}
let lang = BOOT.lang === 'auto' ? (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en') : BOOT.lang;
const t = (key, vars = {}) => {
  let value = (MESSAGES[lang] && MESSAGES[lang][key]) || MESSAGES.en[key] || key;
  for (const [name, replacement] of Object.entries(vars)) value = value.split('{' + name + '}').join(String(replacement));
  return value;
};
let token = BOOT.token;
async function api(path, body) {
  const send = async () => {
    const response = await fetch(BOOT.basePath + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sideby-token': token },
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || t('requestFailed', { status: response.status }));
      error.code = data.code;
      throw error;
    }
    return data;
  };
  try { return await send(); } catch (error) {
    if (error.code !== 'bad-token') throw error;
    const response = await fetch(BOOT.basePath + '/api/session');
    if (!response.ok) throw error;
    token = (await response.json()).token;
    return send();
  }
}
const dialog = $('ask-dialog');
const controller = createNetworkController({
  api,
  facts: factsForTask,
  version: BOOT.version,
  get lang() { return lang; },
  onChange: render,
});
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function routeLabel(target) {
  return h('p', { class: 'net-route' }, h('span', { class: 'muted' }, t('route') + ': '), h('code', { text: target.proxy }));
}
function targetCard(target) {
  const listener = target.listener;
  const support = target.guardSupport;
  const guardBits = [t('guard.' + target.guard.status)];
  if (target.guard.loc) guardBits.push(target.guard.loc);
  guardBits.push(target.guard.checkedAt ? t('guardChecked', { when: target.guard.checkedAt }) : t('guardNever'));
  if (target.guard.error) guardBits.push(target.guard.error);
  return h('article', { class: 'panel net-target' },
    h('div', { class: 'net-target-head' }, h('h3', { text: target.url }), h('span', { class: 'chip', text: t('support.' + support) })),
    routeLabel(target),
    h('p', { class: listener && listener.reachable ? 'net-ok' : 'small muted', text: listener
      ? t(listener.reachable ? 'listenerUp' : 'listenerDown', { host: listener.host, port: listener.port, error: listener.error || t('failed') })
      : support === 'direct' ? t('direct') : t('noListener') }),
    h('p', { class: 'small muted', text: guardBits.join(' · ') }),
    support === 'unsupported' ? h('p', { class: 'note note-warn', text: t('unsupported') }) : null,
    support === 'invalid' ? h('p', { class: 'note note-warn', text: t('invalid') }) : null);
}
function renderMain() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = t('title');
  $('title').textContent = t('title');
  $('tagline').textContent = t('tagline');
  $('intro').textContent = t('intro');
  $('scope').textContent = t('scope');
  $('not-covered').textContent = t('notCovered');
  $('tcp-limit').textContent = t('tcpLimit');
  $('diagnose').textContent = controller.state.loading ? t('diagnosing') : controller.state.diagnosis ? t('diagnoseAgain') : t('diagnose');
  $('diagnose').disabled = controller.state.loading;
  $('diagnose').setAttribute('aria-busy', controller.state.loading ? 'true' : 'false');
  $('language').textContent = lang === 'zh' ? 'English' : '中文';
  $('language').hidden = BOOT.lang !== 'auto';
  const status = $('status');
  clear(status);
  if (controller.state.loading) status.append(h('p', { class: 'note', role: 'status', text: t('loading') }));
  else if (controller.state.error) status.append(h('p', { class: 'note note-fail', role: 'alert', text: t('diagnoseFailed', { message: controller.state.error }) }));
  else if (controller.state.diagnosis) status.append(h('p', { class: 'small muted', role: 'status', text: t('checkedAt', { when: controller.state.diagnosis.checkedAt }) }));
  const list = $('targets');
  const diagnosis = controller.state.diagnosis;
  list.setAttribute('aria-busy', controller.state.loading && !diagnosis ? 'true' : 'false');
  clear(list);
  if (controller.state.loading && !diagnosis) {
    list.append(h('div', { class: 'panel net-placeholder', 'aria-busy': 'true' }, h('span', { class: 'sk sk-line w70' }), h('span', { class: 'sk sk-line w50' })));
  } else if (diagnosis && !diagnosis.targets.length) {
    list.append(h('p', { class: 'panel net-empty', text: t('empty') }));
  } else if (diagnosis) {
    for (const target of diagnosis.targets) list.append(targetCard(target));
  }
  $('ask-open').hidden = !diagnosis;
  $('ask-open').textContent = t('ask');
}
function renderAsk() {
  const ask = controller.state.ask;
  if (!ask) {
    if (dialog.open) dialog.close();
    return;
  }
  if (!dialog.open) dialog.showModal();
  const body = $('ask-body');
  clear(body);
  $('ask-title').textContent = t('ask');
  body.append(h('p', { class: 'small muted', text: t('fixedOnly') }));
  if (ask.loading) body.append(h('p', { class: 'note', role: 'status', text: t('promptLoading') }));
  else {
    body.append(h('span', { class: 'small muted', text: t('actualPrompt') }));
    if (ask.promptChanged) body.append(h('p', { class: 'note note-warn', role: 'status', text: t('promptChanged') }));
    body.append(h('pre', { class: 'net-prompt', text: ask.prompt }));
  }
  if (ask.error) body.append(h('p', { class: 'note note-fail', role: 'alert', text: ask.error }));
  if (ask.result) {
    body.append(h('p', { class: ask.result.opened ? 'note note-ok' : 'note note-warn', role: 'status', text: ask.result.opened ? t('opened') : t('copyFallback') }));
    if (ask.result.command) {
      body.append(h('pre', { class: 'net-prompt', text: ask.result.command }));
      body.append(h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(ask.result.command); } catch { $('command').value = ask.result.command; $('command').select(); }
      }, text: t('copy') }));
      body.append(h('textarea', { id: 'command', class: 'net-command', readonly: true, 'aria-label': t('command'), text: ask.result.command }));
    }
  }
  $('ask-confirm').hidden = Boolean(ask.result);
  $('ask-confirm').disabled = ask.loading || ask.busy || !ask.prompt;
  $('ask-confirm').textContent = ask.busy ? t('checkingPrompt') : t('confirm');
  $('ask-cancel').textContent = ask.result ? t('close') : t('cancel');
}
function render() { renderMain(); renderAsk(); }
$('diagnose').addEventListener('click', () => controller.diagnose());
$('ask-open').addEventListener('click', () => controller.openAsk());
$('ask-confirm').addEventListener('click', () => controller.confirmAsk());
$('ask-cancel').addEventListener('click', () => controller.closeAsk());
dialog.addEventListener('close', () => { if (controller.state.ask) controller.closeAsk(); });
dialog.addEventListener('cancel', () => controller.closeAsk());
$('language').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; render(); });
render();
void controller.start();
`
