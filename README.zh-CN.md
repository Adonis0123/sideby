<p align="center">
  <img alt="sideby：工作号、个人号和 API key 账号，各开一个终端，配置还是同一份" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/banner.jpg" width="880">
</p>

<p align="center">
  <b>工作号、个人号和 API key 账号同时开着，配置也不会各走各的。</b><br>
  每个账号一个目录、一个终端。skills、hooks 和设置链在主账号上，改一处就都生效。支持 Claude Code、Codex、Grok Build 和 pi。
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sideby"><img alt="npm" src="https://img.shields.io/npm/v/sideby"></a>
  <a href="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Adonis0123/sideby/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22.18+" src="https://img.shields.io/badge/node-%E2%89%A522.18-339933">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-blue"></a>
</p>

<p align="center"><a href="README.md">English</a> | 中文</p>

## 为什么不直接写个别名？

每个账号一条别名，再配上 `CLAUDE_CONFIG_DIR`，第二个账号确实能开起来。但它不会帮你把 skills 和设置收成一份，也看不到每个账号还剩多少额度。[会不会违反服务条款？](docs/guide/faq.zh-CN.md#terms)

| | 同时开 | skills、hooks、设置 | 额度和用量 | 准备 |
|---|---|---|---|---|
| `CLAUDE_CONFIG_DIR` 加别名 | 能。每个终端自己 export。 | 每个目录各一份。不自己做软链接，过一阵就不一样了。 | 只有当前这个会话的 status line | 一个账号一条别名 |
| [cc-switch](https://github.com/farion1231/cc-switch) | 启用一个供应商会写进宿主正在用的配置，已经打开的会话跟着变。 | 插件配置要另外复制一次。 | 当前启用的那一个，走对方的额度接口 | 装一个桌面应用 |
| sideby | 能。`sideby run` 只给这个进程选目录，不改你的 shell。 | 链到主账号。副本用 `sideby doctor --fix` 拉齐。登录和会话各留各的。 | 所有账号，只读本地文件。Claude 要先跑 `quota setup`。 | `npm i -g sideby`，然后 `sideby new`，登录一次 |

cc-switch 自己的说明是：切换时把配置写进宿主正在用的文件（[README](https://github.com/farion1231/cc-switch#readme)）。[#1105](https://github.com/farion1231/cc-switch/issues/1105) 和 [#2908](https://github.com/farion1231/cc-switch/issues/2908) 要的是同时开好几个会话。[#1106](https://github.com/farion1231/cc-switch/issues/1106) 已经关闭，维护者说 Claude Code 的「打开终端」可以用某个供应商的配置启动，而不改全局配置。

## 快速上手

需要 Node 22.18 或更高版本，并且至少装好一个宿主 CLI（Claude Code、Codex、Grok Build 或 pi）。AI agent 请改按 [`llms.txt`](llms.txt) 里 "Set up sideby for a user" 的步骤做。

```sh
npm i -g sideby
sideby new claude work        # 新建 ~/.claude-work，共用 ~/.claude 的 skills 和 hooks
sideby login claude:work      # 登录一次
sideby run work               # 用 work 账号启动 Claude Code
sideby ui                     # 在 http://127.0.0.1:17420 查看所有账号的额度
```

`sideby run claude:main` 可以同时在另一个终端里继续用 `~/.claude`。`--` 之后的参数原样交给宿主：`sideby run work -- --resume`。不想安装，可以先跑 `npx sideby` 试试。

## 让 AI 帮你装

把下面这段粘贴给 Claude Code、Codex 或其他 coding agent：

```text
帮我安装 sideby（npm 包 `sideby`）和它的 agent skill，再给我加一个 Claude Code 账号。
按 https://raw.githubusercontent.com/Adonis0123/sideby/main/llms.txt 里 "Set up sideby for a user" 的步骤来。
```

agent 会检查 Node 和宿主 CLI，装好 sideby 和 skill，建账号，告诉你它和主账号共享什么，并让短命令生效。你只需要在浏览器里登录一次，agent 会把那一行命令给你。装好 skill 之后，简短的说法也行：「再加一个 Claude 账号，叫 cc008」「我的 Codex 账号共享了什么」「哪个账号还有额度」。

## 长什么样

<img alt="两个终端：个人号和工作号同时开着，然后切到本机的额度面板" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/demo.gif" width="1280">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel-dark.zh-CN.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.zh-CN.png">
  <img alt="sideby 面板：每个账号的 5h、7d 额度，近 7 天 token 用量和健康状态" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.zh-CN.png" width="1280">
</picture>

## 还能做什么

| 你想 | 命令 | 说明 |
|---|---|---|
| 加一个 API key 账号（DeepSeek、网关等） | `sideby new claude deepseek --api` | [API 账号](docs/guide/usage.zh-CN.md#api-账号) |
| 找出并修复账号之间的配置漂移 | `sideby doctor --fix` | [体检](docs/guide/usage.zh-CN.md#体检doctor) |
| 看 Claude 额度（Codex 不用设置） | `sideby quota setup claude --yes` | [Claude 额度](docs/guide/usage.zh-CN.md#claude-额度) |
| 账号撞上限额时换一个接着用 | `sideby next claude` | [接力](docs/guide/usage.zh-CN.md#账号撞上限额时) |
| 用 `ccw` 这样的短命令 | `sideby alias add ccw claude:work` | [Shell 函数](docs/guide/configuration.zh-CN.md#shell-函数) |
| 在 Orca 这类工具里重开会话时，自动进到存有它的账号 | config 里写 `"resumeRouting": true` | [从其他工具恢复会话](docs/guide/configuration.zh-CN.md#从其他工具恢复会话) |
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

## 平台

在 macOS 和 Linux 上用过。CI 跑的是 `ubuntu-latest` 和 `macos-latest`，Node 22 和 24。**Windows 还没测过。** `sideby app` 只在 macOS 和 Linux 上装启动器。用链接共享的项是符号链接，`sideby shell-init` 只生成 bash 和 zsh 函数，Claude 的额度包装跑的是 `/bin/sh`。

## 路线图

**Gemini CLI。** Gemini 可以用 `GEMINI_CONFIG_DIR` 换一个配置目录。旧文档里的 `GEMINI_CLI_HOME` 已经标成过时；和精确的目录变量一起设的话，现在的版本启动时会直接退出。sideby 要接它，得先定一个测过的版本，确认登录状态怎么判断才不会读到 token，再列出哪些文件该链接、哪些该复制。这一步不小，所以这版先不做。

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

- [`llms.txt`](llms.txt)：安装步骤、命令、JSON 契约和插件 API 的索引。`sideby families --json` 给出每个宿主的账号共享什么。
- [`skills/sideby/SKILL.md`](skills/sideby/SKILL.md)：一个 Agent Skill，用来查看、修复、新建账号，以及在额度用完时换账号。用 `npx skills add Adonis0123/sideby -g` 安装；装的版本和 sideby 不一致时，`sideby doctor` 会提醒。
- [`AGENTS.md`](AGENTS.md)：给维护本仓库的 agent 的规则。

## 许可证

[MIT](LICENSE)
