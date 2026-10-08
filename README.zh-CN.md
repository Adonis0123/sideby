# sideby

**Run every AI coding account side by side.**

把 Claude Code、Codex、Grok Build、pi 的多个账号并排跑起来：每个账号一个目录，skills、hooks、规则共用一份，额度面板一屏看完所有账号。

```sh
npx sideby            # 先试试
npm i -g sideby       # 安装 sideby 命令
```

[English](README.md) | 中文

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png">
  <img alt="sideby 面板：每个账号的 5h、7d 额度，近 7 天 token 用量和健康状态" src="https://raw.githubusercontent.com/Adonis0123/sideby/main/docs/assets/panel.png" width="1280">
</picture>

## 为什么用 sideby

- **并排，不切换。** cc-switch、magpie 这类工具会改宿主的全局配置，同一时间只有一个 provider 生效，适合在几家之间来回换的人。sideby 给每个账号一个独立目录，启动官方 CLI 时选中这个目录。工作订阅、个人订阅和一个 DeepSeek key 可以同时开在三个终端里，父 shell 的环境始终不变。
- **skills、hooks、规则只维护一份。** 主账号（例如 `~/.claude`）是唯一来源。其他账号按各宿主的要求链接或复制它的共享项（Shared Item）。`sideby doctor` 找出漂移，`--fix` 只做安全的修复：不替换真实文件，不改链接指向，不读凭据的值。
- **额度一屏看完。** `sideby quota` 和 `sideby ui` 列出每个账号的 5 小时、7 天额度、重置时间、数据是多久以前的，以及近 7 天的 token 用量。Claude Code 和 Codex 的本地记录由 sideby 自己读取，不需要 ccusage；Claude 的额度取自 Claude Code 交给 status line 的数据。不联网，不读 token。

## 快速上手

需要 Node 22.18 或更高版本，并且至少装好、登录过一个宿主 CLI。

```sh
sideby                        # 列出账号；只有 ~/.claude 时会看到 claude:main
sideby new claude work        # 新建 ~/.claude-work，共享项链接到主账号
sideby login claude:work      # 在自己的终端里登录一次
sideby run work               # 用 work 账号启动 Claude Code
```

`sideby run claude:main` 可以同时继续用 `~/.claude`。`--` 之后的参数原样交给宿主：`sideby run work -- --resume`。

有几个账号之后，`sideby list` 的输出大致如下：

```
ACCOUNT          TYPE  LOGIN         EMAIL             MODEL        DIR
claude:main      main  ✓             me@example.com    opus         ~/.claude
claude:deepseek  api   key           —                 deepseek-v4  ~/.claude-deepseek
claude:work      sub   ✓             work@example.com  opus         ~/.claude-work
codex:team       sub   ✓             team@example.com  gpt-5.5      ~/.codex-team
grok:lab         sub   login needed  —                 grok-code    ~/.grok-lab
```

EMAIL 是账号登录的身份，取自宿主的登录文件（Claude Code、Codex、Grok Build）。sideby 在那里只读这个身份字段，从不读 token（ADR-0003）。

家族插件读取某个账号出错时（例如它的设置文件不是合法 JSON），`list` 照常列出这个账号，把问题打印到 stderr；`list --json` 把它放进该账号的 `problems` 数组。

### API 账号

```sh
sideby new claude deepseek --api
$EDITOR ~/.claude-deepseek/proxy.env     # 填好变量；文件权限保持 600
sideby run deepseek
```

`proxy.env` 用的是 dotenv 的一个子集：`KEY=VALUE`、可选的 `export ` 前缀、单双引号、`#` 注释，以及 `$NAME` / `${NAME}`。引用只能指向同一文件前面已定义的变量，或 `HOME`、`USER`、`LOGNAME`、`TMPDIR`、`XDG_*_HOME` 这几个位置变量。其他 shell 变量一律不读，也不支持命令替换。里面的变量只进入这次启动的宿主进程。文件权限不是 600 时，sideby 拒绝启动，并提示执行 `chmod 600`。

API 账号不需要登录：登录态是 `not-needed`，在 `sideby list` 的 LOGIN 列显示为 `key`。

pi 是例外。pi 的任何账号都可以放一个 `proxy.env` 来加载 provider key，所以 sideby 启动时会加载它，但这个账号仍按订阅账号处理，用 `/login` 登录。

### 体检（doctor）

```sh
sideby doctor            # 所有账号
sideby doctor work       # 单个账号，也可以是一个家族：sideby doctor grok
sideby doctor --fix      # 执行安全的修复
```

```
✓ claude:work subscription shared 4/4  ~/.claude-work
✗ grok:lab subscription shared 2/3  ~/.grok-lab
    fail hooks must be a real copy, not a link (host says: "Grok hooks directory has wrong type (expected real directory)")
         run `sideby doctor --fix` to replace the link with a copy

1 issue(s) can be fixed with `sideby doctor --fix`.
```

- `shared n/m` 只统计主账号里真有的共享项。主账号没有的项（很多人没有 `commands`、`themes`）直接跳过：不告警，也不计数。
- 链接目标存在、但不是主账号对应的项：报 warn（`link.other-target`），因为这可能是你有意这么链的；如果宿主要求这里是真实文件或副本，任何链接都报 fail（`symlink-forbidden`）。悬空的链接报 fail（`link.dangling`）。sideby 从不改链接的指向，只报告。
- 该放链接的位置是真实文件或目录时，只报告，并给出保留它的命令（`mv <x> <x>.local && ln -s …`），sideby 不替换它。
- 凭据文件（`proxy.env`、`auth.json`、`.claude.json`）只检查类型和权限是否为 600，`--fix` 会把权限改回 600。sideby 从中读取的内容只有 `.claude.json` 的 `mcpServers` 键（用来和主账号保持一致），以及显示为账号邮箱的身份字段（`.claude.json` 的 `oauthAccount.emailAddress` 和 `organizationName`、Grok `auth.json` 条目的 `email`、Codex `id_token` 里的 `email` 声明）；token 从不读出、保存或显示。加 `--force` 后，同步时才允许删掉账号里有、主账号里没有的 server。
- 备份残留（`*.bak*`、`*backup*`、`*.tmp*`）只计数，不处理。

只有 warn 时退出码为 0，有任何 fail 时为 1。

### 面板

```sh
sideby ui              # http://127.0.0.1:17420，自动打开浏览器
sideby ui --port 8080
sideby ui --no-open    # 只打印地址
```

面板只监听 `127.0.0.1`。端口上已经有一个 sideby 面板时，直接打开那个面板；端口被别的程序占用时，依次试后面的端口，并打印最终地址。页面按列对齐显示每个账号的各额度窗口、用量、最近使用、登录邮箱和健康状态；页面打开时每 20 秒自动刷新，开启额度后的几分钟里每 5 秒刷新一次，status line 一上报就能看到第一批数字。「隐藏邮箱」开关会把地址显示成 `a•••@example.com`，方便共享屏幕。页面上还有带一键修复的体检、新建账号（可顺手加短命令），还能在展示 diff 后开启 Claude 额度。一次开启对所有 Claude Code 账号生效，所以「开启额度显示」按钮只在 Claude Code 分组标题里，不在每个账号上。新建订阅账号后，面板只给出 `sideby login <account>` 的复制按钮，登录始终在你自己的终端里完成。

#### 桌面应用

```sh
sideby app install       # macOS：~/Applications/sideby.app；Linux：应用菜单里的「sideby」
sideby app uninstall
sideby ui --background   # 应用实际执行的命令：不占终端启动面板，然后打开它
sideby ui --stop         # 停掉后台面板
```

双击应用就能打开面板。没有面板在运行时，它在后台启动一个（`sideby ui --background`）；已经有了就直接复用，然后打开浏览器。关掉标签页后，后台面板继续运行，日志写到 `${XDG_STATE_HOME:-~/.local/state}/sideby/panel.log`。从 Finder 或桌面菜单启动的程序只拿到很短的 PATH，所以后台面板会向你的登录 shell（`$SHELL -ilc`）要 PATH，好找到 `~/.local/bin` 这类目录里的宿主。

应用运行的是安装时那份 Node 和 sideby：升级其中任何一个后，再跑一次 `sideby app install`，就地更新应用。如果你自己的页面嵌入了面板（见下文），`sideby app install --url http://accounts.localhost:17333/` 让应用改为打开这个地址。安装和卸载只动 `sideby app install` 自己创建的文件。这个应用是本机未签名的启动脚本，不适合拷到别的机器上用。

#### 嵌入面板

别的本地 Node 网页可以把面板挂在自己的路径下。handler 照常做 Host、Origin 和 token 校验，你只需列出自己网页使用的主机名。

```ts
import { createServer } from 'node:http'
import { createPanelHandler, createRuntime } from 'sideby'

const panel = createPanelHandler({
  runtime: () => createRuntime(), // 传工厂函数：每个请求都读到磁盘的最新状态
  basePath: '/accounts',
  allowedHosts: ['tools.localhost:8080'],
  theme: {
    colorScheme: 'light', // 默认 'auto'，跟随系统
    header: 'bar', // 通栏页头，而不是放在页面底色上的标题
    light: { font: '-apple-system, "PingFang SC", sans-serif', bg: '#f2f8fc', primary: '#e1f0fb', onPrimary: '#1f6396', radius: '10px', shadow: 'none' },
  },
  lang: 'en', // 默认 'auto'：先用面板里选过的语言，再看浏览器语言
})
createServer(async (req, res) => {
  if (!(await panel(req, res))) res.writeHead(404).end()
}).listen(8080, '127.0.0.1')
```

`theme` 让面板和你的页面风格一致。token 会写成面板自带的、带 nonce 的 `<style>` 里的 CSS 自定义属性，面板严格的 CSP 不需要放宽。iframe 读不到父页面的 CSS 变量，所以要传具体值。

- **token**（都可选）：字体排版 `font`、`monoFont`、`fontSize`、`smallSize`、`controlSize`、`headingSize`、`largeSize`、`titleSize`、`titleWeight`、`headingWeight`、`strongWeight`、`buttonWeight`、`primaryWeight`；颜色 `bg`、`surface`、`surfaceMuted`、`border`、`borderStrong`、`text`、`muted`、`faint`、`hover`、`active`、`accent`、`accentSoft`、`focus`、`primary`、`primaryHover`、`primaryActive`、`onPrimary`、`primaryBorder`、`primaryHoverBorder`、`buttonText`、`buttonHoverBorder`、`buttonHoverText`、`checkColor`、`ok`、`okSoft`、`warn`、`warnSoft`、`fail`、`failSoft`、`logoBg`、`logoColor`、`logoBorder`、`shadow`、`focusOutline`、`focusRing`；形状与布局 `radius`、`controlRadius`、`chipRadius`、`controlHeight`、`controlHeightSmall`、`fieldHeight`、`contentWidth`、`gutter`。每个 token 的含义见 [`src/panel/theme.ts`](src/panel/theme.ts)。
- **浅色与深色**：`light` 里的颜色只在浅色模式生效；字体排版、形状和布局 token 两种模式都生效。深色模式的颜色写在 `dark` 里；你的页面没有深色模式时，设 `colorScheme: 'light'`。
- **创建 handler 时校验**：未知 token，或值里出现字母、数字、空格和 `# % ( ) , . + - / ' " _` 以外的字符（也就是不允许 `;`、`{`、`}`、`<`、`\`、`*`、`:`），或含 `url(`、括号或引号不成对、超过 200 个字符，都会抛出写明 token 名的 `TypeError`。
- 不传 `theme` 时，外观和 `sideby ui` 一样。

`lang`（`'auto'`、`'en'` 或 `'zh'`）让面板语言和你的页面一致。设为 `'en'` 或 `'zh'` 时，它优先于面板里选过的语言，并隐藏面板的语言切换按钮；面板里选过的语言仍然保存着，改回 `'auto'` 后照常生效。`'auto'`（默认）先用面板里选过的语言，再看浏览器语言。其他值会在创建 handler 时抛出 `TypeError`。handler 只在创建时读一次 `lang`：要切换语言，就重新创建 handler。

### Claude 额度

Claude Code 只把额度数据交给 status line 命令，所以需要做一次可还原的改动：

```sh
npm i -g sideby                   # status line 每次刷新都会调用 sideby
sideby quota setup claude         # 只展示 diff，不改文件
sideby quota setup claude --yes   # 写入改动
sideby quota                      # 每个账号的 5h / 7d 额度和数据时间
sideby quota teardown claude      # 把原文件逐字节还原
```

`setup` 修改 `~/.claude/settings.json`：把你的 `statusLine.command` 包成 `sideby statusline-tap --orig-b64 <原命令的 base64>`，用 base64 是为了原命令里的引号和空格不被拆坏。原来没有 status line 时，设成 `sideby statusline-tap`，它会输出一行 `5h 72% · 7d 44%` 这样的内容。原始字节存进 sideby 的状态目录。status line 的显示不变；实测多出的冷启动耗时中位数约 82 ms。

Claude Code 每次刷新都会运行这个包装命令，所以 `sideby` 不在 `PATH` 上、或者来自 npx 缓存时，`setup` 会拒绝，并提示先执行 `npm i -g sideby`。

`teardown` 只在文件仍是 `setup` 写入的样子时才还原。如果之后你改过它，`teardown` 会拒绝并给出 diff，请手动把 `statusLine.command` 改回原命令（就是 `--orig-b64` 后面那段 base64），原来没有 `statusLine` 的就整段删掉。

`settings.json` 链接到主账号的账号（默认如此）共用这一次 setup。自己有一份 `settings.json` 的账号，额度显示为未开启，要等它自己的 status line 也这样包装后才有数据。Codex 的额度不用设置，sideby 直接读本地会话文件。

### 账号撞上限额时

```sh
sideby next claude              # 选剩余额度最多的账号并启动
sideby next codex --dry-run     # 只看推荐
sideby next claude -- --model opus  # 宿主参数放在 -- 之后
```

`next` 按每个账号「还没重置的窗口里最满的那个」排序，启动最低的那个，并列出其余账号和没选它们的原因：

```
   ACCOUNT        STATE       NOTE
→  claude:work    ready       fullest window 23%
   claude:new     unknown     no quota data yet
   claude:key     api         left out; add --include-api to use it
   claude:main    full        back at 14:30
```

- 有窗口到 85% 的账号算用满；已过重置时间的窗口重新按 0% 算。
- 还没有额度数据的账号排在有余量的账号后面。API 账号按次花钱，加 `--include-api` 才参与。
- 全部用满时什么都不启动，并告诉你哪个账号最先恢复。所有账号都还没有额度数据时也不启动，因为那样的推荐只是猜测：先开启额度（`sideby quota setup claude`），或用 `sideby run` 自己选。
- 新账号会开一个新会话，因为每个账号各存各的会话。可以先让旧会话写一份简短的交接说明，再贴进新会话。
- 只支持 Claude 和 Codex。Grok、pi 没有公开额度，`next grok` 会列出账号让你自己选。

sideby 只推荐，账号由你启动，它从不自己切换或轮换（见常见问题）。面板在每个家族里把同一个推荐账号标成「下一个」。

## 命令

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
- `list`、`new`、`next`、`alias`、`doctor`、`quota`（包括 `setup` 和 `teardown`）、`plugins`、`app` 支持 `--json`，输出带 `schemaVersion: 1`，JSON Schema 随包放在 [`schemas/`](schemas/)。加了 `--json` 时，出错会输出 `{ "schemaVersion": 1, "error": "…", "code": "…" }`：命令行写错时 `code` 为 `usage`，其他情况是 `no-quota-source` 这样的原因。只新增字段时版本不变；删除、改名或改语义时加 1。
- 任何输出、日志和错误信息里都不会出现凭据的值。

## 账号

| 家族 | 主账号 | 其他账号 | 选择变量 |
|---|---|---|---|
| claude | `~/.claude` | `~/.claude-<name>` | `CLAUDE_CONFIG_DIR` |
| codex | `~/.codex` | `~/.codex-<name>` | `CODEX_HOME` |
| grok | `~/.grok` | `~/.grok-<name>` | `GROK_HOME` |
| pi | `~/.pi/agent` | `~/.pi-<name>/agent` | `PI_CODING_AGENT_DIR` |

账号从磁盘上自动发现，不用手动登记。名字要匹配 `^[a-z0-9][a-z0-9-]{0,31}$`，`004` 和 `work` 都合法。目录里有 `proxy.env`，或者至少有一个该家族的共享项，才算账号；所以别的工具恰好同名的目录不会被误认，例如 claude-code-router 的 `~/.claude-code-router`。主账号固定叫 `main`，启动时不设选择变量。每次启动前，sideby 会清掉 Hijack Variables（例如全局的 `ANTHROPIC_API_KEY`），避免继承来的变量顶替账号身份。

## 配置

配置文件可以不存在，位置是 `${XDG_CONFIG_HOME:-~/.config}/sideby/config.json`，schema 见 [`schemas/config.json`](schemas/config.json)：

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
  "shellInitFile": { "zsh": "~/.config/sideby/shell-init.zsh" }
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
| `extraSharedItems.<family>` | 在内置清单之外加你自己的共享项，每项要写 Share Mode（`link`、`copy`、`link-or-copy`、`link-or-local`、`local`、`local-if-api`、`info`、`json-key`）。`path` 相对于账号目录，绝对路径和 `..` 会被拒绝。 |

### Shell 函数

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

## 支持的宿主

以下版本于 2026-10-05 测试通过。sideby 启动的是 `PATH` 上的官方可执行文件，不修改也不包装它。

| 宿主 | 家族 | 测试版本 | 登录 | 额度 | 用量（近 7 天） |
|---|---|---|---|---|---|
| Claude Code | `claude` | 2.1.289 | `claude auth login` | status line 缓存（先跑 `quota setup claude`） | 本地会话记录 |
| Codex CLI | `codex` | 0.160.0 | `codex login` | 本地会话文件 | 本地会话文件 |
| Grok Build | `grok` | 1.0.46 | `grok login` | 没有公开来源 | 没有公开来源 |
| pi | `pi` | 1.0.2 | 进入 pi 后执行 `/login` | 没有公开来源 | 没有公开来源 |

用量由 sideby 自己从 Claude Code 的 `projects/**/*.jsonl` 和 Codex 的 `sessions/**/rollout-*.jsonl` 统计，不需要 ccusage。Grok Build 和 pi 没有额度和用量来源。API 账号只显示用量，不显示额度。宿主没装时，`list` 照常列出它的账号并标注「宿主未安装」，`run` 会告诉你去哪里安装。

各宿主的差异：

- **codex**：非 main 账号默认加 `-c cli_auth_credentials_store="file"`，让每个账号的登录存在自己的 `auth.json` 里；你的参数里已经有这个键时不加。
- **grok**：Grok 的沙箱不允许某些路径是 symlink，所以 `hooks`、`hooks-paths` 用复制而不是链接，`trusted_folders.toml` 和 `config.toml` 是账号自己的文件。doctor 发现问题时会引用宿主的原话。
- **pi**：账号目录多一层（`~/.pi-<name>/agent`）。`proxy.env` 只用来加载 provider key，不会让 pi 账号变成 API 账号。

## 插件

> [!WARNING]
> **插件就是以你的全部权限运行的本地代码。** sideby 把它 import 进自己的进程，你能读写的东西它都能读写。只加载你自己写的、或者读过源码的插件。插件目录、`plugin.json` 或入口文件属于其他用户，或者组和其他用户可写时，sideby 拒绝加载。

加载顺序：先内置插件，再 `${XDG_CONFIG_HOME:-~/.config}/sideby/plugins/` 下的每个目录，最后是 `pluginDirs`。内置家族本身也是插件。

```
my-plugin/
├── plugin.json      # name、version、description，可选 main、userConfig
├── index.ts         # export default { name, register(api) } satisfies Plugin
└── index.test.ts    # 可选；用 sideby/testing 测试
```

```json
{ "name": "litellm-gateway", "version": "0.1.0", "description": "Check the local gateway before launch" }
```

```ts
import type { Plugin } from 'sideby' // 只允许 import type

export default {
  name: 'litellm-gateway',
  register(api) {
    api.on('launch.before', { family: 'claude' }, async (ctx) => {
      if (ctx.account.kind !== 'api') return
      const port = Number(ctx.config.port ?? 4000)
      const up = await fetch(`http://127.0.0.1:${port}/health`).then((r) => r.ok, () => false)
      if (!up) throw api.abort(`gateway on port ${port} is not running; start it first`)
    })
  },
} satisfies Plugin
```

- 插件可以写 `.ts` 或 `.js`。Node 22.18 起能直接从磁盘加载 `.ts`，不用构建。入口默认是 `index.ts`，`plugin.json` 里写了 `main` 就用它。
- 只允许 `import type`。插件需要的一切都通过 `api` 传进来，这样 sideby 以后改成单文件二进制时插件照样能用。要类型提示，就把 sideby 装成开发依赖：`npm i -D sideby`；完整契约见 [`src/types.ts`](src/types.ts)。
- `plugin.json` 里的 `name` 必须和导出的 `name` 一致。同名插件后加载的会报冲突，不会被加载。
- `ctx.config` 是这个插件在 `config.plugins.<name>` 里的设置，`userConfig` 的默认值已经填好。

| 扩展点 | 时机 | 能做什么 | 超时 |
|---|---|---|---|
| `api.family(def)` | 加载插件时 | 注册家族：目录约定、选择变量、Hijack Variables、默认参数、共享项、登录命令、登录态判断、模型，可选的 `logo`、`readQuota`、`readUsage`、`quotaSetup` | — |
| `launch.before` | 每次 `run`、`login` 之前 | 改 `ctx.env`、`ctx.args`，或用 `throw api.abort(msg)` 中止启动 | 30 秒 |
| `account.create.before` | `new`（CLI 或面板）写入任何文件之前 | 用 `throw api.abort(msg)` 拒绝新建；`ctx` 里有 `family`、`name`、`api`、该家族已有的 `accounts` 和 `config`。CLI 以退出码 1 结束，面板显示 `msg`，所以要写明改怎么做 | 10 秒 |
| `account.created` | `new` 成功后 | 补文件，用 `ctx.log()` 打印下一步提示 | 30 秒 |
| `doctor.check` | 体检每个账号时 | 返回 Finding，可以附带 `fix()` | 10 秒 |

家族的 `logo` 是面板在卡片和「Tool」下拉框里显示的标志：24×24 视图框里的一条 SVG path，例如取自 [Simple Icons](https://simpleicons.org)。

```ts
logo: { path: 'M11.503.131 1.891 5.678…', title: 'Cursor', color: '#000000' } // color 可省略
```

`path` 只能是 SVG path 数据（命令字母、数字、空格、逗号、点、`+`、`-`，最多 20000 个字符），`color` 必须是十六进制颜色，`fillRule` 取 `nonzero` 或 `evenodd`。不合法的 logo 会被丢弃，并在 `sideby plugins` 里报一条插件错误；家族照常加载，面板改为显示首字母。黑色标志不要设 `color`，这样在深色模式下会跟随文字颜色。

错误信息里总会标明插件名。加载失败只影响它自己；`doctor.check` 出错会变成该账号的一条 fail Finding；`launch.before` 出错会中止启动；家族的读取函数（例如 `model`）抛错时，会出现在 `list` 里该账号的 `problems` 中。`fix()` 只能写当前账号目录，并且要通过 `api.fs.writeFileAtomic` 写。

### `account-script`

内置插件，默认关闭，用来在账号启动前跑一段脚本（例如先拉起 API 账号要用的本地网关）：

```json
{ "plugins": { "account-script": { "enabled": true } } }
```

```sh
$EDITOR ~/.claude-deepseek/sideby-before-launch
chmod 700 ~/.claude-deepseek/sideby-before-launch
```

每次启动这个账号之前，sideby 在账号目录下、用准备好的启动环境运行 `sideby-before-launch`。文件必须属于你、可执行，并且组和其他用户不可写。脚本失败或 25 秒内没跑完，宿主就不会启动，sideby 会显示它 stderr 的最后 20 行。

## 常见问题

### 会不会违反服务条款？

sideby 的设计只用各宿主已经支持的机制（见 [ADR-0001](docs/adr/0001-side-by-side-not-switching.md) 和 [ADR-0003](docs/adr/0003-quota-from-local-and-official-sources.md)）：

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

## 给 AI agent

- [`llms.txt`](llms.txt)：命令、JSON 契约和插件 API 的索引。
- [`skills/sideby/SKILL.md`](skills/sideby/SKILL.md)：一个 Agent Skill，覆盖查看、修复、新建账号，以及账号撞限额后换号接着干。它按任务指向简短的 reference，agent 只加载需要的部分。用 `npx skills add Adonis0123/sideby -g` 安装；已装的版本和 sideby 不一致时，`sideby doctor` 会提醒。
- [`AGENTS.md`](AGENTS.md)：在本仓库干活的 agent 要遵守的规则。

## 许可证

[MIT](LICENSE)
