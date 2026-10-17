# 面板

[English](panel.md) | 中文

← [README](../../README.zh-CN.md)

```sh
sideby ui              # http://127.0.0.1:17420，自动打开浏览器
sideby ui --port 8080
sideby ui --no-open    # 只打印地址
```

面板只监听 `127.0.0.1`。端口上已经有一个 sideby 面板时，直接打开那个面板；端口被别的程序占用时，依次试后面的端口，并打印最终地址。页面显示每个账号的登录邮箱、按列对齐的各额度窗口和最近使用；点一下账号，可以看它的运行方式、token 用量和健康状态。名字后面有橙点或红点，表示这个账号需要看一眼（某个额度窗口快到上限，或体检发现了问题），悬停能看到原因。页面打开时每 20 秒自动刷新，开启额度后的几分钟里每 5 秒刷新一次，status line 一上报就能看到第一批数字。「显示」里的「隐藏邮箱」会把地址显示成 `a•••@example.com`，方便共享屏幕。登录同一个身份的 Claude Code 账号在列表里排在一起：上面一行写 email、「2 个目录共用一份额度」和这份额度，只显示一次（鼠标悬停可以看到读自哪个账号，提醒的圆点也在这一行）；下面每个目录一行，写它自己的名字、模型、最近使用和菜单，点组头可以把它们收起（见[两个目录，同一个登录](usage.zh-CN.md#两个目录同一个登录)）。搜索后只剩其中一个，或者用卡片视图时，每个账号自己显示额度，并写「与 … 同一登录」。「显示」里还能切换已用或剩余额度、列表或卡片。哪些账号展开着，面板会在你的浏览器里记住。展开后，Claude Code 和 Codex 账号会显示它用的模型和 effort；点它，或账号菜单里的「模型和 effort…」，就能只为这个账号设置（见[模型与 effort](usage.zh-CN.md#模型与-effort)）。在 macOS 上，装了桌面应用的 Claude Code、Codex 订阅账号的菜单里有「打开桌面应用」，用这个账号打开 Claude Desktop 或 Codex 应用（见[桌面应用](usage.zh-CN.md#桌面应用)）。装了 Grok Bot 时，账号下面有一组 **Grok Bot**，列出它的各个窗口（各自登录），也能再开一个（见 [Grok Bot 窗口](usage.zh-CN.md#grok-bot-窗口)）。每个账号的菜单里有「上下文调优」，内容和 `sideby tune` 一致；「使用」按钮先展示改动，确认后写入推荐值，「撤销」可以改回原值（见[上下文调优](usage.zh-CN.md#上下文调优)）。页面上还有带一键修复的体检、新建账号（可顺手加短命令），还能在展示 diff 后开启 Claude 额度。一次开启对所有 Claude Code 账号生效，所以「开启额度显示」按钮只在 Claude Code 分组标题里，不在每个账号上。新建订阅账号后，面板只给出 `sideby login <account>` 的复制按钮，登录始终在你自己的终端里完成。

## 面板应用

```sh
sideby app install       # macOS：~/Applications/sideby.app；Linux：应用菜单里的「sideby」
sideby app uninstall
sideby ui --background   # 应用实际执行的命令：不占终端启动面板，然后打开它
sideby ui --stop         # 停掉后台面板
```

双击应用就能打开面板。没有面板在运行时，它在后台启动一个（`sideby ui --background`）；已经有了就直接复用，然后打开浏览器。关掉标签页后，后台面板继续运行，日志写到 `${XDG_STATE_HOME:-~/.local/state}/sideby/panel.log`。从 Finder 或桌面菜单启动的程序只拿到很短的 PATH，所以后台面板会向你的登录 shell（`$SHELL -ilc`）要 PATH，好找到 `~/.local/bin` 这类目录里的宿主。

应用运行的是安装时那份 Node 和 sideby。`sideby update`（以及面板的「更新」按钮和自动更新）会用新版本重新安装应用，图标也一起换新。升级了 Node，或用别的方式装了 sideby，就自己再跑一次 `sideby app install`。如果你自己的页面嵌入了面板（见下文），`sideby app install --url http://localhost:3000/` 让应用改为打开这个地址；再次安装会沿用这个地址。要让应用改回启动面板，先跑 `sideby app uninstall`，再跑 `sideby app install`。安装和卸载只动 `sideby app install` 自己创建的文件。这个应用是本机未签名的启动脚本，不适合拷到别的机器上用。

## 嵌入面板

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

- **token**（都可选）：字体排版 `font`、`monoFont`、`fontSize`、`smallSize`、`controlSize`、`headingSize`、`largeSize`、`titleSize`、`titleWeight`、`headingWeight`、`strongWeight`、`buttonWeight`、`primaryWeight`；颜色 `bg`、`surface`、`surfaceMuted`、`border`、`borderStrong`、`text`、`muted`、`faint`、`hover`、`active`、`accent`、`accentSoft`、`focus`、`primary`、`primaryHover`、`primaryActive`、`onPrimary`、`primaryBorder`、`primaryHoverBorder`、`buttonText`、`buttonHoverBorder`、`buttonHoverText`、`checkColor`、`ok`、`okSoft`、`warn`、`warnSoft`、`fail`、`failSoft`、`logoBg`、`logoColor`、`logoBorder`、`shadow`、`focusOutline`、`focusRing`；形状与布局 `radius`、`controlRadius`、`chipRadius`、`controlHeight`、`controlHeightSmall`、`fieldHeight`、`contentWidth`、`gutter`。每个 token 的含义见 [`src/panel/theme.ts`](../../src/panel/theme.ts)。
- **浅色与深色**：`light` 里的颜色只在浅色模式生效；字体排版、形状和布局 token 两种模式都生效。深色模式的颜色写在 `dark` 里；你的页面没有深色模式时，设 `colorScheme: 'light'`。
- **创建 handler 时校验**：未知 token，或值里出现字母、数字、空格和 `# % ( ) , . + - / ' " _` 以外的字符（也就是不允许 `;`、`{`、`}`、`<`、`\`、`*`、`:`），或含 `url(`、括号或引号不成对、超过 200 个字符，都会抛出写明 token 名的 `TypeError`。
- 不传 `theme` 时，外观和 `sideby ui` 一样。

`updates`（默认 `true`）会在面板页头显示当前版本，有新版本时显示「新版本」标签，以及带「检查更新」、「更新」按钮和自动更新开关的更新对话框（见[更新](configuration.zh-CN.md#更新)）。从这里发起的更新会安装新包；从已安装的包加载 sideby 的页面会自己换上新版本（前提是它每次检查新代码时，都重新找一次 `sideby` 命令所在的包），面板提示刷新页面。你的页面自己管理 sideby 版本时传 `updates: false`：面板不再显示任何更新相关内容，并拒绝 `/api/update*`。

`<basePath>/icon.svg` 提供 sideby 标志（面板自己的 favicon 用 `<basePath>/favicon.svg`，小尺寸版，只有蓝色那个小伙伴）。在你自己的标签页或菜单里直接引用它，不要另存一份，这样换了新标志，你的页面跟着下一个 sideby 版本更新。

`lang`（`'auto'`、`'en'` 或 `'zh'`）让面板语言和你的页面一致。设为 `'en'` 或 `'zh'` 时，它优先于面板里选过的语言，并隐藏面板「设置」里的语言选项；面板里选过的语言仍然保存着，改回 `'auto'` 后照常生效。`'auto'`（默认）先用面板里选过的语言，再看浏览器语言。其他值会在创建 handler 时抛出 `TypeError`。handler 只在创建时读一次 `lang`：要切换语言，就重新创建 handler。
