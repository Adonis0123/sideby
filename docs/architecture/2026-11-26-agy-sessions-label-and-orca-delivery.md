> 目标设计快照，写于 2026-11-26，不随代码更新；与代码冲突时以代码为准，并报告不一致。

# Antigravity CLI（agy）实时会话、状态栏标识与 Orca Chat 投递

## 组件表

| 名称 | 类型 | 职责 | 代码路径 |
| --- | --- | --- | --- |
| Agy Launch Mod | 启动编排模块 | 为交互式 `sideby run agy` 生成会话级临时 `--settings` 文件并挂载 `statusLine` 与 `title` 钩子，尊重用户显式 `--settings`、禁用项与 `accountTitle`，受 `agyMod` 控制且不写宿主目录 | `src/families/agy/mod.ts`, `src/runtime.ts` |
| Agy Statusline Helper | 内部 CLI 入口 | 承接 `agy` 管道 JSON，经祖先进程链/启动绑定定位真实 `agy` 进程与 `procStart`，带递归守卫串联用户原命令输出 `Session Label`，并把非敏感运行态原子缓存到 `<state>/agy-live/<pid>.json` | `src/agy/statusline.ts`, `src/cli/main.ts` |
| Agy Live Session Reader | Family 发现模块 | 识别本机交互式 `agy` 与本机 `agy acp` 进程，优先读 `<state>/agy-live/<pid>.json`（陈旧降级 `unknown`），其余限并发 `lsof` + 单次批量只读 `conversation_summaries.db` 消歧（歧义/撞车标 `guessed`）并区分 Orca 终端与 Chat | `src/families/agy/live-sessions.ts`, `src/families/live-sessions.ts` |
| Session Selector & Schema | 核心领域模块 | 保持 `sessionId` 为 `agy` 的 `conversation_id`，在 CLI `sessions --json` 增量暴露可选 `orcaSessionId`（Panel `/api/sessions` 白名单剔除），`selectSession` 仅接受精确 `orca_session_id:<id>` 别名并补足 `agy` 发送方识别 | `src/core/live-sessions.ts`, `src/core/session-select.ts`, `src/panel/handler.ts`, `schemas/sessions.json` |
| Agy Message Deliverer | 消息投递模块 | 复核目标三要素（`pid`/`procStart`、`ORCA_AGENT_SESSION_ID`、活跃 `conversation_id`）及已核实 Orca 发送者身份后经 `orca orchestration send --body-file` 直投，按结构化回执区分 `delivered` / `unknown` / `paste-needed`，Panel 与非 Orca 调用降级粘贴 | `src/families/agy/deliver.ts`, `src/families/messaging.ts`, `src/core/messages.ts` |
| Orca CLI Adapter | 外部工具适配层 | 复用并扩展受限子进程调用，提供带独立短超时与缓存的 `orca agent list` 核实/状态补齐及 `orca orchestration send --from --body-file` 投递，不经 shell 并清理临时 body 文件 | `src/panel/orca.ts`, `src/core/orca-chat.ts` |
| Sideby Orca Mod | 通用 Orca 插件 | 运行在 Orca（`>=1.4.248`）内的通用插件，列入 `package.json` 打包白名单：Worker 读取 `sideby sessions --json` 按 `orcaSessionId` 绑定当前 Chat，更新底部状态栏并仅向 TSX 面板传最小展示/复制字段 | `mods/orca/`, `package.json` |
| Sideby Panel & Skill | 界面与技能层 | 在 Panel 会话页、`sideby sessions`/`send`/`messages` CLI 和 `skills/sideby/` 文档中统一展示 `agy` 会话、`Started From: Orca` 及双 ID 寻址用法 | `src/panel/`, `src/cli/`, `skills/sideby/references/sessions.md` |

## 关系表

| 起点 | 终点 | 动作 | 协议或数据 |
| --- | --- | --- | --- |
| Agy Launch Mod | 终端 `agy` 进程 | 启动时注入临时 `--settings` 文件并保留用户原配置与禁用项 | CLI 参数 `--settings <state>/agy-launch/*.json`（mode 600，退出清理） |
| 终端 `agy` 进程 | Agy Statusline Helper | 经 `sh -c` 推送会话元数据并取回状态栏/标题文本 | stdin JSON（`conversation_id`, `conversation_title`, `agent_state`, `cwd`）→ stdout 文本 |
| Agy Statusline Helper | `<state>/agy-live/<pid>.json` | 定位真实 `agy` `pid`/`procStart` 后原子写入非敏感运行态 | 本地文件（目录 700、文件 600、无 symlink，不含 `email` 或凭据） |
| Agy Live Session Reader | `<state>/agy-live/<pid>.json` | 校验属主与 `procStart` 严格只读实时 ID 与状态，跳过死进程并降级陈旧状态（死 PID 清理由启动/写入路径负责） | 本地 JSON（限读大小，无写操作） |
| Agy Live Session Reader | `agy` / `agy acp` 进程与 `conversation_summaries.db` | 限并发 `lsof` + 每轮单次批量只读 SQLite 消歧，歧义或撞车标 `guessed` | `ps`/`lsof` + 只读 SQLite（WAL/immutable）+ `ORCA_STRUCTURED_SESSION`/`ORCA_AGENT_SESSION_ID` |
| Agy Live Session Reader | Orca CLI Adapter | 在独立短超时（约 1.5 s）与短缓存内核实 Chat ID 并补齐运行态 | `orca agent list --json`（无 shell） |
| Session Selector & Schema | Agy Message Deliverer | 解析目标会话（`conversation_id` 或精确 `orca_session_id:<id>`）并核对调用方身份 | 内存 `LiveSession` + `<state>/messages/` 已落盘文件与截图 + 预期 `transcript` 路径 |
| Agy Message Deliverer | Orca CLI Adapter | 复核目标三要素与已核实 Orca 发件人后投递，失败或状态不明按契约映射 `paste-needed` / `unknown` | `orca orchestration send --to orca_session_id:<id> --from <sender> --body-file <tmp> --json` |
| `src/core/messages.ts` | `brain/<id>/.system_generated/logs/transcript.jsonl` | 按回执预存路径扫描尾部 256 KB 检测 `sideby message <id>` 判定 `read`（`ENOENT` 视作未读） | 本地 JSONL 只读尾部扫描 |
| Sideby Orca Mod | `sideby sessions --json` | 拉取全量 Live Session 列表并按 `orcaSessionId` 绑定当前 Chat | 本地子进程 JSON（`schemaVersion: 1`） |
| Sideby Orca Mod | Orca Host API | 更新底部状态栏 `Session Label` 并仅向侧边栏面板传递最小展示与复制字段 | `statusBar.update` + `agents.list` + TSX `components` 面板 |
