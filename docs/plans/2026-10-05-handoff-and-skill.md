# Handoff、单 skill 与 CLI 契约 实施计划

依据：spec §3.9、§3.11、§3.13 和 §5 第 13–15 条；术语见 `CONTEXT.md`（Quota Pressure、Handoff）。决策来自 2026-10-05 的 grilling：不照搬 Kivo 的订阅代理（ADR-0001 不变），改做由人确认的 Handoff；skill 只保留一个。

## 任务

1. **Quota Pressure 与排名**
   - `src/core/quota-levels.ts` 加 `quotaPressure(quota, now)`。
   - 新建 `src/core/handoff.ts`：`planHandoff(family, candidates, now, { includeApi })`，纯函数，输出每个账号的 state、pressure、resetsAt，以及 pick 和 earliestReset。
   - 测试 `src/core/handoff.test.ts`：每种 state、排序、已重置窗口、全满、只剩 API、全部未登录。
   - `src/panel/page-logic.test.ts` 加一致性测试：`sortAccounts(..., 'pressure')` 的顺序与 `quotaPressure` 降序一致。
2. **Runtime**：`Runtime.handoff(familyId, { includeApi })` 读账号的 status 和 quota，调用 `planHandoff`；没有额度来源、没有账号时抛带 code 的 `UserError`。
3. **CLI `sideby next`**
   - `main.ts` 注册命令（`--` 之后的参数交给宿主）、HELP；`commands.ts` 加 `cmdNext`：打印表格、理由和交接提示，再走 `prepareLaunch` + `runHost`；`--dry-run` / `--json` 不启动。
   - `json-schemas.ts` 加 `next`；`pnpm schemas`。
   - `cli.test.ts`：启动环境、`--dry-run`、`--json`、全满、`next grok`、缺参数。
4. **契约**：错误 JSON 加 `code`；`quota setup` 不加 `--yes` 返回 10；doctor 的 general 行按级别显示标记。schema `error` 加 `code`。测试更新。
5. **面板**：`PanelState.handoff`；页面在推荐账号的行和卡片上显示「下一个 / Next」，i18n 两种语言；`panel.test.ts` 断言 state。
6. **skill**
   - `skills/sideby/SKILL.md` 改为路由页，frontmatter 加 `metadata.version`；细节拆到 `references/`（diagnose、accounts、quota、handoff）。
   - `scripts/sync-skill-version.ts` + `package.json` 的 `version` 脚本；测试校验版本一致。
   - Doctor：`skill.outdated` general warn（只读），测试用假 HOME。
7. **文档**：两份 README、`llms.txt`、`docs/release.md`（version 脚本）、AGENTS.md 地图。
8. **验收**：`pnpm check`、`pnpm build`、`npm pack --dry-run`；demo HOME 下跑 `sideby next claude|codex|grok` 和 Panel 浏览器检查；独立 review，修完再跑一遍。

## 不做

主动提醒、自动切换、复制会话、`sideby skill install`、`sideby skill read`、JSON 信封改造。
