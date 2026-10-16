# 命令

[English](commands.md) | 中文

← [README](../../README.zh-CN.md)

| 命令 | 作用 | 退出码 |
|---|---|---|
| `sideby` | 等同于 `sideby list` | 0 |
| `sideby list` | 列出账号、类型（main、sub 或 api）、登录态、模型和目录；读取时遇到的问题输出到 stderr | 0 |
| `sideby run <acct> [-- args]` | 用某个账号启动宿主 | 宿主的退出码；被信号 n 终止时为 128+n |
| `sideby next <family> [--dry-run] [--include-api] [-- args]` | 推荐剩余额度最多的账号（Claude、Codex）并启动；`--dry-run` 只推荐 | 宿主的退出码；`--dry-run` 或 `--json` 有推荐时为 0；没有可用账号、都还没有额度数据、家族没有额度来源或没有账号为 1 |
| `sideby new <family> <name>\|--next [--api] [--alias <short>]` | 新建账号并铺好共享项；`--next` 自动选下一个空闲的名字和短命令（`cc008`）；`--alias` 同时把 `cc008` 这样的短命令加进 `aliases` | 0；部分失败或短命令没加上为 1 |
| `sideby families [family]` | 每个宿主的账号和主账号共享什么、放在哪、怎么登录 | 0 |
| `sideby alias add <short> <acct> [-- args]` | 给已有账号加短命令，可以带 `sideby run` 时附加的宿主参数 | 0，已存在也是 0；名字被占用、不合法或账号不存在为 1 |
| `sideby alias rm <short>` | 删掉一个短命令 | 0，不存在也是 0 |
| `sideby resume <family> [-- args]` | 运行宿主；参数按 id 恢复会话时（`claude --resume <id>`、`codex resume <id>`、`grok --resume <id>`），像 `run` 一样启动存有该会话的账号；从没保存过的 Claude 会话，在起过它的账号开新会话；其他情况原样运行宿主 | 宿主的退出码；家族不存在或不支持会话路由（pi）为 1 |
| `sideby login <acct>` | 用该账号运行家族的登录命令；pi 会直接启动，并提示你输入 `/login` | 宿主的退出码 |
| `sideby doctor [acct\|family] [--fix] [--force]` | 检查共享项、凭据文件权限和备份残留；`--fix` 修复安全的部分 | 0 没有 fail（允许有 warn）；1 至少一条 fail |
| `sideby quota [acct]` | 额度和近 7 天用量 | 0 |
| `sideby quota setup claude [--yes]` | 展示改动；加 `--yes` 才开启 Claude 额度来源 | 只展示改动时为 10；开启后为 0；无法开启或失败为 1 |
| `sideby quota teardown claude` | 关闭并还原原文件 | 0；拒绝或失败为 1 |
| `sideby tune [acct\|family]` | 用最近 7 天的会话估算每个模型最省的自动压缩阈值（Claude 给推荐值，Codex 只观测）；只读 | 0；账号或家族不存在为 1；多给参数为 2 |
| `sideby model <acct> [<model>\|default] [--effort <level>\|default] [--yes]` | 显示这个账号启动时用的模型和 effort 及各自来源；给出改动时先展示，加 `--yes` 才保存（Claude、Codex） | 0；等待 `--yes` 为 10；值不合法或是 API 账号为 1 |
| `sideby tune apply <acct> [tokens] [--yes]` / `sideby tune undo <acct> [--yes]` | 把建议的自动压缩大小（或你给的大小，如 `120k`）用在一个 Claude 账号上，或恢复原值。只写该账号 `settings.json` 里的一个键；不加 `--yes` 只展示改动 | 只展示改动时为 10；完成为 0；被拦下、没有可撤销的、没有建议为 1；命令行有误为 2 |
| `sideby remote-control [off\|undo] [--yes]` | 显示每个 Claude 设置文件会不会自动打开 Remote Control；`off` 把开着或没设置的都改成 `remoteControlAtStartup: false`，`undo` 恢复原来的值（都先展示改动） | 只展示改动时 10；完成或无需改动 0；改不了、失败或没有可撤销的 1 |
| `sideby handoff status` | 按家族列出本机启用自动交接还差什么，以及接下来要运行的命令 | 0 |
| `sideby handoff enable [--same-family] [--order <family>=<acct,…>] [--threshold n] [--prepare-at n] [--yes]` | 展示 config 改动；加 `--yes` 才开启（其他设置保留），并列出还要做的步骤 | 只展示改动时为 10；写入后或已是这样为 0；`--order` 里有找不到的账号为 1 |
| `sideby handoff disable [--yes]` | 关闭，其他设置保留 | 只展示改动时为 10；写入后或本来就关着为 0 |
| `sideby handoff ready [--to <account>] [--brief <file>]` | 在 sideby 以自动交接启动的会话里：这一轮结束后交给下一个账号，并说出是哪个；`--to` 指定账号，也可以是这条链用过的账号（交回额度已恢复的账号）；`--brief` 用你自己写的交接说明 | 0；不在这类会话里、读不了 brief 文件，或没有账号（或指定的账号）能接时为 1 |
| `sideby handoff setup grok [--yes]` | 展示改动；加 `--yes` 才添加 sideby 的 hook 文件，让 Grok 撞上限额时能交接 | 只展示改动时为 10；开启后为 0；无法开启或失败为 1 |
| `sideby handoff teardown grok` | 文件未被改动时删除它 | 0；拒绝或失败为 1 |
| `sideby ui [--port n] [--no-open]` | 本地面板，按 Ctrl+C 停止 | — |
| `sideby ui --background` / `--stop` | 脱离终端启动面板（已有就复用，sideby 升级后则替换旧的）并打开 / 停掉它 | 0；启动或停止失败为 1 |
| `sideby desktop <acct>` | 用这个账号打开 Claude Desktop 或 Codex 应用，和其他账号的窗口同时开着；已经开着就切到前台（macOS） | 0；不是 macOS、这个宿主没有桌面应用、API 账号、应用没装或没能打开为 1 |
| `sideby browser [--enable\|--disable] [--yes]` | 每个账号的网站在哪个 Chrome 浏览器用户里登录过，只在本机读取；`--enable --yes` 之前不读（macOS） | 0；`--enable`/`--disable` 不带 `--yes` 为 10 |
| `sideby browser open <acct> [--profile <名字>]` | 用登录过这个账号的浏览器用户打开 claude.ai、chatgpt.com 或 grok.com，或者用 `--profile` 指定的那个（macOS） | 0；不是 macOS、没装 Chrome、没有或有多个浏览器用户可选、没能打开为 1 |
| `sideby desktop grok-bot:<名字> [--remove [--yes]]` | 按名字打开一个 Grok Bot 窗口，新名字就新建一个未登录的窗口；`--remove` 删掉你建的窗口和它的数据（macOS） | 0；不是 macOS、名字不对、应用没装、窗口开着（`--remove` 时）或没能打开为 1；`--remove` 不带 `--yes` 为 10 |
| `sideby app install [--url <url>]` | 添加打开面板（或 `<url>`）的面板应用（macOS、Linux） | 0；平台不支持或目标位置有不是它创建的文件为 1 |
| `sideby app uninstall` | 删除 `app install` 创建的文件 | 0；留下了不是它创建的文件为 1 |
| `sideby shell-init zsh\|bash` | 输出每个账号和每个别名的 shell 函数 | 0 |
| `sideby shell-init [zsh\|bash] --write` | 用这份输出重写 config 里配置的 `shellInitFile` | 0；写不了或没有配置为 1 |
| `sideby plugins` | 已加载的插件和加载错误 | 0；有插件加载失败时为 1 |
| `sideby update [--yes]` | 向 npm registry 查 sideby 最新版本，显示安装它的命令；带 `--yes` 就执行，并重启后台面板（见[更新](configuration.zh-CN.md#更新)） | 0 已是最新或已更新；只显示了命令为 10；这种安装方式不能自己更新（会打印要运行的命令）、连不上 registry 或安装失败为 1 |

- 所有命令遇到用法错误（未知选项、缺参数）时退出码为 2；sideby 自身出错（账号不存在、名字不合法、配置读不了）时为 1。
- `<acct>` 写成 `<family>:<name>`；名字在所有家族里唯一时，只写 `<name>` 也行。有歧义就报错，并列出候选。
- 退出码 10 表示命令展示了改动、在等你确认：同意的话，加上 `--yes` 再跑一次同一条命令。
- `list`、`new`、`next`、`alias`、`doctor`、`quota`（包括 `setup` 和 `teardown`）、`tune`、`model`、`remote-control`、`handoff`、`families`、`plugins`、`app`、`desktop` 支持 `--json`，输出带 `schemaVersion: 1`，JSON Schema 随包放在 [`schemas/`](../../schemas/)。加了 `--json` 时，出错会输出 `{ "schemaVersion": 1, "error": "…", "code": "…" }`：命令行写错时 `code` 为 `usage`，其他情况是 `no-quota-source` 这样的原因。只新增字段时版本不变；删除、改名或改语义时加 1。
- 任何输出、日志和错误信息里都不会出现凭据的值。
