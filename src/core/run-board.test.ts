// WHY: Pure-logic unit tests for the Live Run Board reader, path boundary, stream/autoSteps parsers, pointer, hook, launch wiring, and `runs open`.
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Value } from 'typebox/value'
import { diffSnapshots, fakeHost, snapshot, withFakeHome } from '../../testing/index.ts'
import { parseArgs } from '../cli/args.ts'
import { cmdRuns } from '../cli/commands.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { panelOwner } from '../panel/server.ts'
import { runRunsHook } from '../runs/hook.ts'
import { createRuntime } from '../runtime.ts'
import type { ExecResult } from './desktop-app.ts'
import { UserError } from './errors.ts'
import type { LiveSession } from './live-sessions.ts'
import {
  findRunSummary,
  listRuns,
  parseLaneStream,
  readLiveRun,
  runCompactPointer,
  runWatchTargets,
} from './run-board.ts'
import { withClaudeSessionHooks } from './session-hooks.ts'

describe('run-board', () => {
  it('lists active runs before closed runs, caps closed list at 50, finds the 51st by id, and rejects missing/corrupt run.json', async () => {
    await withFakeHome(async (h) => {
      const dirActive = join(h.home, 'work/.agent-dispatch/runs/run-active')
      const dirCorrupt = join(h.home, 'work/.agent-dispatch/runs/run-corrupt')
      const dirMissing = join(h.home, 'work/.agent-dispatch/runs/run-missing')
      await mkdir(dirActive, { recursive: true })
      await mkdir(dirCorrupt, { recursive: true })
      await mkdir(dirMissing, { recursive: true })
      await writeFile(join(dirCorrupt, 'run.json'), '{not valid json')
      await writeFile(
        join(dirActive, 'run.json'),
        JSON.stringify({
          id: 'run-active',
          objective: 'Ship live board',
          state: 'active',
          created_at: '2026-11-26T09:00:00Z',
          updated_at: '2026-11-26T10:00:00Z',
          coordinator: 'claude:work',
          coordinator_session: 'sess-coord-1',
          steps: [
            { title: 'Step A', state: 'done' },
            { title: 'Step B', state: 'working' },
          ],
          lanes: [
            { id: 'l1', title: 'Worker 1', state: 'working' },
            { id: 'l2', title: 'Worker 2', state: 'done' },
          ],
          asks: [{ id: 'A1', state: 'open', question: 'Proceed?' }],
          waits: [{ id: 'w1', title: 'CI', state: 'running' }],
        }),
      )
      const registry: Record<string, unknown>[] = [
        { id: '../escape', dir: dirActive, objective: 'Bad id', state: 'active' },
        { id: 'run-active', dir: dirActive, objective: 'Ship live board', state: 'active' },
        { id: 'run-corrupt', dir: dirCorrupt, objective: 'Corrupt run', state: 'active' },
        { id: 'run-missing', dir: dirMissing, objective: 'Missing run', state: 'active' },
      ]
      for (let i = 1; i <= 51; i++) {
        const id = `closed-${String(i).padStart(2, '0')}`
        const d = join(h.home, `work/.agent-dispatch/archive/${id}`)
        await mkdir(d, { recursive: true })
        await writeFile(
          join(d, 'run.json'),
          JSON.stringify({
            id,
            objective: `Closed ${id}`,
            state: 'closed',
            updated_at: `2026-11-01T00:${String(i).padStart(2, '0')}:00Z`,
            lanes: [],
            asks: [],
            waits: [],
          }),
        )
        registry.push({ id, dir: d, objective: `Closed ${id}`, state: 'closed' })
      }
      await h.write('.local/state/agent-dispatch/runs.json', JSON.stringify(registry))

      const list = await listRuns(h.env, h.home)
      assert.equal(list.filter((r) => r.state === 'closed').length, 50)
      assert.equal(
        list.some((r) => r.id === 'closed-01'),
        false,
      )
      assert.equal(list[0]!.id, 'run-active')
      assert.equal(list[0]!.activeLanes, 1)
      assert.equal(list[0]!.totalLanes, 2)
      assert.equal(list[0]!.openAsks, 1)
      assert.equal(list[0]!.runningWaits, 1)
      assert.equal(list[0]!.stepsDone, 1)
      assert.equal(list[0]!.stepsTotal, 2)

      const oldest = await findRunSummary(h.env, h.home, 'closed-01')
      assert.equal(oldest?.id, 'closed-01')
      assert.equal(oldest?.state, 'closed')
      assert.equal(await findRunSummary(h.env, h.home, 'run-corrupt'), undefined)
      assert.equal(await findRunSummary(h.env, h.home, 'run-missing'), undefined)
    })
  })

  it('parses Claude/Codex/Grok streams and blocks wait logs or streams outside runDir including tmpdir files and symlinks', async () => {
    const claudeStream = [
      JSON.stringify({ type: 'system', session_id: 'sid-claude-1' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          usage: { input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 40 },
          content: [{ type: 'tool_use', name: 'Bash', input: { description: 'Run unit tests' } }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.42 }),
    ].join('\n')
    const c = parseLaneStream(claudeStream)
    assert.equal(c.sessionId, 'sid-claude-1')
    assert.equal(c.activity, 'Bash: Run unit tests')
    assert.equal(c.streamEnded, true)
    assert.equal(c.streamFailed, false)
    assert.equal(c.costUsd, 0.42)
    assert.deepEqual(c.tokens, { input: 600, output: 40 })

    const codexStream = [
      JSON.stringify({ type: 'thread.started', thread_id: 'thr-codex-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pnpm test' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1200, output_tokens: 300 } }),
    ].join('\n')
    const x = parseLaneStream(codexStream)
    assert.equal(x.sessionId, 'thr-codex-1')
    assert.equal(x.activity, 'Run: pnpm test')
    assert.equal(x.streamEnded, true)
    assert.deepEqual(x.tokens, { input: 1200, output: 300 })

    const grokStream = [
      JSON.stringify({ type: 'tool_call', toolName: 'edit_file', rawInput: { path: 'src/app.ts' } }),
      JSON.stringify({ type: 'end', stopReason: 'error' }),
    ].join('\n')
    const g = parseLaneStream(grokStream)
    assert.equal(g.activity, 'edit_file: src/app.ts')
    assert.equal(g.streamEnded, true)
    assert.equal(g.streamFailed, true)

    const otherTmpFile = join(tmpdir(), `sideby-other-task-${process.pid}-${Date.now()}.txt`)
    await writeFile(otherTmpFile, 'other task secret in tmp\n')
    try {
      await withFakeHome(async (h) => {
        const runDir = join(h.home, 'repo/.agent-dispatch/runs/r-bounds')
        await mkdir(join(runDir, 'logs'), { recursive: true })
        const okLog = join(runDir, 'logs/wait-ok.log')
        await writeFile(okLog, 'step 1\nwaiting on CI\n')
        const outsideLog = await h.write('private-notes/outside.log', 'secret outside line\n')
        const fakeCred = await h.write('.claude/fake-secret.json', '{"secret":"top-secret"}\n', 0o600)
        const linkedLog = join(runDir, 'linked-cred.log')
        const linkedStream = join(runDir, 'linked-stream.jsonl')
        await symlink(fakeCred, linkedLog)
        await symlink(fakeCred, linkedStream)
        await writeFile(
          join(runDir, 'run.json'),
          JSON.stringify({
            id: 'r-bounds',
            objective: 'Artifact boundary check',
            state: 'active',
            lanes: [{ id: 'l1', title: 'Linked', state: 'working', output: 'linked-stream.jsonl' }],
            asks: [],
            waits: [
              { id: 'w-ok', title: 'Valid log', state: 'running', log: 'logs/wait-ok.log' },
              { id: 'w-out', title: 'Outside file', state: 'running', log: outsideLog },
              { id: 'w-tmp', title: 'Other tmp file', state: 'running', log: otherTmpFile },
              { id: 'w-sym', title: 'Symlink cred', state: 'running', log: 'linked-cred.log' },
            ],
          }),
        )
        await h.write(
          '.local/state/agent-dispatch/runs.json',
          JSON.stringify([
            { id: 'r-bounds', dir: runDir, objective: 'Artifact boundary check', state: 'active' },
          ]),
        )

        const view = await readLiveRun(h.env, h.home, 'r-bounds')
        assert.ok(view)
        assert.equal(view.lanes[0]!.activity, undefined)
        assert.equal(view.waits.find((w) => w.id === 'w-ok')?.lastLine, 'waiting on CI')
        assert.equal(view.waits.find((w) => w.id === 'w-out')?.lastLine, undefined)
        assert.equal(view.waits.find((w) => w.id === 'w-tmp')?.lastLine, undefined)
        assert.equal(view.waits.find((w) => w.id === 'w-sym')?.lastLine, undefined)

        await writeFile(okLog, 'step 1\nstep 2 green\n')
        const updated = await readLiveRun(h.env, h.home, 'r-bounds')
        assert.equal(updated?.waits.find((w) => w.id === 'w-ok')?.lastLine, 'step 2 green')

        const targets = await runWatchTargets(h.env, h.home, 'r-bounds')
        assert.ok(targets.some((t) => t.dir.endsWith('/r-bounds/logs')))
        assert.equal(
          targets.some(
            (t) => t.dir.includes('private-notes') || t.dir.includes('.claude') || t.dir === tmpdir(),
          ),
          false,
        )
      })
    } finally {
      await rm(otherTmpFile, { force: true })
    }
  })

  it('auto-syncs agy update_steps and Claude TaskCreate/TaskUpdate past 256 KiB tail while discarding is_error TaskUpdates', async () => {
    await withFakeHome(async (h) => {
      const runAgy = join(h.home, 'repo/.agent-dispatch/runs/r-agy')
      const runClaude = join(h.home, 'repo/.agent-dispatch/runs/r-claude')
      await mkdir(runAgy, { recursive: true })
      await mkdir(runClaude, { recursive: true })
      await writeFile(
        join(runAgy, 'worker.jsonl'),
        `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Checking tests' }] } })}\n`,
      )
      await writeFile(
        join(runAgy, 'run.json'),
        JSON.stringify({
          id: 'r-agy',
          objective: 'Agy coordinated run',
          state: 'active',
          coordinator_session: 'agy-sess-1',
          lanes: [
            { id: 'l1', title: 'Impl', state: 'working', output: 'worker.jsonl', session: 'live-sid-1' },
          ],
          waits: [],
          asks: [],
        }),
      )
      await h.write(
        '.gemini/antigravity-cli/brain/agy-sess-1/.system_generated/logs/transcript.jsonl',
        `${JSON.stringify({
          created_at: '2026-11-26T12:00:00Z',
          tool_calls: [
            {
              name: 'update_steps',
              args: {
                steps: JSON.stringify([
                  { title: 'Design', status: 'done' },
                  { title: 'Build', status: 'in_progress' },
                ]),
              },
            },
          ],
        })}\n`,
      )

      await writeFile(
        join(runClaude, 'run.json'),
        JSON.stringify({
          id: 'r-claude',
          objective: 'Claude long transcript run',
          state: 'active',
          coordinator_session: 'claude-sess-1',
          lanes: [],
          waits: [],
          asks: [],
        }),
      )
      const headCreates = [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tu-1', name: 'TaskCreate', input: { subject: 'Old task 1' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'Task #1 created successfully' }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'tu-2', name: 'TaskCreate', input: { subject: 'Old task 2' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'Task #2 created successfully' }],
          },
        }),
      ]
      const filler = JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'x'.repeat(4000) }] },
      })
      const paddingLines = Array.from({ length: 75 }, () => filler)
      const tailEvents = [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-26T12:05:00Z',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-u1',
                name: 'TaskUpdate',
                input: { taskId: '1', status: 'completed' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-26T12:05:01Z',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu-u1', content: 'Updated task #1' }] },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-26T12:06:00Z',
          message: {
            content: [
              { type: 'tool_use', id: 'tu-3', name: 'TaskCreate', input: { subject: 'Task 3 live work' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-26T12:06:01Z',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tu-3',
                content: 'Task #3 created successfully: Task 3 live work',
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-26T12:06:02Z',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-u3-err',
                name: 'TaskUpdate',
                input: { taskId: '3', status: 'completed' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: '2026-11-26T12:06:03Z',
          message: {
            content: [
              { type: 'tool_result', tool_use_id: 'tu-u3-err', is_error: true, content: 'Update failed' },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-11-26T12:06:05Z',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-orphan',
                name: 'TaskCreate',
                input: { subject: 'Uncorrelated task' },
              },
            ],
          },
        }),
      ]
      await h.write(
        '.claude-work/projects/repo/claude-sess-1.jsonl',
        [...headCreates, ...paddingLines, ...tailEvents].join('\n'),
      )

      await h.write(
        '.local/state/agent-dispatch/runs.json',
        JSON.stringify([
          { id: 'r-agy', dir: runAgy, objective: 'Agy coordinated run', state: 'active' },
          { id: 'r-claude', dir: runClaude, objective: 'Claude long transcript run', state: 'active' },
        ]),
      )

      const fakeSessions: LiveSession[] = [
        {
          account: 'claude:work',
          accountLabel: 'cw',
          family: 'claude',
          sessionId: 'live-sid-1',
          title: 'Impl worker',
          label: 'cw · Impl worker · live-sid',
          status: 'busy',
          cwd: h.home,
          guessed: false,
          transcript: join(h.home, '.claude-work/projects/repo/live-sid-1.jsonl'),
          resumeCommand: 'sideby resume claude -- --resume live-sid-1',
          reference: 'ref',
        },
      ]

      const v1 = await readLiveRun(h.env, h.home, 'r-agy', { sessions: fakeSessions })
      assert.ok(v1)
      assert.equal(v1.autoSteps?.source, 'agy')
      assert.deepEqual(v1.autoSteps?.items, [
        { title: 'Design', state: 'done' },
        { title: 'Build', state: 'working' },
      ])
      assert.equal(v1.lanes[0]!.sessionStatus, 'busy')
      const v1Again = await readLiveRun(h.env, h.home, 'r-agy', { sessions: fakeSessions })
      assert.equal(v1.fingerprint, v1Again?.fingerprint)

      const v2 = await readLiveRun(h.env, h.home, 'r-claude')
      assert.ok(v2)
      assert.equal(v2.autoSteps?.source, 'claude')
      assert.deepEqual(v2.autoSteps?.items, [{ title: 'Task 3 live work', state: 'queued' }])
    })
  })

  it('wires runs-hook unconditionally on Claude launches even before agent-dispatch state exists, and injects pointer once a Run appears', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-work/settings.json', '{}')
      await fakeHost(h, 'claude')

      const beforeMain = await snapshot(h.path('.claude'))
      const beforeWork = await snapshot(h.path('.claude-work'))
      const rt = await createRuntime({ env: h.env })
      const p = await rt.prepareLaunch('claude:work', [], 'run')
      const at = p.args.indexOf('--settings')
      assert.ok(at >= 0, 'Claude launch includes --settings even before agent-dispatch exists')
      const settingsFile = p.args[at + 1]!
      const settings = JSON.parse(await readFile(settingsFile, 'utf8')) as {
        hooks: { SessionStart?: { matcher?: string; hooks: { command: string }[] }[] }
      }
      assert.equal(settings.hooks.SessionStart?.length, 1)
      assert.equal(settings.hooks.SessionStart?.[0]?.matcher, 'compact')
      assert.match(
        settings.hooks.SessionStart?.[0]?.hooks[0]?.command ?? '',
        /runs-hook claude SessionStart$/,
      )
      assert.deepEqual(diffSnapshots(beforeMain, await snapshot(h.path('.claude'))), [])
      assert.deepEqual(diffSnapshots(beforeWork, await snapshot(h.path('.claude-work'))), [])
      assert.equal((await rt.prepareLaunch('claude:work', [], 'login')).args.includes('--settings'), false)

      const handoff = await h.write('state/handoff.json', JSON.stringify({ hooks: {} }))
      const mergedArgs = await withClaudeSessionHooks(['--settings', handoff], p.sessionHookArgs!)
      const mergedSettings = JSON.parse(
        await readFile(mergedArgs[mergedArgs.indexOf('--settings') + 1]!, 'utf8'),
      ) as {
        hooks: { SessionStart?: { matcher?: string }[] }
      }
      assert.equal(mergedSettings.hooks.SessionStart?.[0]?.matcher, 'compact')

      const cwd = join(h.home, 'proj')
      let emptyOut = ''
      assert.equal(
        await runRunsHook(
          ['claude', 'SessionStart'],
          h.env,
          JSON.stringify({ session_id: 'coord-ptr', cwd, source: 'compact' }),
          { out: { write: (s) => (emptyOut += s) } },
        ),
        0,
      )
      assert.equal(emptyOut, '')

      const runDir = join(cwd, '.agent-dispatch/runs/r-ptr')
      await mkdir(runDir, { recursive: true })
      await writeFile(
        join(runDir, 'run.json'),
        JSON.stringify({
          id: 'r-ptr',
          objective: 'Pointer test',
          state: 'active',
          coordinator_session: 'coord-ptr',
          steps: [{ title: 'Implement', state: 'working' }],
          lanes: [{ id: 'w1', title: 'Writer', state: 'working' }],
          asks: [{ id: 'A1', state: 'open', question: 'Confirm?' }],
          waits: [],
        }),
      )
      await h.write(
        '.local/state/agent-dispatch/runs.json',
        JSON.stringify([{ id: 'r-ptr', dir: runDir, objective: 'Pointer test', state: 'active' }]),
      )

      const ptr = await runCompactPointer(h.env, h.home, { sessionId: 'coord-ptr' })
      assert.equal(ptr.runs.length, 1)
      assert.ok(ptr.text.split('\n').length <= 3)
      assert.match(ptr.text, /http:\/\/127\.0\.0\.1:17420\/runs\/r-ptr/)

      let hookOut = ''
      assert.equal(
        await runRunsHook(
          ['claude', 'SessionStart'],
          h.env,
          JSON.stringify({ session_id: 'coord-ptr', cwd, source: 'compact' }),
          { out: { write: (s) => (hookOut += s) } },
        ),
        0,
      )
      const parsedHook = JSON.parse(hookOut) as { hookSpecificOutput: { additionalContext: string } }
      assert.match(parsedHook.hookSpecificOutput.additionalContext, /Run r-ptr/)

      let hookIgnored = ''
      assert.equal(
        await runRunsHook(
          ['claude', 'SessionStart'],
          h.env,
          JSON.stringify({ session_id: 'coord-ptr', cwd, source: 'startup' }),
          { out: { write: (s) => (hookIgnored += s) } },
        ),
        0,
      )
      assert.equal(hookIgnored, '')

      const runCli = async (argv: string[]) => {
        const out: string[] = []
        const code = await cmdRuns(
          parseArgs(argv, ['json'], ['session', 'cwd']),
          { out: (s) => out.push(s), err: () => {} },
          rt,
        )
        return { code, out: out.join('\n') }
      }
      assert.ok(Value.Check(OUTPUT_SCHEMAS.runs!, JSON.parse((await runCli(['--json'])).out)))
      assert.ok(
        Value.Check(OUTPUT_SCHEMAS['runs-detail']!, JSON.parse((await runCli(['r-ptr', '--json'])).out)),
      )
      assert.ok(
        Value.Check(
          OUTPUT_SCHEMAS['runs-pointer']!,
          JSON.parse((await runCli(['pointer', '--cwd', cwd, '--json'])).out),
        ),
      )
    })
  })

  it('verifies loopback-only Panel port, tampered PID url rejection, opener failure, static board TOCTOU, missing run.json, and >50 closed lookup in `runs open`', async () => {
    await withFakeHome(async (h) => {
      const registry: Record<string, unknown>[] = []
      for (let i = 1; i <= 51; i++) {
        const id = `old-${String(i).padStart(2, '0')}`
        const d = join(h.home, `work/.agent-dispatch/archive/${id}`)
        await mkdir(d, { recursive: true })
        await writeFile(
          join(d, 'run.json'),
          JSON.stringify({ id, objective: `Run ${id}`, state: 'closed', lanes: [], asks: [], waits: [] }),
        )
        registry.push({ id, dir: d, objective: `Run ${id}`, state: 'closed' })
      }
      const corruptDir = join(h.home, 'work/.agent-dispatch/runs/corrupt-run')
      await mkdir(corruptDir, { recursive: true })
      await writeFile(join(corruptDir, 'run.json'), '{broken')
      registry.push({ id: 'corrupt-run', dir: corruptDir, objective: 'Corrupt', state: 'active' })
      await h.write('.local/state/agent-dispatch/runs.json', JSON.stringify(registry))

      const calls: string[][] = []
      let failOpen = false
      const exec = async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
        calls.push([cmd, ...args])
        if (failOpen) return { code: 1, stdout: '', stderr: 'open failed' }
        return { code: 0, stdout: '', stderr: '' }
      }
      const rt = await createRuntime({ env: h.env, desktop: { platform: 'darwin', exec } })
      const runOpen = async (id: string, deps: Parameters<typeof cmdRuns>[3]) => {
        const out: string[] = []
        const code = await cmdRuns(
          parseArgs(['open', id, '--json'], ['json'], ['session', 'cwd']),
          { out: (s) => out.push(s), err: () => {} },
          rt,
          deps,
        )
        return { code, out: out.join('\n') }
      }

      await assert.rejects(
        runOpen('corrupt-run', { findPanelPort: async () => 17420, probeLiveBoard: async () => true }),
        (e: unknown) => e instanceof UserError && e.code === 'not-found',
      )

      const fakePanel = createServer((req, res) => {
        if (req.url === '/api/health') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ app: 'sideby', version: '0.48.0', owner: panelOwner(h.home) }))
          return
        }
        if (req.url === '/runs/old-01') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end()
          return
        }
        res.writeHead(404)
        res.end()
      })
      await new Promise<void>((r) => fakePanel.listen(0, '127.0.0.1', r))
      const panelPort = (fakePanel.address() as AddressInfo).port
      try {
        await h.write(
          '.local/state/sideby/panel.json',
          JSON.stringify({
            pid: 999999,
            port: panelPort,
            url: 'http://evil.example/hijacked',
            startedAt: '2026-11-26T10:00:00Z',
            instance: 'tampered',
          }),
        )
        const probedUrls: string[] = []
        const openedLive = await runOpen('old-01', {
          defaultPort: panelPort,
          probeLiveBoard: async (url) => {
            probedUrls.push(url)
            const r = await fetch(url, { method: 'HEAD' })
            return r.status === 200
          },
        })
        assert.equal(openedLive.code, 0)
        const liveData = JSON.parse(openedLive.out) as Record<string, unknown>
        assert.equal(liveData.url, `http://127.0.0.1:${panelPort}/runs/old-01`)
        assert.deepEqual(probedUrls, [`http://127.0.0.1:${panelPort}/runs/old-01`])
        assert.deepEqual(calls, [['/usr/bin/open', `http://127.0.0.1:${panelPort}/runs/old-01`]])
        assert.equal(
          probedUrls.some((u) => u.includes('evil.example')),
          false,
        )
      } finally {
        await new Promise<void>((r) => fakePanel.close(() => r()))
      }
      calls.length = 0

      await assert.rejects(
        runOpen('old-01', { findPanelPort: async () => 17420, probeLiveBoard: async () => false }),
        (e: unknown) => e instanceof UserError && e.code === 'board-unavailable',
      )
      await assert.rejects(
        runOpen('old-01', { findPanelPort: async () => undefined }),
        (e: unknown) => e instanceof UserError && e.code === 'board-unavailable',
      )

      failOpen = true
      await assert.rejects(
        runOpen('old-01', { findPanelPort: async () => 17420, probeLiveBoard: async () => true }),
        (e: unknown) => e instanceof UserError && e.code === 'open-failed',
      )
      failOpen = false
      calls.length = 0

      const board = await h.write(
        '.local/state/agent-dispatch/boards/old-01.html',
        '<!doctype html>\n',
        0o600,
      )
      const fallback = await runOpen('old-01', {
        findPanelPort: async () => 17420,
        probeLiveBoard: async () => false,
      })
      assert.equal(fallback.code, 0)
      const fbData = JSON.parse(fallback.out) as Record<string, unknown>
      assert.ok(Value.Check(OUTPUT_SCHEMAS['runs-open']!, fbData))
      assert.equal(fbData.source, 'static')
      assert.equal(fbData.opened, true)
      assert.deepEqual(calls, [['/usr/bin/open', board]])

      calls.length = 0
      await assert.rejects(
        runOpen('old-01', {
          findPanelPort: async () => undefined,
          beforeOpenStatic: async () => {
            await rm(board)
            await writeFile(board, '<!doctype html><p>swapped</p>\n', { mode: 0o600 })
          },
        }),
        (e: unknown) => e instanceof UserError && e.code === 'board-changed',
      )
      assert.deepEqual(calls, [])

      const outsideHtml = await h.write('outside.html', '<!doctype html>\n')
      await symlink(outsideHtml, join(h.path('.local/state/agent-dispatch/boards'), 'old-02.html'))
      await assert.rejects(
        runOpen('old-02', { findPanelPort: async () => undefined }),
        (e: unknown) => e instanceof UserError && e.code === 'board-unavailable',
      )
      assert.deepEqual(calls, [])

      const boardsDir = h.path('.local/state/agent-dispatch/boards')
      const realOther = await h.write('other-boards/old-03.html', '<!doctype html>\n')
      await rm(boardsDir, { recursive: true })
      await symlink(join(h.home, 'other-boards'), boardsDir)
      assert.ok(realOther)
      await assert.rejects(
        runOpen('old-03', { findPanelPort: async () => undefined }),
        (e: unknown) => e instanceof UserError && e.code === 'board-unavailable',
      )
      assert.deepEqual(calls, [])
    })
  })
})
