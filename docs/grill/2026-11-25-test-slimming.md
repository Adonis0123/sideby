# Grill: test-slimming

- Date: 2026-11-25
- Pairing: Interviewer Claude Code, answers by the maintainer ("all as recommended")
- Rounds: 2; stopped because frontier empty
- Status: decided

## Plan

「先看看架构现状，然后分析一下原因，是不是测试用例太多了，我觉得可以精简一下」(CI 的 `pnpm check` 跑 5–7 分钟)

## Findings

- 169 test files, 2176 tests; 79% run under 50 ms each (14 s in total). Deleting small tests saves almost nothing.
- `src/cli/cli.test.ts` (3587 lines, about 430 CLI subprocesses) runs serially in one process: 107 s alone, against 117 s for the whole local suite; 377–401 s in CI.
- About 58 s are real waits: a missing fake clock in `network/hook.test.ts`, the `local-build` autostart wait, a 300-round lock stress loop.
- typecheck, lint and leak-check take under 2 s together.

## Decisions

| ID | Question | Decision |
| --- | --- | --- |
| Q1 | Metric | CI wall-clock under 5 min; local `pnpm check` under 3 min |
| Q2 | Invariant tests | Never deleted, only sped up |
| Q3 | Scope | Deleting/merging and speed-ups, ordered by time saved |
| Q4 | Deletion rule | One behaviour is tested in one layer; the CLI layer keeps a smoke test per command |
| Q5 | Split `cli.test.ts` | Split into 6–8 files by its top-level blocks, bodies unchanged, helpers in a non-test module |
| Q6 | Real waits | Pass the fake clock, make the fake `launchctl` report exit, lock stress 300 → 50 rounds (8 contenders kept) |
| Q7 | In-process CLI tests | Step 1 now: the parametrized error cases of `unattended-cli` and `history-cli`. `main()` taking env and io waits until CI is measured after Q5–Q6 |
| Q8 | CLI duplicates | Delete CLI detail tests of advisor, tune, next and remote-control that core tests already cover; keep one smoke test each |
| Q9 | CI matrix | Unchanged (jobs run in parallel; fewer jobs saves runner minutes, not waiting time) |
| Q10 | Keep it from growing back | AGENTS.md "Tests": CLI behaviour in-process first; split a test file that takes over about 15 s alone. No CI check |

## Follow-up

- CI still took about 5.5 minutes after Q5–Q8, so Q7 step 2 was done: `main()` takes optional output lines, and the CLI test helpers call it in-process (`runMain` in `src/cli/cli-test-helpers.ts`), keeping a subprocess smoke test per command (`sidebySpawn`). Local `pnpm test` went from about 131 s to about 50–85 s depending on load. No ADR: only `src/cli` and its tests changed, and no public contract.
