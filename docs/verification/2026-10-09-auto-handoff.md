# Auto Handoff：宿主实测记录

依据 spec §3.17「实现前的实测」。宿主版本：Claude Code（`~/.local/bin/claude`，当日版本）、codex-cli 0.162.0、grok 1.0.50、pi 1.1.0（`@earendil-works/pi-coding-agent`）。

做法：在临时 HOME 和全新的账号目录里运行真实二进制，用 `SessionStart`、`UserPromptSubmit` hook 往临时目录写标记文件。这两类 hook 在第一次 API 调用前触发，不需要登录。不在真实账号上跑：真实账号会触发用户自己的 hook，还要消耗额度。

## 结果

| # | 项目 | 结果 | 证据 |
|---|---|---|---|
| 1 | Claude：`--settings` 的 hooks 与账号 `settings.json` 的 hooks 合并 | 通过 | `claude -p --settings <file> "say hi"`：账号 `settings.json` 和 `--settings` 文件里的 `SessionStart` 都写了标记，之后才报 `Not logged in` |
| 3 | Codex：`-c` 注入 hooks | 通过（加载） | `codex exec --dangerously-bypass-hook-trust -c 'hooks.SessionStart=[…]' -c 'hooks.UserPromptSubmit=[…]'`：两个标记都写了，之后 401。实验里才用跳过信任的参数，sideby 不会加 |
| 3 | Codex：没信任的 hook | 不运行，也没有任何提示 | 同一条命令去掉 `--dangerously-bypass-hook-trust`：没有标记，输出里没有 hook 或 trust 字样。所以每个账号第一次带 hook 启动前，sideby 必须提示用户在 `/hooks` 里信任 |
| 7 | Doctor 的 copy 模式能否同步 `hooks/` 里新加的文件 | 通过 | demo HOME（`normal`）：主账号 `hooks/` 加文件后，`grok:lab` 报 `copy.stale`（fail），`sideby doctor grok --fix` 后文件同步过去。setup 之后要跑一次 `--fix`；在那之前 Doctor 退出 1 |
| 8 | Grok 首条 prompt | 通过 | `grok --help`：`[PROMPT]  Initial prompt for the interactive session` |
| 8 | pi 首条 prompt | 通过 | `pi --help`：`pi [options] [--] [@files...] [messages...]`；不带 `-p` 时进入交互会话 |
| — | Claude：首条 prompt 放在 `--` 之后 | 必须这样 | `claude -p --add-dir /tmp "say hi"` 报 `Input must be provided…`：`--add-dir` 接多个值，把 prompt 吞掉了；`claude -p --add-dir /tmp -- "say hi"` 正常解析。所以四个家族的 `promptArgs` 都是 `['--', prompt]` |
| — | Codex、Grok、pi 接受 `--` 之后的首条 prompt | 通过 | 都越过了参数解析：`codex --add-dir /tmp -- "say hi"` 停在 `stdin is not a terminal`，`grok --model x -- "say hi"` 停在终端错误（对照：`grok --bogus-flag` 报 `unexpected argument`），`pi -p -- "say hi"` 停在 `No API key found` |
| — | `handoff-hook` 冷启动 | 约 40 ms | `node dist/src/cli/main.js handoff-hook claude PostToolUse`，21 次取中位数 40.4 ms，和 `statusline-tap` 同一量级 |

## 未验证（UNVERIFIED）

这些项需要已登录的账号、真实对话或撞上限额，本机没跑：

| # | 项目 | 为什么没跑 | 不通过时的退路 |
|---|---|---|---|
| 2 | Claude：一轮结束后 SIGTERM，会话完整、`SessionEnd` 跑完、能 `--resume`；`--add-dir` 后读 Brief 不弹确认；用量上限时 `StopFailure` 的报错文字 | 需要登录和交互 TTY | SIGTERM 不行就等宿主空闲再发；文字认不出就只看 tap 压力 |
| 3 | Codex：TUI 里 `additionalContext` 和 `Stop` 的 `block` 生效；`--add-dir` 后能写链目录 | 需要登录 | 降为只能接手 |
| 4 | Codex：SIGTERM 后能 `codex resume`；daemon 模式 | 需要登录 | 降为只能接手 |
| 5 | Grok：撞上每周额度时 `StopFailure` 触发，以及报错文字 | 需要登录并真的用完额度 | Grok 只能接手 |
| 6 | Grok：SIGTERM 后能 `--resume`；默认 sandbox 下 hook 能写链目录；leader socket | 需要登录 | 降为只能接手 |
| — | Grok：`$GROK_HOME/hooks/*.json` 在本机的运行 | 没登录时 Grok 在会话开始前就退出，`SessionStart` 不触发（假的 `XAI_API_KEY` 也一样） | 依据官方文档（`~/.grok/docs/user-guide/10-hooks.md`），sideby 现有的 Grok `hooks` 共享项也依赖这一点 |

## 用户自己验证的步骤

实现完成后，在打开 `handoff.auto` 的 config 下：

1. Claude：`sideby quota setup claude --yes`，再用 `cc00x` 启动，让它做一个长任务。看到预备档提示后，在另一个终端运行 `sideby handoff ready`。确认原会话结束，新账号在同一个终端带 Brief 启动。然后用 `claude --resume <旧 id>` 在原账号续接，确认旧会话完整。
2. Codex：用 `codex00x` 启动，按提示在 `/hooks` 里信任 sideby 的 hook，再重复第 1 步。
3. Grok：`sideby handoff setup grok --yes` 和 `sideby doctor grok --fix`，用 `grok00x` 启动，确认 `sideby handoff ready` 能交接。

每一步的结果补进上面的表格。
