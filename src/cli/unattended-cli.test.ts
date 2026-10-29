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
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))

function cli(h: FakeHome, args: string[], extra: { input?: string; env?: Record<string, string> } = {}) {
  return spawnSync(process.execPath, [MAIN, ...args], {
    env: { ...h.env, ...extra.env } as NodeJS.ProcessEnv,
    encoding: 'utf8',
    input: extra.input ?? '',
    timeout: 30_000,
  })
}

function json(h: FakeHome, args: string[], schema = 'unattended', env: Record<string, string> = {}) {
  const r = cli(h, ['unattended', ...args, '--json'], { env })
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
      const first = json(h, [])
      assert.equal(first.on, false)
      assert.equal(first.configured, false)
      assert.equal(first.coverage.claude, 'not-covered')
      const on = json(h, ['on', '--for', '60m'])
      assert.equal(on.on, true)
      assert.equal(on.reason, 'manual')
      assert.equal(on.changed, true)
      assert.equal(on.undo, 'sideby unattended off')
      assert.equal(on.coverage.claude, 'covered')
      assert.equal(on.coverage.codex, 'needs-trust')
      assert.equal(on.coverage.grok, 'not-covered')
      assert.ok(Date.parse(on.until) > Date.now() + 59 * 60 * 1000)
      assert.equal(json(h, ['status']).on, true)
      const off = json(h, ['off'])
      assert.equal(off.on, false)
      assert.match(off.undo, /^sideby unattended on --until /)
      const human = cli(h, ['unattended'])
      assert.equal(human.status, 0)
      assert.match(human.stdout, /Unattended Mode: off/)
      assert.match(human.stdout, /Covers Claude sessions sideby starts/)
    })
  })

  it('refuses times and options it does not take, saying what to use (exit 2)', async () => {
    await withFakeHome(async (h) => {
      for (const args of [
        ['on', '--for', '73h'],
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
      ]) {
        const r = cli(h, ['unattended', ...args, '--json'])
        assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`)
        const out = JSON.parse(r.stdout)
        assert.equal(out.schemaVersion, 1)
        assert.equal(out.code, 'usage')
        assert.match(out.error, /use|choose|run|add|give|usage/i, args.join(' '))
      }
      // A Slot or a decision that is not there is not a malformed command line: exit 1, with what to do.
      const missing = cli(h, ['unattended', 'pending', 'done', 'abcdefgh', '--json'])
      assert.equal(missing.status, 1)
      assert.match(JSON.parse(missing.stdout).error, /pending --all/)
      const none = cli(h, ['unattended', 'schedule', 'remove', '1'])
      assert.equal(none.status, 1)
      assert.match(none.stderr, /schedule add/)
    })
  })

  it('edits the Schedule and prints an undo command that runs', async () => {
    await withFakeHome(async (h) => {
      const added = json(h, [
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
      assert.equal(json(h, ['schedule', 'preset', 'weeknights']).schedule.length, 2)
      const again = json(h, ['schedule', 'preset', 'weeknights'])
      assert.equal(again.changed, false)
      assert.equal(again.schedule.length, 2)
      const removed = json(h, ['schedule', 'remove', '1'])
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
      const human = cli(h, ['unattended', 'schedule'])
      assert.match(human.stdout, /1\. A user's Slot {2}fri-mon 23:00-08:00 \(next day\)/)
    })
  })

  it('keeps what a session defers, with its account and session, and marks decisions done', async () => {
    await withFakeHome(async (h) => {
      const env = { SIDEBY_ACCOUNT: 'claude:work', CLAUDE_CODE_SESSION_ID: 's1' }
      const one = json(h, ['defer', 'deleting', 'the', 'old', 'branch'], 'unattended-defer', env).decision
      assert.equal(one.text, 'deleting the old branch')
      assert.equal(one.family, 'claude')
      assert.equal(one.account, 'claude:work')
      assert.equal(one.sessionId, 's1')
      assert.equal(one.kind, 'deferred')
      json(h, ['defer', 'deploy'], 'unattended-defer', { CODEX_THREAD_ID: 't1' })
      const listed = json(h, ['pending'], 'unattended-pending').pending
      assert.equal(listed.length, 2)
      assert.equal(listed[1].family, 'codex')
      assert.equal(json(h, []).pending, 2)
      const done = json(h, ['pending', 'done', one.id], 'unattended-pending')
      assert.deepEqual(done.done, [one.id])
      assert.equal(done.pending.length, 1)
      json(h, ['pending', 'done', '--all'], 'unattended-pending')
      assert.equal(json(h, ['pending'], 'unattended-pending').pending.length, 0)
      assert.ok(
        json(h, ['pending', '--all'], 'unattended-pending').pending.every(
          (d: { doneAt?: string }) => d.doneAt,
        ),
      )
      const human = cli(h, ['unattended', 'pending'])
      assert.match(human.stdout, /Nothing is waiting for you/)
    })
  })

  it('refuses a question and a permission request through the real hook entry while on, and goes silent when off', async () => {
    await withFakeHome(async (h) => {
      json(h, ['on', '--for', '1h'])
      const input = JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'AskUserQuestion',
        tool_input: { questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] },
        session_id: 's1',
        cwd: '/tmp',
      })
      const refused = cli(h, ['unattended-hook', 'claude', 'PreToolUse'], { input })
      assert.equal(refused.status, 2)
      assert.equal(refused.stdout, '')
      assert.match(refused.stderr, /recommended option/)
      const [d] = json(h, ['pending'], 'unattended-pending').pending
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
      const denied = cli(h, ['unattended-hook', 'claude', 'PermissionRequest'], { input: request })
      assert.equal(denied.status, 0)
      assert.equal(denied.stderr, '')
      assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.decision.behavior, 'deny')
      const kept = json(h, ['pending'], 'unattended-pending').pending
      assert.deepEqual(
        kept.map((x: { kind: string; agentType?: string }) => [x.kind, x.agentType]),
        [
          ['question', undefined],
          ['permission', 'general-purpose'],
        ],
      )
      json(h, ['off'])
      const allowed = cli(h, ['unattended-hook', 'claude', 'PreToolUse'], { input })
      assert.equal(allowed.status, 0)
      assert.equal(allowed.stdout + allowed.stderr, '')
      const prompt = cli(h, ['unattended-hook', 'claude', 'PermissionRequest'], { input: request })
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
      json(h, ['on', '--for', '1h'])
      json(h, ['defer', 'left the release for the user'], 'unattended-defer')
      json(h, ['off'])
      assert.equal(cli(h, ['unattended']).status, 0)
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
      const r = cli(h, ['run', 'claude:001', '--unattended', '--', 'hello'])
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
      assert.equal(cli(h, ['alias', 'add', 'cc1', 'claude:001']).status, 0)
      assert.equal(cli(h, ['run', 'cc1', '--', '--unattended']).status, 0)
      const second = (await readHostLog(h, 'claude'))[1]
      assert.equal(second?.env.SIDEBY_UNATTENDED, '1')
      assert.ok(!second!.argv.includes('--unattended'))
      // Without it, and before the feature is used, the session gets nothing.
      assert.equal(cli(h, ['run', 'claude:001']).status, 0)
      const third = (await readHostLog(h, 'claude'))[2]
      assert.equal(third?.env.SIDEBY_UNATTENDED, undefined)
      assert.ok(!third!.argv.includes('--settings'))
    })
  })
})
