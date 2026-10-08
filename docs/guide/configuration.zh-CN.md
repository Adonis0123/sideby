# 配置

[English](configuration.md) | 中文

← [README](../../README.zh-CN.md)

配置文件可以不存在，位置是 `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json`，schema 见 [`schemas/config.json`](../../schemas/config.json)：

```json
{
  "accounts": {
    "claude:work": { "args": ["--model", "opus"] }
  },
  "aliases": {
    "cc": "claude:main",
    "ccw": "claude:work",
    "cx": "codex:main",
    "pi-kimi": { "account": "pi:main", "args": ["--model", "kimi-coding/k3"] }
  },
  "ignore": ["claude:backup"],
  "pluginDirs": ["~/code/sideby-plugins/litellm-gateway"],
  "plugins": {
    "account-script": { "enabled": true },
    "litellm-gateway": { "port": 4000 }
  },
  "extraSharedItems": {
    "claude": [
      { "path": "statusline-command.sh", "mode": "link" },
      { "path": "scripts", "mode": "link" }
    ]
  },
  "shellInitFile": { "zsh": "~/.config/sideby/shell-init.zsh" },
  "resumeRouting": true
}
```

| 字段 | 含义 |
|---|---|
| `accounts.<ref>.args` | 给单个账号加的参数。顺序是：家族默认参数，然后这里的参数，再是短命令的 `args`，最后是 `--` 之后的参数。sideby 默认不带任何危险参数，需要的话在这里按账号配置。 |
| `aliases` | 短名到账号引用的映射；也可以写成 `{ "account": "<ref>", "args": [...] }`，用固定的宿主参数（比如换个模型）启动同一个账号。`shell-init` 为每个短名生成一个 shell 函数，`sideby run`、`sideby doctor` 等命令也认这些短名；只有 `sideby run` 会加上 `args`。同一账号的几个短名共用它的登录态和会话。短名不能设置环境变量。 |
| `ignore` | 看起来像账号、其实不是的账号引用（`<family>:<name>`）。名字里有 `bak`、`backup`、`old`、`tmp` 时，doctor 会给一条 warn，建议加到这里。 |
| `pluginDirs` | 额外的插件目录，只接受绝对路径或以 `~/` 开头的路径。 |
| `plugins.<name>` | 单个插件的设置；`enabled` 控制开关，内置家族也适用。 |
| `shellInitFile` | 可选，`{ "zsh": …, "bash": … }`，绝对路径或以 `~/` 开头。sideby 每次新增账号、新增或删除别名（`sideby new`、`sideby alias`、面板）后，都用 `sideby shell-init <shell>` 的输出重写这些文件，source 它的 shell 就能用上新命令。不是 `shell-init` 写的文件，它不会覆盖。 |
| `accountTitle` | 可选，默认关。设为 `true` 时，启动账号会把终端标签页标题设成 `[<短命令或 ref>]`，并用 `-c tui.terminal_title=[]` 启动 Codex，让它保留这个标题（你的参数里自己设了 `tui.terminal_title` 时不加）。其他宿主可能换成自己的标题；见[在会话里显示是哪个账号](usage.zh-CN.md#在会话里显示是哪个账号)。 |
| `resumeRouting` | 可选，默认关。设为 `true` 时，`shell-init` 还会生成与宿主同名的函数（`claude`、`codex`、`grok`），按 id 恢复会话时转到存有该会话的账号；见[从其他工具恢复会话](#从其他工具恢复会话)。 |
| `extraSharedItems.<family>` | 在内置清单之外加你自己的共享项，每项要写 Share Mode（`link`、`copy`、`link-or-copy`、`link-or-local`、`local`、`local-if-api`、`info`、`json-key`）。`path` 相对于账号目录，绝对路径和 `..` 会被拒绝。 |

## Shell 函数

```sh
# ~/.zshrc（bash 用户写进 ~/.bashrc，参数换成 bash）
eval "$(sideby shell-init zsh)"
```

它会为每个账号定义一个函数，例如 `sideby-claude-work`，再为每个别名各定义一个。按上面的配置，`ccw --resume` 等同于 `sideby run claude:work -- --resume`。之后新建的账号，要开新 shell（或再执行一次 `eval`）才有对应的函数。

新建账号时想顺手加短命令，就传 `--alias`（`sideby new claude 008 --alias cc008`），或在面板「新建账号」里填「短命令」。面板会按同一家族已有的别名推断：`cc001` … `cc007` 对应 `claude:001` … `claude:007`，就建议 `cc008`；结尾不是账号名的别名（例如指向 `codex:main` 的 `codex001`）不参与推断。短命令写进 config 文件的 `aliases`，其他键和顺序保持不变；config 不是合法 JSON 时，sideby 拒绝写入，原文件不动。账号建好了但短命令没写进去时，会明确告诉你。

给已有账号加短命令，或想用别的宿主参数启动同一个账号，用 `sideby alias add`：

```sh
sideby alias add pi-kimi pi:main -- --model kimi-coding/k3   # pi-kimi = 换了模型的 pi001
sideby alias rm pi-kimi
```

面板在账号旁边列出它的每个短命令（悬停能看到参数），搜索也能按参数找到账号。还要改环境变量的入口不算短命令，继续写在你的 shell rc 里。

如果你想 source 一个文件、不用 `eval`（这样开新 shell 时不用启动 Node），设置 `shellInitFile` 后 source 它：

```sh
sideby shell-init zsh --write                            # 先生成一次 ~/.config/sideby/shell-init.zsh
echo 'source ~/.config/sideby/shell-init.zsh' >> ~/.zshrc
```

之后 sideby 会自动保持这个文件最新。用 `eval "$(sideby shell-init zsh)"` 的话什么都不用设置。

## 从其他工具恢复会话

Orca 这类终端管理器重开窗格时，会在 shell 里敲裸的宿主命令，比如 `claude --resume <id>`。这条命令没说会话属于哪个账号，宿主只在主账号里找，于是报 `No conversation found`。把 `"resumeRouting": true` 写进 config，再重新生成函数（`sideby shell-init --write`，用 `eval` 的话开个新 shell）。之后，对每个除主账号外还有别的账号的家族，`shell-init` 会多生成一个与宿主同名的函数：

```sh
function claude { local a; if [ -z "${CLAUDE_CONFIG_DIR-}" ]; then for a in "$@"; do case $a in ????????-????-????-????-????????????|--resume=????????-????-????-????-????????????) command sideby resume 'claude' -- "$@"; return;; esac; done; fi; command claude "$@"; }
```

`sideby resume` 找出账号目录里存有这个会话 id 的账号（Claude 是 `projects/*/<id>.jsonl`，Codex 是 `sessions/**/rollout-*-<id>.jsonl`，Grok 是 `sessions/*/<id>/`），像 `sideby run` 一样启动它。其他情况原样运行宿主，包括 `--continue`、按标题恢复、会话在主账号里。sideby 启动的宿主已经设了选择变量，不会被二次路由。`alias claude='claude --dangerously-skip-permissions'` 这样的 alias 照常生效。只有参数里有会话 id 形状的命令才经过 sideby（多约 140 ms），其他宿主命令直接运行。sideby 不复制、不移动会话。
