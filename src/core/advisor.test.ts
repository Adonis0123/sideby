import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin } from '../../testing/demo.ts'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import type { Account, ReadContext } from '../types.ts'
import {
  ADVISOR_UNLOCK_VAR,
  advisorGroups,
  advisorPlan,
  advisorStatus,
  apiBetasEnv,
  checkAdvisorAccount,
  setAdvisor,
  setAdvisorUnlock,
  undoAdvisor,
  unlockAdvisorEnv,
} from './advisor.ts'

const MARKER = 'not-a-secret-marker-only-for-this-test'

const acct = (
  h: FakeHome,
  name: string,
  family = 'claude',
  kind: Account['kind'] = 'subscription',
): Account => ({
  family,
  name,
  ref: `${family}:${name}`,
  dir: h.path(name === 'main' ? `.${family}` : `.${family}-${name}`),
  isMain: name === 'main',
  kind,
})

const ctx = (h: FakeHome, env = h.env): ReadContext => ({
  home: h.home,
  now: new Date(),
  stateDir: h.path('.local/state/sideby'),
  env,
})

const json = async (p: string) => JSON.parse(await readFile(p, 'utf8'))
const configFile = (h: FakeHome) => h.path('.config/sideby/config.json')

/**
 * main names sonnet, 001 links to it, 002 has a file of its own without the key, 003 has no settings.json, api is an
 * API Account with a file of its own; a Codex Account is never read.
 */
async function setUp(h: FakeHome) {
  const main = acct(h, 'main')
  const linked = acct(h, '001')
  const own = acct(h, '002')
  const none = acct(h, '003')
  const api = acct(h, 'api', 'claude', 'api')
  await h.write(
    '.claude/settings.json',
    `{\n    "env": { "X": "${MARKER}" },\n    "advisorModel": "sonnet"\n}\n`,
    0o644,
  )
  await mkdir(linked.dir, { recursive: true })
  await symlink(join(main.dir, 'settings.json'), join(linked.dir, 'settings.json'))
  await h.write('.claude-002/settings.json', '{"model":"x"}')
  await mkdir(none.dir, { recursive: true })
  await h.write('.claude-api/settings.json', '{"model":"y"}')
  return { main, linked, own, none, api, all: [main, linked, own, none, api, acct(h, 'main', 'codex')] }
}

describe('Advisor (spec §3.41)', () => {
  it('groups subscription Accounts by the file they share, leaves API Accounts out and reads only the one key', async () => {
    await withFakeHome(async (h) => {
      const { all } = await setUp(h)
      const groups = await advisorGroups(all, ctx(h))
      assert.deepEqual(
        groups.map((g) => [g.accounts, g.state, g.undo]),
        [
          [['claude:main', 'claude:001'], 'sonnet', false],
          [['claude:002'], 'off', false],
          [['claude:003'], 'missing', false],
        ],
      )
      assert.match(groups[2]?.reason ?? '', /doctor --fix/)
      assert.ok(!JSON.stringify(groups).includes(MARKER))
    })
  })

  it('tells a full model id, a value it does not know and an empty one apart', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'main')
      const state = async (v: unknown) => {
        await h.write('.claude/settings.json', JSON.stringify({ advisorModel: v }))
        const [g] = await advisorGroups([a], ctx(h))
        return [g?.state, g?.model]
      }
      assert.deepEqual(await state('Opus'), ['opus', undefined])
      assert.deepEqual(await state('claude-opus-5-5'), ['other', 'claude-opus-5-5'])
      assert.deepEqual(await state('not a model; rm -rf'), ['other', undefined])
      assert.deepEqual(await state(42), ['other', undefined])
      assert.deepEqual(await state(''), ['off', undefined])
    })
  })

  it('a model writes only advisorModel where it differs, keeps the rest, creates no file or link, and unlocks', async () => {
    await withFakeHome(async (h) => {
      const { main, linked, own, none, api, all } = await setUp(h)
      const before = await snapshot(h.home)
      const r = await setAdvisor(all, ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: false,
        apiBetasOff: false,
      })
      assert.deepEqual([r.ok, r.results.length, r.unlocked], [true, 2, true])
      assert.match(r.message, /Opus/)
      assert.match(r.message, /restart/)
      assert.equal(
        await readFile(join(main.dir, 'settings.json'), 'utf8'),
        `${JSON.stringify({ env: { X: MARKER }, advisorModel: 'opus' }, null, 4)}\n`,
      )
      assert.equal((await stat(join(main.dir, 'settings.json'))).mode & 0o777, 0o644)
      assert.deepEqual(await json(join(own.dir, 'settings.json')), { model: 'x', advisorModel: 'opus' })
      assert.ok((await lstat(join(linked.dir, 'settings.json'))).isSymbolicLink())
      assert.equal(await readlink(join(linked.dir, 'settings.json')), join(main.dir, 'settings.json'))
      await assert.rejects(stat(join(none.dir, 'settings.json')))
      assert.deepEqual(await json(join(api.dir, 'settings.json')), { model: 'y' })
      assert.deepEqual((await json(configFile(h))).advisor, { unlock: true })
      // Only the two settings files, sideby's own config and its undo records change.
      const changed = diffSnapshots(before, await snapshot(h.home)).filter(
        (k) => !k.startsWith('.local') && !k.startsWith('.config'),
      )
      assert.deepEqual(changed, ['.claude-002/settings.json', '.claude/settings.json'])
      const dir = h.path('.local/state/sideby/advisor')
      for (const f of await readdir(dir)) assert.ok(!(await readFile(join(dir, f), 'utf8')).includes(MARKER))
      assert.ok(!JSON.stringify(r).includes(MARKER))
      const after = await advisorGroups(all, ctx(h))
      assert.deepEqual(
        after.map((g) => [g.state, g.undo]),
        [
          ['opus', true],
          ['opus', true],
          ['missing', false],
        ],
      )
      const again = await setAdvisor(all, ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
      })
      assert.deepEqual([again.ok, again.results.length], [false, 0])
      assert.match(again.message, /already Opus/)
    })
  })

  it('off removes the key, undo puts each file back, and a second undo has nothing to do', async () => {
    await withFakeHome(async (h) => {
      const { main, own, all } = await setUp(h)
      await writeFile(join(own.dir, 'settings.json'), '{"model":"x","advisorModel":""}\n')
      const r = await setAdvisor(all, ctx(h), 'off', {
        configFile: configFile(h),
        unlock: false,
        apiBetasOff: false,
      })
      assert.deepEqual([r.ok, r.results.length, r.unlocked], [true, 1, false])
      assert.deepEqual(await json(join(main.dir, 'settings.json')), { env: { X: MARKER } })
      await assert.rejects(stat(configFile(h)))
      assert.deepEqual(
        (await advisorGroups(all, ctx(h))).map((g) => [g.state, g.undo]),
        [
          ['off', true],
          ['off', false],
          ['missing', false],
        ],
      )
      const u = await undoAdvisor(all, ctx(h), {
        configFile: configFile(h),
        unlock: false,
        apiBetasOff: false,
      })
      assert.equal(u.ok, true)
      assert.equal((await json(join(main.dir, 'settings.json'))).advisorModel, 'sonnet')
      assert.equal(
        (await undoAdvisor(all, ctx(h), { configFile: configFile(h), unlock: false, apiBetasOff: false })).ok,
        false,
      )
    })
  })

  it('undo removes a key that was not there and says when sideby still unlocks', async () => {
    await withFakeHome(async (h) => {
      const { own, all } = await setUp(h)
      await setAdvisor(all, ctx(h), 'fable', { configFile: configFile(h), unlock: false, apiBetasOff: false })
      const u = await undoAdvisor(all, ctx(h), {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
      })
      assert.equal(u.ok, true)
      assert.match(u.message, /advisor unlock off/)
      assert.deepEqual(await json(join(own.dir, 'settings.json')), { model: 'x' })
    })
  })

  it('undo leaves a setting the user changed since, also after off', async () => {
    await withFakeHome(async (h) => {
      const { main, all } = await setUp(h)
      await setAdvisor(all, ctx(h), 'off', { configFile: configFile(h), unlock: false, apiBetasOff: false })
      await writeFile(join(main.dir, 'settings.json'), '{"advisorModel":"opus"}\n')
      const groups = await advisorGroups(all, ctx(h))
      assert.deepEqual([groups[0]?.state, groups[0]?.undo], ['opus', false])
      await undoAdvisor(all, ctx(h), { configFile: configFile(h), unlock: false, apiBetasOff: false })
      assert.equal(await readFile(join(main.dir, 'settings.json'), 'utf8'), '{"advisorModel":"opus"}\n')
    })
  })

  it('--account limits the change to the file that Account uses and refuses an API or other Account', async () => {
    await withFakeHome(async (h) => {
      const { main, own, api, all } = await setUp(h)
      const r = await setAdvisor(all, ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
        account: 'claude:002',
      })
      assert.deepEqual([r.ok, r.results.map((x) => x.accounts)], [true, [['claude:002']]])
      assert.equal((await json(join(own.dir, 'settings.json'))).advisorModel, 'opus')
      assert.equal((await json(join(main.dir, 'settings.json'))).advisorModel, 'sonnet')
      const missing = await setAdvisor(all, ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
        account: 'claude:003',
      })
      assert.deepEqual([missing.ok, missing.results.length], [false, 0])
      assert.match(missing.message, /doctor --fix/)
      assert.throws(() => checkAdvisorAccount(api), /API account/)
      assert.throws(() => checkAdvisorAccount(acct(h, 'main', 'codex')), /not a Claude Code account/)
    })
  })

  it('only unlocks when every file already names the model, and not when none can be changed', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'main')
      await h.write('.claude/settings.json', '{"advisorModel":"opus"}')
      const plan = advisorPlan(await advisorGroups([a], ctx(h)), 'opus', {
        unlock: false,
        apiBetasOff: false,
      })
      assert.deepEqual([plan.todo.length, plan.unlock], [0, true])
      const r = await setAdvisor([a], ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: false,
        apiBetasOff: false,
      })
      assert.deepEqual([r.ok, r.results.length, r.unlocked], [true, 0, true])
      await h.write('.claude/settings.json', '[1,2]')
      const blocked = await setAdvisor([a], ctx(h), 'opus', {
        configFile: h.path('other.json'),
        unlock: false,
        apiBetasOff: false,
      })
      assert.deepEqual([blocked.ok, blocked.unlocked], [false, false])
      assert.match(blocked.message, /not a JSON object/)
      assert.equal(await readFile(join(a.dir, 'settings.json'), 'utf8'), '[1,2]')
      await assert.rejects(stat(h.path('other.json')))
      const none = await setAdvisor([], ctx(h), 'opus', {
        configFile: h.path('other.json'),
        unlock: false,
        apiBetasOff: false,
      })
      assert.match(none.message, /No Claude subscription accounts/)
    })
  })

  it('the unlock switch writes only config advisor.unlock and says when nothing changed', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', '{"editor":"vscode"}\n')
      assert.equal((await setAdvisorUnlock(configFile(h), true)).ok, true)
      assert.deepEqual(await json(configFile(h)), { editor: 'vscode', advisor: { unlock: true } })
      assert.equal((await setAdvisorUnlock(configFile(h), true)).ok, false)
      assert.equal((await setAdvisorUnlock(configFile(h), false)).ok, true)
      assert.deepEqual(await json(configFile(h)), { editor: 'vscode' })
    })
  })

  it('status names a variable that hides the advisor', async () => {
    await withFakeHome(async (h) => {
      const st = await advisorStatus([], ctx(h, { ...h.env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' }), {
        unlock: true,
        apiBetasOff: false,
      })
      assert.deepEqual(st, {
        groups: [],
        unlock: true,
        apiBetasOff: false,
        envOff: 'CLAUDE_CODE_DISABLE_ADVISOR_TOOL',
      })
    })
  })
})

describe('a settings file whose env turns experimental features off (spec §3.41)', () => {
  const BETAS = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'
  const pretty = (o: object) => `${JSON.stringify(o, null, 2)}\n`

  it('reads only whether the variable is true, never another env entry, and blocks an env that is not an object', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'main')
      const read = async (env: unknown) => {
        await h.write('.claude/settings.json', JSON.stringify({ env, advisorModel: 'opus' }))
        const [g] = await advisorGroups([a], ctx(h))
        return g!
      }
      const on = await read({ [BETAS]: '1', X: MARKER })
      assert.deepEqual([on.state, on.betasOff, on.betasValue], ['opus', true, '"1"'])
      assert.ok(!JSON.stringify(on).includes(MARKER))
      assert.equal((await read({ [BETAS]: 'TRUE ' })).betasOff, true)
      assert.equal((await read({ [BETAS]: '0', X: MARKER })).betasOff, undefined)
      const bad = await read('not an object')
      assert.deepEqual([bad.state, bad.why], ['blocked', 'unsafe'])
      assert.match(bad.reason ?? '', /env/)
      const r = await setAdvisor([a], ctx(h), 'sonnet', {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
      })
      assert.equal(r.ok, false)
      assert.equal(
        await readFile(join(a.dir, 'settings.json'), 'utf8'),
        JSON.stringify({ env: 'not an object', advisorModel: 'opus' }),
      )
    })
  })

  it('a model also removes it, keeping every other env entry, and undo puts the file back byte for byte', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'main')
      const before = pretty({ model: 'sonnet', env: { [BETAS]: '1', FOO: MARKER } })
      await h.write('.claude/settings.json', before)
      const groups = await advisorGroups([a], ctx(h))
      const plan = advisorPlan(groups, 'opus', { unlock: false, apiBetasOff: false })
      assert.deepEqual([plan.todo.length, plan.betas.length, plan.unlock], [1, 1, true])
      assert.equal(advisorPlan(groups, 'off', { unlock: false, apiBetasOff: false }).todo.length, 0)
      const r = await setAdvisor([a], ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: false,
        apiBetasOff: false,
      })
      assert.equal(r.ok, true)
      assert.match(r.results[0]?.message ?? '', /Removed env\.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS/)
      assert.match(r.message, /other experimental features back on/)
      assert.ok(!JSON.stringify(r).includes(MARKER))
      assert.deepEqual(await json(join(a.dir, 'settings.json')), {
        model: 'sonnet',
        env: { FOO: MARKER },
        advisorModel: 'opus',
      })
      const dir = h.path('.local/state/sideby/advisor')
      for (const f of await readdir(dir)) assert.ok(!(await readFile(join(dir, f), 'utf8')).includes(MARKER))
      const [after] = await advisorGroups([a], ctx(h))
      assert.deepEqual([after?.state, after?.betasOff, after?.undo], ['opus', undefined, true])
      assert.equal(
        (await undoAdvisor([a], ctx(h), { configFile: configFile(h), unlock: true, apiBetasOff: false })).ok,
        true,
      )
      assert.equal(await readFile(join(a.dir, 'settings.json'), 'utf8'), before)
    })
  })

  it('removes it where the file already names the model, and keeps an env it emptied', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'main')
      await h.write('.claude/settings.json', pretty({ advisorModel: 'opus', env: { [BETAS]: 'yes' } }))
      const plan = advisorPlan(await advisorGroups([a], ctx(h)), 'opus', { unlock: true, apiBetasOff: false })
      assert.deepEqual([plan.todo.length, plan.betas.length, plan.unlock], [1, 1, false])
      const r = await setAdvisor([a], ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
      })
      assert.deepEqual([r.ok, r.results.length], [true, 1])
      assert.deepEqual(await json(join(a.dir, 'settings.json')), { advisorModel: 'opus', env: {} })
    })
  })

  it('undo leaves the variable alone when the user set it again, and off never touches it', async () => {
    await withFakeHome(async (h) => {
      const a = acct(h, 'main')
      await h.write('.claude/settings.json', pretty({ env: { [BETAS]: '1' } }))
      await setAdvisor([a], ctx(h), 'fable', { configFile: configFile(h), unlock: true, apiBetasOff: false })
      await writeFile(
        join(a.dir, 'settings.json'),
        pretty({ env: { FOO: 'x', [BETAS]: 'true' }, advisorModel: 'fable' }),
      )
      assert.equal(
        (await undoAdvisor([a], ctx(h), { configFile: configFile(h), unlock: true, apiBetasOff: false })).ok,
        true,
      )
      assert.deepEqual(await json(join(a.dir, 'settings.json')), { env: { FOO: 'x', [BETAS]: 'true' } })
      const mid = pretty({ a: 1, advisorModel: 'opus', env: { [BETAS]: '1' }, z: 2 })
      await writeFile(join(a.dir, 'settings.json'), mid)
      const off = await setAdvisor([a], ctx(h), 'off', {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
      })
      assert.equal(off.ok, true)
      assert.deepEqual(await json(join(a.dir, 'settings.json')), { a: 1, env: { [BETAS]: '1' }, z: 2 })
      assert.equal(
        (await undoAdvisor([a], ctx(h), { configFile: configFile(h), unlock: true, apiBetasOff: false })).ok,
        true,
      )
      assert.equal(await readFile(join(a.dir, 'settings.json'), 'utf8'), mid)
    })
  })

  it('status names the variable when sideby itself runs with it, and a false value does not count', async () => {
    await withFakeHome(async (h) => {
      assert.equal(
        (await advisorStatus([], ctx(h, { ...h.env, [BETAS]: '1' }), { unlock: true, apiBetasOff: false }))
          .envOff,
        BETAS,
      )
      assert.equal(
        (await advisorStatus([], ctx(h, { ...h.env, [BETAS]: '0' }), { unlock: true, apiBetasOff: false }))
          .envOff,
        undefined,
      )
      const env: Record<string, string> = { [BETAS]: 'true' }
      assert.equal(unlockAdvisorEnv(env, 'claude', { kind: 'subscription' }), false)
    })
  })
})

describe('unlocking the advisor at launch (spec §3.41)', () => {
  it('sets the variable for a Claude subscription Account only, and never over a variable that turns it off', () => {
    const sub = { kind: 'subscription' as const }
    const env: Record<string, string> = {}
    assert.equal(unlockAdvisorEnv(env, 'claude', sub), true)
    assert.equal(env[ADVISOR_UNLOCK_VAR], '1')
    for (const [fam, kind, e] of [
      ['claude', 'api', {}],
      ['codex', 'subscription', {}],
      ['claude', 'subscription', { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' }],
      ['claude', 'subscription', { CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: 'true' }],
      ['claude', 'subscription', { [ADVISOR_UNLOCK_VAR]: '0' }],
    ] as const) {
      const copy: Record<string, string> = { ...e }
      assert.equal(unlockAdvisorEnv(copy, fam, { kind }), false)
      assert.deepEqual(copy, e)
    }
  })

  it('prepareLaunch sets it only while config advisor.unlock is on, for Claude subscription runs', async () => {
    await withFakeHome(async (h) => {
      const { claudePlugin } = await import('../families/claude/index.ts')
      await h.write('.claude/settings.json', '{}')
      await h.write('.claude-api/settings.json', '{}')
      await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://example.com\n', 0o600)
      const launch = async (ref: string, command: 'run' | 'login' = 'run', env = h.env) => {
        const rt = await createRuntime({ env, builtins: [asBuiltin(claudePlugin)] })
        return (await rt.prepareLaunch(ref, [], command)).env[ADVISOR_UNLOCK_VAR]
      }
      await h.write('.config/sideby/config.json', '{"claudeMod":false}\n')
      assert.equal(await launch('claude:main'), undefined)
      await h.write('.config/sideby/config.json', '{"claudeMod":false,"advisor":{"unlock":true}}\n')
      assert.equal(await launch('claude:main'), '1')
      assert.equal(await launch('claude:api'), undefined)
      assert.equal(await launch('claude:main', 'login'), undefined)
      assert.equal(
        await launch('claude:main', 'run', { ...h.env, CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' }),
        undefined,
      )
    })
  })
})

describe('API Accounts that share a file which turns experimental features off (spec §3.41)', () => {
  const BETAS = 'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS'
  const CONFIG = '{"claudeMod":false}\n'
  const pretty = (o: object) => `${JSON.stringify(o, null, 2)}\n`

  it('apiBetasEnv sets the variable for a Claude API Account only, and never over a value already set', () => {
    const env: Record<string, string> = { KEEP: 'x' }
    assert.equal(apiBetasEnv(env, 'claude', { kind: 'api' }), true)
    assert.deepEqual(env, { KEEP: 'x', [BETAS]: '1' })
    for (const [fam, kind, e] of [
      ['claude', 'subscription', {}],
      ['codex', 'api', {}],
      ['claude', 'api', { [BETAS]: '0' }],
      ['claude', 'api', { [BETAS]: '' }],
    ] as const) {
      const copy: Record<string, string> = { ...e }
      assert.equal(apiBetasEnv(copy, fam, { kind }), false)
      assert.deepEqual(copy, e)
    }
  })

  /** main and work (subscriptions) and api (an API Account) all use main's settings.json, which sets the variable. */
  async function shared(h: FakeHome, env: object = { [BETAS]: '1', X: MARKER }) {
    const { claudePlugin } = await import('../families/claude/index.ts')
    const before = pretty({ model: 'sonnet', env })
    await h.write('.claude/settings.json', before, 0o644)
    for (const name of ['work', 'api']) {
      await mkdir(h.path(`.claude-${name}`), { recursive: true })
      await symlink(h.path('.claude/settings.json'), h.path(`.claude-${name}/settings.json`))
    }
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://example.com\n', 0o600)
    await h.write('.config/sideby/config.json', CONFIG)
    const runtime = () => createRuntime({ env: h.env, builtins: [asBuiltin(claudePlugin)] })
    const launchEnv = async (ref: string) => (await (await runtime()).prepareLaunch(ref, [], 'run')).env
    return { before, runtime, launchEnv }
  }

  it('one change removes it from the file and turns config claude.apiBetasOff on; undo puts both back', async () => {
    await withFakeHome(async (h) => {
      const { before, runtime, launchEnv } = await shared(h)
      assert.equal((await launchEnv('claude:api'))[BETAS], undefined)
      const rt = await runtime()
      const st = await rt.advisor()
      assert.equal(st.apiBetasOff, false)
      assert.deepEqual(
        st.groups.map((g) => [g.accounts, g.apiAccounts, g.betasOff]),
        [[['claude:main', 'claude:work'], ['claude:api'], true]],
      )
      const plan = advisorPlan(st.groups, 'opus', st)
      assert.deepEqual([plan.betas.length, plan.apiAccounts, plan.apiBetas], [1, ['claude:api'], true])
      assert.equal(advisorPlan(st.groups, 'off', st).apiBetas, false)

      const r = await rt.advisorSet('opus')
      assert.deepEqual([r.ok, r.apiBetas], [true, true])
      assert.match(r.message, /claude:api still get CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1 from sideby/)
      assert.deepEqual(await json(h.path('.claude/settings.json')), {
        model: 'sonnet',
        env: { X: MARKER },
        advisorModel: 'opus',
      })
      assert.deepEqual((await json(configFile(h))).claude, { apiBetasOff: true })
      // The API Account gets it from sideby now; the subscription Accounts do not.
      assert.equal((await launchEnv('claude:api'))[BETAS], '1')
      assert.equal((await launchEnv('claude:main'))[BETAS], undefined)
      const after = await (await runtime()).advisor()
      assert.deepEqual(
        [after.apiBetasOff, after.groups[0]?.undo, after.groups[0]?.undoApiBetas],
        [true, true, true],
      )
      const dir = h.path('.local/state/sideby/advisor')
      for (const f of await readdir(dir)) assert.ok(!(await readFile(join(dir, f), 'utf8')).includes(MARKER))
      for (const out of [st, r, after]) assert.ok(!JSON.stringify(out).includes(MARKER))
      assert.ok(!(await readFile(configFile(h), 'utf8')).includes(MARKER))

      const u = await (await runtime()).advisorUndo()
      assert.deepEqual([u.ok, u.apiBetas], [true, false])
      assert.match(u.message, /no longer adds CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS/)
      assert.equal(await readFile(h.path('.claude/settings.json'), 'utf8'), before)
      assert.equal((await stat(h.path('.claude/settings.json'))).mode & 0o777, 0o644)
      assert.ok((await lstat(h.path('.claude-api/settings.json'))).isSymbolicLink())
      assert.deepEqual(await json(configFile(h)), { claudeMod: false, advisor: { unlock: true } })
      assert.equal((await launchEnv('claude:api'))[BETAS], undefined)
    })
  })

  it("the Account's proxy.env and the environment still decide", async () => {
    await withFakeHome(async (h) => {
      const { runtime, launchEnv } = await shared(h)
      await (await runtime()).advisorSet('sonnet')
      await h.write('.claude-api/proxy.env', `ANTHROPIC_BASE_URL=https://example.com\n${BETAS}=0\n`, 0o600)
      assert.equal((await launchEnv('claude:api'))[BETAS], '0')
      await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://example.com\n', 0o600)
      const { claudePlugin } = await import('../families/claude/index.ts')
      const rt = await createRuntime({
        env: { ...h.env, [BETAS]: 'false' },
        builtins: [asBuiltin(claudePlugin)],
      })
      assert.equal((await rt.prepareLaunch('claude:api', [], 'run')).env[BETAS], 'false')
    })
  })

  it('with config claude.apiBetasOff already on, the change and its undo leave it on', async () => {
    await withFakeHome(async (h) => {
      const { before, runtime } = await shared(h)
      await h.write('.config/sideby/config.json', '{"claudeMod":false,"claude":{"apiBetasOff":true}}\n')
      const st = await (await runtime()).advisor()
      const plan = advisorPlan(st.groups, 'opus', st)
      assert.deepEqual([plan.apiAccounts, plan.apiBetas], [['claude:api'], false])
      const r = await (await runtime()).advisorSet('opus')
      assert.deepEqual([r.ok, r.apiBetas], [true, undefined])
      const u = await (await runtime()).advisorUndo()
      assert.deepEqual([u.ok, u.apiBetas], [true, undefined])
      assert.equal(await readFile(h.path('.claude/settings.json'), 'utf8'), before)
      assert.deepEqual((await json(configFile(h))).claude, { apiBetasOff: true })
    })
  })

  it('undo leaves the config alone once the user turned it off, and keeps it on while a file still lacks the variable', async () => {
    await withFakeHome(async (h) => {
      const { runtime } = await shared(h)
      await (await runtime()).advisorSet('opus')
      await h.write('.config/sideby/config.json', '{"claudeMod":false,"claude":{"apiBetasOff":false}}\n')
      const u = await (await runtime()).advisorUndo()
      assert.deepEqual([u.ok, u.apiBetas], [true, undefined])
      assert.deepEqual((await json(configFile(h))).claude, { apiBetasOff: false })

      // The user put a value of their own into env meanwhile that is not true: the variable does not come back, so
      // the API Accounts keep getting it from sideby.
      await h.write('.config/sideby/config.json', CONFIG)
      await (await runtime()).advisorSet('opus')
      const s = pretty({ model: 'sonnet', env: { X: MARKER }, advisorModel: 'opus' })
      assert.equal(await readFile(h.path('.claude/settings.json'), 'utf8'), s)
      await writeFile(
        h.path('.claude/settings.json'),
        pretty({ model: 'sonnet', env: { [BETAS]: '0' }, advisorModel: 'opus' }),
      )
      const kept = await (await runtime()).advisorUndo()
      assert.deepEqual([kept.ok, kept.apiBetas], [true, undefined])
      assert.match(kept.message, /still get CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS from sideby/)
      assert.deepEqual((await json(configFile(h))).claude, { apiBetasOff: true })
    })
  })

  it('a file only API Accounts use is never offered, and a subscription-only file never turns the config on', async () => {
    await withFakeHome(async (h) => {
      const api = acct(h, 'api', 'claude', 'api')
      const main = acct(h, 'main')
      const apiFile = pretty({ env: { [BETAS]: '1' } })
      await h.write('.claude-api/settings.json', apiFile)
      await h.write('.claude/settings.json', pretty({ env: { [BETAS]: '1' } }))
      const groups = await advisorGroups([main, api], ctx(h))
      assert.deepEqual(
        groups.map((g) => [g.accounts, g.apiAccounts]),
        [[['claude:main'], undefined]],
      )
      assert.equal(advisorPlan(groups, 'opus', { unlock: true, apiBetasOff: false }).apiBetas, false)
      const r = await setAdvisor([main, api], ctx(h), 'opus', {
        configFile: configFile(h),
        unlock: true,
        apiBetasOff: false,
      })
      assert.deepEqual([r.ok, r.apiBetas], [true, undefined])
      assert.equal(await readFile(h.path('.claude-api/settings.json'), 'utf8'), apiFile)
      await assert.rejects(stat(configFile(h)))
    })
  })
})
