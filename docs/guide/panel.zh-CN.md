# 面板

[English](panel.md) | 中文

← [README](../../README.zh-CN.md)

```sh
sideby ui              # http://127.0.0.1:17420，自动打开浏览器
sideby ui --port 8080
sideby ui --no-open    # 只打印地址
```

面板只监听 `127.0.0.1`。端口上已经有一个 sideby 面板时，直接打开那个面板；端口被别的程序占用时，依次试后面的端口，并打印最终地址。页面按列对齐显示每个账号的各额度窗口、用量、最近使用、登录邮箱和健康状态；页面打开时每 20 秒自动刷新，开启额度后的几分钟里每 5 秒刷新一次，status line 一上报就能看到第一批数字。「隐藏邮箱」开关会把地址显示成 `a•••@example.com`，方便共享屏幕。页面上还有带一键修复的体检、新建账号（可顺手加短命令），还能在展示 diff 后开启 Claude 额度。一次开启对所有 Claude Code 账号生效，所以「开启额度显示」按钮只在 Claude Code 分组标题里，不在每个账号上。新建订阅账号后，面板只给出 `sideby login <account>` 的复制按钮，登录始终在你自己的终端里完成。

### 桌面应用

```sh
sideby app install       # macOS：~/Applications/sideby.app；Linux：应用菜单里的「sideby」
sideby app uninstall
sideby ui --background   # 应用实际执行的命令：不占终端启动面板，然后打开它
sideby ui --stop         # 停掉后台面板
```

双击应用就能打开面板。没有面板在运行时，它在后台启动一个（`sideby ui --background`）；已经有了就直接复用，然后打开浏览器。关掉标签页后，后台面板继续运行，日志写到 `${XDG_STATE_HOME:-~/.local/state}/sideby/panel.log`。从 Finder 或桌面菜单启动的程序只拿到很短的 PATH，所以后台面板会向你的登录 shell（`$SHELL -ilc`）要 PATH，好找到 `~/.local/bin` 这类目录里的宿主。

应用运行的是安装时那份 Node 和 sideby：升级其中任何一个后，再跑一次 `sideby app install`，就地更新应用。如果你自己的页面嵌入了面板（见下文），`sideby app install --url http://accounts.localhost:17333/` 让应用改为打开这个地址。安装和卸载只动 `sideby app install` 自己创建的文件。这个应用是本机未签名的启动脚本，不适合拷到别的机器上用。

### 嵌入面板

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

`lang`（`'auto'`、`'en'` 或 `'zh'`）让面板语言和你的页面一致。设为 `'en'` 或 `'zh'` 时，它优先于面板里选过的语言，并隐藏面板的语言切换按钮；面板里选过的语言仍然保存着，改回 `'auto'` 后照常生效。`'auto'`（默认）先用面板里选过的语言，再看浏览器语言。其他值会在创建 handler 时抛出 `TypeError`。handler 只在创建时读一次 `lang`：要切换语言，就重新创建 handler。
