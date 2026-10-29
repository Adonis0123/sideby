// The Search Catalog (spec §3.36, ADR-0054): every page, setting and action of the Panel that the Command Palette
// finds, in English and Chinese, with where it lives and the command that does the same. The Panel embeds it and
// `sideby commands` searches it, so both find the same things. It names features only, never Accounts or Sessions.

export type SearchKind = 'page' | 'setting' | 'action'
export type PanelPage = 'accounts' | 'sessions' | 'tuning' | 'handoff' | 'unattended'

/** Where the Panel takes the user. Internal: the CLI shows `panel`, never this. */
export type SearchTarget =
  /** A page of its own (the tabs under the header). */
  | { page: PanelPage }
  /** A row of the Settings dialog: its section, and the `fm('<find>', …)` mark on the row. */
  | { settings: string; find: string }
  /** A row of the Accounts page's Display popover, marked the same way. */
  | { display: string }
  /** One of the page's PALETTE_ACTIONS; `write` ones are disabled in a read-only Panel. */
  | { action: string; write: boolean }

export interface Words {
  en: string
  zh: string
}

export interface SearchEntry {
  id: string
  kind: SearchKind
  title: Words
  /** Other words people use for it, in either language. */
  synonyms: string[]
  /** Where it lives, as the user reads it ("Settings → General → Language"). */
  panel: Words
  target: SearchTarget
  cliCommand: string | null
}

const SET = { en: 'Settings', zh: '设置' }
const at = (...parts: Words[]): Words => ({
  en: parts.map((p) => p.en).join(' → '),
  zh: parts.map((p) => p.zh).join(' → '),
})
const GENERAL = { en: 'General', zh: '通用' }
const MENUBAR = { en: 'Menu bar', zh: '状态栏' }
const ACCOUNTS = { en: 'Accounts', zh: '账号' }
const QUOTA = { en: 'Quota checks', zh: '额度查询' }
const AI = { en: 'Let AI help', zh: '让 AI 帮我' }
const DISPLAY = at({ en: 'Accounts', zh: '账号' }, { en: 'Display', zh: '显示' })
const HEADER = { en: 'Header', zh: '顶栏' }

const ENTRIES: SearchEntry[] = [
  {
    id: 'page.accounts',
    kind: 'page',
    title: { en: 'Accounts', zh: '账号' },
    synonyms: ['quota', 'usage', 'list', 'limit', '额度', '用量', '列表'],
    panel: { en: 'Accounts page', zh: '账号页' },
    target: { page: 'accounts' },
    cliCommand: 'sideby list',
  },
  {
    id: 'page.sessions',
    kind: 'page',
    title: { en: 'Sessions', zh: '会话' },
    synonyms: ['session history', 'live sessions', 'past sessions', 'history', '历史', '会话记录', '运行中'],
    panel: { en: 'Sessions page', zh: '会话页' },
    target: { page: 'sessions' },
    cliCommand: 'sideby history',
  },
  {
    id: 'page.tuning',
    kind: 'page',
    title: { en: 'Context tuning', zh: '上下文调优' },
    synonyms: [
      'auto-compact',
      'autocompact',
      'compaction threshold',
      'context window',
      'tune',
      '自动压缩',
      '压缩阈值',
      '上下文窗口',
    ],
    panel: { en: 'Context tuning page', zh: '上下文调优页' },
    target: { page: 'tuning' },
    cliCommand: 'sideby tune',
  },
  {
    id: 'page.handoff',
    kind: 'page',
    title: { en: 'Auto Handoff', zh: '自动接力' },
    synonyms: [
      'handoff',
      'switch account',
      'out of quota',
      'limit reached',
      '接力',
      '换号',
      '额度用完',
      '切换账号',
    ],
    panel: { en: 'Auto Handoff page', zh: '自动接力页' },
    target: { page: 'handoff' },
    cliCommand: 'sideby handoff',
  },
  {
    id: 'page.unattended',
    kind: 'page',
    title: { en: 'Unattended Mode', zh: '无人值守' },
    synonyms: [
      'unattended',
      'away',
      'overnight',
      'do not disturb',
      'pending decisions',
      '挂机',
      '今晚自己跑完',
      '别问我',
      '待你决定',
    ],
    panel: { en: 'Unattended page', zh: '无人值守页' },
    target: { page: 'unattended' },
    cliCommand: 'sideby unattended',
  },
  {
    id: 'setting.language',
    kind: 'setting',
    title: { en: 'Language', zh: '语言' },
    synonyms: ['english', 'chinese', '中文', '英文', 'lang'],
    panel: at(SET, GENERAL),
    target: { settings: 'general', find: 'lang' },
    cliCommand: 'sideby config set panel.language zh',
  },
  {
    id: 'setting.light-dark',
    kind: 'setting',
    title: { en: 'Light or dark', zh: '明暗' },
    synonyms: ['dark mode', 'light mode', 'appearance', 'night', '深色', '浅色', '暗色模式', '外观'],
    panel: at(SET, GENERAL),
    target: { settings: 'general', find: 'theme' },
    cliCommand: 'sideby config set panel.theme dark',
  },
  {
    id: 'setting.theme',
    kind: 'setting',
    title: { en: 'Theme', zh: '主题' },
    synonyms: ['colors', 'colours', 'accent', 'look', '配色', '颜色', '皮肤'],
    panel: at(SET, GENERAL),
    target: { settings: 'general', find: 'themes' },
    cliCommand: 'sideby theme',
  },
  {
    id: 'setting.autostart',
    kind: 'setting',
    title: { en: 'Start sideby at login', zh: '登录后启动 sideby' },
    synonyms: ['autostart', 'launch at login', 'background', 'startup', '开机启动', '自启动', '后台'],
    panel: at(SET, GENERAL),
    target: { settings: 'general', find: 'autostart' },
    cliCommand: 'sideby autostart on',
  },
  {
    id: 'setting.terminal',
    kind: 'setting',
    title: { en: 'Preferred terminal', zh: '首选终端' },
    synonyms: ['terminal app', 'iterm', 'ghostty', 'warp', '终端'],
    panel: at(SET, GENERAL),
    target: { settings: 'general', find: 'terminal' },
    cliCommand: 'sideby terminal',
  },
  {
    id: 'setting.menubar',
    kind: 'setting',
    title: { en: 'Show quota in the menu bar', zh: '在状态栏显示额度' },
    synonyms: ['menu bar', 'menubar', 'tray', 'status bar', '菜单栏', '状态栏'],
    panel: at(SET, MENUBAR),
    target: { settings: 'menubar', find: 'menubar' },
    cliCommand: 'sideby menubar on',
  },
  {
    id: 'setting.hotkey',
    kind: 'setting',
    title: { en: 'Menu bar shortcut', zh: '状态栏快捷键' },
    synonyms: ['hotkey', 'keyboard shortcut', 'menu bar icon', '快捷键', '热键'],
    panel: at(SET, MENUBAR),
    target: { settings: 'menubar', find: 'hotkey' },
    cliCommand: 'sideby menubar hotkey',
  },
  {
    id: 'setting.order',
    kind: 'setting',
    title: { en: 'Account order, pins and hidden', zh: '账号顺序、置顶与隐藏' },
    synonyms: ['sort', 'pin', 'hide', 'arrange', 'reorder', '排序', '置顶', '隐藏'],
    panel: at(SET, ACCOUNTS),
    target: { settings: 'accounts', find: 'order' },
    cliCommand: 'sideby order',
  },
  {
    id: 'setting.pick',
    kind: 'setting',
    title: { en: 'Start the account with the most quota left', zh: '自动启动剩余额度最多的账号' },
    synonyms: ['pick command', 'alias', 'short command', 'next', '挑选命令', '短命令', '别名'],
    panel: at(SET, ACCOUNTS),
    target: { settings: 'accounts', find: 'pick' },
    cliCommand: 'sideby alias add <short> --pick <family>',
  },
  {
    id: 'setting.remote-control',
    kind: 'setting',
    title: { en: 'Remote Control', zh: '远程控制' },
    synonyms: ['phone', 'web', 'continue on phone', 'remote', '手机', '网页', '远控'],
    panel: at(SET, ACCOUNTS),
    target: { settings: 'accounts', find: 'rc' },
    cliCommand: 'sideby remote-control',
  },
  {
    id: 'setting.quota-checks',
    kind: 'setting',
    title: { en: 'Quota checks', zh: '额度查询' },
    synonyms: ['fetch quota', 'ask host', 'quota refresh', '查询额度', '刷新额度'],
    panel: at(SET, QUOTA),
    target: { settings: 'quota', find: 'checks' },
    cliCommand: 'sideby quota check <family> on|off',
  },
  {
    id: 'setting.network',
    kind: 'setting',
    title: { en: 'Network check', zh: '网络检查' },
    synonyms: ['network guard', 'proxy', 'vpn', 'country', 'region', '网络守卫', '代理', '地区', '国家'],
    panel: at(SET, { en: 'Network check', zh: '网络检查' }),
    target: { settings: 'network', find: 'net' },
    cliCommand: 'sideby network',
  },
  {
    id: 'setting.skill',
    kind: 'setting',
    title: { en: 'Ask your AI to do it', zh: '让 AI 帮你操作' },
    synonyms: ['skill', 'agent skill', 'install skill', 'claude code', 'codex', '技能', '安装技能'],
    panel: at(SET, AI),
    target: { settings: 'ai', find: 'skill' },
    cliCommand: 'sideby update --skill',
  },
  {
    id: 'setting.quota-as',
    kind: 'setting',
    title: { en: 'Show quota as used or left', zh: '额度显示：已用或剩余' },
    synonyms: ['used', 'left', 'remaining', 'percent', '已用', '剩余', '百分比'],
    panel: DISPLAY,
    target: { display: 'quota' },
    cliCommand: null,
  },
  {
    id: 'setting.view',
    kind: 'setting',
    title: { en: 'List or cards', zh: '列表或卡片' },
    synonyms: ['view', 'layout', 'grid', '视图', '布局', '网格'],
    panel: DISPLAY,
    target: { display: 'view' },
    cliCommand: null,
  },
  {
    id: 'setting.hide-emails',
    kind: 'setting',
    title: { en: 'Hide emails', zh: '隐藏邮箱' },
    synonyms: ['privacy', 'screenshot', 'email', '隐私', '截图', '邮箱'],
    panel: DISPLAY,
    target: { display: 'emails' },
    cliCommand: null,
  },
  {
    id: 'action.new-account',
    kind: 'action',
    title: { en: 'New account', zh: '新建账号' },
    synonyms: ['add account', 'create account', 'api account', 'sign in', '添加账号', '加账号', '登录'],
    panel: at(ACCOUNTS, { en: 'New account', zh: '新建账号' }),
    target: { action: 'new-account', write: true },
    cliCommand: 'sideby new <family> --next',
  },
  {
    id: 'action.remote-control-off',
    kind: 'action',
    title: { en: 'Turn Remote Control off', zh: '关闭远程控制' },
    synonyms: ['disable remote control', '关掉远程控制'],
    panel: at(SET, ACCOUNTS, { en: 'Remote Control', zh: '远程控制' }),
    target: { action: 'remote-control', write: true },
    cliCommand: 'sideby remote-control off',
  },
  {
    id: 'action.handoff-on',
    kind: 'action',
    title: { en: 'Turn on Auto Handoff', zh: '开启自动接力' },
    synonyms: ['handoff setup', 'enable handoff', '设置接力', '打开接力'],
    panel: { en: 'Auto Handoff page', zh: '自动接力页' },
    target: { action: 'handoff-on', write: true },
    cliCommand: 'sideby handoff enable',
  },
  {
    id: 'action.unattended-on',
    kind: 'action',
    title: { en: 'Turn on Unattended Mode now', zh: '现在开无人值守' },
    synonyms: ['unattended on', 'go unattended', 'until morning', '现在开', '开启无人值守', '挂机到明早'],
    panel: { en: 'Unattended page', zh: '无人值守页' },
    target: { action: 'unattended-on', write: true },
    cliCommand: 'sideby unattended on',
  },
  {
    id: 'action.unattended-add-slot',
    kind: 'action',
    title: { en: 'Add an Unattended Slot', zh: '添加无人值守时段' },
    synonyms: ['add a slot', 'unattended schedule', 'weeknights', '添加时段', '时间表', '工作日夜间'],
    panel: at({ en: 'Unattended page', zh: '无人值守页' }, { en: 'Schedule', zh: '时间表' }),
    target: { action: 'unattended-add-slot', write: true },
    cliCommand: 'sideby unattended schedule add',
  },
  {
    id: 'action.network-guard',
    kind: 'action',
    title: { en: 'Turn the network check on or off', zh: '开关网络检查' },
    synonyms: ['network guard on', 'block country', '网络守卫开关'],
    panel: at(SET, { en: 'Network check', zh: '网络检查' }),
    target: { action: 'network', write: true },
    cliCommand: 'sideby network on|off',
  },
  {
    id: 'action.themes',
    kind: 'action',
    title: { en: 'Choose a theme', zh: '选择主题' },
    synonyms: ['import theme', 'theme preview', '导入主题', '换主题'],
    panel: at(SET, GENERAL, { en: 'Theme', zh: '主题' }),
    target: { action: 'themes', write: false },
    cliCommand: 'sideby theme use <name>',
  },
  {
    id: 'action.update',
    kind: 'action',
    title: { en: 'Update sideby', zh: '更新 sideby' },
    synonyms: ['upgrade', 'new version', 'auto update', '升级', '新版本', '自动更新'],
    panel: at(HEADER, { en: 'Version', zh: '版本' }),
    target: { action: 'update', write: true },
    cliCommand: 'sideby update',
  },
  {
    id: 'action.ask-ai',
    kind: 'action',
    title: { en: 'Let AI do it', zh: '让 AI 帮我' },
    synonyms: ['ask ai', 'assistant', 'help', '问 AI', '助手', '帮助'],
    panel: at(HEADER, { en: 'Let AI do it', zh: '让 AI 帮我' }),
    target: { action: 'ask', write: true },
    cliCommand: 'sideby ask',
  },
  {
    id: 'action.health-check',
    kind: 'action',
    title: { en: 'Health check and fixes', zh: '健康检查与修复' },
    synonyms: [
      'doctor',
      'fix',
      'repair',
      'broken',
      'symlink',
      'permissions',
      '修复',
      '诊断',
      '权限',
      '软链接',
    ],
    panel: at(ACCOUNTS, { en: 'Health check', zh: '健康检查' }),
    target: { action: 'health', write: false },
    cliCommand: 'sideby doctor --fix',
  },
  {
    id: 'action.inbound',
    kind: 'action',
    title: { en: 'Receiving messages', zh: '接收消息' },
    synonyms: ['send to session', 'inbound', 'cross-session', 'accept messages', '发消息', '跨会话'],
    panel: at({ en: 'Sessions', zh: '会话' }, { en: 'Receiving messages', zh: '接收消息' }),
    target: { action: 'inbound', write: false },
    cliCommand: 'sideby messages inbound accept',
  },
]

/** The catalog; a row of the Settings dialog or the Display popover names itself at the end of its place. */
export const SEARCH_CATALOG: readonly SearchEntry[] = ENTRIES.map((e) =>
  'settings' in e.target || 'display' in e.target ? { ...e, panel: at(e.panel, e.title) } : e,
)

/** Shown on an empty query after the recently used ones (spec §3.36). */
export const COMMON_ENTRIES: readonly string[] = [
  'action.new-account',
  'setting.language',
  'setting.light-dark',
  'page.sessions',
]

export interface SearchHit {
  entry: SearchEntry
  /** 0 exact, 1 prefix, 2 contains (title before synonym at each level). */
  rank: number
}

export function catalogNorm(s: string): string {
  return s.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** How well one text matches: 0 exact, 1 starts with it, 2 a word starts with it, 3 contains it, -1 not at all. */
export function catalogMatchLevel(text: string, q: string): number {
  const s = catalogNorm(text)
  if (s === q) return 0
  if (s.startsWith(q)) return 1
  if (s.split(/[\s,→()/-]+/).some((w) => w && w.startsWith(q))) return 2
  return s.includes(q) ? 3 : -1
}

/**
 * Entries matching `query`, best first: exact before prefix before contains, titles before synonyms, then the
 * catalog's own order. Both languages are searched whatever the Panel shows. An empty query matches nothing.
 */
export function searchCatalog(query: string, catalog: readonly SearchEntry[]): SearchHit[] {
  const q = catalogNorm(query)
  if (!q) return []
  const hits: { entry: SearchEntry; rank: number; order: number }[] = []
  catalog.forEach((entry, order) => {
    let best = -1
    for (const title of [entry.title.en, entry.title.zh]) {
      const l = catalogMatchLevel(title, q)
      if (l >= 0 && (best < 0 || l * 2 < best)) best = l * 2
    }
    for (const syn of entry.synonyms) {
      const l = catalogMatchLevel(syn, q)
      if (l >= 0 && (best < 0 || l * 2 + 1 < best)) best = l * 2 + 1
    }
    if (best >= 0) hits.push({ entry, rank: best, order })
  })
  hits.sort((a, b) => a.rank - b.rank || a.order - b.order)
  return hits.map(({ entry, rank }) => ({ entry, rank }))
}
