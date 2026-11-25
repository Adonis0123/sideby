# Grill: quota-idle-sort

- Date: 2026-11-25
- Pairing: Interviewer Claude Code, Proxy Codex, Red-team skipped: 没有难回退的决定
- Rounds: 2; stopped because frontier empty
- Duration: 约 15 分钟
- Status: proposed (no decision here has been implemented)

## Plan

「看下是不是支持按照额度的空闲排序比较好，联网搜索相关的知识」（针对状态栏菜单里各账号的额度列表；现状是「首选」在前，其余按 Display Order）

## Decisions

| ID | Question | Decision | Status | Reversibility | Evidence |
| --- | --- | --- | --- | --- | --- |
| Q1 | 排序加在哪里 | 只加到状态栏菜单。Panel「状态栏图标」设置里给切换；CLI 用 `sideby config set menubar.sort room --json`；shipped skill 补入口；`sideby menubar snapshot --json` 按设置输出。`sideby list` 不变 | Decided | easy | `src/panel/page-logic.ts`; `src/cli/commands.ts`; `AGENTS.md` |
| Q2 | 「空闲」怎么算 | 复用状态栏现有的 Handoff 计划，组内顺序和「首选」读同一份快照：够宽裕且 24 小时内重置的长窗口优先，其余按离 Takeover Limit 的余量排。Fable 等模型组照常显示，不参与排名 | Decided | easy | `docs/adr/0083-spread-picks-by-room-per-session.md`; https://github.com/yetone/magpie/blob/main/docs/reference.md |
| Q3 | 默认开还是选择开启 | 默认 `menubar.sort: "order"`，可切到 `"room"`。两种模式都让 Pinned Account 在各组最前；默认模式接着放未置顶的首选，其余按 Display Order | Assumption | easy | `CONTEXT.md`; `src/menubar/snapshot.ts` |
| Q4 | 顺序怎么不乱跳 | 菜单展开前用最近一份快照排好；打开期间行序和「首选」不动，额度和刷新状态原位更新；内容相同不重绘；同分沿用 Handoff 的顺序，不设「差几分算并列」 | Decided | easy | `src/menubar/script.ts`; https://developer.apple.com/documentation/appkit/nsmenudelegate/menuneedsupdate%28_%3A%29 |
| Q5 | 「另外 N 个账号」收什么 | 仍只收 API 账号、已退出登录账号和 Same Login 的其他目录。额度用完的账号留在主列表，未置顶的排在可用账号之后，显示恢复时间 | Decided | easy | `src/menubar/snapshot.ts`; `src/core/handoff.ts` |
| Q6 | Panel 排序方向 | Panel 保留现有四种排序，「按额度」仍是用量高的在前，已保存的偏好照常生效；按可用额度排序只加到状态栏菜单 | Decided | easy | `src/panel/page-logic.ts`; `docs/specs/2026-10-05-sideby-v0.1-design.md` §3.45 |
| Q7 | 模型组用满怎么排 | 状态栏排序、「首选」和 Handoff 都继续按全计划窗口计算；Fable 用满时在 Fable 行显示 `100%` 和重置时间。模型组影响选号另立 ADR | Decided | easy | `docs/specs/2026-10-05-sideby-v0.1-design.md`; https://code.claude.com/docs/en/model-config |
| Q8 | 文案 | 「状态栏图标」下 **Menu bar account order / 状态栏账号顺序**，选项 **Default order / 默认顺序**（`order`）和 **By available quota / 按可用额度**（`room`）；配置 `menubar.sort: "order" \| "room"` | Assumption | easy | `src/panel/i18n.ts` |

## Reasons

### Q1 — 排序加在哪里

- Reason: Panel 的「按额度」把用量高的排前，适合检查谁快用满；`sideby list` 已按 Display Order 输出，这轮保留原有语义。
- Revisit if: 有明确的终端场景，需要在 `sideby list` 里直接按余量看。

### Q2 — 「空闲」怎么算

- Reason: Magpie 的 `smart` 也优先用快重置且还有余量的账号。状态栏沿用 ADR-0083 的轻量预览，不扫会话，所以实际运行 `sideby next` 时，Live Session 和 Pick Record 可能改变结果。
- Revisit if: 多会话实测反复出现状态栏首选和实际启动的账号不同，再给状态栏加后台会话计数。

### Q3 — 默认开还是选择开启

- Reason: 固定位置方便点常用账号；置顶是用户明确给的优先级，「首选」继续由额度计划决定。
- Revisit if: 实际使用中多数用户每次打开菜单都在找下一个可用账号，并一直选 `"room"`。

### Q4 — 顺序怎么不乱跳

- Reason: 用户可以放心用鼠标或键盘选账号。AppKit 允许在 `menuNeedsUpdate` 更新菜单结构，`menuWillOpen` 之后应保持结构稳定。
- Revisit if: macOS 实测刷新会移走焦点或收起子菜单。原生交互本轮 `UNVERIFIED`。

### Q5 — 「另外 N 个账号」收什么

- Reason: 用户需要一眼看到账号何时能再用。任一全计划窗口到 Takeover Limit 就不能接手，只有全计划窗口到 100% 才算用完。
- Revisit if: 长列表里用完的账号经常把可用账号挤出首屏。

### Q6 — Panel 排序方向

- Reason: Panel 已有「现在最该用」卡片，一键启动推荐账号；「额度用量」排序让用户快速找出快用满的账号。
- Revisit if: 实测用户在 Panel 经常要比较多个备用账号，一个推荐不够用。

### Q7 — 模型组用满怎么排

- Reason: `lastModel` 是上次用的模型；即使账号设了默认模型，短命令、启动参数和会话里的 `/model` 都能换模型，按默认模型降序会把可用账号排错。
- Revisit if: 用户能在启动前明确指定目标模型，且 Host 能可靠报告该模型的额度窗口。

### Q8 — 文案

- Reason: 「默认顺序」包含置顶和首选，符合菜单实际呈现；「按可用额度」也涵盖快重置且有余量的账号优先这条规则。
- Revisit if: 首次试用的人普遍以为「按可用额度」只比较剩余百分比。

## Escalations

无。

## Assumptions

- Q3：默认仍是「默认顺序」，用户在设置里切到「按可用额度」。
- Q8：文案用「状态栏账号顺序 / 默认顺序 / 按可用额度」，配置值 `order | room`。

## Glossary and decision records

- Terms added to `CONTEXT.md`: 无（沿用 Display Order、Pinned Account、Room per Session、Takeover Limit）。
- Decision records written (status proposed): 无；实现时按 Change process 先改 spec §3.31，再决定是否需要 ADR。
