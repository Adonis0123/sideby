# 常见问题

[English](faq.md) | 中文

← [README](../../README.zh-CN.md)

### 会不会违反服务条款？

sideby 的设计只用各宿主已经支持的机制（见 [ADR-0001](../../docs/adr/0001-side-by-side-not-switching.md) 和 [ADR-0003](../../docs/adr/0003-quota-from-local-and-official-sources.md)）：

- 不切换：从不改宿主的全局配置来换当前账号。每个账号是一个独立的配置目录，这是各宿主都写进文档的机制（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`、`PI_CODING_AGENT_DIR`）。
- 不轮换：额度用完时，不会自动换到另一个订阅。`sideby next` 只根据本机已有的数据推荐余量最多的账号，启不启动由你决定。
- 不代理凭据：从不读取订阅 token 去调模型，也不把多个登录凑成一个池子。
- 不调私有接口：额度来自本地文件，以及 Claude Code 交给 status line 命令的数据。

以上是维护者自己对规则的理解，不构成法律意见。具体情况请以各服务商的条款为准。

### 为什么要求 Node 22.18？

Node 从 22.18 起默认剥离 TypeScript 类型，sideby 才能直接 `import()` 磁盘上的 `.ts` 插件。Node 版本更低时，sideby 会提示升级并以 1 退出。

### 数据存在哪里？

| 内容 | 位置 |
|---|---|
| 配置（sideby 只写其中的 `aliases`，来自 `new --alias`、`sideby alias` 或面板） | `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json` |
| 你的插件 | `${XDG_CONFIG_HOME:-~/.config}/sideby/plugins/` |
| 状态：额度缓存、上次体检结果、`settings.json` 原始字节、后台面板的 pid 和日志 | `${XDG_STATE_HOME:-~/.local/state}/sideby/` |
| 桌面应用（`sideby app install`） | macOS `~/Applications/sideby.app`；Linux `~/.local/share/applications/sideby.desktop`、`~/.local/share/sideby/`、`~/.local/share/icons/hicolor/*/apps/sideby.*` |

sideby 不往宿主的账号目录里写自己的文件。唯一的例外是 `quota setup claude --yes`，它会修改 `~/.claude/settings.json`。用 `sideby new` 建出来的账号目录归宿主所有。

### 和 aimux、agenv、cc-switch、magpie 有什么区别？

它们解决的是相近的问题，取舍不同，按自己的用法选就好。

| | sideby | [aimux](https://github.com/Digital-Threads/aimux) | [agenv](https://github.com/combinatrix-ai/agenv) | [cc-switch](https://github.com/farion1231/cc-switch) | [magpie](https://github.com/yetone/magpie) |
|---|---|---|---|---|---|
| 思路 | 每个账号一个目录，并排运行 | 每个 profile 一个目录，并排运行 | 每个 profile 隔离，自带一份宿主可执行文件 | 在宿主配置里切换当前 provider | 在菜单栏为每个 agent 设模型和 provider |
| 宿主 | Claude Code、Codex、Grok Build、pi | Claude Code、Codex、Gemini CLI | Claude Code、Codex、Gemini CLI | 很多，包括 Grok Build 和 pi | 多个 agent |
| 额度 | 只用本地记录和 status line 数据 | 实时探测额度；`run --auto` 自动选余量最多的订阅 | — | — | — |
| 形态 | CLI、本地网页面板、本地插件 | 带 TUI 的 CLI | 带 TUI 的 CLI | 桌面应用 | 菜单栏应用 |

### 怎么卸载？

```sh
sideby quota teardown claude                  # 跑过 quota setup 的话先执行；status line 会调用 sideby
sideby ui --stop && sideby app uninstall       # 用过桌面应用的话
npm rm -g sideby
rm -rf ~/.config/sideby ~/.local/state/sideby  # 设置过 XDG_CONFIG_HOME / XDG_STATE_HOME 的话换成对应路径
```

再从 shell 配置文件里删掉 `eval "$(sideby shell-init …)"` 这一行。`~/.claude-work` 这类账号目录会保留，不需要了就自己删。
