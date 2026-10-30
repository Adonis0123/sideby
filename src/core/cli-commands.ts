// The Command List (spec §3.38, ADR-0061): every `sideby` command a person or their AI runs, grouped by task, with a
// one-line description in English and Chinese, an example and, where the Panel has a place for it, the Search Catalog
// entry that takes the user there. `sideby --help` is generated from it, `sideby commands` lists it and the Panel
// embeds it, so the three never drift apart. Internal entries sideby runs itself (hooks, `update-check`) are not in it.
import { catalogNorm, type Words } from './search-catalog.ts'

export type CommandGroupId =
  | 'accounts'
  | 'start'
  | 'shortcuts'
  | 'quota'
  | 'handoff'
  | 'sessions'
  | 'health'
  | 'panel'
  | 'settings'
  | 'help'

export interface CommandGroup {
  id: CommandGroupId
  title: Words
}

export interface CliCommand {
  /** Stable: `sideby commands --json` and the Panel name it. */
  id: string
  group: CommandGroupId
  /** The command line as `sideby --help` shows it. */
  usage: string
  /** What `sideby --help` prints next to it, in English; it may name more options than `summary`. */
  help: string
  /** One line for the Command List. */
  summary: Words
  /** A line that runs as it is, with the demo names (`claude:work`, `cc008`). */
  example?: string
  /** Its place in the "Common" group, 1 first. */
  common?: number
  /** The Search Catalog id of its place in the Panel, for "Open in Panel". */
  feature?: string
}

/** Task groups, in the order `sideby --help`, `sideby commands` and the Panel show them. */
export const COMMAND_GROUPS: readonly CommandGroup[] = [
  { id: 'accounts', title: { en: 'Accounts', zh: '账号' } },
  { id: 'start', title: { en: 'Start and open', zh: '启动与打开' } },
  { id: 'shortcuts', title: { en: 'Short commands', zh: '短命令' } },
  { id: 'quota', title: { en: 'Quota and usage', zh: '额度与用量' } },
  { id: 'handoff', title: { en: 'Auto Handoff', zh: '自动接力' } },
  { id: 'sessions', title: { en: 'Sessions and messages', zh: '会话与消息' } },
  { id: 'health', title: { en: 'Health and safety', zh: '健康与安全' } },
  { id: 'panel', title: { en: 'Panel and app', zh: '面板与应用' } },
  { id: 'settings', title: { en: 'Settings and updates', zh: '设置与更新' } },
  { id: 'help', title: { en: 'Help, AI and plugins', zh: '帮助、AI 与插件' } },
]

export const CLI_COMMANDS: readonly CliCommand[] = [
  // ---------- Accounts ----------
  {
    id: 'list',
    group: 'accounts',
    usage: 'sideby',
    help: 'list accounts (same as `sideby list`)',
    summary: {
      en: 'List your accounts with quota, sign-in and model',
      zh: '列出账号，带额度、登录状态和模型',
    },
    example: 'sideby list',
    common: 1,
    feature: 'page.accounts',
  },
  {
    id: 'list.all',
    group: 'accounts',
    usage: 'sideby list --all',
    help: 'also list hidden families and accounts',
    summary: { en: 'Also list hidden tools and accounts', zh: '连隐藏的工具和账号一起列出' },
  },
  {
    id: 'new',
    group: 'accounts',
    usage: 'sideby new <family> <name>|--next [--api] [--alias <short>]',
    help: 'create an account (families: claude, codex, grok, pi); --next picks the next name and short command (cc008); --alias also adds a short command such as cc008',
    summary: { en: 'Create an account; --next picks the name for you', zh: '新建账号；--next 自动起名' },
    example: 'sideby new claude --next',
    common: 4,
    feature: 'action.new-account',
  },
  {
    id: 'login',
    group: 'accounts',
    usage: 'sideby login <account>',
    help: 'sign in to an account',
    summary: { en: 'Sign in to an account in the browser', zh: '在浏览器里登录一个账号' },
    example: 'sideby login claude:work',
    common: 5,
  },
  {
    id: 'key',
    group: 'accounts',
    usage: 'sideby key <account> [--var <NAME>]',
    help: 'enter an API key without echo',
    summary: { en: 'Enter an API key without showing it', zh: '输入 API 密钥，屏幕上不显示' },
    example: 'sideby key claude:deepseek',
  },
  {
    id: 'try',
    group: 'accounts',
    usage: 'sideby try <account> [--model <m>]',
    help: 'try the Host with a short paid request',
    summary: {
      en: 'Check an account works with a short paid request',
      zh: '发一个很短的付费请求，看账号能不能用',
    },
    example: 'sideby try claude:deepseek',
  },
  {
    id: 'model',
    group: 'accounts',
    usage: 'sideby model <account> [<model>|default] [--effort <level>|default] [--yes]',
    help: 'show or set the model and effort sideby starts this account with',
    summary: {
      en: 'Show or set the model and effort an account starts with',
      zh: '查看或设置账号启动时用的模型和推理强度',
    },
    example: 'sideby model claude:work',
  },
  {
    id: 'edit',
    group: 'accounts',
    usage: 'sideby edit <account> [--path]',
    help: "open the account's own settings file (settings.json, config.toml) in your editor",
    summary: {
      en: "Open an account's own settings file in your editor",
      zh: '用编辑器打开账号自己的设置文件',
    },
    example: 'sideby edit claude:work',
  },
  {
    id: 'families',
    group: 'accounts',
    usage: 'sideby families [family]',
    help: "what each host's accounts share with the main account, where they live and how they sign in",
    summary: {
      en: "What each tool's accounts share with the main account",
      zh: '每个工具的账号和主账号共享哪些东西',
    },
    example: 'sideby families claude',
  },
  {
    id: 'pin',
    group: 'accounts',
    usage: 'sideby pin|unpin <account|short command> [--json]',
    help: 'pin or unpin a Same Login (at most 3 per family)',
    summary: { en: 'Pin an account to the top, or unpin it', zh: '把账号置顶或取消置顶' },
    example: 'sideby pin claude:work',
    feature: 'setting.order',
  },
  {
    id: 'hide',
    group: 'accounts',
    usage: 'sideby hide|unhide <family|account> [--json]',
    help: 'hide a family or an account from the Panel, menu bar and list',
    summary: {
      en: 'Hide a tool or an account from the Panel, menu bar and list',
      zh: '在面板、状态栏和列表里隐藏某个工具或账号',
    },
    example: 'sideby hide pi',
    feature: 'setting.order',
  },
  {
    id: 'order',
    group: 'accounts',
    usage: 'sideby order [--json]',
    help: 'show display order, with pinned and hidden accounts marked',
    summary: {
      en: 'Show the display order, with pins and hidden ones',
      zh: '查看显示顺序，标出置顶和隐藏的',
    },
    feature: 'setting.order',
  },
  {
    id: 'order.accounts',
    group: 'accounts',
    usage: 'sideby order <family> <name>...',
    help: 'set account order within a family',
    summary: { en: "Set the order of one tool's accounts", zh: '设置某个工具里账号的顺序' },
    example: 'sideby order claude work main',
  },
  {
    id: 'order.families',
    group: 'accounts',
    usage: 'sideby order --families <id>...',
    help: 'set family order',
    summary: { en: 'Set the order of the tools', zh: '设置工具的顺序' },
    example: 'sideby order --families codex claude',
  },
  {
    id: 'order.reset',
    group: 'accounts',
    usage: 'sideby order --reset',
    help: 'restore default order, keeping pins and hidden ones',
    summary: {
      en: 'Go back to the default order, keeping pins and hidden ones',
      zh: '恢复默认顺序，保留置顶和隐藏',
    },
  },
  // ---------- Start and open ----------
  {
    id: 'run',
    group: 'start',
    usage: 'sideby run <account> [-- args]',
    help: 'start the host CLI for one account',
    summary: { en: 'Start the AI tool as one account', zh: '用某个账号启动 AI 工具' },
    example: 'sideby run claude:work',
    common: 2,
  },
  {
    id: 'next',
    group: 'start',
    usage: 'sideby next <family> [--dry-run] [--include-api] [--ignore-network] [--unattended] [-- args]',
    help: 'recommend the account with the most quota left (claude, codex, grok) and start it; --dry-run only recommends',
    summary: { en: 'Start the account with the most quota left', zh: '启动剩余额度最多的账号' },
    example: 'sideby next claude',
    common: 3,
  },
  {
    id: 'resume',
    group: 'start',
    usage: 'sideby resume <family> [-- args]',
    help: 'run the host; a session resumed by id (claude --resume <id>, codex resume <id>) starts in the account that holds it',
    summary: {
      en: 'Resume a session by id in the account that holds it',
      zh: '按 id 恢复会话，自动用存着它的账号',
    },
  },
  {
    id: 'desktop',
    group: 'start',
    usage: 'sideby desktop <account>',
    help: 'open the desktop app (Claude Desktop, the Codex app) as this account, next to the others (macOS)',
    summary: { en: 'Open the desktop app as this account (macOS)', zh: '用这个账号打开桌面应用（macOS）' },
    example: 'sideby desktop claude:work',
  },
  {
    id: 'desktop.grok-bot',
    group: 'start',
    usage: 'sideby desktop grok-bot:<name>',
    help: 'open a Grok Bot window, a new one for a new name (macOS)',
    summary: { en: 'Open a Grok Bot window (macOS)', zh: '打开一个 Grok Bot 窗口（macOS）' },
    example: 'sideby desktop grok-bot:002',
  },
  {
    id: 'browser',
    group: 'start',
    usage: 'sideby browser [--enable [--yes]]',
    help: "which Chrome browser user signed in to each account's website (read on this computer only; off until you enable it)",
    summary: {
      en: "Which Chrome user is signed in to each account's website",
      zh: '每个账号的网站登录在哪个 Chrome 用户里',
    },
    example: 'sideby browser --enable',
  },
  {
    id: 'browser.open',
    group: 'start',
    usage: 'sideby browser open <account> [--profile <name>]',
    help: 'open claude.ai, chatgpt.com or grok.com in that browser user',
    summary: {
      en: "Open the account's website in the right Chrome user",
      zh: '在对应的 Chrome 用户里打开账号的网站',
    },
    example: 'sideby browser open cc008',
  },
  {
    id: 'browser.set',
    group: 'start',
    usage: 'sideby browser set <account> <name> | --auto',
    help: 'choose that browser user yourself, or let sideby find it again',
    summary: {
      en: 'Choose the Chrome user yourself, or let sideby find it',
      zh: '自己指定 Chrome 用户，或让 sideby 重新找',
    },
  },
  // ---------- Short commands ----------
  {
    id: 'alias.add',
    group: 'shortcuts',
    usage: 'sideby alias add <short> <account> [-- args]',
    help: 'add a short command, optionally with host arguments (sideby alias add pi-kimi pi:main -- --model kimi-coding/k3)',
    summary: { en: 'Add a short command that starts an account', zh: '加一个启动某个账号的短命令' },
    example: 'sideby alias add cc008 claude:008',
  },
  {
    id: 'alias.pick',
    group: 'shortcuts',
    usage: 'sideby alias add <short> --pick <family> [--yes]',
    help: 'add a pick command: each run starts the account with the most quota left (sideby alias add cc --pick claude)',
    summary: {
      en: 'Add a pick command: it starts the account with the most quota left',
      zh: '加一个挑选命令：每次启动剩余额度最多的账号',
    },
    example: 'sideby alias add cc --pick claude',
    feature: 'setting.pick',
  },
  {
    id: 'alias.rm',
    group: 'shortcuts',
    usage: 'sideby alias rm <short>',
    help: 'remove a short command',
    summary: { en: 'Remove a short command', zh: '删除一个短命令' },
    example: 'sideby alias rm cc008',
  },
  {
    id: 'alias.list',
    group: 'shortcuts',
    usage: 'sideby alias list',
    help: 'list short commands and pick commands',
    summary: { en: 'List short commands and pick commands', zh: '列出短命令和挑选命令' },
  },
  {
    id: 'shell-init',
    group: 'shortcuts',
    usage: 'sideby shell-init zsh|bash',
    help: 'print shell functions, e.g. eval "$(sideby shell-init zsh)"',
    summary: {
      en: 'Print the shell functions behind your short commands',
      zh: '输出短命令背后的 shell 函数',
    },
    example: 'eval "$(sideby shell-init zsh)"',
  },
  {
    id: 'shell-init.write',
    group: 'shortcuts',
    usage: 'sideby shell-init [zsh|bash] --write',
    help: "rewrite the config's shellInitFile with them",
    summary: { en: "Rewrite the config's shellInitFile with them", zh: '用它们重写配置里的 shellInitFile' },
  },
  {
    id: 'shell-init.setup',
    group: 'shortcuts',
    usage: 'sideby shell-init setup [zsh|bash] [--yes|--undo]',
    help: 'make new terminals load your short commands: adds one line to ~/.zshrc (or ~/.bashrc), shown first; --undo takes it out',
    summary: { en: 'Make new terminals load your short commands', zh: '让新开的终端自动加载短命令' },
    example: 'sideby shell-init setup',
  },
  // ---------- Quota and usage ----------
  {
    id: 'quota',
    group: 'quota',
    usage: 'sideby quota [account|family] [--refresh]',
    help: 'quota and 7-day token usage; --refresh asks every fetching family again now',
    summary: { en: 'Quota left and 7-day token usage', zh: '剩余额度和 7 天的 token 用量' },
    example: 'sideby quota claude',
    common: 6,
    feature: 'page.accounts',
  },
  {
    id: 'quota.setup',
    group: 'quota',
    usage: 'sideby quota setup claude [--yes]',
    help: 'turn on Claude quota (shows the change first)',
    summary: { en: 'Turn on Claude quota (shows the change first)', zh: '开启 Claude 额度（先给你看改动）' },
  },
  {
    id: 'quota.teardown',
    group: 'quota',
    usage: 'sideby quota teardown claude',
    help: 'undo it, restoring the original file',
    summary: { en: 'Undo the Claude quota setup', zh: '撤销 Claude 额度设置，恢复原文件' },
  },
  {
    id: 'quota.check',
    group: 'quota',
    usage: 'sideby quota check <family> on|off',
    help: 'turn quota fetching on or off',
    summary: { en: "Turn a tool's quota checks on or off", zh: '开关某个工具的额度查询' },
    example: 'sideby quota check grok off',
    feature: 'setting.quota-checks',
  },
  {
    id: 'tune',
    group: 'quota',
    usage: 'sideby tune [account|family]',
    help: 'estimate the cheapest auto-compact threshold per model from your last 7 days of sessions (read-only)',
    summary: {
      en: 'Estimate the cheapest auto-compact size per model',
      zh: '按模型估算最省钱的自动压缩大小',
    },
    example: 'sideby tune claude',
    feature: 'page.tuning',
  },
  // ---------- Auto Handoff ----------
  {
    id: 'handoff.status',
    group: 'handoff',
    usage: 'sideby handoff status',
    help: 'what Auto Handoff still needs on this machine',
    summary: { en: 'What Auto Handoff still needs on this computer', zh: '自动接力在这台电脑上还缺什么' },
    feature: 'page.handoff',
  },
  {
    id: 'handoff.rules',
    group: 'handoff',
    usage: 'sideby handoff rules',
    help: "every rule that decides when it hands over and to whom, and where each account's work would go now",
    summary: { en: 'When it hands over, and to which account', zh: '什么时候接力、交给哪个账号' },
  },
  {
    id: 'handoff.enable',
    group: 'handoff',
    usage: 'sideby handoff enable [--yes]',
    help: 'turn it on (shows the config change first); --same-family, --order claude=codex001,cc002, --threshold n, --prepare-at n, --other-ai [--ai-order codex,grok], --api (billed per use)',
    summary: { en: 'Turn on Auto Handoff (shows the change first)', zh: '开启自动接力（先给你看改动）' },
    example: 'sideby handoff enable',
    feature: 'action.handoff-on',
  },
  {
    id: 'handoff.disable',
    group: 'handoff',
    usage: 'sideby handoff disable [--yes]',
    help: 'turn it off, keeping the other settings',
    summary: { en: 'Turn Auto Handoff off, keeping its settings', zh: '关闭自动接力，保留其他设置' },
  },
  {
    id: 'handoff.ready',
    group: 'handoff',
    usage: 'sideby handoff ready [--brief <f>]',
    help: 'inside a session sideby started with Auto Handoff: hand over to the next account when this turn ends (config `handoff`); --to <account> names it, also one this chain already used',
    summary: {
      en: 'Inside a session: hand the task to the next account',
      zh: '在会话里：把任务交给下一个账号',
    },
    example: 'sideby handoff ready --to cc008',
  },
  {
    id: 'handoff.setup',
    group: 'handoff',
    usage: 'sideby handoff setup grok [--yes]',
    help: "add sideby's hook file so Grok can hand over at its limit",
    summary: {
      en: 'Let Grok hand over at its limit (adds a hook file)',
      zh: '让 Grok 到上限时也能接力（加一个 hook 文件）',
    },
  },
  {
    id: 'handoff.teardown',
    group: 'handoff',
    usage: 'sideby handoff teardown grok',
    help: 'remove it',
    summary: { en: "Remove Grok's handoff hook file", zh: '删掉 Grok 的接力 hook 文件' },
  },
  // ---------- Sessions and messages ----------
  {
    id: 'sessions',
    group: 'sessions',
    usage: 'sideby sessions [<account>|<family>]',
    help: 'which session each account runs now, needing you first',
    summary: { en: 'Which session each account runs now', zh: '每个账号现在在跑哪个会话' },
    example: 'sideby sessions',
    feature: 'page.sessions',
  },
  {
    id: 'sessions.copy',
    group: 'sessions',
    usage: 'sideby sessions copy <account|session-id> [--as reference|id|resume]',
    help: 'copy one for another AI: a reference to its record (default), its id or its resume command',
    summary: {
      en: 'Copy a session for another AI: a reference, its id or resume command',
      zh: '把会话复制给另一个 AI：引用、id 或恢复命令',
    },
    example: 'sideby sessions copy cc008 --as resume',
  },
  {
    id: 'sessions.open-run',
    group: 'sessions',
    usage: 'sideby sessions open-run <account|session-id>',
    help: 'open the run report of the dispatched task that session works for',
    summary: {
      en: 'Open the run report of the task a session works for',
      zh: '打开会话所属派发任务的进度报告',
    },
  },
  {
    id: 'history',
    group: 'sessions',
    usage: 'sideby history [<words>...]',
    help: 'find any past session of any account, by project, AI, time or what was said (--project, --family, --account, --since, --tools also searches tool output)',
    summary: { en: 'Find any past session of any account', zh: '查找任一账号的历史会话' },
    example: 'sideby history login page --since 7d',
    common: 7,
    feature: 'page.sessions',
  },
  {
    id: 'history.show',
    group: 'sessions',
    usage: 'sideby history show <id>',
    help: 'read one session; history projects lists the projects',
    summary: { en: 'Read one past session', zh: '阅读一个历史会话' },
  },
  {
    id: 'history.index',
    group: 'sessions',
    usage: 'sideby history index [--clear]',
    help: 'the local search index: how far it is built, or delete it',
    summary: {
      en: 'The local search index: how far it is built, or delete it',
      zh: '本地搜索索引：建到哪了，或删掉它',
    },
  },
  {
    id: 'send',
    group: 'sessions',
    usage: 'sideby send <account|session> "<text>" [--image <path>]...',
    help: 'tell another session something (a screenshot too): Claude sessions get it at once, others through a line you paste',
    summary: { en: 'Tell another running session something', zh: '给另一个正在跑的会话发消息' },
    example: 'sideby send cc008 "the build is green"',
  },
  {
    id: 'messages',
    group: 'sessions',
    usage: 'sideby messages [--to <account|session>]',
    help: 'the messages you sent and whether each was delivered or read',
    summary: { en: 'Messages you sent, and whether each arrived', zh: '你发过的消息，以及是否送达或已读' },
  },
  {
    id: 'messages.inbound',
    group: 'sessions',
    usage: 'sideby messages inbound [accept|undo] [--yes]',
    help: 'whether Claude sessions show messages from other sessions at once',
    summary: {
      en: 'Whether Claude sessions show messages from others at once',
      zh: 'Claude 会话是否马上显示别的会话发来的消息',
    },
    feature: 'action.inbound',
  },
  // ---------- Health and safety ----------
  {
    id: 'doctor',
    group: 'health',
    usage: 'sideby doctor [target] [--fix] [--force]',
    help: 'check shared items and permissions; --fix repairs safe issues',
    summary: {
      en: 'Check shared items and permissions; --fix repairs them',
      zh: '检查共享项和权限；--fix 修复',
    },
    example: 'sideby doctor --fix',
    common: 8,
    feature: 'action.health-check',
  },
  {
    id: 'remote-control',
    group: 'health',
    usage: 'sideby remote-control [on|off|undo] [--yes]',
    help: 'whether Claude sessions connect to claude.ai by themselves; off stops that for every account (shows the change first)',
    summary: {
      en: 'Whether Claude sessions connect to claude.ai by themselves',
      zh: 'Claude 会话是否自己连上 claude.ai',
    },
    example: 'sideby remote-control off',
    feature: 'setting.remote-control',
  },
  {
    id: 'network',
    group: 'health',
    usage: 'sideby network [check]',
    help: 'stop Claude and Codex when requests would leave from a country you did not allow (network on|off|allow <CC>... [--yes])',
    summary: {
      en: 'Stop Claude and Codex when requests leave from a country you did not allow',
      zh: '请求从你没允许的国家或地区发出时，拦下 Claude 和 Codex',
    },
    example: 'sideby network check',
    feature: 'setting.network',
  },
  {
    id: 'unattended',
    group: 'health',
    usage: 'sideby unattended [on|off]',
    help: 'nobody is here: sessions sideby starts do not stop to ask; on takes --for 4h, --until 07:30 or --slot-end (schedule add|remove|preset weeknights, pending [done <id>|--all], defer "<text>"); run --unattended for one session',
    summary: { en: 'Nobody is here: sessions do not stop to ask', zh: '无人值守：会话不停下来问你' },
    example: 'sideby unattended on --until 07:30',
    feature: 'page.unattended',
  },
  // ---------- Panel and app ----------
  {
    id: 'ui',
    group: 'panel',
    usage: 'sideby ui [--port n] [--no-open]',
    help: 'open the local panel',
    summary: { en: 'Open the Panel in your browser', zh: '在浏览器里打开面板' },
    example: 'sideby ui',
    common: 9,
  },
  {
    id: 'ui.background',
    group: 'panel',
    usage: 'sideby ui --background',
    help: 'same, without a terminal: keeps running after this command exits',
    summary: { en: 'Run the Panel in the background', zh: '在后台运行面板' },
  },
  {
    id: 'ui.stop',
    group: 'panel',
    usage: 'sideby ui --stop',
    help: 'stop the background panel',
    summary: { en: 'Stop the background Panel', zh: '停止后台运行的面板' },
  },
  {
    id: 'app.install',
    group: 'panel',
    usage: 'sideby app install [--url <url>]',
    help: 'add a sideby app that opens the panel (macOS, Linux)',
    summary: { en: 'Add a sideby app that opens the Panel', zh: '添加一个打开面板的 sideby 应用' },
  },
  {
    id: 'app.uninstall',
    group: 'panel',
    usage: 'sideby app uninstall',
    help: 'remove that app',
    summary: { en: 'Remove the sideby app', zh: '删除 sideby 应用' },
  },
  {
    id: 'menubar',
    group: 'panel',
    usage: 'sideby menubar [on|off] [--yes]',
    help: 'show quota in the macOS menu bar; click an account to start it',
    summary: { en: 'Show quota in the macOS menu bar', zh: '在 macOS 状态栏显示额度' },
    example: 'sideby menubar on',
    feature: 'setting.menubar',
  },
  {
    id: 'menubar.hotkey',
    group: 'panel',
    usage: 'sideby menubar hotkey [<keys>|off]',
    help: 'show or change the shortcut that opens that menu (⌥X)',
    summary: { en: 'Show or change the menu bar shortcut', zh: '查看或修改状态栏快捷键' },
    feature: 'setting.hotkey',
  },
  {
    id: 'autostart',
    group: 'panel',
    usage: 'sideby autostart [on|off] [--yes]',
    help: 'start the panel in the background at login (macOS, Linux, WSL; shows the file first)',
    summary: { en: 'Start the Panel in the background at login', zh: '登录电脑后在后台启动面板' },
    example: 'sideby autostart on',
    feature: 'setting.autostart',
  },
  {
    id: 'theme',
    group: 'panel',
    usage: 'sideby theme [list]',
    help: "the Panel's Themes; use <name> switches, use --undo goes back, use default clears",
    summary: { en: "The Panel's themes; use <name> switches to one", zh: '面板的主题；use <名字> 切换' },
    example: 'sideby theme use teal',
    feature: 'setting.theme',
  },
  {
    id: 'theme.check',
    group: 'panel',
    usage: 'sideby theme check|preview <name|file>',
    help: 'contrast report, or one look in the Panel without switching',
    summary: {
      en: "Check a theme's contrast, or preview it in the Panel",
      zh: '检查主题对比度，或在面板里预览',
    },
  },
  {
    id: 'theme.files',
    group: 'panel',
    usage: 'sideby theme import <file> | export <name> | remove <name>',
    help: 'your own Themes (JSON, colors only)',
    summary: { en: 'Import, export or remove your own themes', zh: '导入、导出或删除自己的主题' },
  },
  // ---------- Settings and updates ----------
  {
    id: 'config.get',
    group: 'settings',
    usage: 'sideby config get [<key>]',
    help: 'every setting with its value and meaning, or one setting',
    summary: { en: 'Every setting with its value and meaning', zh: '每项设置的取值和含义' },
    example: 'sideby config get panel.theme',
  },
  {
    id: 'config.set',
    group: 'settings',
    usage: 'sideby config set <key> <value> [--yes]',
    help: 'change any setting (sideby config set panel.theme dark)',
    summary: { en: 'Change any setting', zh: '修改任意一项设置' },
    example: 'sideby config set panel.theme dark',
  },
  {
    id: 'config.unset',
    group: 'settings',
    usage: 'sideby config unset <key> [--yes]',
    help: 'back to the default',
    summary: { en: 'Put a setting back to its default', zh: '把一项设置恢复默认' },
  },
  {
    id: 'terminal',
    group: 'settings',
    usage: 'sideby terminal [--set <id>|--custom <t>|--unset]',
    help: 'choose your terminal',
    summary: { en: 'Choose the terminal sideby opens tasks in', zh: '选择 sideby 打开任务用的终端' },
    feature: 'setting.terminal',
  },
  {
    id: 'update',
    group: 'settings',
    usage: 'sideby update [--yes]',
    help: 'update sideby to the newest version (shows the command first)',
    summary: { en: 'Update sideby to the newest version', zh: '把 sideby 更新到最新版本' },
    example: 'sideby update',
    feature: 'action.update',
  },
  {
    id: 'update.auto',
    group: 'settings',
    usage: 'sideby update --auto on|off',
    help: 'set Auto Update without running an update',
    summary: { en: 'Turn Auto Update on or off', zh: '开关自动更新' },
  },
  {
    id: 'update.skill',
    group: 'settings',
    usage: 'sideby update --skill [--yes]',
    help: 'update only the installed sideby skill to this version',
    summary: { en: 'Update only the installed sideby skill', zh: '只更新已安装的 sideby 技能' },
    feature: 'setting.skill',
  },
  {
    id: 'local',
    group: 'settings',
    usage: 'sideby local [on|off] [--yes]',
    help: 'for sideby developers: switch the global sideby between the last local build (pnpm local) and the npm package',
    summary: {
      en: 'For sideby developers: use the local build or the npm package',
      zh: '给 sideby 开发者：在本地构建和 npm 包之间切换',
    },
  },
  // ---------- Help, AI and plugins ----------
  {
    id: 'commands',
    group: 'help',
    usage: 'sideby commands',
    help: 'list every command by task, the common ones first (in the Panel: Commands, or press ?)',
    summary: { en: 'List every command by task', zh: '按任务列出所有命令' },
    example: 'sideby commands',
    feature: 'action.commands',
  },
  {
    id: 'commands.find',
    group: 'help',
    usage: 'sideby commands <words>',
    help: 'find where a page, setting or action lives in the Panel, and the command that does the same (read-only)',
    summary: {
      en: 'Find where a feature lives in the Panel, and its command',
      zh: '查某个功能在面板哪里，以及对应的命令',
    },
    example: 'sideby commands language',
  },
  {
    id: 'ask',
    group: 'help',
    usage: 'sideby ask [<text>] [--print]',
    help: 'let your AI handle a sideby task',
    summary: { en: 'Let your AI handle a sideby task', zh: '让你的 AI 处理一件 sideby 的事' },
    feature: 'action.ask-ai',
  },
  {
    id: 'plugins',
    group: 'help',
    usage: 'sideby plugins',
    help: 'list loaded plugins and load errors',
    summary: { en: 'List loaded plugins and load errors', zh: '列出已加载的插件和加载错误' },
  },
  {
    id: 'plugins.new',
    group: 'help',
    usage: 'sideby plugins new <id>',
    help: 'create a local Family Plugin skeleton',
    summary: { en: 'Create a plugin that adds a tool', zh: '新建一个支持新工具的插件骨架' },
  },
  {
    id: 'plugins.check',
    group: 'help',
    usage: 'sideby plugins check <id|path>',
    help: 'check a plugin and show fixes',
    summary: { en: 'Check a plugin and show fixes', zh: '检查插件并给出修法' },
  },
]

/** The common commands, in the order the "Common" group shows them. */
export function commonCommands(list: readonly CliCommand[] = CLI_COMMANDS): CliCommand[] {
  return list.filter((c) => c.common).sort((a, b) => (a.common ?? 0) - (b.common ?? 0))
}

/** The commands `main.ts` dispatches for a usage line: `run`; `pin` and `unpin` for `pin|unpin`; `list` for `sideby`. */
export function commandWords(usage: string): string[] {
  return (usage.split(' ')[1] ?? 'list').split('|')
}

/**
 * Commands matching `query`, in catalog order. Every word of the query must appear in the usage, the example, the
 * description in either language or the group's title; an empty query matches everything. Runs in the Panel too.
 */
export function filterCommands<
  T extends { usage: string; group: string; summary: { en: string; zh: string }; example?: string },
>(
  query: string,
  list: readonly T[],
  groups: readonly { id: string; title: { en: string; zh: string } }[],
): readonly T[] {
  const words = catalogNorm(query).split(' ').filter(Boolean)
  if (!words.length) return list
  return list.filter((c) => {
    const g = groups.find((x) => x.id === c.group)
    const text = catalogNorm(
      [c.usage, c.example || '', c.summary.en, c.summary.zh, g ? g.title.en : '', g ? g.title.zh : ''].join(
        ' ',
      ),
    )
    return words.every((w) => text.includes(w))
  })
}

const HELP_COL = 38
const HELP_WIDTH = 118

function wrapHelp(text: string): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > HELP_WIDTH - HELP_COL) {
      lines.push(line)
      line = word
    } else line = line ? `${line} ${word}` : word
  }
  if (line) lines.push(line)
  return lines
}

/** One command as `sideby --help` prints it: the usage, then its description from column 38, wrapped. */
function helpEntry(c: CliCommand): string {
  const head = `  ${c.usage}`
  const pad = ' '.repeat(HELP_COL)
  const sameLine = head.length < HELP_COL
  const lines = wrapHelp(c.help)
  const out = sameLine ? [head.padEnd(HELP_COL) + lines[0]] : [head, pad + lines[0]]
  for (const l of lines.slice(1)) out.push(pad + l)
  return out.join('\n')
}

/** `sideby --help`: the commands grouped by task, from the Command List, then the options and the notes. */
export function cliHelp(list: readonly CliCommand[] = CLI_COMMANDS): string {
  const parts = [
    'sideby — run every AI coding account side by side',
    '',
    'Usage, by task (`sideby commands` lists them with examples; `sideby <command> --help` explains one):',
  ]
  for (const g of COMMAND_GROUPS) {
    const cmds = list.filter((c) => c.group === g.id)
    if (!cmds.length) continue
    parts.push('', `${g.title.en}:`, ...cmds.map(helpEntry))
  }
  parts.push('', HELP_TAIL)
  return parts.join('\n')
}

const HELP_TAIL = `Options:
  --json        machine-readable output (list, new, next, alias, doctor, quota, tune, model, remote-control, handoff,
                families, commands, plugins, app, desktop, sessions, history, send, messages, edit, browser, update, local, ask,
                terminal, key, try, autostart, menubar, config, network, unattended)
  -h, --help    show this help; \`sideby <command> --help\` for new, alias, login, doctor, families, commands, desktop, edit, browser,
                autostart, menubar, config, sessions, history, send, messages, network, unattended
  -v, --version show the version

An <account> is <family>:<name> (claude:work) or just <name> when it is unique.

For AI agents:
  Add --json and read the result; JSON Schemas ship in the package under schemas/.
  Install the skill: npx skills add Adonis0123/sideby -g
  Setup steps and the full contract: https://github.com/Adonis0123/sideby/blob/main/llms.txt
  Run everything else yourself, but hand the user these as one line each: \`sideby login <account>\`
  (browser sign-in), filling in proxy.env, and \`sideby run\` or \`sideby next\` (interactive sessions).
  Exit 10 means a change was shown: ask the user, then run it again with --yes.

Updates: once a day sideby asks the npm registry for its newest version and says so after a command.
  Turn it off with NO_UPDATE_NOTIFIER=1 or config "update": { "check": false }; "auto": true installs by itself.`

/** What the Panel embeds: everything but the `--help` text, which only the terminal shows. */
export function commandListForPage(): {
  groups: readonly CommandGroup[]
  commands: Omit<CliCommand, 'help'>[]
} {
  return { groups: COMMAND_GROUPS, commands: CLI_COMMANDS.map(({ help: _help, ...rest }) => rest) }
}
