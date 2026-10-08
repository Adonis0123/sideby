# 命令

[English](commands.md) | 中文

← [README](../../README.zh-CN.md)

| 命令 | 作用 | 退出码 |
|---|---|---|
| `sideby` | 等同于 `sideby list` | 0 |
| `sideby list` | 列出账号、类型（main、sub 或 api）、登录态、模型和目录；读取时遇到的问题输出到 stderr | 0 |
| `sideby run <acct> [-- args]` | 用某个账号启动宿主 | 宿主的退出码；被信号 n 终止时为 128+n |
| `sideby next <family> [--dry-run] [--include-api] [-- args]` | 推荐剩余额度最多的账号（Claude、Codex）并启动；`--dry-run` 只推荐 | 宿主的退出码；`--dry-run` 或 `--json` 有推荐时为 0；没有可用账号、都还没有额度数据、家族没有额度来源或没有账号为 1 |
| `sideby new <family> <name> [--api] [--alias <short>]` | 新建账号并铺好共享项；`--alias` 同时把 `cc008` 这样的短命令加进 `aliases` | 0；部分失败或短命令没加上为 1 |
| `sideby alias add <short> <acct> [-- args]` | 给已有账号加短命令，可以带 `sideby run` 时附加的宿主参数 | 0，已存在也是 0；名字被占用、不合法或账号不存在为 1 |
| `sideby alias rm <short>` | 删掉一个短命令 | 0，不存在也是 0 |
| `sideby login <acct>` | 用该账号运行家族的登录命令；pi 会直接启动，并提示你输入 `/login` | 宿主的退出码 |
| `sideby doctor [acct\|family] [--fix] [--force]` | 检查共享项、凭据文件权限和备份残留；`--fix` 修复安全的部分 | 0 没有 fail（允许有 warn）；1 至少一条 fail |
| `sideby quota [acct]` | 额度和近 7 天用量 | 0 |
| `sideby quota setup claude [--yes]` | 展示改动；加 `--yes` 才开启 Claude 额度来源 | 只展示改动时为 10；开启后为 0；无法开启或失败为 1 |
| `sideby quota teardown claude` | 关闭并还原原文件 | 0；拒绝或失败为 1 |
| `sideby ui [--port n] [--no-open]` | 本地面板，按 Ctrl+C 停止 | — |
| `sideby ui --background` / `--stop` | 脱离终端启动面板（已有就复用，sideby 升级后则替换旧的）并打开 / 停掉它 | 0；启动或停止失败为 1 |
| `sideby app install [--url <url>]` | 添加打开面板（或 `<url>`）的桌面应用（macOS、Linux） | 0；平台不支持或目标位置有不是它创建的文件为 1 |
| `sideby app uninstall` | 删除 `app install` 创建的文件 | 0；留下了不是它创建的文件为 1 |
| `sideby shell-init zsh\|bash` | 输出每个账号和每个别名的 shell 函数 | 0 |
| `sideby shell-init [zsh\|bash] --write` | 用这份输出重写 config 里配置的 `shellInitFile` | 0；写不了或没有配置为 1 |
| `sideby plugins` | 已加载的插件和加载错误 | 0；有插件加载失败时为 1 |

- 所有命令遇到用法错误（未知选项、缺参数）时退出码为 2；sideby 自身出错（账号不存在、名字不合法、配置读不了）时为 1。
- `<acct>` 写成 `<family>:<name>`；名字在所有家族里唯一时，只写 `<name>` 也行。有歧义就报错，并列出候选。
- 退出码 10 表示命令展示了改动、在等你确认：同意的话，加上 `--yes` 再跑一次同一条命令。
- `list`、`new`、`next`、`alias`、`doctor`、`quota`（包括 `setup` 和 `teardown`）、`plugins`、`app` 支持 `--json`，输出带 `schemaVersion: 1`，JSON Schema 随包放在 [`schemas/`](../../schemas/)。加了 `--json` 时，出错会输出 `{ "schemaVersion": 1, "error": "…", "code": "…" }`：命令行写错时 `code` 为 `usage`，其他情况是 `no-quota-source` 这样的原因。只新增字段时版本不变；删除、改名或改语义时加 1。
- 任何输出、日志和错误信息里都不会出现凭据的值。
