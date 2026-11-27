> 目标设计快照，写于 2026-11-27，不随代码更新；与代码冲突时以代码为准，并报告不一致。

# Antigravity CLI（agy）多账号支持（`agy00x`）

## 组件表

| 名称 | 类型 | 职责 | 代码路径 |
| --- | --- | --- | --- |
| Family Selection Contract | 公共契约层 | 在 `FamilyDef` 增量新增可选 `selectArgs(account)` 与 `selectEnv(account)`，允许非 `mainOnly` Family 通过 `selectVar` 或 `selectArgs` 选账号，保持 `schemaVersion: 1` 兼容 | `src/types.ts`, `src/plugins/loader.ts`, `src/plugins/check.ts`, `src/cli/json-schemas.ts` |
| Nested Account Discovery & Creation | 核心账号模块 | 扩展 `splitLayout` / `discoverAccounts` 支持 `<name>` 出现在 `layout.account` 的非首段路径（如 `.gemini/antigravity-cli-<name>`），并沿用实目录守卫与 Shared Items 创建/Doctor 校验 | `src/core/accounts.ts`, `src/core/create.ts` |
| Launch & Account Env Builder | 启动编排模块 | 在 `accountEnv` 注入 `family.selectEnv(account)`，在 `launchCommand`（覆盖 `run`/`login`/`probe`）前置 `family.selectArgs(account)`，统一保证副账号绝不漏传隔离参数或环境变量 | `src/core/launch.ts`, `src/runtime.ts` |
| Agy Multi-Account Family | Family 插件 | 移除 `agy` 的 `mainOnly: true`，声明 `layout.account: '.gemini/antigravity-cli-<name>'`、`selectArgs`（`--app_data_dir=antigravity-cli-<name>`）与 `selectEnv`（`AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1`）；主账号保持 Keychain，副账号按 `antigravity-oauth-token`（`credential: true`, 0600）判登录态；共享 `settings.json`（`link-or-local`）与 `skills`（`link`） | `src/families/agy/index.ts`, `src/panel/page-logic.ts` |
| Agy Quota Fetcher | Quota 采集模块 | 查 `/usage` 时对非主账号透传 `selectArgs` 与 `selectEnv`；识别上游移除隐藏参数或文件凭据开关时的失败信号并给出明确升级/上游变更提示，不静默回落主账号 | `src/families/agy/quota.ts` |
| Agy Mod & Live Session Isolator | 会话发现与启动模组 | 在 `mod.ts` 的参数分类器加入 `--app_data_dir`/`--gemini_dir`；在 `statusline.ts` 与 `live-sessions.ts` 记录并校验进程所属账号（`SIDEBY_ACCOUNT` / 启动参数 / 打开文件目录），避免双开时同一进程在多个账号下重复出现 | `src/families/agy/mod.ts`, `src/families/agy/live-sessions.ts`, `src/agy/statusline.ts` |
| CLI / Panel / Skill 同步层 | 交互与文档层 | 在 Panel 新增账号流、默认别名建议（`agy002` 起，不劫持裸 `agy`）、`sideby families`/`new`/`login`/`doctor` 与 `skills/sideby/` 同步呈现 `agy` 多账号用法与风险提示，不接入 Handoff 与 `--api` | `src/cli/commands.ts`, `src/panel/`, `skills/sideby/` |

## 关系表

| 起点 | 终点 | 动作 | 协议或数据 |
| --- | --- | --- | --- |
| CLI / Panel | Nested Account Discovery & Creation | 扫描 `~/.gemini/` 发现 `antigravity-cli-<name>` 或新建副账号并建立共享链接 | 本地文件系统（实目录校验，`settings.json` `link-or-local`、`skills` `link`） |
| Launch & Account Env Builder | Agy Multi-Account Family | 仅对非主账号查询 `selectArgs(account)` 与 `selectEnv(account)` 并合并到进程启动配置 | 内存接口：`--app_data_dir=antigravity-cli-<name>` + `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` |
| Launch & Account Env Builder | `agy` 主账号进程（`agy:main`） | 保持真实 `HOME` 且不注入隐藏目录参数与文件存储开关 | 子进程 `exec`/`spawn`，沿用系统 Keychain（`gemini:antigravity`） |
| Launch & Account Env Builder | `agy` 副账号进程（`agy:<name>`） | 保持真实 `HOME` 启动副账号进程并隔离应用数据与凭据 | 子进程 `agy --app_data_dir=antigravity-cli-<name>` + `AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1` |
| `agy` 主/副账号进程 | `~/.gemini/config/` | 原生共用全局 MCP、plugins、rules、skills 与 ADR-0089 无值守 `hooks.json` | 本地目录直读（无需软链） |
| `agy` 副账号进程 | `~/.gemini/antigravity-cli-<name>/` | 隔离读写独立 OAuth 凭据文件、会话数据库与脑图产物 | `antigravity-oauth-token`（mode 0600）、`conversation_summaries.db`、`conversations/`、`brain/` |
| Agy Quota Fetcher | `agy` 主/副账号进程 | 并发或独立拉取各账号 `/usage`，附假 `open` 拦截器防止弹浏览器并校验参数生效 | `agy [selectArgs] -p /usage --output-format json`（stdout JSON，不读 stderr） |
| Agy Mod & Live Session Isolator | `<state>/agy-live/<pid>.json` 与 `conversation_summaries.db` | 写入并按账号归属过滤实时会话记录，确保双开时各账号只认领属于自己的 PID | 本地 JSON（含账号归属字段，mode 600）+ 只读 SQLite（WAL/immutable） |
