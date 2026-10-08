<p align="center">
  <img alt="sideby：一份共享配置，每个账号一个终端" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/banner.jpg" width="880">
</p>

<p align="center">
  <b>Run every AI coding account side by side.</b><br>
  把 Claude Code、Codex、Grok Build、pi 的多个账号并排跑起来：每个账号一个目录，skills、hooks、规则共用一份，额度在一个面板里看完。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sideby"><img alt="npm" src="https://img.shields.io/npm/v/sideby"></a>
  <a href="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

## 为什么用 sideby

你有一个工作订阅、一个个人订阅，可能还有一个 API key。切换类工具会改宿主的全局配置，同一时间只有一个账号生效；各账号的 skills 和 hooks 也会慢慢变得不一致。

- **并排，不切换。** 每个账号一个独立目录，sideby 启动官方 CLI 时选中这个目录。三个账号可以同时开在三个终端里，你的 shell 环境不受影响。
- **skills、hooks、规则只维护一份。** 主账号（例如 `~/.claude`）是唯一来源，其他账号链接或复制它的共享项（Shared Item）。`sideby doctor --fix` 修复漂移，不碰真实文件，也不碰凭据。
- **额度一屏看完。** 每个账号的 5 小时、7 天额度、重置时间和近 7 天 token 用量。额度用完了，`sideby next` 帮你启动剩余最多的账号。数据都来自本地文件：不联网，不读 token。

## 快速上手

需要 Node 22.18 或更高版本，并且至少装好一个宿主 CLI（Claude Code、Codex、Grok Build 或 pi）。

```sh
npm i -g sideby
sideby new claude work        # 新建 ~/.claude-work，共用 ~/.claude 的 skills 和 hooks
sideby login claude:work      # 登录一次
sideby run work               # 用 work 账号启动 Claude Code
sideby ui                     # 在 http://127.0.0.1:17420 查看所有账号的额度
```

`sideby run claude:main` 可以同时在另一个终端里继续用 `~/.claude`。`--` 之后的参数原样交给宿主：`sideby run work -- --resume`。不想安装，可以先跑 `npx sideby` 试试。

## 长什么样

<img alt="终端里的 sideby：列出账号、查看额度、推荐下一个账号、发现并修复漂移" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/demo.gif" width="1320">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png">
  <img alt="sideby 面板：每个账号的 5h、7d 额度，近 7 天 token 用量和健康状态" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png" width="1280">
</picture>

## 还能做什么

| 你想 | 命令 | 说明 |
|---|---|---|
| 加一个 API key 账号（DeepSeek、网关等） | `sideby new claude deepseek --api` | [API 账号](docs/guide/usage.zh-CN.md#api-账号) |
| 找出并修复账号之间的配置漂移 | `sideby doctor --fix` | [体检](docs/guide/usage.zh-CN.md#体检doctor) |
| 看 Claude 额度（Codex 不用设置） | `sideby quota setup claude --yes` | [Claude 额度](docs/guide/usage.zh-CN.md#claude-额度) |
| 账号撞上限额时换一个接着用 | `sideby next claude` | [接力](docs/guide/usage.zh-CN.md#账号撞上限额时) |
| 用 `ccw` 这样的短命令 | `sideby alias add ccw claude:work` | [Shell 函数](docs/guide/configuration.zh-CN.md#shell-函数) |
| 从 Dock 或应用菜单打开面板 | `sideby app install` | [桌面应用](docs/guide/panel.zh-CN.md#桌面应用) |
| 把面板嵌进自己的本地页面 | `createPanelHandler()` | [嵌入面板](docs/guide/panel.zh-CN.md#嵌入面板) |
| 新增一个宿主，或加启动前检查 | 本地插件 | [插件](docs/guide/plugins.zh-CN.md) |

## 支持的宿主

| 宿主 | 账号目录 | 登录 | 额度 | 用量（7 天） |
|---|---|---|---|---|
| Claude Code | `~/.claude`、`~/.claude-<name>` | `claude auth login` | ✓ 需先 `quota setup claude` | ✓ |
| Codex CLI | `~/.codex`、`~/.codex-<name>` | `codex login` | ✓ | ✓ |
| Grok Build | `~/.grok`、`~/.grok-<name>` | `grok login` | 无公开来源 | 无公开来源 |
| pi | `~/.pi/agent`、`~/.pi-<name>/agent` | 在 pi 里输入 `/login` | 无公开来源 | 无公开来源 |

sideby 启动 `PATH` 上的官方程序，从不修改它。测试过的版本和各宿主的注意事项见[使用指南](docs/guide/usage.zh-CN.md#宿主说明)。

## 安全边界

- 不改宿主的全局配置来切换账号，也不会自己轮换账号。
- 不读取、不打印、不发送任何凭据的值。数据不出本机：sideby 不调用任何远程服务。
- `doctor --fix` 不替换真实文件，也不改链接的指向。

细节和服务条款的问题见[常见问题](docs/guide/faq.zh-CN.md)。

## 文档

- [使用指南](docs/guide/usage.zh-CN.md)：账号、API 账号、体检、额度、接力、宿主说明
- [命令](docs/guide/commands.zh-CN.md)：所有命令、退出码和 `--json`
- [配置](docs/guide/configuration.zh-CN.md)：`config.json`、短命令、Shell 函数
- [面板](docs/guide/panel.zh-CN.md)：面板、桌面应用、嵌入
- [插件](docs/guide/plugins.zh-CN.md)：自己写家族或启动 hook
- [常见问题](docs/guide/faq.zh-CN.md)：服务条款、数据位置、同类工具对比、卸载

## 给 AI agent

- [`llms.txt`](llms.txt)：命令、JSON 契约和插件 API 的索引。
- [`skills/sideby/SKILL.md`](skills/sideby/SKILL.md)：一个 Agent Skill，用来查看、修复、新建账号，以及在额度用完时换账号。用 `npx skills add Adonis0123/sideby -g` 安装；装的版本和 sideby 不一致时，`sideby doctor` 会提醒。
- [`AGENTS.md`](AGENTS.md)：给维护本仓库的 agent 的规则。

## 许可证

[MIT](LICENSE)
