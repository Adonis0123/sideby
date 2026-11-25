> 目标设计快照，写于 2026-11-26，不随代码更新；与代码冲突时以代码为准，并报告不一致。

# 账号隐藏修复与安全删除（Account Hide & Remove）

## 组件表

| 名称 | 类型 | 职责 | 代码路径 |
| --- | --- | --- | --- |
| Account Remove Core | 核心领域模块 | 生成删除预览计划并执行安全删除：拦截主账号、活跃会话与运行中桌面应用，清理配置与缓存 | `src/core/remove.ts` |
| Trash Helper | 基础设施模块 | 从 `claude-memory.ts` 抽离的统一移入废纸篓工具：优先调用系统 `trash`，无废纸篓或测试 HOME 时移入 `<state>/trash/` | `src/core/trash.ts` |
| Runtime | 核心编排层 | 暴露 `removeAccountPlan` / `removeAccount` 方法，复用账号发现、Live Session 与桌面应用检查、配置写入和 `shellInitFile` 刷新 | `src/runtime.ts` |
| CLI Remove Command | CLI 命令层 | 提供 `sideby remove <account\|alias> [--yes] [--json]`（别名 `rm`），无 `--yes` 输出计划并退出码 10，有 `--yes` 执行 | `src/cli/commands.ts`, `src/cli/main.ts`, `src/core/cli-commands.ts` |
| Panel Handler | HTTP 接口层 | 新增 `POST /api/accounts/remove`（支持 `confirm: false` 预览与 `confirm: true` 执行），写操作遵循 token/Origin/只读检查 | `src/panel/handler.ts` |
| Panel UI | 前端界面层 | 修复 `ui.showHidden` 粘连并收起总览底部常驻条；行菜单「管理」区新增「移入废纸篓…」及确认弹窗（主账号置灰） | `src/panel/page-script.ts`, `src/panel/i18n.ts` |
| Menu Bar Item | macOS 状态栏层 | 只读过滤已隐藏与已删除账号，不增加隐藏/删除菜单操作 | `src/cli/commands.ts` (`menubarFamilies`), `src/menubar/snapshot.ts` |
| Sideby Skill | Agent 技能文档 | 在路由表和参考文档中补充 `sideby remove` 用法及「先预览后确认再 `--yes`」规则 | `skills/sideby/SKILL.md`, `skills/sideby/references/accounts.md` |

## 关系表

| 起点 | 终点 | 动作 | 协议或数据 |
| --- | --- | --- | --- |
| Panel UI | Panel Handler | 请求删除预览或确认删除 | `POST /api/accounts/remove` (`{ ref, confirm }`) |
| Panel UI | Panel Handler | 保存隐藏配置 | `POST /api/display-order` (`{ display }`) |
| Panel Handler | Runtime | 调用删除计划或执行删除 | `removeAccountPlan(ref)` / `removeAccount(ref)` |
| CLI Remove Command | Runtime | 预览删除计划（exit 10）或带 `--yes` 执行 | `removeAccountPlan(ref)` / `removeAccount(ref)` |
| Runtime | Account Remove Core | 校验主账号、Live Session 与桌面应用状态，计算受影响配置与目录 | 内存对象（`RemovePlan` / `RemoveResult`） |
| Account Remove Core | Trash Helper | 将非主账号目录及对应的桌面 App Data 移入系统废纸篓或状态目录回收站 | 文件系统移动（不跟随 symlink） |
| Account Remove Core | Runtime | 清理 `aliases`、`display`、`handoff.order`、`quota` 缓存并重写 `shellInitFile` | `config.json` 原子写 + 状态文件清理 |
| Menu Bar Item | Runtime | 读取可见账号快照，跳过隐藏与已移走账号 | `menubarFamilies()` 过滤结果 |
