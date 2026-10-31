# 命令

[English](commands.md) | 中文

← [README](../../README.zh-CN.md)

| 命令 | 作用 | 退出码 |
|---|---|---|
| `sideby` | 等同于 `sideby list` | 0 |
| `sideby list` | 列出账号、类型（main、sub 或 api）、登录态、模型和目录；读取时遇到的问题输出到 stderr。隐藏的工具和账号不列出（`--all` 会列出，标 `(hidden)`） | 0 |
| `sideby hide\|unhide <family\|account>` | 把整个工具，或一个账号连同它的 Same Login，从面板、菜单栏和 `sideby list` 里隐藏，或取消隐藏。只影响显示：照常能启动，照常能接班 | 0；1 账号不存在，或要单独显示隐藏工具里的一个账号 |
| `sideby run <acct> [-- args]` | 用某个账号启动宿主 | 宿主的退出码；被信号 n 终止时为 128+n |
| `sideby next <family> [--dry-run] [--include-api] [-- args]` | 推荐剩余额度最多的账号（Claude、Codex）并启动；`--dry-run` 只推荐 | 宿主的退出码；`--dry-run` 或 `--json` 有推荐时为 0；没有可用账号、都还没有额度数据、家族没有额度来源或没有账号为 1 |
| `sideby new <family> <name>\|--next [--api] [--alias <short>]` | 新建账号并铺好共享项；`--next` 自动选下一个空闲的名字和短命令（`cc008`）；`--alias` 同时把 `cc008` 这样的短命令加进 `aliases` | 0；部分失败或短命令没加上为 1 |
| `sideby commands` | 按任务列出所有命令，常用的在前，每条一句说明和一个例子（面板的“命令”对话框和 `sideby --help` 用同一份列表） | 0 |
| `sideby commands <词>` | 某个页面、设置或操作在面板哪里，以及做同一件事的命令（只读；面板的搜索用同一份列表） | 0，没有匹配也是 |
| `sideby families [family]` | 每个宿主的账号和主账号共享什么、放在哪、怎么登录 | 0 |
| `sideby alias add <short> <acct> [-- args]` | 给已有账号加短命令，可以带 `sideby run` 时附加的宿主参数 | 0，已存在也是 0；名字被占用、不合法或账号不存在为 1 |
| `sideby alias rm <short>` | 删掉一个短命令或自动选号命令 | 0，不存在也是 0 |
| `sideby alias add <short> --pick <family> [--yes]` | 加一个自动选号命令：每次启动这个家族额度最多的账号，没有额度数据时启动主账号 | 0；没有 `--yes` 时为 10（显示会加什么、会遮住 PATH 上哪个命令）；名字被占用或不合法为 1 |
| `sideby shell-init setup [zsh\|bash] [--yes\|--undo]` | 让新终端能用短命令：往 `~/.zshrc` 或 `~/.bashrc` 加一行，先显示再写 | 0；没有 `--yes` 时为 10 |
| `sideby alias list` | 列出短命令和自动选号命令 | 0 |
| `sideby resume <family> [-- args]` | 运行宿主；参数按 id 恢复会话时（`claude --resume <id>`、`codex resume <id>`、`grok --resume <id>`），像 `run` 一样启动存有该会话的账号；从没保存过的 Claude 会话，在起过它的账号开新会话；其他情况原样运行宿主 | 宿主的退出码；家族不存在或不支持会话路由（pi）为 1 |
| `sideby login <acct>` | 用该账号运行家族的登录命令，前后各说一次它登录的是谁（也用来给账号换号）；pi 会直接启动，并提示你输入 `/login` | 宿主的退出码 |
| `sideby doctor [acct\|family] [--fix] [--force]` | 检查共享项、凭据文件权限和备份残留；`--fix` 修复安全的部分 | 0 没有 fail（允许有 warn）；1 至少一条 fail |
| `sideby quota [acct]` | 额度和近 7 天用量 | 0 |
| `sideby quota setup claude [--yes]` | 展示改动；加 `--yes` 后会话进行中也从 status line 读 Claude 额度（自动接力需要；不开也能看到额度） | 只展示改动时为 10；开启后为 0；无法开启或失败为 1 |
| `sideby quota teardown claude` | 关闭并还原原文件 | 0；拒绝或失败为 1 |
| `sideby tune [acct\|family]` | 用最近 7 天的会话估算每个模型最省的自动压缩阈值（Claude 给推荐值，Codex 只观测）；只读 | 0；账号或家族不存在为 1；多给参数为 2 |
| `sideby model <acct> [<model>\|default] [--effort <level>\|default] [--yes]` | 显示这个账号启动时用的模型和 effort 及各自来源；给出改动时先展示，加 `--yes` 才保存（Claude、Codex） | 0；等待 `--yes` 为 10；值不合法或是 API 账号为 1 |
| `sideby tune apply <acct> [tokens] [--yes]` / `sideby tune undo <acct> [--yes]` | 把建议的自动压缩大小（或你给的大小，如 `120k`）用在一个 Claude 账号上，或恢复原值。只写该账号 `settings.json` 里的一个键；不加 `--yes` 只展示改动 | 只展示改动时为 10；完成为 0；被拦下、没有可撤销的、没有建议为 1；命令行有误为 2 |
| `sideby remote-control [on\|off\|undo] [--yes]` | 显示每个 Claude 设置文件会不会自动打开 Remote Control；`off` 把开着或没设置的都改成 `remoteControlAtStartup: false`，`on` 把关着或没设置的都改成 `true`，`undo` 恢复原来的值（都先展示改动） | 只展示改动时 10；完成 0；无需改动、改不了、失败或没有可撤销的 1 |
| `sideby network [check]`、`sideby network allow <地区代码>...`、`sideby network on\|off` [--yes] | 网络检查：显示 Claude、Codex 的请求从哪里发出（`check` 现在查），设置允许的地区，打开或关闭（每次改动先展示）。打开后，启动账号、以及 sideby 启动的会话里每条消息和工具调用前，地区不在允许范围内或查不出时都会被拦下；`run`、`next`、`resume` 加 `--ignore-network` 可以跳过一次 | 只展示改动时 10；显示或完成 0；地区代码不对、或没有允许的地区就打开 1；`run` 被拦时 1 |
| `sideby unattended [status]`、`sideby unattended on [--for 4h\|--until 07:30\|--slot-end]`、`sideby unattended off` | 无人值守：显示开没开、为什么、到几点、时间表、未处理的 Pending Decision 和覆盖哪些 Host；现在打开（最长 72 小时）或关闭（在时段内只暂停到这一段结束）。开着时，sideby 启动的 Claude、Codex 会话不能提问；Claude 会话里 Claude Code 要弹的权限确认直接回答「不行」（记成 Pending Decision）。`run`、`next`、`resume`、短命令和挑选命令加 `--unattended` 只让这一个会话无人值守 | 0；时间或选项不对 2 |
| `sideby unattended schedule [add --days <days> --from HH:MM --to HH:MM [--name <名字>]\|remove <n>\|preset weeknights]` | 时间表：列出时段、加一个、按编号删一个，或加上周一到周五 23:00 到次日 08:00。每次改动都打印撤销命令 | 0；没有这个时段 1；星期或时间不对 2 |
| `sideby unattended pending [--all]`、`sideby unattended pending done <id>\|--all`、`sideby unattended defer "<文字>"` | Pending Decision（待你决定）：会话没能问出口的问题和跳过的操作；标成已处理（30 天后删除）；在会话里记一条 | 0；没有这条 1 |
| `sideby handoff status` | 按家族列出本机启用自动接力还差什么，以及接下来要运行的命令 | 0 |
| `sideby handoff enable [--same-family] [--order <family>=<acct,…>] [--threshold n] [--prepare-at n] [--yes]` | 展示 config 改动；加 `--yes` 才开启（其他设置保留），并列出还要做的步骤 | 只展示改动时为 10；写入后或已是这样为 0；`--order` 里有找不到的账号为 1 |
| `sideby handoff disable [--yes]` | 关闭，其他设置保留 | 只展示改动时为 10；写入后或本来就关着为 0 |
| `sideby handoff ready [--to <account>] [--brief <file>]` | 在 sideby 以自动接力启动的会话里：这一轮结束后交给下一个账号，并说出是哪个；`--to` 指定账号，也可以是这条链用过的账号（交回额度已恢复的账号）；`--brief` 用你自己写的接力说明 | 0；不在这类会话里、读不了 brief 文件，或没有账号（或指定的账号）能接时为 1 |
| `sideby handoff setup grok [--yes]` | 展示改动；加 `--yes` 才添加 sideby 的 hook 文件，让 Grok 撞上限额时能接力 | 只展示改动时为 10；开启后为 0；无法开启或失败为 1 |
| `sideby handoff teardown grok` | 文件未被改动时删除它 | 0；拒绝或失败为 1 |
| `sideby ui [--port n] [--no-open]` | 本地面板，按 Ctrl+C 停止 | — |
| `sideby ui --background` / `--stop` | 脱离终端启动面板（已有就复用，sideby 升级后则替换旧的）并打开 / 停掉它 | 0；启动或停止失败为 1 |
| `sideby desktop <acct>` | 用这个账号打开 Claude Desktop 或 Codex 应用，和其他账号的窗口同时开着；已经开着就切到前台（macOS） | 0；不是 macOS、这个宿主没有桌面应用、API 账号、应用没装或没能打开为 1 |
| `sideby browser [--enable\|--disable] [--yes]` | 每个账号的网站在哪个 Chrome 浏览器用户里登录过，只在本机读取；`--enable --yes` 之前不读（macOS；WSL 里读 Windows 上的 Chrome） | 0；`--enable`/`--disable` 不带 `--yes` 为 10 |
| `sideby browser open <acct> [--profile <名字>]` | 用登录过这个账号的浏览器用户打开 claude.ai、chatgpt.com 或 grok.com，或者用 `--profile` 指定的那个（macOS；WSL 里用 Windows 上的 Chrome） | 0；不是 macOS 或 WSL、没装 Chrome、没有或有多个浏览器用户可选、没能打开为 1 |
| `sideby browser set <acct> <名字>` / `--auto` | sideby 认错时，自己指定这个账号的 Chrome 浏览器用户（存在 config `browser.choices`）；`--auto` 改回自动识别 | 0；没有这个浏览器用户、同名的有多个、账号没有网站为 1 |
| `sideby desktop grok-bot:<名字> [--remove [--yes]]` | 按名字打开一个 Grok Bot 窗口，新名字就新建一个未登录的窗口；`--remove` 删掉你建的窗口和它的数据（macOS） | 0；不是 macOS、名字不对、应用没装、窗口开着（`--remove` 时）或没能打开为 1；`--remove` 不带 `--yes` 为 10 |
| `sideby sessions [acct\|family]` | 列出每个账号正在运行的会话，一行一个：Session Label（`cc002 · knip cleanup · 61230c3d`，即账号、宿主自己的会话标题、id 前 8 位）、是否需要你处理（不是会话自己在问时说明原因：`needs you: a decision` 是有 Pending Decision 待你决定，`approve a message`、`paste a message` 是有消息等你批准或粘贴，并给出查看它的命令）、工作目录、开始时间；需要你处理的排最前。sideby 对不上运行中程序的 Codex 或 pi 会话，取该账号最新的会话并标为推测。本机的编排工具（如 `agent-dispatch` skill）发布了会话属于哪个任务（Run）时，多一列 `RUN`，表下每个任务一行，给出它的看板文件。只读，不读凭证 | 0；账号或家族不存在为 1 |
| `sideby sessions copy <acct\|session-id> [--as reference\|id\|resume] [--lang en\|zh]` | 把一个会话复制给另一个 AI：默认复制 Session Reference（一句话，写明账号、Label 和记录文件路径），也可以复制 id 或恢复命令。用 pbcopy（macOS）、wl-copy 或 xclip（Linux）；都没有时把文字打印出来 | 0；没有这个账号或运行中的会话、或这个账号有几个会话（会列出来，按 id 复制其中一个）为 1 |
| `sideby sessions open-run <acct\|session-id>` | 用系统默认程序打开会话所在任务的报告（Run Board），和面板会话页上的任务标签一样。选会话的规则同 `sessions copy`；只打开编排工具会话索引里写的看板，打开前再检查一次 | 0；没有这个运行中的会话、有几个会话（会列出来）、会话不在任务里、或报告变了或没打开为 1 |
| `sideby history [<关键词>...] [--project <路径\|名字>] [--family <id>] [--account <acct>] [--since today\|7d\|30d\|all] [--category <c>] [--group <g>] [--scripts] [--tools] [--limit <n>] [--offset <n>]` | 找回任何账号以前的任何会话（Session History），默认按最近活动排，有关键词时按匹配程度排。一行显示最近活动时间、账号、Session Title（你起的名字，没有就用宿主的标题，再没有就用你的第一条提问）、Project（会话所在的 git 仓库，worktree 和子目录都算进去）、分支和 id；有关键词时下一行是命中的片段。每个关键词都要命中；用引号括起来（`"fix login"`）就按整句匹配；中文词和一两个字的词也能搜。`--project .`（或任意文件夹路径）表示这个文件夹所在的项目。`--limit` 最多 500，`--offset 500` 看下一页。Script Session（脚本、SDK 或别的 agent 启动的会话）只在加 `--scripts` 时显示；`--tools` 会现场读筛选范围内的会话文件来搜工具输出，什么都不存；这些结果排在最后一页，带 `foundIn: "tools"`。`--group project\|category\|account\|family\|day\|none` 按组列出，每组一行组头（不能和 `--tools` 一起用）；插件给项目分了类时，`--category <名字>` 只看这一类。只读，不读凭证 | 0；没有这个项目、分类或账号为 1；参数写错为 2 |
| `sideby history show <id> [--account <acct>] [--before <n>] [--limit <n>]` | 只读查看一个会话（id 或至少前 8 位；两个账号都有这个 id 的会话时，用 `--account` 选一个）：最新 200 条消息，工具调用每个只占一行；`--before` 往前翻。最后给出在原目录继续它的命令（`cd <它的目录> && <恢复命令>`） | 0；没有这个会话、或有几个会话都对得上这个 id 为 1 |
| `sideby history projects` | 列出各个 Project 和它们的会话数，最近活动的排前面；插件给了分类时带上每个项目的分类 | 0 |
| `sideby history index [--clear]` | History Index，即 sideby 在本机为每个会话的标题、Project、你的提问和回答建的搜索索引（不存工具输出；放在 sideby 的状态目录，权限 600）：建到哪了、每个账号读到多少会话。`--clear` 删掉它，下次查看时从宿主文件重建。config `history.index: false` 关掉并删除它 | 0 |
| `sideby send <acct\|session> "<text>" [--image <path>]... [--lang en\|zh]` | 给另一个正在运行的会话传话，可以带截图，也可以只发截图（PNG、JPEG、GIF、WebP，每张不超过 20 MB）。sideby 先把消息（Message）存成文件（mode 600，放在它的状态目录），再送达：Claude Code 会话走 Claude Code 自带的跨会话消息，Codex 会话走 `codex queue`（Codex 0.163 起，这一轮结束后读到）；Grok Build 和 pi 会把一句话复制到剪贴板，你粘贴到那个 tab。在会话里运行时，消息会写明是哪个会话发的，并在末尾加一行对方可以照着回话的 `Reply: sideby send <你的会话 id> "<text>"`。交出去了但没法确认到没到时，它说「未确认送达」，不复制任何东西：再发之前先去那个会话看看。想知道某个 Claude Code 会话什么时候忙完，直接问你的 AI：Claude Code 自带的空闲提醒（`SendMessage` 的 `notify_when_idle`，2.1.236 起）能对本机的会话做到，所以 sideby 不另做 | 0 已送达、未确认送达或已存好待粘贴；没有这个运行中的会话、有几个会话（会列出来，按 id 发给其中一个）、或文件不是截图为 1 |
| `sideby messages [--to <acct\|session>] [--limit <n>]` | 你发过的消息，最新的在前，以及每条到了哪一步：已送达、等批准（在对方终端里；6 分钟没读就变成需要你粘贴）、已读（对方记录里出现了它的 id）、需要你粘贴、未确认送达（显示为 `Not confirmed`，它可能稍后出现，再发之前先去看看；出现 id 后变成已读） | 0 |
| `sideby messages inbound [accept\|undo] [--yes]` | 每个 Claude 账号是否马上显示别的会话发来的消息（`crossSessionInbound`）。不设的话，bypass 权限模式下的会话会把每条消息扣下等你批准，约 5 分钟后丢掉。`accept` 先展示改动，加 `--yes` 才写入，只改这一个键，只改没设或为 `hold` 的文件；`refuse` 和其他值都不动，逐个说明原因；`undo` 原样恢复改之前的值 | 0；有文件改不了、一个都没改、或没有可撤销的为 1；展示了改动、等 `--yes` 为 10 |
| `sideby edit <acct> [--path]` | 用默认编辑器打开这个账号自己的设置文件（`settings.json`、`config.toml`）；`--path` 只输出路径。sideby 不读文件内容 | 0；文件不存在、这个宿主没有设置文件或没能打开为 1 |
| `sideby app install [--url <url>]` | 添加打开面板（或 `<url>`）的面板应用（macOS、Linux） | 0；平台不支持或目标位置有不是它创建的文件为 1 |
| `sideby app uninstall` | 删除 `app install` 创建的文件 | 0；留下了不是它创建的文件为 1 |
| `sideby shell-init zsh\|bash` | 输出每个账号和每个别名的 shell 函数 | 0 |
| `sideby shell-init [zsh\|bash] --write` | 用这份输出重写 config 里配置的 `shellInitFile` | 0；写不了或没有配置为 1 |
| `sideby plugins` | 已加载的插件和加载错误 | 0；有插件加载失败时为 1 |
| `sideby plugins new <id>` | 为 sideby 还不支持的工具，在第一个插件目录里建一个本地 Family 插件：`plugin.json`、每个必填字段都带 `TODO` 的 `index.ts` 骨架和一个测试（见[插件](plugins.zh-CN.md#加一个-sideby-还不支持的工具)） | 0；名字不合法或目录已存在为 1 |
| `sideby plugins check <id>` | 检查这个插件：必填字段、共享项路径、logo、只用 type import、在临时 HOME 里跑一遍发现、启动和体检，以及有没有个人信息；每个问题都写明怎么改 | 0 全部通过；有问题为 1 |
| `sideby ask [<text>] [--task fix\|quota\|account\|host\|plugin] [--account <acct>] [--terminal <id>] [--attach <file>]… [--print]` | 打开首选终端，用你的一个账号带着这件事的短提示启动，和面板的「让 AI 帮我」一样（见[让 AI 帮我](panel.zh-CN.md#让-ai-帮我)）；`--attach` 加一张截图或一段视频（可写多次，最多 5 个；图片最大 20MB，视频最大 200MB），文件复制到 sideby 自己的目录并列进提示词；`--print` 只打印提示词，文件留在原处 | 0 已打开或已打印；终端打不开、没有能用的账号为 1（`--json` 会给出要粘贴的命令）；未知任务为 2 |
| `sideby ask --run <id>` | 终端里实际运行的命令：读出面板或 `ask` 准备好的任务，带着提示词启动账号。任务保留一小时 | 宿主的退出码；任务不存在或已过期为 1 |
| `sideby ask --spec - [--print] --json` | 给 Portal 用（把 sideby 和其他工具做成标签页的页面）：从 stdin 读一个 JSON 对象（最大 1MB），按它开始一个 AI Task。可以是 `{ "specVersion": 1, "prompt": …, "cwd": … }`，Portal 为别的工具写好的提示词（sideby 会再删一次像密钥的文字，并加上附件），也可以是 `{ "specVersion": 1, "native": { "task": …, "text": …, "context": … } }`，sideby 自己的任务，提示词照旧。两种都可以带 `lang`、`account`、`terminal`、`remember`、`files`。`--print` 只返回 `{ prompt, removedSecrets }` | 同 `ask`；内容不合法、超过大小、`cwd` 不是 HOME 里已有的文件夹为 1（`code` 和 `reason` 说明是哪种）；`specVersion` 不认识为 2（请更新 sideby） |
| `sideby ask --choices --json` | 给 Portal 用：任务现在会用哪个账号（用不了时说明原因）、能用哪些账号、本机装了哪些终端以及会打开哪个 | 0 |
| `sideby terminal [--set <id>\|--unset]` | 列出支持的终端、本机装了哪些、当前用哪个；`--set` 保存首选终端 | 0；sideby 不认识的终端为 1 |
| `sideby menubar [on\|off] [--yes]` | 在 macOS 状态栏显示额度：sideby 小人图标；某个工具连下一个要用的账号也到了提醒级别（5 小时窗口 60%，每周窗口 85%）时，旁边显示工具名和百分比；点开列出每个账号的额度，点一个账号就在终端里启动它。`menubar snapshot` 打印菜单内容；`menubar start <账号>` 在终端里启动账号；`menubar hotkey [<组合键>\|off\|default]` 查看或更换打开菜单的快捷键（⌥X）。先显示要写的文件 | 0；有变化等 `--yes` 为 10；被拒绝（Windows 原生、sideby 在 npx 缓存或临时目录里、文件不是 sideby 的）为 1 |
| `sideby autostart [on\|off] [--yes]` | 登录后在后台启动面板（macOS、Linux 桌面、WSL：登录 Windows 时），不打开窗口；不带 `on`/`off` 时报告开着、关着、过期了，还是被一个不是 sideby 写的文件挡住。先显示要写的文件（macOS 还有 `launchctl` 命令） | 0；有变化等 `--yes` 为 10；被拒绝（不是 macOS、sideby 在 npx 缓存或临时目录里、文件不是 sideby 的）为 1 |
| `sideby theme [list]` / `theme use <名字>` / `theme use --undo` / `theme check <名字\|文件>` / `theme preview <名字\|文件>` / `theme import <文件> [--id <名字>] [--yes]` / `theme export <名字> [--out <文件>]` / `theme remove <名字> [--yes]` | 面板主题：列出、切换和撤销，检查亮暗两套的对比度，在运行中的面板里看一眼，把自己的主题存成 JSON 文件（只放颜色） | 完成为 0；`check` 有太淡的颜色为 1；`import` 遇到同名、`remove` 等 `--yes` 为 10；拒绝为 1；命令写错为 2 |
| `sideby config get [<key>]` / `config set <key> <value> [--yes]` / `config unset <key> [--yes]` | 读或改任意设置，比如 `panel.theme`（`system`、`light`、`dark`）、`panel.language`（`auto`、`en`、`zh`）、`handoff.threshold`；`get` 不带 key 列出每个键、当前值和说明。值能按 JSON 解析就按 JSON，否则当文字。插件自己的配置不在这里读写 | `get` 为 0；`set`/`unset` 有变化等 `--yes` 为 10；不是键或值不对为 1；命令写错为 2 |
| `sideby key <acct> [--var <NAME>]` | 把 API 密钥输入到这个账号的 `proxy.env`，屏幕上不显示（变量默认是宿主的密钥变量）；其他行原样保留，权限 600。用于 API 账号和 pi | 0；不是 API 账号、不是在终端里输入、写不了为 1 |
| `sideby try <acct> [--model <model>] [--yes]` | 试一下账号能不能用：宿主发一次很短的请求（花几个 token），sideby 告诉你它有没有回答。`<acct>` 也可以是短命令，它的参数（比如模型）和 `sideby run` 一样生效；`--model` 只这一次换个模型试，不改任何设置 | 只说明了要运行什么为 10；宿主回答了为 0；失败、这个宿主不支持试一下或不能选模型为 1 |
| `sideby update [--yes]` | 向 npm registry 查 sideby 最新版本，显示安装它的命令；带 `--yes` 就执行，并重启后台面板（见[更新](configuration.zh-CN.md#更新)） | 0 已是最新或已更新；只显示了命令为 10；这种安装方式不能自己更新（会打印要运行的命令）、连不上 registry 或安装失败为 1 |
| `sideby update --skill [--yes]` | 只把 agent 读的 sideby skill 更新到当前 sideby 的版本；不安装 sideby 本身，即使有新版本 | 0 已更新、已是最新，或因 skill 归某个 git 仓库管而不动它（会打印要运行的命令）；只显示了命令为 10；skill 更新失败为 1 |

- 所有命令遇到用法错误（未知选项、缺参数）时退出码为 2；sideby 自身出错（账号不存在、名字不合法、配置读不了）时为 1。
- `<acct>` 写成 `<family>:<name>`；名字在所有家族里唯一时，只写 `<name>` 也行。有歧义就报错，并列出候选。
- 退出码 10 表示命令展示了改动、在等你确认：同意的话，加上 `--yes` 再跑一次同一条命令。
- `list`、`new`、`next`、`alias`、`doctor`、`quota`（包括 `setup` 和 `teardown`）、`tune`、`model`、`remote-control`、`network`、`unattended`、`handoff`、`families`、`plugins`、`ask`、`terminal`、`key`、`try`、`autostart`、`menubar`、`config`、`app`、`desktop`、`sessions`、`send`、`messages` 支持 `--json`，输出带 `schemaVersion: 1`，JSON Schema 随包放在 [`schemas/`](../../schemas/)。有新版本或本机装的 skill 版本不对时，输出里还会多一个 `_notice`（sideby skill 让 agent 提一次并主动问要不要帮你更新；设 `SIDEBY_NO_UPDATE_NOTIFIER=1` 就不带）。加了 `--json` 时，出错会输出 `{ "schemaVersion": 1, "error": "…", "code": "…" }`：命令行写错时 `code` 为 `usage`，其他情况是 `no-quota-source` 这样的原因。只新增字段时版本不变；删除、改名或改语义时加 1。
- 任何输出、日志和错误信息里都不会出现凭据的值。
