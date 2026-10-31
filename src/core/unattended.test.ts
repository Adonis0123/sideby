// Unattended Mode in the sessions sideby starts (spec §3.37): the hook goes in through Claude's one `--settings`
// (shared with Network Guard and Auto Handoff) and Codex's `-c hooks.*`, nothing is written into a Host directory;
// and the core API the CLI and the Panel use.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { claudePlugin } from '../families/claude/index.ts'
import { codexPlugin } from '../families/codex/index.ts'
import { createRuntime } from '../runtime.ts'
import { resolvePaths } from './paths.ts'
import { withClaudeSessionHooks } from './session-hooks.ts'
import {
  addUnattendedSlot,
  onUntil,
  removeUnattendedSlot,
  slotFromOptions,
  turnUnattendedOff,
  turnUnattendedOn,
  WEEKNIGHTS,
} from './unattended.ts'
import { readUnattendedOverride, type UnattendedSlot } from './unattended-state.ts'

const builtins = [claudePlugin, codexPlugin].map((plugin) => ({
  plugin,
  version: '0.1.0',
  description: '',
  defaultEnabled: true,
}))

async function setup(h: FakeHome, config: object) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude-001/settings.json', '{}')
  await h.write('.codex/auth.json', '{}', 0o600)
  await h.write('.codex/config.toml', '')
  await h.write('.config/sideby/config.json', JSON.stringify(config))
  return createRuntime({
    env: { ...h.env, LANG: 'en_US.UTF-8' },
    builtins,
    network: { fetcher: async () => 'ip=203.0.113.7\nloc=US\n', print: 'p' },
  })
}

const settingsOf = async (args: readonly string[]) => {
  const at = args.indexOf('--settings')
  assert.ok(at >= 0, 'has --settings')
  return { file: args[at + 1]!, hooks: JSON.parse(await readFile(args[at + 1]!, 'utf8')).hooks }
}

describe('Launch', () => {
  it('adds nothing before the feature is used', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, {})
      const p = await rt.prepareLaunch('claude:001', [], 'run')
      assert.deepEqual(p.args, [])
      assert.equal(p.sessionHookArgs, undefined)
      assert.equal(p.env.SIDEBY_UNATTENDED, undefined)
    })
  })

  it("adds Claude's hook through a settings file of sideby's, writing nothing into a Host directory", async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { unattended: {} })
      const before = await snapshot(h.path('.claude-001'))
      const main = await snapshot(h.path('.claude'))
      const p = await rt.prepareLaunch('claude:001', ['--', 'hi'], 'run')
      const at = p.args.indexOf('--settings')
      assert.ok(at >= 0 && at < p.args.indexOf('--'), 'before the user’s own --')
      const { file, hooks } = await settingsOf(p.args)
      assert.ok(file.startsWith(`${rt.paths.stateDir}/unattended/`))
      // Before the ask tool only (no hook on every Bash call), on every permission request Claude Code shows, at
      // the end of every turn, on every MCP server form, and after a turn that failed for a passing reason.
      assert.deepEqual(Object.keys(hooks), [
        'PreToolUse',
        'PermissionRequest',
        'Stop',
        'Elicitation',
        'StopFailure',
      ])
      // In the background: its exit 2 wakes the session (Turn Retry). No matcher: every failure ends an earlier wait.
      assert.equal(hooks.StopFailure.length, 1)
      assert.equal(hooks.StopFailure[0].matcher, undefined)
      assert.match(
        hooks.StopFailure[0].hooks[0].command,
        /^'.+' '.+main\.ts' unattended-hook claude StopFailure$/,
      )
      assert.equal(hooks.StopFailure[0].hooks[0].asyncRewake, true)
      assert.equal(hooks.StopFailure[0].hooks[0].timeout, 600)
      assert.deepEqual(
        hooks.PreToolUse.map((g: { matcher: string }) => g.matcher),
        ['AskUserQuestion'],
      )
      assert.match(
        hooks.PreToolUse[0].hooks[0].command,
        /^'.+' '.+main\.ts' unattended-hook claude PreToolUse$/,
      )
      assert.deepEqual(
        hooks.PermissionRequest.map((g: { matcher: string }) => g.matcher),
        ['*'],
      )
      assert.match(
        hooks.PermissionRequest[0].hooks[0].command,
        /^'.+' '.+main\.ts' unattended-hook claude PermissionRequest$/,
      )
      // Stop takes no matcher.
      assert.equal(hooks.Stop.length, 1)
      assert.equal(hooks.Stop[0].matcher, undefined)
      assert.match(hooks.Stop[0].hooks[0].command, /^'.+' '.+main\.ts' unattended-hook claude Stop$/)
      assert.deepEqual(
        hooks.Elicitation.map((g: { matcher: string }) => g.matcher),
        ['*'],
      )
      assert.match(
        hooks.Elicitation[0].hooks[0].command,
        /^'.+' '.+main\.ts' unattended-hook claude Elicitation$/,
      )
      assert.deepEqual(p.sessionHookArgs, ['--settings', file])
      assert.equal(p.networkArgs, undefined)
      assert.equal(p.env.SIDEBY_UNATTENDED, undefined)
      assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude-001'))), [])
      assert.deepEqual(diffSnapshots(main, await snapshot(h.path('.claude'))), [])
      // `login` is no session: nothing added.
      assert.equal((await rt.prepareLaunch('claude:001', [], 'login')).args.includes('--settings'), false)
    })
  })

  it("shares Claude's one --settings with Network Guard", async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { unattended: {}, network: { guard: true, allow: ['US'] } })
      const p = await rt.prepareLaunch('claude:001', [], 'run')
      assert.equal(p.args.filter((a) => a === '--settings').length, 1)
      const { file, hooks } = await settingsOf(p.args)
      assert.match(file, /network\/claude-settings-unattended\.json$/)
      assert.deepEqual(Object.keys(hooks).sort(), [
        'Elicitation',
        'PermissionRequest',
        'PreToolUse',
        'Stop',
        'StopFailure',
        'UserPromptSubmit',
      ])
      const commands = hooks.PreToolUse.map((g: { hooks: { command: string }[] }) => g.hooks[0]!.command)
      assert.equal(commands.length, 2)
      assert.match(commands[0], /network-hook claude PreToolUse$/)
      assert.match(commands[1], /unattended-hook claude PreToolUse$/)
      assert.deepEqual(p.networkArgs, p.sessionHookArgs)
    })
  })

  it('merges every session hook into Auto Handoff’s settings file, keeping its own options', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { unattended: {}, network: { guard: true, allow: ['US'] } })
      const p = await rt.prepareLaunch('claude:001', [], 'run')
      const handoff = await h.write(
        'state/handoff.json',
        JSON.stringify({
          hooks: {
            PreToolUse: [{ hooks: [{ type: 'command', command: 'h' }] }],
            Stop: [{ hooks: [{ type: 'command', command: 'w', asyncRewake: true, timeout: 18000 }] }],
          },
        }),
      )
      const args = await withClaudeSessionHooks(['--settings', handoff], p.sessionHookArgs!)
      const { file, hooks } = await settingsOf(args)
      assert.match(file, /claude-settings-unattended-handoff\.json$/)
      assert.deepEqual(Object.keys(hooks).sort(), [
        'Elicitation',
        'PermissionRequest',
        'PreToolUse',
        'Stop',
        'StopFailure',
        'UserPromptSubmit',
      ])
      assert.equal(hooks.PreToolUse.length, 3)
      assert.equal(hooks.PermissionRequest.length, 1)
      assert.equal(hooks.PreToolUse[0].hooks[0].command, 'h')
      // Auto Handoff's Stop hook first, then Unattended Mode's.
      assert.equal(hooks.Stop.length, 2)
      assert.match(hooks.Stop[1].hooks[0].command, /unattended-hook claude Stop$/)
      assert.deepEqual(hooks.Stop[0].hooks[0], {
        type: 'command',
        command: 'w',
        asyncRewake: true,
        timeout: 18000,
      })
    })
  })

  it('adds Codex’s hook with -c, in one value per event next to Network Guard’s, and the trust note once', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { unattended: {}, network: { guard: true, allow: ['US'] } })
      const p = await rt.prepareLaunch('codex:main', [], 'run')
      const pre = p.args.filter((a) => a.startsWith('hooks.PreToolUse='))
      assert.equal(pre.length, 1)
      assert.match(pre[0]!, /network-hook codex PreToolUse/)
      assert.match(pre[0]!, /matcher="\^request_user_input\$"/)
      assert.match(pre[0]!, /unattended-hook codex PreToolUse/)
      assert.ok(p.args.some((a) => a.startsWith('hooks.UserPromptSubmit=')))
      const stop = p.args.filter((a) => a.startsWith('hooks.Stop='))
      assert.equal(stop.length, 1)
      assert.match(
        stop[0]!,
        /^hooks\.Stop=\[\{hooks=\[\{type="command",command=".+unattended-hook codex Stop"\}\]\}\]$/,
      )
      assert.match(p.notice ?? '', /trust both `unattended-hook` entries/)
      const again = await rt.prepareLaunch('codex:main', [], 'run')
      assert.doesNotMatch(again.notice ?? '', /unattended-hook/)
    })
  })

  it('tells a Codex account told before the Stop hook existed once more, to trust that one too', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { unattended: {} })
      await h.write('.local/state/sideby/unattended/codex-trust-notices.json', '{"refs":["codex:main"]}')
      const p = await rt.prepareLaunch('codex:main', [], 'run')
      assert.match(p.notice ?? '', /at the end of a turn/)
      assert.doesNotMatch((await rt.prepareLaunch('codex:main', [], 'run')).notice ?? '', /unattended-hook/)
    })
  })

  it("leaves the user's own --settings alone and says the session is not covered", async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { unattended: {} })
      const p = await rt.prepareLaunch('claude:001', ['--settings', 'mine.json'], 'run')
      assert.equal(p.args.filter((a) => a === '--settings').length, 1)
      assert.equal(p.sessionHookArgs, undefined)
      assert.match(p.notice ?? '', /Unattended Mode does not cover this session/)
    })
  })

  it('--unattended marks the session and adds the hook before the feature is set up', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, {})
      const p = await rt.prepareLaunch('claude:001', [], 'run', { unattended: true })
      assert.equal(p.env.SIDEBY_UNATTENDED, '1')
      assert.ok(p.args.includes('--settings'))
    })
  })

  it('covers the Host run unchanged by `sideby resume`', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { unattended: {} })
      const r = await rt.resumeLaunch('claude', [], { unattended: true })
      assert.equal(r.launch.env.SIDEBY_UNATTENDED, '1')
      assert.ok(r.launch.args.includes('--settings'))
      const off = await setup(h, {})
      const plain = await off.resumeLaunch('claude', [])
      assert.equal(plain.launch.env, off.env)
    })
  })
})

describe('status and changes', () => {
  // 2026-10-26 is a Monday, in this computer's own time zone.
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute)
  const families = ['claude', 'codex', 'grok']

  it('reports what each Family gets', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, {})
      assert.deepEqual((await rt.unattendedStatus()).coverage, {
        claude: 'not-covered',
        codex: 'not-covered',
      })
      const on = await setup(h, { unattended: {} })
      const s = await on.unattendedStatus()
      assert.deepEqual(s.coverage, { claude: 'covered', codex: 'needs-trust' })
      assert.equal(s.configured, true)
      assert.equal(s.pending, 0)
    })
  })

  it('works out how long `on` lasts, and says what to use instead', () => {
    const now = at(26, 12)
    assert.deepEqual(onUntil({ for: '90m' }, [], now), { until: at(26, 13, 30).getTime() })
    assert.deepEqual(onUntil({ for: '1h30m' }, [], now), { until: at(26, 13, 30).getTime() })
    assert.deepEqual(onUntil({ until: '07:30' }, [], now), { until: at(27, 7, 30).getTime() })
    assert.deepEqual(onUntil({ until: '13:00' }, [], now), { until: at(26, 13).getTime() })
    assert.deepEqual(onUntil({ until: at(27, 9).toISOString() }, [], now), { until: at(27, 9).getTime() })
    assert.deepEqual(onUntil({ slotEnd: true }, [WEEKNIGHTS], now), { until: at(27, 8).getTime() })
    // Without a choice: the Slot's end when there is one within 72 hours, else 12 hours.
    assert.deepEqual(onUntil({}, [WEEKNIGHTS], now), { until: at(27, 8).getTime() })
    assert.deepEqual(onUntil({}, [], now), { until: at(27, 0).getTime() })
    const weekend: UnattendedSlot = { days: ['sun'], start: '01:00', end: '05:00' }
    assert.deepEqual(onUntil({}, [weekend], now), { until: at(27, 0).getTime() })
    const errors: [object, RegExp][] = [
      [{ for: '73h' }, /72h or less/],
      [{ for: '0h' }, /hours or minutes/],
      [{ for: '-1m' }, /hours or minutes/],
      [{ until: '2020-01-01T00:00:00Z' }, /not in the future/],
      [{ until: 'soon' }, /takes a time/],
      [{ until: at(30, 13).toISOString() }, /within 72 hours/],
      [{ slotEnd: true }, /schedule add/],
      [{ slotEnd: true, for: '1h' }, /choose one/],
    ]
    for (const [choice, why] of errors) {
      const r = onUntil(choice, [], now)
      assert.ok('error' in r && why.test(r.error), JSON.stringify(choice))
    }
    assert.ok('error' in onUntil({ slotEnd: true }, [weekend], now))
  })

  it('turns on and off, pausing inside a Slot, each with its undo', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', JSON.stringify({ unattended: { schedule: [WEEKNIGHTS] } }))
      const paths = resolvePaths(h.env)
      const on = await turnUnattendedOn({ paths, families, until: at(26, 14).getTime(), now: at(26, 12) })
      assert.equal(on.status.reason, 'manual')
      assert.equal(on.undo, 'sideby unattended off')
      const off = await turnUnattendedOff({ paths, families, now: at(26, 13) })
      assert.equal(off.status.on, false)
      assert.equal(off.undo, `sideby unattended on --until ${at(26, 14).toISOString()}`)
      assert.equal(await readUnattendedOverride(paths.stateDir), undefined)
      assert.equal((await turnUnattendedOff({ paths, families, now: at(26, 13) })).changed, false)
      // In a Slot: a pause until it ends; the next one comes on as usual.
      const pause = await turnUnattendedOff({ paths, families, now: at(27, 1) })
      assert.equal(pause.status.reason, 'paused')
      assert.equal(pause.status.until, at(27, 8).toISOString())
      assert.equal(pause.undo, `sideby unattended on --until ${at(27, 8).toISOString()}`)
      assert.equal((await readUnattendedOverride(paths.stateDir))?.mode, 'pause')
      await assert.rejects(
        turnUnattendedOn({ paths, families, until: at(30, 12).getTime(), now: at(26, 12) }),
        /at most 72 hours/,
      )
    })
  })

  it('keeps the hour of --until across a clock change', () => {
    // In New York, clocks went from 02:00 to 03:00 on 2026-03-08 and back from 02:00 to 01:00 on 2026-11-01.
    const module = new URL('./unattended.ts', import.meta.url).href
    const script = `import { onUntil } from ${JSON.stringify(module)}
const ask = (until, now) => new Date(onUntil({ until }, [], new Date(now)).until).toISOString()
console.log(JSON.stringify([
  ask('02:30', '2026-03-08T07:45:00Z'),
  ask('01:30', '2026-03-08T07:45:00Z'),
  ask('04:00', '2026-03-08T07:45:00Z'),
  ask('02:30', '2026-03-08T06:45:00Z'),
  ask('01:30', '2026-11-01T05:45:00Z'),
  ask('00:30', '2026-11-01T05:45:00Z'),
]))`
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), [
      // 03:45 EDT on the day clocks go forward: 02:30 is tomorrow's, at 02:30 EDT.
      '2026-03-09T06:30:00.000Z',
      '2026-03-09T05:30:00.000Z',
      // 04:00 EDT the same day.
      '2026-03-08T08:00:00.000Z',
      // 01:45 EST, before the change: today's 02:30 never comes, so the hour after it, 03:30 EDT.
      '2026-03-08T07:30:00.000Z',
      // 01:45 EDT on the day clocks go back: today's 01:30 (the first one) has passed, so tomorrow's.
      '2026-11-02T06:30:00.000Z',
      '2026-11-02T05:30:00.000Z',
    ])
  })

  it('has no end, and pauses until turned on, when the Schedule covers every hour', async () => {
    await withFakeHome(async (h) => {
      const always: UnattendedSlot = {
        days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
        start: '00:00',
        end: '00:00',
      }
      await h.write('.config/sideby/config.json', JSON.stringify({ unattended: { schedule: [always] } }))
      const paths = resolvePaths(h.env)
      const rt = await setup(h, { unattended: { schedule: [always] } })
      const status = await rt.unattendedStatus()
      assert.equal(status.on, true)
      assert.equal(status.reason, 'slot')
      assert.equal(status.until, undefined)
      assert.equal(status.slotEnd, undefined)
      assert.equal(status.next, undefined)
      const slotEnd = onUntil({ slotEnd: true }, [always], at(26, 12))
      assert.ok('error' in slotEnd && /covers every hour/.test(slotEnd.error))
      assert.deepEqual(onUntil({}, [always], at(26, 12)), { until: at(27, 0).getTime() })
      const off = await turnUnattendedOff({ paths, families, now: at(26, 12) })
      assert.equal(off.status.reason, 'paused')
      assert.equal(off.status.until, undefined)
      assert.equal(off.status.manual?.until, undefined)
      assert.equal(off.undo, 'sideby unattended on')
      assert.equal((await readUnattendedOverride(paths.stateDir))?.until, undefined)
      // Still paused a month later.
      const later = await turnUnattendedOff({ paths, families, now: new Date(2026, 10, 26, 12) })
      assert.equal(later.changed, false)
      assert.equal(later.status.reason, 'paused')
      // `on` ends the pause; after it, the Schedule goes on with no end.
      const on = await turnUnattendedOn({ paths, families, until: at(26, 14).getTime(), now: at(26, 13) })
      assert.equal(on.status.reason, 'manual')
      assert.equal(on.status.until, undefined)
      assert.equal(on.undo, 'sideby unattended off')
      const after = await turnUnattendedOff({ paths, families, now: at(26, 15) })
      assert.equal(after.status.reason, 'paused')
      // Once the Schedule has a gap, the open pause ends with the stretch it was made in.
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ unattended: { schedule: [{ ...always, days: ['mon'] }] } }),
      )
      const s = await turnUnattendedOff({ paths, families, now: at(28, 12) })
      assert.equal(s.status.reason, 'off')
      assert.equal(s.status.next?.at, new Date(2026, 10, 2, 0).toISOString())
    })
  })

  it('creates the config section the first time it is turned on', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await turnUnattendedOn({ paths, families, until: Date.now() + 3_600_000 })
      const config = JSON.parse(await readFile(paths.configFile, 'utf8'))
      assert.deepEqual(config.unattended, {})
    })
  })

  it('adds a Slot once, at a position, and removes it with an undo that puts it back', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      const named = {
        name: "A user's Slot",
        days: ['mon' as const, 'fri' as const, 'sat' as const, 'sun' as const],
        start: '23:00',
        end: '08:00',
      }
      const a = await addUnattendedSlot({ paths, families, slot: named })
      assert.equal(a.undo, 'sideby unattended schedule remove 1')
      const b = await addUnattendedSlot({ paths, families, slot: WEEKNIGHTS })
      assert.equal(b.undo, 'sideby unattended schedule remove 2')
      assert.equal((await addUnattendedSlot({ paths, families, slot: WEEKNIGHTS })).changed, false)
      const r = await removeUnattendedSlot({ paths, families, n: 1 })
      assert.deepEqual(r.status.schedule, [WEEKNIGHTS])
      assert.equal(
        r.undo,
        `sideby unattended schedule add --days mon,fri,sat,sun --from 23:00 --to 08:00 --name 'A user'\\''s Slot' --at 1`,
      )
      await addUnattendedSlot({ paths, families, slot: named, at: 1 })
      const config = JSON.parse(await readFile(paths.configFile, 'utf8'))
      assert.deepEqual(config.unattended.schedule, [named, WEEKNIGHTS])
      await assert.rejects(removeUnattendedSlot({ paths, families, n: 3 }), /choose 1 to 2/)
    })
  })

  it('checks a Slot given on the command line', () => {
    assert.deepEqual(slotFromOptions({ days: 'mon-fri', from: '23:00', to: '8:00' }), {
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      start: '23:00',
      end: '08:00',
    })
    assert.match(
      (slotFromOptions({ days: 'bad', from: '23:00', to: '08:00' }) as { error: string }).error,
      /--days/,
    )
    assert.match(
      (slotFromOptions({ days: 'mon', from: '24:00', to: '08:00' }) as { error: string }).error,
      /24-hour/,
    )
    assert.match(
      (slotFromOptions({ days: 'mon' }) as { error: string }).error,
      /give --days, --from and --to/,
    )
  })
})
