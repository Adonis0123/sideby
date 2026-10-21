import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../../testing/index.ts'
import { defProblems } from '../../plugins/check.ts'
import { mainOnlyProblem } from '../../plugins/loader.ts'
import { createRuntime } from '../../runtime.ts'
import { agyFamily, agyPlugin } from './index.ts'
import { AGY_QUOTA_ARGS, agyQuota } from './quota.ts'

const builtins = [{ plugin: agyPlugin, version: '0.1.0', description: '', defaultEnabled: true }]
const MAIN = '.gemini/antigravity-cli'
const RESET = '2026-10-25T10:47:45Z'

/** agy's `/usage` answer, as agy 1.4.4 writes it (2026-10-21), with fake numbers. */
const usage = {
  conversation_id: '',
  status: 'SUCCESS',
  response: 'Gemini Models\tWeekly Limit Remaining\t97%',
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      description: 'Usage limits',
      groups: [
        {
          name: 'Gemini Models',
          description: 'Models within this group: Gemini Flash, Gemini Pro',
          buckets: [
            { id: 'gemini-weekly', window: 'weekly', remaining_fraction: 0.97, reset_time: RESET },
            { id: 'gemini-5h', window: '5h', remaining_fraction: 0.5, reset_time: RESET },
          ],
        },
        {
          name: 'Gemini 4 Argon',
          buckets: [{ id: 'argon-weekly', window: 'weekly', remaining_fraction: 0, reset_time: RESET }],
        },
      ],
    },
  },
}
const signedOut = { conversation_id: '', status: 'ERROR', error: 'authentication failed or timed out' }

/** A fake `agy` that records how it was started and answers as `<bin>/agy.mode` says: `ok`, `auth`, `odd` or `exit`. */
async function fakeAgy(h: FakeHome, mode = 'ok'): Promise<void> {
  await writeFile(join(h.bin, 'agy.mode'), mode)
  const answers = { ok: usage, auth: signedOut, odd: { status: 'SUCCESS', command: { data: {} } } }
  const script = `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(join(h.bin, 'agy.log'))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n')
const mode = fs.readFileSync(${JSON.stringify(join(h.bin, 'agy.mode'))}, 'utf8').trim()
if (mode === 'exit') process.exit(1)
process.stderr.write('Authentication required. Please visit the URL to log in: https://example.invalid/secret-link\\n')
process.stdout.write(JSON.stringify(${JSON.stringify(answers)}[mode]))
process.exit(mode === 'ok' ? 0 : 1)
`
  await writeFile(join(h.bin, 'agy'), script, { mode: 0o755 })
}

async function agyRuns(h: FakeHome): Promise<{ argv: string[]; env: Record<string, string> }[]> {
  try {
    return (await readFile(join(h.bin, 'agy.log'), 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

describe('Antigravity CLI family (ADR-0047)', () => {
  it('finds only the Main Account, never another directory in HOME', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{}\n')
      await h.mkdir('.gemini/antigravity-cli-work')
      await h.mkdir('.gemini-work/antigravity-cli')
      const rt = await createRuntime({ env: h.env, builtins })
      assert.deepEqual(
        (await rt.accounts()).map((a) => a.ref),
        ['agy:main'],
      )
    })
  })

  it('has no Account before agy has run once', async () => {
    await withFakeHome(async (h) => {
      const rt = await createRuntime({ env: h.env, builtins })
      assert.deepEqual(await rt.accounts(), [])
    })
  })

  it('launches with the sign-in variables cleared, no select variable and HOME unchanged', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      const env = {
        ...h.env,
        GEMINI_API_KEY: 'k1',
        GOOGLE_API_KEY: 'k2',
        AGY_ADC_AUTH: '1',
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
        GOOGLE_GENAI_USE_ENTERPRISE: 'true',
        ANTIGRAVITY_PROJECT_ID: 'p',
        GOOGLE_CLOUD_PROJECT: 'kept',
        AGY_ACCOUNT: 'github',
      }
      const rt = await createRuntime({ env, builtins })
      const p = await rt.prepareLaunch('agy:main', ['--model', 'gemini-3.8-flash-low'], 'run')
      assert.equal(p.bin, 'agy')
      assert.deepEqual(p.args, ['--model', 'gemini-3.8-flash-low'])
      for (const v of agyFamily.hijackVars) assert.equal(p.env[v], undefined, v)
      assert.equal(p.env.GOOGLE_CLOUD_PROJECT, 'kept')
      assert.equal(p.env.AGY_ACCOUNT, 'github')
      assert.equal(p.env.HOME, h.env.HOME)
      assert.equal(p.env.SIDEBY_ACCOUNT, 'agy:main')
    })
  })

  it('signs in by starting agy itself', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      const rt = await createRuntime({ env: h.env, builtins })
      const c = await rt.launchCommand('agy:main', [], 'login')
      assert.equal(c.bin, 'agy')
      assert.deepEqual(c.args, [])
      assert.match((c as { notice?: string }).notice ?? '', /sign in with your Google account/)
    })
  })

  it('starts an AI Task without the permission bypass', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      const rt = await createRuntime({ env: h.env, builtins })
      const p = await rt.prepareLaunch('agy:main', ['--dangerously-skip-permissions', '-p', 'hi'], 'run', {
        aiTask: true,
      })
      assert.deepEqual(p.args, ['-p', 'hi'])
    })
  })

  it('refuses to create another Account, API Accounts too, before writing anything', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      const rt = await createRuntime({ env: h.env, builtins })
      const before = await snapshot(h.home)
      for (const api of [false, true])
        await assert.rejects(rt.createAccount('agy', 'work', { api }), (err: Error & { code?: string }) => {
          assert.equal(err.code, 'family-main-only')
          assert.match(err.message, /supports only its main account/)
          assert.match(err.message, /sideby run agy:main/)
          return true
        })
      assert.deepEqual(diffSnapshots(before, await snapshot(h.home)), [])
    })
  })
})

describe('Main-only Family contract (ADR-0047)', () => {
  const base = {
    id: 'tool',
    title: 'Tool',
    bin: 'tool',
    installUrl: 'https://example.invalid/tool',
    hijackVars: [],
    apiVars: [],
    sharedItems: [],
    login: { args: null, hint: 'sign in' },
  }

  it('accepts mainOnly with neither selectVar nor layout.account, and both without mainOnly', () => {
    assert.equal(mainOnlyProblem({ ...base, mainOnly: true, layout: { main: '.tool' } }), undefined)
    assert.equal(
      mainOnlyProblem({
        ...base,
        selectVar: 'TOOL_HOME',
        layout: { main: '.tool', account: '.tool-<name>' },
      }),
      undefined,
    )
    assert.deepEqual(defProblems({ ...base, mainOnly: true, layout: { main: '.tool' } }), [])
  })

  it('rejects every other combination', () => {
    assert.match(
      mainOnlyProblem({ ...base, mainOnly: true, selectVar: 'TOOL_HOME', layout: { main: '.tool' } }) ?? '',
      /must leave out selectVar and layout.account/,
    )
    assert.match(
      mainOnlyProblem({ ...base, mainOnly: true, layout: { main: '.tool', account: '.tool-<name>' } }) ?? '',
      /must leave out/,
    )
    assert.match(
      mainOnlyProblem({ ...base, mainOnly: false, layout: { main: '.tool' } }) ?? '',
      /true or left out/,
    )
    // A forgotten selectVar is still reported as missing, not taken for a Main-only Family.
    const codes = defProblems({ ...base, layout: { main: '.tool' } }).map((p) => p.code)
    assert.ok(codes.includes('select-var.missing'), codes.join(','))
    assert.ok(codes.includes('field.layout'), codes.join(','))
    assert.ok(
      defProblems({ ...base, mainOnly: true, selectVar: 'TOOL_HOME', layout: { main: '.tool' } }).some(
        (p) => p.code === 'field.mainOnly',
      ),
    )
  })

  it('a Plugin registering a mixed shape fails to load', async () => {
    await withFakeHome(async (h) => {
      const bad = {
        name: 'bad',
        register(api: { family(def: unknown): void }) {
          api.family({ ...base, mainOnly: true, selectVar: 'TOOL_HOME', layout: { main: '.tool' } })
        },
      }
      const rt = await createRuntime({
        env: h.env,
        builtins: [{ plugin: bad as never, version: '0.1.0', description: '', defaultEnabled: true }],
      })
      assert.ok(!(await rt.familyInfo()).some((f) => f.id === 'tool'))
    })
  })
})

describe('Antigravity CLI quota (ADR-0048)', () => {
  it('reads each model group as its own window, keeping only names, windows, percentages and reset times', () => {
    const q = agyQuota(usage, '2026-10-21T08:00:00.000Z')
    assert.deepEqual(q, {
      status: 'ok',
      observedAt: '2026-10-21T08:00:00.000Z',
      source: 'agy /usage',
      windows: [
        {
          label: '7d',
          name: 'Gemini Models',
          windowMinutes: 10080,
          usedPercent: 3,
          resetsAt: '2026-10-25T10:47:45.000Z',
        },
        {
          label: '5h',
          name: 'Gemini Models',
          windowMinutes: 300,
          usedPercent: 50,
          resetsAt: '2026-10-25T10:47:45.000Z',
        },
        {
          label: '7d',
          name: 'Gemini 4 Argon',
          windowMinutes: 10080,
          usedPercent: 100,
          resetsAt: '2026-10-25T10:47:45.000Z',
        },
      ],
    })
    assert.doesNotMatch(JSON.stringify(q), /Gemini Flash|description/)
    assert.equal(agyQuota(signedOut, '2026-10-21T08:00:00.000Z'), null)
  })

  it('asks agy /usage with the launch environment and writes nothing outside sideby state', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{}\n')
      await fakeAgy(h)
      const rt = await createRuntime({ env: { ...h.env, GEMINI_API_KEY: 'leak-me' }, builtins })
      const before = await snapshot(h.home)
      const q = await rt.quota(await rt.resolve('agy:main'))
      assert.equal(q.status, 'ok')
      if (q.status !== 'ok') return
      assert.equal(q.fetched, true)
      assert.equal(q.windows.length, 3)
      const runs = await agyRuns(h)
      assert.deepEqual(
        runs.map((r) => r.argv),
        [[...AGY_QUOTA_ARGS]],
      )
      assert.equal(runs[0]!.env.GEMINI_API_KEY, undefined)
      const changed = diffSnapshots(before, await snapshot(h.home))
      assert.deepEqual(
        changed.filter(
          (p) => !['.local', '.local/state'].includes(p) && !p.startsWith('.local/state/sideby'),
        ),
        [],
      )
    })
  })

  it('says to sign in when agy is signed out, without repeating what agy printed', async () => {
    const cases: [string, RegExp][] = [
      ['auth', /not signed in; run `sideby login agy:main`/],
      ['odd', /does not recognise; update sideby/],
      ['exit', /exited without answering/],
    ]
    for (const [mode, detail] of cases)
      await withFakeHome(async (h) => {
        await h.mkdir(MAIN)
        await fakeAgy(h, mode)
        const rt = await createRuntime({ env: h.env, builtins })
        const q = await rt.quota(await rt.resolve('agy:main'))
        assert.equal(q.status, 'unavailable', mode)
        if (q.status !== 'unavailable') return
        assert.match(q.detail ?? '', detail, mode)
        assert.doesNotMatch(JSON.stringify(q), /secret-link|authentication failed/)
      })
  })

  it('stays off under quota.check.agy: false', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      await fakeAgy(h)
      await h.write('.config/sideby/config.json', `${JSON.stringify({ quota: { check: { agy: false } } })}\n`)
      const rt = await createRuntime({ env: h.env, builtins })
      const q = await rt.quota(await rt.resolve('agy:main'))
      assert.equal(q.status, 'unavailable')
      assert.deepEqual(await agyRuns(h), [])
    })
  })
})
