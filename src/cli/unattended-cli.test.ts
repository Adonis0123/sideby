// `sideby unattended …` and `--unattended` end to end (spec §3.37), as real child processes against a fake HOME and
// fake Host binaries: JSON output against its schema, errors that say what to do, undo commands that run, the hook
// entry, and a plugin that gets `unattended.ended`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import {
  diffSnapshots,
  type FakeHome,
  fakeHost,
  readHostLog,
  snapshot,
  withFakeHome,
} from '../../testing/index.ts'
import { UserError } from '../core/errors.ts'
import { resolvePaths } from '../core/paths.ts'
import { addPendingDecision } from '../core/unattended-pending.ts'
import { parseArgs, UsageError } from './args.ts'
import { runMain, spawnMain } from './cli-test-helpers.ts'
import { cmdUnattended } from './commands.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

async function cli(
  h: FakeHome,
  args: string[],
  extra: { input?: string; env?: Record<string, string> } = {},
) {
  const r = await runMain(args, { env: { ...h.env, ...extra.env }, input: extra.input ?? '' })
  return { status: r.code, stdout: r.out, stderr: r.err }
}
async function cliSpawn(h: FakeHome, args: string[], extra: { input?: string } = {}) {
  const r = await spawnMain(args, { env: h.env, input: extra.input ?? '' })
  return { status: r.code, stdout: r.out, stderr: r.err }
}

/**
 * `sideby unattended <args>` in this process, with the fake HOME as process.env (cmdUnattended builds its own
 * Runtime). main() exits 2 for the UsageError it may reject with and 1 for any other error.
 */
async function inProcess(h: FakeHome, args: string[]): Promise<number> {
  const env = process.env
  process.env = { ...h.env } as NodeJS.ProcessEnv
  try {
    const parsed = parseArgs(
      args,
      ['json', 'all', 'slot-end', 'replied', 'help'],
      ['for', 'until', 'days', 'from', 'to', 'name', 'at', 'project', 'ids'],
    )
    return await cmdUnattended(parsed, { out: () => {}, err: () => {} })
  } finally {
    process.env = env
  }
}

const usageMatching = (re: RegExp) => (e: unknown) => e instanceof UsageError && re.test(e.message)

async function json(h: FakeHome, args: string[], schema = 'unattended', env: Record<string, string> = {}) {
  const r = await cli(h, ['unattended', ...args, '--json'], { env })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  const value = JSON.parse(r.stdout)
  // Checked on a second parse, so the guard does not narrow `value` to the schema's static type (unknown).
  assert.ok(
    Value.Check(OUTPUT_SCHEMAS[schema]!, JSON.parse(r.stdout)),
    `${schema}: ${JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS[schema]!, value)].slice(0, 3))}`,
  )
  return value
}

describe('sideby unattended', () => {
  it('shows the state, turns it on for a while and off, with JSON that matches its schema', async () => {
    await withFakeHome(async (h) => {
      const first = await json(h, [])
      assert.equal(first.on, false)
      assert.equal(first.configured, false)
      assert.equal(first.coverage.claude, 'not-covered')
      const on = await json(h, ['on', '--for', '60m'])
      assert.equal(on.on, true)
      assert.equal(on.reason, 'manual')
      assert.equal(on.changed, true)
      assert.equal(on.undo, 'sideby unattended off')
      assert.equal(on.coverage.claude, 'covered')
      assert.equal(on.coverage.codex, 'needs-trust')
      assert.equal(on.coverage.grok, 'not-covered')
      assert.ok(Date.parse(on.until) > Date.now() + 59 * 60 * 1000)
      assert.equal((await json(h, ['status'])).on, true)
      const off = await json(h, ['off'])
      assert.equal(off.on, false)
      assert.match(off.undo, /^sideby unattended on --until /)
      const human = await cli(h, ['unattended'])
      assert.equal(human.status, 0)
      assert.match(human.stdout, /Unattended Mode: off/)
      assert.match(human.stdout, /Covers Claude sessions sideby starts/)
    })
  })

  it('refuses times and options it does not take, saying what to use (exit 2)', async () => {
    await withFakeHome(async (h) => {
      const r = await cliSpawn(h, ['unattended', 'on', '--for', '73h', '--json'])
      assert.equal(r.status, 2, `${r.stdout}${r.stderr}`)
      const out = JSON.parse(r.stdout)
      assert.equal(out.schemaVersion, 1)
      assert.equal(out.code, 'usage')
      assert.match(out.error, /use|choose|run|add|give|usage/i)
      for (const args of [
        ['on', '--for', '0h'],
        ['on', '--until', '2020-01-01T00:00:00Z'],
        ['on', '--until', 'not-a-time'],
        ['on', '--slot-end'],
        ['on', '--for', '1h', '--until', '12:00'],
        ['off', '--for', '1h'],
        ['schedule', 'remove', '0'],
        ['schedule', 'add', '--days', 'bad', '--from', '23:00', '--to', '08:00'],
        ['schedule', 'add', '--days', 'mon', '--from', '24:00', '--to', '08:00'],
        ['schedule', 'preset', 'mornings'],
        ['pending', 'done'],
        ['pending', 'done', 'x', '--all'],
        ['defer'],
        ['nap'],
        ['wait', '0'],
        ['wait', '121'],
        ['wait', '5m'],
        ['wait', '10', '20'],
      ])
        await assert.rejects(
          inProcess(h, [...args, '--json']),
          usageMatching(/use|choose|run|add|give|usage/i),
          args.join(' '),
        )
      // A Slot or a decision that is not there is not a malformed command line: exit 1, with what to do.
      const notUsage = (re: RegExp) => (e: unknown) =>
        e instanceof UserError && !(e instanceof UsageError) && re.test(e.message)
      await assert.rejects(inProcess(h, ['pending', 'done', 'abcdefgh', '--json']), notUsage(/pending --all/))
      await assert.rejects(inProcess(h, ['schedule', 'remove', '1']), notUsage(/schedule add/))
    })
  })

  it('sets how long a question waits for you (Answer Wait), with an undo that runs', async () => {
    await withFakeHome(async (h) => {
      // 10 minutes until someone changes it, also before the feature is set up.
      assert.equal((await json(h, [])).answerWait, 10)
      const set = await json(h, ['wait', '30'])
      assert.deepEqual(
        [set.answerWait, set.changed, set.undo, set.configured],
        [30, true, 'sideby unattended wait 10', true],
      )
      assert.equal((await json(h, ['wait', '30'])).changed, false)
      const off = await json(h, ['wait', 'off'])
      assert.deepEqual([off.answerWait, off.undo], [null, 'sideby unattended wait 30'])
      const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.equal(config.unattended.answerWait, false)
      const undo = spawnSync('/bin/sh', ['-c', off.undo.replace(/^sideby /, '"$NODE" "$MAIN" ')], {
        env: { ...h.env, NODE: process.execPath, MAIN } as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 30_000,
      })
      assert.equal(undo.status, 0, undo.stdout + undo.stderr)
      assert.equal((await json(h, ['wait'])).answerWait, 30)
      const human = await cli(h, ['unattended', 'wait'])
      assert.match(human.stdout, /after 30 minutes with Unattended Mode on, the session goes on/)
      assert.match((await cli(h, ['unattended'])).stdout, /If nobody answers: after 30 minutes/)
      // What went on without an answer says how long it waited.
      await addPendingDecision(resolvePaths(h.env).stateDir, {
        kind: 'question',
        family: 'claude',
        account: 'claude:work',
        sessionId: 's1',
        text: 'Which framework should I use?',
        waited: 30,
      })
      assert.equal((await json(h, ['pending'], 'unattended-pending')).pending[0].waited, 30)
      assert.match((await cli(h, ['unattended', 'pending'])).stdout, /question · no answer for 30 min/)
    })
  })

  it('edits the Schedule and prints an undo command that runs', async () => {
    await withFakeHome(async (h) => {
      const added = await json(h, [
        'schedule',
        'add',
        '--days',
        'fri-mon',
        '--from',
        '23:00',
        '--to',
        '8:00',
        '--name',
        "A user's Slot",
      ])
      assert.deepEqual(added.schedule[0].days, ['mon', 'fri', 'sat', 'sun'])
      assert.equal(added.schedule[0].end, '08:00')
      assert.equal((await json(h, ['schedule', 'preset', 'weeknights'])).schedule.length, 2)
      const again = await json(h, ['schedule', 'preset', 'weeknights'])
      assert.equal(again.changed, false)
      assert.equal(again.schedule.length, 2)
      const removed = await json(h, ['schedule', 'remove', '1'])
      assert.deepEqual(
        removed.schedule.map((s: { name: string }) => s.name),
        ['Weeknights'],
      )
      const undo = spawnSync('/bin/sh', ['-c', removed.undo.replace(/^sideby /, '"$NODE" "$MAIN" ')], {
        env: { ...h.env, NODE: process.execPath, MAIN } as NodeJS.ProcessEnv,
        encoding: 'utf8',
        timeout: 30_000,
      })
      assert.equal(undo.status, 0, undo.stdout + undo.stderr)
      const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
      assert.deepEqual(
        config.unattended.schedule.map((s: { name: string }) => s.name),
        ["A user's Slot", 'Weeknights'],
      )
      const human = await cli(h, ['unattended', 'schedule'])
      assert.match(human.stdout, /1\. A user's Slot {2}fri-mon 23:00-08:00 \(next day\)/)
    })
  })

  it('keeps what a session defers, with its account and session, and marks decisions done', async () => {
    await withFakeHome(async (h) => {
      const env = { SIDEBY_ACCOUNT: 'claude:work', CLAUDE_CODE_SESSION_ID: 's1' }
      const one = (await json(h, ['defer', 'deleting', 'the', 'old', 'branch'], 'unattended-defer', env))
        .decision
      assert.equal(one.text, 'deleting the old branch')
      assert.equal(one.family, 'claude')
      assert.equal(one.account, 'claude:work')
      assert.equal(one.sessionId, 's1')
      assert.equal(one.kind, 'deferred')
      await json(h, ['defer', 'deploy'], 'unattended-defer', { CODEX_THREAD_ID: 't1' })
      const listed = (await json(h, ['pending'], 'unattended-pending')).pending
      assert.equal(listed.length, 2)
      assert.equal(listed[1].family, 'codex')
      assert.equal((await json(h, [])).pending, 2)
      const done = await json(h, ['pending', 'done', one.id], 'unattended-pending')
      assert.deepEqual(done.done, [one.id])
      assert.equal(done.pending.length, 1)
      await json(h, ['pending', 'done', '--all'], 'unattended-pending')
      assert.equal((await json(h, ['pending'], 'unattended-pending')).pending.length, 0)
      assert.ok(
        (await json(h, ['pending', '--all'], 'unattended-pending')).pending.every(
          (d: { doneAt?: string }) => d.doneAt,
        ),
      )
      const human = await cli(h, ['unattended', 'pending'])
      assert.match(human.stdout, /Nothing is waiting for you/)
    })
  })

  it('lists decisions by project with what the user wrote in afterwards, marks and reopens them (ADR-0078)', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.mkdir('code/shop/.git')
      await h.mkdir('code/shop/web')
      await h.mkdir('code/blog')
      const state = resolvePaths(h.env).stateDir
      const base = Date.now() - 2 * 60 * 60_000
      const at = (m: number) => new Date(base + m * 60_000)
      const sid = (n: number) => `5e55000${n}-0000-4000-8000-00000000000${n}`
      const human = (s: string, m: number, text: string) =>
        JSON.stringify({
          type: 'user',
          sessionId: s,
          timestamp: at(m).toISOString(),
          origin: { kind: 'human' },
          message: { role: 'user', content: text },
        })
      // shop: the user replied in session 1; session 2 got nothing after its decision. blog: replied too.
      await h.write(`.claude/projects/-code-shop/${sid(1)}.jsonl`, `${human(sid(1), 20, 'Ship it.')}\n`)
      await h.write(`.claude/projects/-code-shop/${sid(2)}.jsonl`, `${human(sid(2), 0, 'Start.')}\n`)
      await h.write(`.claude/projects/-code-blog/${sid(3)}.jsonl`, `${human(sid(3), 30, 'Publish it.')}\n`)
      const keep = (n: number, cwd: string) =>
        addPendingDecision(
          state,
          {
            kind: 'question',
            family: 'claude',
            account: 'claude:main',
            sessionId: sid(n),
            cwd: h.path(cwd),
            text: `Q${n}?`,
          },
          at(10),
        )
      const shopReplied = await keep(1, 'code/shop')
      const shopOpen = await keep(2, 'code/shop/web')
      const blogReplied = await keep(3, 'code/blog')

      const listed = await json(h, ['pending'], 'unattended-pending')
      const by = (id: string) => listed.pending.find((d: { id: string }) => d.id === id)
      assert.deepEqual([by(shopReplied.id).state, by(shopReplied.id).projectName], ['replied', 'shop'])
      assert.equal(by(shopReplied.id).repliedAt, at(20).toISOString())
      assert.deepEqual([by(shopOpen.id).state, by(shopOpen.id).project], ['open', h.path('code/shop')])
      assert.equal(by(blogReplied.id).state, 'replied')
      assert.deepEqual(listed.projects, [
        { project: h.path('code/shop'), projectName: 'shop', open: 1, replied: 1, done: 0 },
        { project: h.path('code/blog'), projectName: 'blog', open: 0, replied: 1, done: 0 },
      ])
      const blogOnly = await json(h, ['pending', '--project', 'blog'], 'unattended-pending')
      assert.deepEqual(
        blogOnly.pending.map((d: { id: string }) => d.id),
        [blogReplied.id],
      )
      const text = (await cli(h, ['unattended', 'pending'])).stdout
      assert.match(text, /shop\s+1 untouched · 1 you wrote in afterwards/)
      assert.match(text, /you wrote in the session afterwards \(\d+[mhd] ago\)/)
      assert.ok(text.indexOf(shopOpen.id) < text.indexOf(shopReplied.id), 'open ones first')
      // Writing in the session afterwards is not finishing it: the hint marks checked ones, never all replied ones.
      assert.doesNotMatch(text, /done --replied|probably/)
      assert.match(text, /not that it was finished/)
      assert.match(text, /reopen <id>/)

      // Only the replied one of shop.
      const done = await json(h, ['pending', 'done', '--replied', '--project', 'shop'], 'unattended-pending')
      assert.deepEqual(done.done, [shopReplied.id])
      assert.deepEqual(
        done.pending.map((d: { id: string }) => d.id).sort(),
        [shopOpen.id, blogReplied.id].sort(),
      )
      // Then the rest of shop, and the replied ones anywhere.
      assert.deepEqual((await json(h, ['pending', 'done', '--project', 'shop'], 'unattended-pending')).done, [
        shopOpen.id,
      ])
      assert.deepEqual((await json(h, ['pending', 'done', '--replied'], 'unattended-pending')).done, [
        blogReplied.id,
      ])
      assert.match((await cli(h, ['unattended', 'pending', 'done', '--replied'])).stdout, /Nothing to mark/)

      // Reopen one marked by mistake; a list reopens only the done ones and says which.
      const back = await json(h, ['pending', 'reopen', shopReplied.id], 'unattended-pending')
      assert.deepEqual(back.reopened, [shopReplied.id])
      assert.ok(
        back.pending.some(
          (d: { id: string; state: string }) => d.id === shopReplied.id && d.state === 'replied',
        ),
      )
      const both = await json(
        h,
        ['pending', 'reopen', '--ids', `${shopReplied.id},${shopOpen.id}`],
        'unattended-pending',
      )
      assert.deepEqual(both.reopened, [shopOpen.id])
      assert.match(
        (await cli(h, ['unattended', 'pending', 'reopen', shopOpen.id])).stdout,
        /Nothing to reopen/,
      )
      // --ids marks only the ones still open; the text answer reads no session record and names reopen.
      const marked = await json(
        h,
        ['pending', 'done', '--ids', `${shopOpen.id},${blogReplied.id}`],
        'unattended-pending',
      )
      assert.deepEqual(marked.done, [shopOpen.id])
      const said = (await cli(h, ['unattended', 'pending', 'done', shopReplied.id])).stdout
      assert.match(said, /marked 1 decision done; 0 still open/)
      assert.match(said, /reopen <id>/)
      const none = (await cli(h, ['unattended', 'pending', 'done', '--ids', shopOpen.id])).stdout
      assert.match(none, /Nothing to mark: those are done already/)

      for (const args of [
        ['reopen'],
        ['reopen', shopOpen.id, '--ids', shopOpen.id],
        ['done', '--ids', ','],
        ['done', shopOpen.id, '--ids', shopOpen.id],
        ['done', '--all', '--replied'],
        ['done', shopOpen.id, '--project', 'shop'],
        ['done'],
        ['done', '--project', 'nope'],
        ['--project', ''],
      ])
        await assert.rejects(
          inProcess(h, ['pending', ...args]),
          usageMatching(/usage|project|--ids/),
          args.join(' '),
        )
    })
  })

  it('refuses a question and a permission request through the real hook entry while on, and goes silent when off', async () => {
    await withFakeHome(async (h) => {
      await json(h, ['on', '--for', '1h'])
      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
        session_id: 's1',
        cwd: '/tmp',
      })
      const refused = await cliSpawn(h, ['unattended-hook', 'claude', 'PreToolUse'], { input })
      assert.equal(refused.status, 2)
      assert.equal(refused.stdout, '')
      assert.match(refused.stderr, /recommended option/)
      const [d] = (await json(h, ['pending'], 'unattended-pending')).pending
      assert.equal(d.sessionId, 's1')
      assert.equal(d.text, 'Which?\n- A\n- B')
      // A permission request is answered on stdout, which Claude Code reads once the process has exited.
      const request = JSON.stringify({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf build' },
        session_id: 's1',
        agent_id: 'a1',
        agent_type: 'general-purpose',
      })
      const denied = await cliSpawn(h, ['unattended-hook', 'claude', 'PermissionRequest'], { input: request })
      assert.equal(denied.status, 0)
      assert.equal(denied.stderr, '')
      assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.decision.behavior, 'deny')
      const kept = (await json(h, ['pending'], 'unattended-pending')).pending
      assert.deepEqual(
        kept.map((x: { kind: string; agentType?: string }) => [x.kind, x.agentType]),
        [
          ['question', undefined],
          ['permission', 'general-purpose'],
        ],
      )
      await json(h, ['off'])
      const allowed = await cliSpawn(h, ['unattended-hook', 'claude', 'PreToolUse'], { input })
      assert.equal(allowed.status, 0)
      assert.equal(allowed.stdout + allowed.stderr, '')
      const prompt = await cliSpawn(h, ['unattended-hook', 'claude', 'PermissionRequest'], { input: request })
      assert.equal(prompt.status, 0)
      assert.equal(prompt.stdout + prompt.stderr, '')
    })
  })

  it('tells a plugin once when a stretch ends', async () => {
    await withFakeHome(async (h) => {
      const out = h.path('ended.jsonl')
      await h.write('plugins/notify/plugin.json', JSON.stringify({ name: 'notify', version: '1.0.0' }))
      await h.write(
        'plugins/notify/index.ts',
        `import { appendFile } from 'node:fs/promises'
export default { name: 'notify', register(api) {
  api.on('unattended.ended', (ctx) => appendFile(${JSON.stringify(out)}, JSON.stringify(ctx) + '\\n'))
} }
`,
      )
      await h.write('.config/sideby/config.json', JSON.stringify({ pluginDirs: ['~/plugins/notify'] }))
      await json(h, ['on', '--for', '1h'])
      await json(h, ['defer', 'left the release for the user'], 'unattended-defer')
      await json(h, ['off'])
      assert.equal((await cli(h, ['unattended'])).status, 0)
      const lines = (await readFile(out, 'utf8')).trim().split('\n')
      assert.equal(lines.length, 1)
      const ctx = JSON.parse(lines[0]!)
      assert.equal(ctx.reason, 'manual')
      assert.equal(ctx.pending.length, 1)
      assert.equal(ctx.pending[0].text, 'left the release for the user')
      assert.ok(Date.parse(ctx.endedAt) >= Date.parse(ctx.startedAt))
    })
  })
})

describe('--unattended', () => {
  it('starts one session as unattended, also through a short command, writing nothing into the account', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-001/settings.json', '{}')
      await fakeHost(h, 'claude')
      const before = await snapshot(h.path('.claude-001'))
      const r = await cli(h, ['run', 'claude:001', '--unattended', '--', 'hello'])
      assert.equal(r.status, 0, r.stderr)
      const [rec] = await readHostLog(h, 'claude')
      assert.equal(rec?.env.SIDEBY_UNATTENDED, '1')
      const at = rec!.argv.indexOf('--settings')
      assert.ok(at >= 0)
      assert.match(rec!.argv[at + 1]!, /\/unattended\/claude-settings\.json$/)
      assert.ok(!rec!.argv.includes('--unattended'))
      assert.ok(rec!.argv.includes('hello'))
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude-001'))), [])
      // A short command passes its arguments after `--`, as its shell function does.
      assert.equal((await cli(h, ['alias', 'add', 'cc1', 'claude:001'])).status, 0)
      assert.equal((await cli(h, ['run', 'cc1', '--', '--unattended'])).status, 0)
      const second = (await readHostLog(h, 'claude'))[1]
      assert.equal(second?.env.SIDEBY_UNATTENDED, '1')
      assert.ok(!second!.argv.includes('--unattended'))
      // Without it, and before the feature is used, the session gets nothing.
      assert.equal((await cli(h, ['run', 'claude:001'])).status, 0)
      const third = (await readHostLog(h, 'claude'))[2]
      assert.equal(third?.env.SIDEBY_UNATTENDED, undefined)
      assert.ok(!third!.argv.includes('--settings'))
    })
  })

  it('previews (exit 10), applies (--yes), and tears down agy Unattended Mode hooks (ADR-0089)', async () => {
    await withFakeHome(async (h) => {
      await fakeHost(h, 'sideby')
      const preview = await cli(h, ['unattended', 'setup', 'agy', '--json'])
      assert.equal(preview.status, 10, preview.stderr)
      const pBody = JSON.parse(preview.stdout) as { applied: boolean; plan: { status: string } }
      assert.equal(pBody.applied, false)
      assert.equal(pBody.plan.status, 'ready')

      const applied = await cli(h, ['unattended', 'setup', 'agy', '--yes', '--json'])
      assert.equal(applied.status, 0, applied.stderr)
      assert.equal(JSON.parse(applied.stdout).applied, true)

      const st = await json(h, ['status'])
      assert.equal((st.coverage as Record<string, string>).agy, 'covered')
      assert.equal((st.agySetup as { status: string }).status, 'enabled')

      const torn = await cli(h, ['unattended', 'teardown', 'agy', '--json'])
      assert.equal(torn.status, 0, torn.stderr)
      assert.equal(JSON.parse(torn.stdout).ok, true)
      const after = await json(h, ['status'])
      assert.equal((after.coverage as Record<string, string>).agy, 'not-covered')
    })
  })
})
