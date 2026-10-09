# Auto Handoff 实施计划

**目标**：实现 spec §3.17：sideby 启动的交互会话额度快用完时，旧会话写好 Handoff Brief，sideby 结束它，在同一个终端按 Handoff Order 启动下一个账号的新会话。

**架构**：父进程 `sideby run` 守着宿主。宿主的 hook 调用隐藏命令 `sideby handoff-hook`（只引入叶子模块，同 `statusline-tap`），读额度和父进程写好的 `plan.json`，往会话里注入指令，把 `ready.json` 写进链目录。父进程监听 `ready.json`，结束宿主、补全 Brief、倒计时，然后启动下一个账号。选号是纯函数，额度和账号状态都来自已有的 Runtime。

**技术栈**：Node 22.18+ 直接运行 `.ts`；typebox 做 config schema；`node --test`；测试只用 `testing/` 的 `withFakeHome`、`fakeHost`。

**依据**：`docs/specs/2026-10-05-sideby-v0.1-design.md` §3.17、ADR-0010、`CONTEXT.md`「Limits」。

## 全局约束

- 默认关闭：`handoff.auto` 为 true 才注入 hook、设环境变量；`sameFamily` 另开。
- 不读凭据、不代理、不复制会话、不调私有接口；Brief 正文不进启动参数。
- hook 入口只 import Node 内置模块和叶子模块：不 import `runtime.ts`、家族 index、`core/accounts.ts`。任何错误都退出 0、不输出。
- 只对 sideby 启动的交互会话生效；headless（`claude -p`/`--print`、`codex exec`、`grok -p`/`--single`/`--prompt-file`）不注入。
- 默认值：`prepareAt` 80、`threshold` 95、`waitIfResetWithinMinutes` 30、`countdownSeconds` 10；SIGTERM 后最多等 10 秒，不发 SIGKILL。
- 链目录 `${XDG_STATE_HOME}/sideby/handoffs/<chain>/`：目录 700，文件 600，原子写。
- `--json` 带 `schemaVersion: 1`；改了 `--json` 或 config 就跑 `pnpm schemas` 并更新 `llms.txt`。
- 用户可见错误都说下一步怎么做；hook 注入给模型的文字用英文。
- 用户没要求就不 commit；各任务末尾的提交信息留作之后提交时用。
- 与 spec 的三处偏差，在任务 11 同步回 spec：插件家族这一期只能接手（hook 入口不能加载插件代码）；`order` 里不存在的账号由 Doctor 报 `handoff.order-unknown`，交接时跳过（账号从磁盘发现，config 校验时不知道）；手动入口需要 `handoff.auto`（否则每次启动都要注入 hook）。

## 重点检查（容易出错、各任务测试要覆盖的输入）

1. 临时限流（`rate_limit` 但额度没满、Grok 的「try again later」文字）不能触发交接：任务 4 的 Claude、Grok 读取器测试。
2. 宿主在 10 秒内不退出：不启动下一个账号、不 SIGKILL，原会话照常运行：任务 7。
3. 用户取消倒计时：原账号续接刚才的会话，且这次不带 hook：任务 7。
4. 写了一半的 rollout 行、缺失的 `rate_limits`、损坏的 `plan.json` 或 `run-*.json`：hook 都安静退出 0：任务 4。
5. 链里每个账号只用一次、不回到已满账号；`order` 里写短命令也能解析：任务 3。

---

### 任务 1：实测宿主的 hook 加载方式（不需要登录的部分）

**文件**：新建 `docs/verification/2026-10-09-auto-handoff.md`；实验脚本放会话 scratchpad，不进仓库。

- [ ] 在 demo HOME（`node scripts/demo-home.ts <dir> empty`）里，用真实二进制和全新的账号目录，验证三种注入方式能否加载 hook。用 `SessionStart` hook 写标记文件，它在第一次 API 调用之前触发，不需要登录：
  - Claude：账号 `settings.json` 和 `--settings <file>` 各有一个 `SessionStart` hook，两个标记文件都要出现（spec 实测第 1 项）。
  - Codex：`-c 'hooks.SessionStart=[{hooks=[{type="command",command="…"}]}]'`，配合 `--dangerously-bypass-hook-trust`（只在实验里用），标记文件出现（第 3 项的加载部分）。
  - Grok：`$GROK_HOME/hooks/x.json` 的 `SessionStart`，标记文件出现；再复制一份到 copy 模式的账号，看 Doctor 是否同步新文件（第 7 项）。
- [ ] 需要登录、真实对话或撞上限额的项（第 2、4、5、6 项，第 3 项的运行部分，pi 的首条 prompt）在文档里逐条标 `UNVERIFIED`，并写好用户自己运行的步骤和命令。原因是 demo HOME 里没有登录态，在真实账号上跑会触发用户自己的 hook（例如飞书提醒），还要消耗额度。
- [ ] 按结果调整后续任务：Claude 合并失败就在任务 5 里改用 setup；Codex `-c` 失败就让 Codex 也走 setup。
- [ ] 提交：`📝 docs(verification): record how each host loads sideby's handoff hooks`

### 任务 2：config `handoff` 与解析

**文件**：改 `src/core/config.ts`；测试 `src/core/config.test.ts`（没有就新建）；`schemas/config.json`（`pnpm schemas`）。

**产出**：
- `ConfigSchema.handoff`：字段与 spec §3.17 一致；`prepareAt`、`threshold` 为 1–100 的整数；`policy` 为 `'pressure' | 'order'`。
- `export interface HandoffSettings { auto: boolean; sameFamily: boolean; prepareAt: number; threshold: number; waitIfResetWithinMinutes: number; countdownSeconds: number; crossOrganization: string[]; families: Record<string, { policy: 'pressure' | 'order'; order: string[] }> }`
- `export function handoffSettings(config: Config): HandoffSettings`：填默认值。

- [ ] 写测试：空 config 得到全部默认值；`prepareAt >= threshold` 时 `loadConfig` 抛 `ConfigError`，信息含 `handoff.prepareAt` 和修法；`threshold: 101` 被 schema 拒绝。
- [ ] 跑 `node --test src/core/config.test.ts`，确认失败。
- [ ] 实现：schema、跨字段校验放进 `loadConfig` 现有的校验位置、`handoffSettings`。
- [ ] 跑测试通过；`pnpm schemas`。
- [ ] 提交：`✨ feat(config): add handoff settings`

### 任务 3：公开契约、链目录存储与选号

**文件**：改 `src/types.ts`；新建 `src/core/handoff-chain.ts`（叶子模块）、`src/core/handoff-select.ts`；测试 `src/core/handoff-chain.test.ts`、`src/core/handoff-select.test.ts`。

**产出（types.ts）**：
```ts
export type HandoffHookEvent = 'PostToolUse' | 'Stop' | 'StopFailure'
export interface HandoffEligibility { start: boolean; receive: boolean; reason?: string }
export interface FamilyHandoff {
  /** What this Family can start: before the limit from Quota, after the limit from a failed turn. Empty: receive only. */
  starts: readonly ('quota' | 'limit')[]
  /** Host arguments that load sideby's hooks for one run; omitted when hooks come from `hookSetup`. */
  hookArgs?(command: (event: HandoffHookEvent) => string, stateDir: string): Promise<string[]>
  /** Host arguments that let the session read and write the chain directory. */
  dirArgs?(dir: string): string[]
  /** Host arguments that start a new interactive session with this first prompt. */
  promptArgs(prompt: string): string[]
  /** The user's Host arguments for the next session of this Family: no resume, continue or old first prompt. */
  continueArgs(args: readonly string[]): string[]
  /** Host arguments that resume this session in the same Account. */
  resumeArgs(sessionId: string): string[]
  /** Whether this run may start or receive a Handoff (headless runs, Codex `--remote`, Grok sandbox profiles). */
  eligibility(args: readonly string[], account: Account, env: Env): Promise<HandoffEligibility>
  /** A Brief from the session's local records, without a model; undefined when nothing could be read. */
  briefFromSession?(account: Account, session: { id?: string; transcriptPath?: string }): Promise<string | undefined>
  /** One-time hook installation for a Host without a launch option (Grok); same contract as QuotaSetup. */
  hookSetup?: QuotaSetup
}
```
`FamilyDef` 加 `handoff?: FamilyHandoff`。

**产出（handoff-chain.ts）**：`HANDOFF_ENV = { run: 'SIDEBY_HANDOFF_RUN', family: 'SIDEBY_HANDOFF_FAMILY', dir: 'SIDEBY_HANDOFF_DIR' }`；`newId(): string`；`chainDir(stateDir, chain)`；`ensureChainDir(dir)`（700）；`briefPath(dir, n, ref)`（文件名里的 `:` 换成 `-`）；`readJsonFile<T>(path): Promise<T | null>`（缺失或损坏返回 null）；`writeJsonFile(path, value)`（原子写，600）。四种文件的类型：
- `PlanFile { at: string; decision: 'pick' | 'wait' | 'none'; pick?: string; prepareAt: number; threshold: number }`：父进程写。
- `RunState { prepareSentAt?: string; thresholdSentAt?: string; stopBlocked?: boolean; sessionId?: string; transcriptPath?: string }`：hook 写，文件名 `run-<runId>.json`。
- `ReadyFile { runId: string; at: string; trigger: 'threshold' | 'limit' | 'manual'; brief?: string; briefSource?: 'agent' | 'user'; sessionId?: string; transcriptPath?: string }`。
- `RequestFile`：手动入口写 `request.json`，形状同 `ReadyFile`，由 `Stop` hook 转成 `ready.json`。
- `ChainFile { hops: { ref: string; startedAt: string; trigger?: ReadyFile['trigger']; briefSource?: 'agent' | 'sideby' | 'user'; brief?: string }[] }`。

**产出（handoff-select.ts）**：
```ts
export interface SelectCandidate { ref: string; family: string; name: string; isMain: boolean; kind: Account['kind']; login: LoginState | 'not-needed'; quota: QuotaResult; identity?: AccountIdentity; installed: boolean; receive: boolean }
export type HandoffDecision =
  | { kind: 'pick'; ref: string }
  | { kind: 'wait'; until: string }
  | { kind: 'none'; reason: string; earliestReset?: { ref: string; at: string } }
export function sameOrganization(a?: AccountIdentity, b?: AccountIdentity): boolean
export function selectNext(input: { origin: SelectCandidate; candidates: readonly SelectCandidate[]; settings: HandoffSettings; aliases: Record<string, string>; used: readonly string[]; now: Date }): HandoffDecision
```
复用 `planHandoff` 里每个账号的 state（`ready`、`unknown`、`api`、`full`、`logged-out`）和排序。

- [ ] 写测试（handoff-select）：
  - 原账号满了的窗口在 30 分钟内重置时得到 `wait`；31 分钟时不等。
  - `policy: order` 按列表顺序，短命令经 `aliases` 解析成 ref。
  - 跳过已用过的、`full`、`logged-out`、`installed: false`、`receive: false` 的账号。
  - `sameFamily: false` 时去掉同家族账号。
  - 组织判断：两边都有 org 时比 org；否则比 email 域名；都没有时视为相同。`crossOrganization` 放行。
  - 没有可选账号时得到 `none`，带 `earliestReset`。
  - 没写 `order` 时按压力选本家族账号，再补其他家族的 API 账号。
- [ ] 写测试（handoff-chain）：`readJsonFile` 读到损坏的 JSON 返回 null；写出的文件 mode 600，目录 700。
- [ ] 跑测试，确认失败；实现；再跑，确认通过。
- [ ] 提交：`✨ feat(handoff): add chain files and next-account selection`

### 任务 4：hook 入口与各家族的 hook 读取器

**文件**：
- 新建 `src/handoff/hook.ts`（入口）、`src/handoff/messages.ts`（注入文字、Brief 模板）、`src/families/claude/handoff-hook.ts`、`src/families/codex/handoff-hook.ts`、`src/families/grok/handoff-hook.ts`、`src/families/codex/rate-limits.ts`（从 `rollout.ts` 提出 `quotaWindow`、`rateLimits`，两边共用）。
- 改 `src/cli/main.ts`：在 `statusline-tap` 旁边懒加载分派 `handoff-hook`。
- 测试 `src/handoff/hook.test.ts`、每个 `handoff-hook.test.ts`。

**产出**：
- `runHandoffHook(argv: string[], env: Env, stdin: AsyncIterable<Uint8Array | string>, stdout: NodeJS.WritableStream): Promise<number>`：总是返回 0。
- 读取器接口（hook.ts 内部）：`{ pressure?(input: Record<string, unknown>, env: Env): Promise<number | null>; limitHit?(input: Record<string, unknown>, pressure: number | null, threshold: number): boolean }`。
  - Claude：压力取 tap 缓存（`quota-cache.ts` 的 `readQuotaCache` + `quotaPressure`）。限额判断：`error === 'rate_limit'`，并且压力 ≥ `threshold`，或 `error_details`/`last_assistant_message` 含 `usage limit`。
  - Codex：压力取 `transcript_path` 文件里最后一个有效的 `rate_limits`，跳过写了一半的行。没有限额判断。
  - Grok：没有压力。限额判断按 spec §3.17 的子串名单，`status 403` 要和名单中一条同时出现；带 `subagentType` 的忽略。
- 字段名两种都认：`session_id`/`sessionId`、`transcript_path`、`stop_hook_active`/`stopHookActive`、`error_details`/`errorDetails`、`last_assistant_message`/`lastAssistantMessage`。
- 输出（三个宿主同形）：`PostToolUse` 输出 `{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":…}}`；`Stop` 输出 `{"decision":"block","reason":…}`。
- 决策：
  - `PostToolUse`：压力 ≥ `threshold`，且 `plan.decision === 'pick'`，且这次运行还没发过交接档指令 → 发交接档指令，记 `thresholdSentAt`。否则压力 ≥ `prepareAt` 且还没发过预备档指令 → 发预备档指令。
  - `Stop`：有 `request.json` → 转成 `ready.json`。已发过交接档指令：Brief 在 `thresholdSentAt` 之后更新过 → 写 `ready.json`；没更新，且没 block 过、`stop_hook_active` 不为真 → block 一次；否则写不带 brief 的 `ready.json`。还没发过交接档指令但压力已过阈值、`plan` 是 `pick` → 用交接档文字 block，并记 `thresholdSentAt`。
  - `StopFailure`：限额判断为真 → 写 `ready.json`（`trigger: 'limit'`）。

- [ ] 写测试（hook.test.ts，用 `withFakeHome`，通过 env 指向假链目录）：
  - 没有 `SIDEBY_HANDOFF_RUN` → 无输出；`SIDEBY_HANDOFF_FAMILY` 和参数不一致 → 无输出。
  - 预备档只发一次；交接档在 `plan` 为 `wait` 时不发。
  - `Stop` 的三条分支；`request.json` 转成 `ready.json`。
  - 损坏的 `plan.json`、stdin 不是 JSON → 退出 0、无输出。
- [ ] 写测试（读取器）：
  - Claude：`rate_limit` 但压力 40、报错文字无关 → false；压力 96 → true；文字含 `usage limit` → true。
  - Grok：`You hit your weekly limit` → true；单独的 `status 403` → false；`You’ve hit the rate limit for your plan … try again later` → false；带 `subagentType` → false。
  - Codex：rollout 最后一行写了一半 → 用前一个有效值；没有 `rate_limits` → null。
- [ ] 跑测试，确认失败；实现；再跑，确认通过。
- [ ] 测冷启动：`node dist/src/cli/main.js handoff-hook claude PostToolUse < /dev/null`，取 21 次的中位数，记进 verification 文档。目标和 `statusline-tap` 同一量级（约 40 ms）。
- [ ] 提交：`✨ feat(handoff): add the hook entry and per-host hook readers`

### 任务 5：各家族的 `handoff` 成员

**文件**：改 `src/families/claude/index.ts`、`src/families/codex/index.ts`、`src/families/grok/index.ts`、`src/families/pi/index.ts`；新建 `src/families/shared/handoff-args.ts`（按「去掉哪些参数」的表过滤，带每个家族要取值的选项列表）；新建 `src/families/claude/brief.ts`、`src/families/grok/brief.ts`；测试写进各家族已有的 `index.test.ts`。

**产出**：
- Claude：`starts: ['quota', 'limit']`。`hookArgs` 写 `<stateDir>/handoff/claude-settings.json`（三个事件，`StopFailure` 用 matcher `rate_limit`），返回 `['--settings', file]`。`dirArgs` 返回 `['--add-dir', dir]`。`promptArgs` 返回 `[prompt]`。`resumeArgs` 返回 `['--resume', id]`。`eligibility`：有 `-p`/`--print` 时两项都是 false。
- Codex：`starts: ['quota']`。`hookArgs` 返回 `['-c', 'hooks.PostToolUse=[{hooks=[{type="command",command="sideby handoff-hook codex PostToolUse"}]}]', '-c', 'hooks.Stop=[…]']`。`dirArgs` 返回 `['--add-dir', dir]`。`resumeArgs` 返回 `['resume', id]`。`eligibility`：`exec` 子命令或 `--remote` 时两项都是 false；`-s read-only`/`--sandbox read-only` 时 `start: true`，但 Brief 由 sideby 拼。
- Grok：`starts: ['limit']`。没有 `hookArgs`，有 `hookSetup`（写主账号 `hooks/sideby-handoff.json`，含 `Stop` 和 `StopFailure`，`StopFailure` 的 `timeout` 设 60）。`promptArgs` 返回 `[prompt]`。`resumeArgs` 返回 `['--resume', id]`。`eligibility` 按 spec §3.17 读 `requirements.toml`、`--sandbox`、`GROK_SANDBOX`、账号 `config.toml`、`managed_config.toml` 算出生效的 profile；`allow_managed_hooks_only` 为真时不能发起；`-p`/`--single`/`--prompt-file` 时两项都是 false。
- pi：`starts: []`，`promptArgs` 返回 `[prompt]`，只能接手。前提是任务 1 的手动步骤确认 pi 支持首条 prompt；没确认之前不加 `handoff`。
- `continueArgs`：按 spec 的表格逐个家族实现。
- `briefFromSession`：
  - Claude：读 `projects/*/<id>.jsonl`，或直接读 `transcriptPath`：取第一条用户文字、最后 6 条文字消息、Edit/Write 工具改过的路径。
  - Grok：读 `sessions/` 下对应的会话文件，取同样的内容。只取文字，每段截断到 2000 字符。

- [ ] 写测试：
  - 每个家族的 `continueArgs`：Claude 去掉 `--resume <id>`、`-c`、旧 prompt，保留 `--model opus`、`--dangerously-skip-permissions`；Codex 保留 `-c model="o3"`，去掉 `resume <id>`、`--last`；Grok 去掉 `-r <标题>` 和不带值的 `--resume`。
  - 每个家族的 `eligibility` 分支。
  - Claude `hookArgs` 写出的 settings 文件内容。
  - Grok `hookSetup` 的 plan、apply、teardown：teardown 后文件按字节还原；hash 变了就拒绝。
  - `briefFromSession` 读 fixture 会话，fixture 里只放假内容。
- [ ] 跑测试，确认失败；实现；再跑，确认通过。
- [ ] 提交：`✨ feat(families): describe how each host takes part in a handoff`

### 任务 6：可控的宿主进程与 Brief 组装

**文件**：改 `src/core/launch.ts`；新建 `src/core/handoff-brief.ts`；测试 `src/core/handoff-brief.test.ts`。`launch` 已有的测试要保持通过。

**产出**：
- `spawnHost(p: HostLaunch): { child: ChildProcess; exited: Promise<number> }`。`runHost` 改成调用它，行为不变：信号转发、退出码、标题都和现在一样。
- `gitSection(cwd: string): Promise<string>`：输出分支、`git status --porcelain` 的文件列表、`git diff --stat`。每条命令 3 秒超时；不是仓库时返回空字符串。
- `firstPrompt(fromRef: string, briefFile: string): string`：一句英文，说明来源账号，让新会话先读 Brief 文件。
- `finishBrief(dir: string, ready: ReadyFile, assembled?: string): Promise<{ path: string; source: 'agent' | 'sideby' | 'user' }>`：在 Brief 末尾追加 git 部分。agent 没写 Brief 时用 `assembled`，开头注明「由 sideby 机械生成，可能不完整」。

- [ ] 写测试：
  - `gitSection` 在临时 git 仓库里能列出未提交的文件；在非仓库目录返回空字符串。
  - `finishBrief` 的三种来源；写出的文件 mode 600。
  - `firstPrompt` 里只有路径，不含 Brief 正文。
- [ ] 跑测试，确认失败；实现；再跑，确认通过；跑 `node --test src/cli/cli.test.ts`，确认信号相关测试仍然通过。
- [ ] 提交：`♻️ refactor(launch): expose the host process for handoff control`

### 任务 7：交接编排与 `run`、`next` 的接入

**文件**：新建 `src/core/handoff-run.ts`；改 `src/runtime.ts`（新增 `handoffSettings()`、`handoffCandidates(origin: Account)`、`handoffDecision(origin: Account, used: string[])`）；改 `src/cli/commands.ts`（`cmdRun`、`cmdNext` 在符合条件时调用 `runWithHandoff`）；测试 `src/core/handoff-run.test.ts`、`src/cli/cli.test.ts`。

**产出**：
```ts
export async function runWithHandoff(rt: Runtime, ref: string, userArgs: readonly string[], io: { err(s: string): void; stdin: NodeJS.ReadStream }): Promise<number>
```
- 符合条件才进入编排：`handoff.auto` 为真、家族有 `handoff` 且 `starts` 非空、`eligibility.start` 为真、`stdin.isTTY`。否则走原来的 `runHost`。
- 每一跳：
  - 在 `prepareLaunch` 的结果上加 `hookArgs`、`dirArgs`、`promptArgs`（第二跳起），以及三个 `HANDOFF_ENV` 变量。
  - 启动时和之后每 60 秒写一次 `plan.json`。
  - 监听 `ready.json`：用 `fs.watch`，再加 1 秒轮询兜底。
- 收到 `ready.json`：
  1. SIGTERM，等 10 秒；10 秒内没退出就在宿主退出后说明情况，不交接。
  2. Brief 不完整时用 `briefFromSession` 拼，再走 `finishBrief`。
  3. 重新算一次选号：`none` 时打印最早恢复的账号和时间并结束；`wait` 时说明并结束。
  4. 倒计时，按 `Enter` 取消：取消就用 `resumeArgs` 在原账号续接会话，不带 hook。
  5. 写 `chain.json`；同家族时下一跳用 `continueArgs(userArgs)`，跨家族时不带用户参数（账号 `args` 由 `prepareLaunch` 从 config 带上）。
- 会话正常结束、没交接时，如果额度当时已过阈值，而选号结果是 `wait` 或 `none`，在终端说明一次。
- Codex 账号第一次带 hook 启动前，打印一行信任提示，并记进 state，之后不再打印。

- [ ] 写测试（handoff-run.test.ts，用 `fakeHost` 扩展）：
  - 给 `fakeHost` 加选项 `onStart`：启动后执行一段脚本，模拟 hook 写 `ready.json`。只加选项，不改已有行为。
  - 假宿主写 `ready.json` 后，父进程发 SIGTERM，用正确的参数启动下一个账号：首条 prompt 只有路径，第二跳带 `--add-dir`。
  - 假宿主忽略 SIGTERM → 不启动下一个账号。
  - 选号结果为 `none` → 只启动了一跳。
  - 取消倒计时：用伪 TTY 输入换行 → 原账号带 `--resume <id>` 启动，环境里没有 `SIDEBY_HANDOFF_RUN`。
  - `handoff.auto` 为 false → 环境里没有 `HANDOFF_ENV` 变量，参数里没有 `--settings`。
- [ ] 写测试（cli.test.ts）：`sideby run` 在非 TTY 下不注入 hook。
- [ ] 跑测试，确认失败；实现；再跑，确认通过。
- [ ] 提交：`✨ feat(handoff): hand a running session to the next account`

### 任务 8：`sideby handoff ready|setup|teardown`

**文件**：改 `src/cli/main.ts`（命令表、HELP、`handoff` 分命令帮助）、`src/cli/commands.ts`、`src/cli/json-schemas.ts`；`schemas/`（`pnpm schemas`）；测试写进 `src/cli/cli.test.ts`。

**产出**：
- `sideby handoff ready [--brief <file>] [--json]`：只在有 `SIDEBY_HANDOFF_RUN` 的会话里可用。`--brief` 的文件复制进链目录，写 `request.json`。不在 sideby 会话里时退出 1，提示「set `handoff.auto` and start the account with sideby, or use `sideby next`」。
- `sideby handoff setup|teardown <family> [--yes] [--json]`：调用 `family.handoff.hookSetup`，规则同 `quota setup`：不带 `--yes` 时退出 10；`sideby` 不在 PATH 或来自 npx 缓存时拒绝。家族没有 `hookSetup` 时退出 1，说明这个家族不需要 setup。
- JSON schema：`handoff-ready`、`handoff-setup`。

- [ ] 写测试：ready 在会话外退出 1；ready 带 `--brief` 后，链目录里有副本和 `request.json`；setup 不带 `--yes` 退出 10，带上后在假 HOME 里写入，`diffSnapshots` 只多一个文件；teardown 后快照和 setup 前一致。
- [ ] 跑测试，确认失败；实现；再跑，确认通过；`pnpm schemas`。
- [ ] 提交：`✨ feat(cli): add sideby handoff ready, setup and teardown`

### 任务 9：Doctor 提醒

**文件**：改 `src/core/doctor.ts`；测试写进 doctor 已有的测试文件。

**产出**：三条 general warn，都只在 `handoff.auto` 为真时出现：
- `handoff.no-quota-tap`：有 Claude 账号，但 `quotaSetup.plan` 不是 `enabled`。hint 是 `sideby quota setup claude`。
- `handoff.setup-missing`：有 Grok 账号，但它的 `hooks/sideby-handoff.json` 不存在。hint 是 setup 或 `sideby doctor grok --fix`。
- `handoff.order-unknown`：`order` 里有解析不出的账号或短命令。

- [ ] 写测试：每条各一个出现的用例；`auto` 为 false 时一条都没有；Doctor 的退出码不变（warn 退出 0）。
- [ ] 跑测试，确认失败；实现；再跑，确认通过。
- [ ] 提交：`✨ feat(doctor): warn when auto handoff cannot work`

### 任务 10：文档与 skill

**文件**：`README.md`、`README.zh-CN.md`、`docs/guide/usage.md`、`docs/guide/usage.zh-CN.md`、`skills/sideby/SKILL.md`、新建 `skills/sideby/references/handoff.md`（已有就改）、`llms.txt`、`AGENTS.md`、spec §3.17（同步三处偏差和任务 1 的实测结果）。

- [ ] 两份 README 各加一句 Auto Handoff，带风险提示，指向 guide。
- [ ] guide 两种语言同步加「Auto Handoff」一节：配置示例；每个宿主能做到什么；Codex 每个账号要信任一次；Grok 要跑 setup，sandbox 有限制；MDM 缺口；同家族接力的风险。
- [ ] skill 的 reference：手动交接流程；委派时先用 `sideby next <family> --json` 找有余量的账号，再用 `sideby run <ref> -- -p "<task>"`，默认示例是同家族账号，并写明风险。
- [ ] `AGENTS.md` 不变量：Host directories 一节加 `handoff setup grok` 这个例外；hook 入口的 import 限制写进 `statusline-tap` 那一条；`sideby next` 那一条注明自动交接见 §3.17。
- [ ] `llms.txt`：加新命令和 config 键。
- [ ] 提交：`📝 docs(handoff): document auto handoff`

### 任务 11：总验收

- [ ] 跑 `pnpm check`，全部通过。
- [ ] 跑 `pnpm build`；`npm pack --dry-run` 里除了 `.d.ts` 没有 `.ts` 源码。
- [ ] 在 demo HOME（`normal`）里，用 `fakeHost` 跑一遍两跳交接，人工看终端输出是否清楚：倒计时、取消、没有可接账号三种情况。
- [ ] 独立审查：派一个只读 subagent 对照 spec §3.17 和本计划审查整条分支的 diff，修完再跑 `pnpm check`。
- [ ] ADR-0010 保持 proposed，直到用户跑完 verification 文档里需要登录的项。
- [ ] 提交前和用户确认，这次是否要 commit。
