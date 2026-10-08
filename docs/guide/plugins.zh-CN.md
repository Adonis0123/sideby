# 插件

[English](plugins.md) | 中文

← [README](../../README.zh-CN.md)

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
- 只允许 `import type`。插件需要的一切都通过 `api` 传进来，这样 sideby 以后改成单文件二进制时插件照样能用。要类型提示，就把 sideby 装成开发依赖：`npm i -D sideby`；完整契约见 [`src/types.ts`](../../src/types.ts)。
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

## `account-script`

内置插件，默认关闭，用来在账号启动前跑一段脚本（例如先拉起 API 账号要用的本地网关）：

```json
{ "plugins": { "account-script": { "enabled": true } } }
```

```sh
$EDITOR ~/.claude-deepseek/sideby-before-launch
chmod 700 ~/.claude-deepseek/sideby-before-launch
```

每次启动这个账号之前，sideby 在账号目录下、用准备好的启动环境运行 `sideby-before-launch`。文件必须属于你、可执行，并且组和其他用户不可写。脚本失败或 25 秒内没跑完，宿主就不会启动，sideby 会显示它 stderr 的最后 20 行。
