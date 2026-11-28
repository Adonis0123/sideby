import assert from 'node:assert/strict'
import { access, lstat, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  diffSnapshots,
  type FakeHome,
  fakeHost,
  readHostLog,
  snapshot,
  withFakeHome,
} from '../../../testing/index.ts'
import { sideby } from '../../cli/cli-test-helpers.ts'
import { discoverAccounts } from '../../core/accounts.ts'
import { orcaChatBindingsFile, orcaChatSessionId } from '../../core/orca-chat-bindings.ts'
import { defProblems } from '../../plugins/check.ts'
import { mainOnlyProblem } from '../../plugins/loader.ts'
import { createRuntime } from '../../runtime.ts'
import type { FamilyDef } from '../../types.ts'
import { AGY_FORCE_FILE_TOKEN_VAR, AGY_OAUTH_TOKEN_FILE, agyFamily, agyPlugin } from './index.ts'
import { AGY_QUOTA_ARGS, agyLastActivityAt, agyQuota, agyQuotaFetch, fetchAgyQuota } from './quota.ts'

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

/** A fake `agy` that records how it was started and answers as `<bin>/agy.mode` says: `ok`, `auth`, `odd`, `exit` or `badflag`. */
async function fakeAgy(h: FakeHome, mode = 'ok'): Promise<void> {
  await writeFile(join(h.bin, 'agy.mode'), mode)
  const answers = { ok: usage, auth: signedOut, odd: { status: 'SUCCESS', command: { data: {} } } }
  const script = `#!${process.execPath}
const fs = require('node:fs')
fs.appendFileSync(${JSON.stringify(join(h.bin, 'agy.log'))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }) + '\\n')
const mode = fs.readFileSync(${JSON.stringify(join(h.bin, 'agy.mode'))}, 'utf8').trim()
if (mode === 'exit') process.exit(1)
if (mode === 'badflag') {
  process.stderr.write('flag provided but not defined: -app_data_dir\\n')
  process.exit(2)
}
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

describe('Antigravity CLI family (ADR-0090)', () => {
  it('discovers main and real antigravity-cli-<name> accounts under .gemini, ignoring siblings, backups, and symlinks', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{}\n')
      await h.mkdir('.gemini/antigravity-cli-work')
      await h.write(`.gemini/antigravity-cli-002/${AGY_OAUTH_TOKEN_FILE}`, 'secret-token', 0o600)
      await h.write('.gemini/antigravity-ide/settings.json', '{}\n')
      await h.write('.gemini/antigravity-backup/settings.json', '{}\n')
      await h.mkdir('.gemini-work/antigravity-cli')
      await h.mkdir('sym-target')
      await symlink(h.path('sym-target'), h.path('.gemini/antigravity-cli-sym'))
      const rt = await createRuntime({ env: h.env, builtins })
      assert.deepEqual(
        (await rt.accounts()).map((a) => a.ref),
        ['agy:main', 'agy:002', 'agy:work'],
      )
      // WHY: symlinked ~/.gemini must never be walked during account discovery (ADR-0090).
      await withFakeHome(async (h2) => {
        await h2.mkdir('outside/antigravity-cli-evil')
        await symlink(h2.path('outside'), h2.path('.gemini'))
        const rt2 = await createRuntime({ env: h2.env, builtins })
        assert.deepEqual(await rt2.accounts(), [])
      })
    })
  })

  it('has no Account before agy has run once', async () => {
    await withFakeHome(async (h) => {
      const rt = await createRuntime({ env: h.env, builtins })
      assert.deepEqual(await rt.accounts(), [])
    })
  })

  it('isolates non-main launches with --app_data_dir and forced file token storage, and clears it for main', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      await h.mkdir('.gemini/antigravity-cli-work')
      const env = {
        ...h.env,
        GEMINI_API_KEY: 'k1',
        GOOGLE_API_KEY: 'k2',
        AGY_ADC_AUTH: '1',
        GOOGLE_GENAI_USE_VERTEXAI: 'true',
        GOOGLE_GENAI_USE_ENTERPRISE: 'true',
        ANTIGRAVITY_PROJECT_ID: 'p',
        [AGY_FORCE_FILE_TOKEN_VAR]: '1',
        GOOGLE_CLOUD_PROJECT: 'kept',
        AGY_ACCOUNT: 'github',
      }
      const rt = await createRuntime({ env, builtins })
      const mainLaunch = await rt.prepareLaunch('agy:main', ['--model', 'gemini-3.8-flash-low'], 'run')
      assert.equal(mainLaunch.bin, 'agy')
      assert.equal(mainLaunch.args[0], '--settings')
      assert.deepEqual(mainLaunch.args.slice(2), ['--model', 'gemini-3.8-flash-low'])
      await mainLaunch.cleanup?.()
      for (const v of agyFamily.hijackVars) assert.equal(mainLaunch.env[v], undefined, v)
      assert.equal(mainLaunch.env.GOOGLE_CLOUD_PROJECT, 'kept')
      assert.equal(mainLaunch.env.AGY_ACCOUNT, 'github')
      assert.equal(mainLaunch.env.HOME, h.env.HOME)
      assert.equal(mainLaunch.env.SIDEBY_ACCOUNT, 'agy:main')

      const workLaunch = await rt.prepareLaunch('agy:work', ['--model', 'gemini-3.8-flash-low'], 'run')
      assert.equal(workLaunch.args[0], '--settings')
      assert.deepEqual(workLaunch.args.slice(2), [
        '--app_data_dir=antigravity-cli-work',
        '--model',
        'gemini-3.8-flash-low',
      ])
      await workLaunch.cleanup?.()
      assert.equal(workLaunch.env[AGY_FORCE_FILE_TOKEN_VAR], '1')
      assert.equal(workLaunch.env.GEMINI_API_KEY, undefined)
      assert.equal(workLaunch.env.HOME, h.env.HOME)
      assert.equal(workLaunch.env.SIDEBY_ACCOUNT, 'agy:work')
    })
  })

  it('passes --app_data_dir on non-main login and checks token file existence for loginState', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      await h.mkdir('.gemini/antigravity-cli-002')
      const rt = await createRuntime({ env: h.env, builtins })
      const mainLogin = await rt.launchCommand('agy:main', [], 'login')
      assert.equal(mainLogin.bin, 'agy')
      assert.deepEqual(mainLogin.args, [])
      assert.match((mainLogin as { notice?: string }).notice ?? '', /sign in with your Google account/)

      const subLogin = await rt.launchCommand('agy:002', [], 'login')
      assert.deepEqual(subLogin.args, ['--app_data_dir=antigravity-cli-002'])
      const subProbe = await rt.prepareLaunch('agy:002', agyFamily.probe!.args, 'run')
      assert.deepEqual(subProbe.args, ['--app_data_dir=antigravity-cli-002', '-p', 'Reply with OK'])
      assert.equal(subProbe.env[AGY_FORCE_FILE_TOKEN_VAR], '1')

      const acctMain = await rt.resolve('agy:main')
      const acct002 = await rt.resolve('agy:002')
      assert.equal(await agyFamily.loginState!(acctMain), 'unknown')
      assert.equal(await agyFamily.loginState!(acct002), 'logged-out')
      await h.write(`.gemini/antigravity-cli-002/${AGY_OAUTH_TOKEN_FILE}`, 'tok', 0o600)
      assert.equal(await agyFamily.loginState!(acct002), 'logged-in')
    })
  })

  it('starts an AI Task without the permission bypass', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      await h.mkdir('.gemini/antigravity-cli-002')
      const rt = await createRuntime({ env: h.env, builtins })
      const p = await rt.prepareLaunch('agy:main', ['--dangerously-skip-permissions', '-p', 'hi'], 'run', {
        aiTask: true,
      })
      assert.deepEqual(p.args, ['-p', 'hi'])
      const p2 = await rt.prepareLaunch('agy:002', ['--dangerously-skip-permissions', '-p', 'hi'], 'run', {
        aiTask: true,
      })
      assert.deepEqual(p2.args, ['--app_data_dir=antigravity-cli-002', '-p', 'hi'])
    })
  })

  it('creates extra subscription accounts, fixes token permissions safely in doctor, and refuses --api before writing', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{"theme":"light"}\n')
      await h.write(`${MAIN}/skills/demo/SKILL.md`, '# Demo\n')
      await h.write(`${MAIN}/conversations/main-only.db`, 'main-db')
      const rt = await createRuntime({ env: h.env, builtins })

      const beforeApi = await snapshot(h.home)
      await assert.rejects(
        rt.createAccount('agy', 'work', { api: true }),
        (err: Error & { code?: string }) => {
          assert.equal(err.code, 'create-refused')
          assert.match(err.message, /API key accounts are not supported/)
          return true
        },
      )
      assert.deepEqual(diffSnapshots(beforeApi, await snapshot(h.home)), [])

      const created = await rt.createAccount('agy', 'work')
      assert.equal(created.ok, true)
      assert.equal(created.account.ref, 'agy:work')
      assert.equal((await stat(created.account.dir)).mode & 0o777, 0o700)
      const sharedPaths = created.steps.map((s) => s.item)
      assert.deepEqual(sharedPaths, ['settings.json', 'skills'])
      await assert.rejects(stat(join(created.account.dir, 'conversations')))

      await h.write(`.gemini/antigravity-cli-work/${AGY_OAUTH_TOKEN_FILE}`, 'secret-tok', 0o644)
      const beforeMain = await snapshot(h.path(MAIN))
      const doc = await rt.doctor({ target: 'agy:work', fix: true })
      assert.equal(doc.fixes.length, 1)
      assert.equal((await stat(join(created.account.dir, AGY_OAUTH_TOKEN_FILE))).mode & 0o777, 0o600)
      assert.equal(await readFile(join(created.account.dir, AGY_OAUTH_TOKEN_FILE), 'utf8'), 'secret-tok')
      assert.deepEqual(diffSnapshots(beforeMain, await snapshot(h.path(MAIN))), [])

      // WHY: ADR-0090 regression guards for AGY-01, AGY-02, AGY-03, AGY-04, AGY-05, AGY-10, AGY-11, and AGY-12.
      await assert.rejects(
        rt.prepareLaunch('agy:main', ['--app_data_dir=antigravity-cli-work'], 'run'),
        /manages the Antigravity CLI account directory/,
      )
      await assert.rejects(
        rt.prepareLaunch('agy:work', ['--gemini_dir', '/tmp/evil'], 'run'),
        /manages the Antigravity CLI account directory/,
      )
      assert.ok(agyFamily.probe)
      assert.doesNotThrow(() => agyFamily.probe?.args)
      const promptOk = await rt.prepareLaunch(
        'agy:main',
        ['-p', '--app_data_dir=antigravity-cli-work'],
        'run',
      )
      assert.deepEqual(promptOk.args, ['-p', '--app_data_dir=antigravity-cli-work'])

      // WHY: ADR-0091 opens pick commands (`ag` default) and primary-group ranking for agy while keeping Auto Handoff off.
      const offer = await rt.pickSuggestion('agy')
      assert.equal(offer?.name, 'ag')
      assert.equal(offer?.exists, false)
      const pickAdded = await rt.addPickCommand('ag', 'agy', { yes: true })
      assert.equal(pickAdded.ok, true)
      assert.equal(pickAdded.status, 'added')
      assert.equal(agyFamily.handoff, undefined)

      await h.write(`${MAIN}/${AGY_OAUTH_TOKEN_FILE}`, 'main-secret-must-never-leak', 0o600)
      await h.write(
        '.config/sideby/config.json',
        `${JSON.stringify({
          extraSharedItems: {
            agy: [
              { path: AGY_OAUTH_TOKEN_FILE, mode: 'copy' },
              { path: '.', mode: 'link' },
            ],
          },
        })}\n`,
      )
      const rtExtra = await createRuntime({ env: h.env, builtins })
      const beforeExtra = await snapshot(h.path(MAIN))
      const createdExtra = await rtExtra.createAccount('agy', '003')
      assert.equal(createdExtra.steps.find((s) => s.item === AGY_OAUTH_TOKEN_FILE)?.ok, false)
      assert.equal(createdExtra.steps.find((s) => s.item === '.')?.ok, false)
      await assert.rejects(lstat(join(createdExtra.account.dir, AGY_OAUTH_TOKEN_FILE)))
      const docExtra = await rtExtra.doctor({ target: 'agy:003' })
      assert.ok(
        docExtra.accounts[0]!.findings.some(
          (f) => f.code === 'path.invalid' && f.item === AGY_OAUTH_TOKEN_FILE,
        ),
      )
      assert.deepEqual(diffSnapshots(beforeExtra, await snapshot(h.path(MAIN))), [])

      await h.write(`${MAIN}/proxy.env`, 'FOO=bar\nAGY_CLI_FORCE_FILE_TOKEN_STORAGE=1\n', 0o600)
      await h.write('.gemini/antigravity-cli-004/settings.json', '{}\n')
      await h.write('.gemini/antigravity-cli-004/proxy.env', 'SECRET_X=val\n', 0o600)
      await h.write('.gemini/antigravity-cli-onlyproxy/proxy.env', 'SECRET_Y=val\n', 0o600)
      await h.mkdir('.gemini/antigravity-cli-onlyconv/conversations')
      const rtStray = await createRuntime({ env: h.env, builtins })
      const listStray = await rtStray.accounts()
      const mainAcct = listStray.find((a) => a.ref === 'agy:main')!
      const subStray = listStray.find((a) => a.ref === 'agy:004')!
      assert.equal(mainAcct.kind, 'subscription')
      assert.equal(subStray.kind, 'subscription')
      assert.equal(
        listStray.some((a) => a.ref === 'agy:onlyproxy'),
        false,
      )
      assert.ok(listStray.some((a) => a.ref === 'agy:onlyconv'))
      const mainLaunch = await rtStray.prepareLaunch('agy:main', [], 'run')
      assert.equal(mainLaunch.env.FOO, undefined)
      assert.equal(mainLaunch.env[AGY_FORCE_FILE_TOKEN_VAR], undefined)
      const strayDoc = await rtStray.doctor({ target: 'agy:004' })
      assert.ok(strayDoc.accounts[0]!.findings.some((f) => f.code === 'secret.unsupported'))

      await h.mkdir('.gemini/antigravity-cli-symtok')
      await symlink(
        h.path(`${MAIN}/${AGY_OAUTH_TOKEN_FILE}`),
        h.path('.gemini/antigravity-cli-symtok/antigravity-oauth-token'),
      )
      await h.mkdir('.gemini/antigravity-cli-dirtok/antigravity-oauth-token')
      const rtBadTok = await createRuntime({ env: h.env, builtins })
      const badTokDoc = await rtBadTok.doctor({ target: 'agy' })
      assert.ok(
        badTokDoc.accounts
          .find((a) => a.ref === 'agy:symtok')!
          .findings.some((f) => f.code === 'symlink-forbidden'),
      )
      assert.ok(
        badTokDoc.accounts
          .find((a) => a.ref === 'agy:dirtok')!
          .findings.some((f) => f.code === 'credential.not-file'),
      )

      // AGY-11 & AGY-12: intermediate symlink guard in nested layout, double-<name>/backslash check, and ctx.hostArgs.
      const nestedFam: FamilyDef = {
        ...agyFamily,
        id: 'nest',
        layout: { main: '.nest/main', account: 'profiles/<name>/state/current' },
      }
      await h.mkdir('real-state/current')
      await h.mkdir('profiles/evil')
      await symlink(h.path('real-state'), h.path('profiles/evil/state'))
      await h.mkdir('profiles/good/state/current')
      assert.deepEqual(
        (await discoverAccounts(nestedFam, h.home)).map((a) => a.ref),
        ['nest:good'],
      )
      assert.ok(
        defProblems({ ...agyFamily, layout: { main: '.m', account: '.m-<name>-<name>' } }).some(
          (p) => p.code === 'field.layout',
        ),
      )
      assert.ok(
        defProblems({ ...agyFamily, layout: { main: '.m', account: '.dir\\<name>' } }).some(
          (p) => p.code === 'field.layout',
        ),
      )

      const seenHostArgs: (readonly string[] | undefined)[] = []
      const argPlugin = {
        name: 'arg-plug',
        register(api: { family(d: FamilyDef): void }) {
          api.family({
            ...agyFamily,
            id: 'argfam',
            layout: { main: '.argfam', account: '.argfam-<name>' },
            selectArgs: (a) => ['--cfg', a.dir],
            selectEnv: undefined,
            loginState: async () => 'logged-in',
            fetchQuota: {
              everyMinutes: 15,
              summary: 'test selectArgs forwarding',
              async fetch(_a, ctx) {
                seenHostArgs.push(ctx.hostArgs)
                return {
                  status: 'ok',
                  source: 'test-argfam',
                  observedAt: ctx.now.toISOString(),
                  windows: [
                    { label: '5h', windowMinutes: 300, usedPercent: 10, resetsAt: '2026-11-28T00:00:00Z' },
                  ],
                }
              },
            },
          })
        },
      }
      await h.mkdir('.argfam')
      await h.mkdir('.argfam-two')
      const rtArg = await createRuntime({
        env: h.env,
        builtins: [{ plugin: argPlugin as never, version: '0.1.0', description: '', defaultEnabled: true }],
      })
      await rtArg.quota(await rtArg.resolve('argfam:main'))
      await rtArg.quota(await rtArg.resolve('argfam:two'))
      assert.deepEqual(seenHostArgs, [[], ['--cfg', h.path('.argfam-two')]])
    })
  })
})

describe('Main-only Family contract (ADR-0047, ADR-0090)', () => {
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

  it('accepts mainOnly with neither selectVar/selectArgs nor layout.account, and selectVar or selectArgs without mainOnly', () => {
    assert.equal(mainOnlyProblem({ ...base, mainOnly: true, layout: { main: '.tool' } }), undefined)
    assert.equal(
      mainOnlyProblem({
        ...base,
        selectVar: 'TOOL_HOME',
        layout: { main: '.tool', account: '.tool-<name>' },
      }),
      undefined,
    )
    assert.equal(
      mainOnlyProblem({
        ...base,
        selectArgs: () => ['--dir'],
        layout: { main: '.tool', account: '.dir/.tool-<name>' },
      }),
      undefined,
    )
    assert.deepEqual(defProblems({ ...base, mainOnly: true, layout: { main: '.tool' } }), [])
    assert.deepEqual(
      defProblems({
        ...base,
        selectArgs: () => ['--dir'],
        layout: { main: '.tool', account: '.dir/.tool-<name>' },
      }),
      [],
    )
  })

  it('rejects every other combination', () => {
    assert.match(
      mainOnlyProblem({ ...base, mainOnly: true, selectVar: 'TOOL_HOME', layout: { main: '.tool' } }) ?? '',
      /must leave out selectVar.*layout.account/,
    )
    assert.match(
      mainOnlyProblem({ ...base, mainOnly: true, selectArgs: () => [], layout: { main: '.tool' } }) ?? '',
      /must leave out/,
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
    assert.equal(agyQuotaFetch.onlyWhenActive, true)
    assert.equal(agyQuotaFetch.everyMinutes, 30)
    assert.equal(agyQuotaFetch.jitterMinutes, 15)
    assert.equal(agyQuotaFetch.serialGapMs, 3_000)
  })

  it('detects local agy activity from conversation files only, ignoring logs and cache (ADR-0092)', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path(MAIN)
      await h.write(`${MAIN}/last_check.timestamp`, '')
      await h.write(`${MAIN}/log/cli.log`, 'usage\n')
      assert.equal(await agyLastActivityAt({ dir }), undefined)
      await h.write(`${MAIN}/conversation_summaries.db`, 'x')
      const t1 = await agyLastActivityAt({ dir })
      assert.ok(typeof t1 === 'number' && Number.isFinite(t1))
      await new Promise((r) => setTimeout(r, 20))
      await h.write(`${MAIN}/conversation_summaries.db-wal`, 'wal')
      const t2 = await agyLastActivityAt({ dir })
      assert.ok(typeof t2 === 'number' && t2 >= t1)
    })
  })

  it('asks agy /usage with the launch environment, isolates extra accounts via --app_data_dir, and fails explicitly if upstream drops the flag', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{}\n')
      await h.write(`.gemini/antigravity-cli-work/${AGY_OAUTH_TOKEN_FILE}`, 'tok', 0o600)
      await fakeAgy(h)
      const rt = await createRuntime({ env: { ...h.env, GEMINI_API_KEY: 'leak-me' }, builtins })
      const before = await snapshot(h.home)
      const q = await rt.quota(await rt.resolve('agy:main'))
      assert.equal(q.status, 'ok')
      if (q.status !== 'ok') return
      assert.equal(q.fetched, true)
      assert.equal(q.windows.length, 3)

      const qWork = await rt.quota(await rt.resolve('agy:work'))
      assert.equal(qWork.status, 'ok')

      const runs = await agyRuns(h)
      assert.deepEqual(
        runs.map((r) => r.argv),
        [[...AGY_QUOTA_ARGS], ['--app_data_dir=antigravity-cli-work', ...AGY_QUOTA_ARGS]],
      )
      assert.equal(runs[0]!.env.GEMINI_API_KEY, undefined)
      assert.equal(runs[0]!.env[AGY_FORCE_FILE_TOKEN_VAR], undefined)
      assert.equal(runs[1]!.env.GEMINI_API_KEY, undefined)
      assert.equal(runs[1]!.env[AGY_FORCE_FILE_TOKEN_VAR], '1')
      const changed = diffSnapshots(before, await snapshot(h.home))
      assert.deepEqual(
        changed.filter(
          (p) => !['.local', '.local/state'].includes(p) && !p.startsWith('.local/state/sideby'),
        ),
        [],
      )

      await h.write(`.gemini/antigravity-cli-002/${AGY_OAUTH_TOKEN_FILE}`, 'tok', 0o600)
      await fakeAgy(h, 'badflag')
      const bad = await rt.quota(await rt.resolve('agy:002'))
      assert.equal(bad.status, 'unavailable')
      if (bad.status !== 'unavailable') return
      assert.match(bad.detail ?? '', /no longer accepts --app_data_dir/)
      assert.doesNotMatch(bad.detail ?? '', /flag provided/)
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

/**
 * A fake `agy` that, like agy 1.5.14 whose sign-in cannot be refreshed (2026-11-23), prints a sign-in link on stderr,
 * runs `open <link>` from PATH and waits for the sign-in; on SIGTERM it prints its JSON error and exits. `<bin>/open`
 * stands for the user's browser and records that it was asked.
 */
async function signInAgy(h: FakeHome): Promise<string> {
  const opened = join(h.bin, 'browser-opened')
  await writeFile(join(h.bin, 'open'), `#!/bin/sh\necho "$@" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 })
  await writeFile(
    join(h.bin, 'agy'),
    `#!${process.execPath}
const answer = () => { process.stdout.write(JSON.stringify(${JSON.stringify(signedOut)})); process.exit(1) }
process.on('SIGTERM', answer)
process.stderr.write('Authentication required. Please visit the URL to log in:\\n  https://example.invalid/secret-link\\n')
require('node:child_process').spawnSync('open', ['https://example.invalid/secret-link'], { stdio: 'ignore' })
setTimeout(answer, 60000)
`,
    { mode: 0o755 },
  )
  return opened
}

/** A fake `agy` that does not answer and ignores SIGTERM; it writes its pid to `<bin>/agy.pid`. */
async function stuckAgy(h: FakeHome): Promise<string> {
  const pidFile = join(h.bin, 'agy.pid')
  await writeFile(
    join(h.bin, 'agy'),
    `#!${process.execPath}
process.on('SIGTERM', () => {})
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
// Ends by itself after 30 s, so a check that never stops it fails the test instead of hanging the run.
setTimeout(() => process.exit(0), 30000)
`,
    { mode: 0o755 },
  )
  return pidFile
}

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

describe('Antigravity CLI quota never opens a browser (ADR-0082)', () => {
  it('stops agy when it asks for a browser sign-in, opens nothing and says to sign in again', {
    timeout: 15_000,
  }, async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      const opened = await signInAgy(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const account = await rt.resolve('agy:main')
      const started = Date.now()
      const q = await rt.quota(account)
      assert.ok(Date.now() - started < 10_000, 'agy was stopped at once, not after its sign-in wait')
      assert.equal(await exists(opened), false, 'the browser was asked to open the sign-in page')
      assert.equal(q.status, 'unavailable')
      if (q.status !== 'unavailable') return
      assert.match(q.detail ?? '', /needs a new sign-in; run `sideby login agy:main`/)
      assert.doesNotMatch(JSON.stringify(q), /secret-link|authentication failed/)
      // The menu bar and the Panel show it as a sign-in to renew, although agy's login state is unknown.
      assert.equal((await rt.loginProblem(account))?.kind, 'expired')
      // A later good answer clears it.
      await fakeAgy(h, 'ok')
      assert.equal((await rt.quota(account, { fetch: 'force' })).status, 'ok')
      assert.equal(await rt.loginProblem(account), undefined)
    })
  })

  it('ends an agy that never answers and ignores SIGTERM, within its own time limit', {
    timeout: 15_000,
  }, async () => {
    await withFakeHome(async (h) => {
      await h.mkdir(MAIN)
      const pidFile = await stuckAgy(h)
      const rt = await createRuntime({ env: h.env, builtins })
      const account = await rt.resolve('agy:main')
      const started = Date.now()
      const q = await fetchAgyQuota(
        account,
        {
          home: h.home,
          now: new Date(),
          stateDir: join(h.home, '.local', 'state', 'sideby'),
          env: h.env,
          hostEnv: h.env,
          // Never aborts: the check must stop agy by itself.
          signal: new AbortController().signal,
        },
        { timeoutMs: 500, killAfterMs: 200 },
      )
      assert.ok(Date.now() - started < 8_000)
      assert.equal(q.status, 'unavailable')
      if (q.status !== 'unavailable') return
      assert.match(q.detail ?? '', /no answer within/)
      assert.equal(q.loginExpired, undefined)
      const pid = Number(await readFile(pidFile, 'utf8'))
      assert.throws(() => process.kill(pid, 0), /ESRCH/, 'agy is still running')
    })
  })
})

describe('Antigravity CLI pick commands, primary quota group, and Orca Chat routing (ADR-0091)', () => {
  const FUTURE = '2099-12-31T00:00:00.000Z'
  const OBSERVED = '2026-11-28T09:00:00.000Z'
  const SID = '5404a5ea-8f90-4bc4-ad82-79d27c3c43da'
  const CONV_ID = '6780ebe9-1657-443d-a2d6-3f72e0b1fa42'

  async function seedQuota(
    h: FakeHome,
    entries: Record<string, { gemini7d: number; gemini5h: number; claude7d: number; claude5h: number }>,
  ) {
    for (const [name, q] of Object.entries(entries)) {
      const entry = {
        version: 1,
        attemptedAt: OBSERVED,
        quota: {
          status: 'ok',
          observedAt: OBSERVED,
          source: 'agy /usage',
          windows: [
            {
              label: '7d',
              name: 'Gemini Models',
              windowMinutes: 10080,
              usedPercent: q.gemini7d,
              resetsAt: FUTURE,
            },
            {
              label: '5h',
              name: 'Gemini Models',
              windowMinutes: 300,
              usedPercent: q.gemini5h,
              resetsAt: FUTURE,
            },
            {
              label: '7d',
              name: 'Claude and GPT models',
              windowMinutes: 10080,
              usedPercent: q.claude7d,
              resetsAt: FUTURE,
            },
            {
              label: '5h',
              name: 'Claude and GPT models',
              windowMinutes: 300,
              usedPercent: q.claude5h,
              resetsAt: FUTURE,
            },
          ],
        },
      }
      await h.write(`.local/state/sideby/quota/agy/${name}.fetched.json`, `${JSON.stringify(entry)}\n`)
    }
  }

  it('ranks agy accounts by Gemini Models by default and follows agy.pickGroup when switched', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{}\n')
      await h.write(`.gemini/antigravity-cli-002/${AGY_OAUTH_TOKEN_FILE}`, 'tok', 0o600)
      await fakeHost(h, 'agy')
      await h.write(
        '.config/sideby/config.json',
        `${JSON.stringify({ quota: { check: { agy: false } }, pickCommands: { ag: 'agy' } })}\n`,
      )
      await seedQuota(h, {
        main: { gemini7d: 60, gemini5h: 10, claude7d: 10, claude5h: 0 },
        '002': { gemini7d: 5, gemini5h: 2, claude7d: 80, claude5h: 0 },
      })

      const defNext = await sideby(h, ['next', 'agy', '--json'])
      assert.equal(defNext.code, 0, defNext.err)
      assert.equal(JSON.parse(defNext.out).pick, 'agy:002')

      const setGroup = await sideby(h, ['config', 'set', 'agy.pickGroup', 'Claude and GPT models', '--yes'])
      assert.equal(setGroup.code, 0, setGroup.err)

      const switched = await sideby(h, ['next', 'agy', '--json'])
      assert.equal(switched.code, 0, switched.err)
      assert.equal(JSON.parse(switched.out).pick, 'agy:main')

      // WHY: verify the Panel endpoint switches agy.pickGroup and exposes updated pickNow/pickGroup (ADR-0091).
      const { createPanelHandler } = await import('../../panel/handler.ts')
      const { createServer } = await import('node:http')
      let panel!: ReturnType<typeof createPanelHandler>
      const srv = createServer((req, res) => {
        void panel(req, res)
      })
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
      try {
        const port = (srv.address() as { port: number }).port
        panel = createPanelHandler({
          runtime: () => createRuntime({ env: h.env }),
          allowedHosts: [`127.0.0.1:${port}`],
          updates: false,
        })
        const base = `http://127.0.0.1:${port}`
        const post = await fetch(`${base}/api/agy/pick-group`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: base,
            'x-sideby-token': panel.token,
          },
          body: JSON.stringify({ group: 'Gemini Models' }),
        })
        assert.equal(post.status, 200)
        const stateRes = await fetch(`${base}/api/state`, {
          headers: { 'x-sideby-token': panel.token },
        })
        const state = (await stateRes.json()) as {
          families: { id: string; pickGroup?: string }[]
          handoff?: Record<string, string>
          pickNow?: Record<string, { pick: string | null }>
        }
        assert.equal(state.families.find((f) => f.id === 'agy')?.pickGroup, 'Gemini Models')
        assert.equal(state.handoff?.agy, 'agy:002')
        assert.equal(state.pickNow?.agy?.pick, 'agy:002')
      } finally {
        await new Promise<void>((r) => srv.close(() => r()))
      }
    })
  })

  it('routes terminal resume flags to the owning agy account and pins Orca acp chats by ORCA_AGENT_SESSION_ID', async () => {
    await withFakeHome(async (h) => {
      await h.write(`${MAIN}/settings.json`, '{}\n')
      await h.write(`.gemini/antigravity-cli-002/${AGY_OAUTH_TOKEN_FILE}`, 'tok', 0o600)
      await h.write(`${MAIN}/conversations/${CONV_ID}.db`, 'sqlite')
      await fakeHost(h, 'agy')
      await h.write(
        '.config/sideby/config.json',
        `${JSON.stringify({ quota: { check: { agy: false } }, pickCommands: { ag: 'agy' } })}\n`,
      )
      await seedQuota(h, {
        main: { gemini7d: 75, gemini5h: 20, claude7d: 50, claude5h: 0 },
        '002': { gemini7d: 5, gemini5h: 0, claude7d: 10, claude5h: 0 },
      })

      // WHY: terminal --conversation must override quota and route to the account holding the .db (ADR-0091).
      const resumed = await sideby(h, ['run', 'ag', '--', '--conversation', CONV_ID])
      assert.equal(resumed.code, 0, resumed.err)
      assert.match(resumed.err, new RegExp(`session ${CONV_ID} is in agy:main; starting it there`))
      assert.equal((await readHostLog(h, 'agy'))[0]?.env.SIDEBY_ACCOUNT, 'agy:main')

      // WHY: non-acp commands run inside an Orca Chat inherit ORCA_AGENT_SESSION_ID and must never bind (ADR-0091).
      const orcaEnv = { ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: SID }
      assert.equal(orcaChatSessionId(orcaEnv, 'agy', ['-p', 'hi']), null)
      assert.equal(orcaChatSessionId(orcaEnv, 'agy', ['acp', '--dangerously-skip-permissions']), SID)

      const firstChat = await sideby(h, ['run', 'ag', '--', 'acp', '--dangerously-skip-permissions'], orcaEnv)
      assert.equal(firstChat.code, 0, firstChat.err)
      assert.match(firstChat.err, /ag → agy:002/)
      const runs1 = await readHostLog(h, 'agy')
      assert.equal(runs1[1]?.env.SIDEBY_ACCOUNT, 'agy:002')
      assert.ok(runs1[1]?.argv.includes('--app_data_dir=antigravity-cli-002'))

      // Flip quota so agy:main has far more room; waking the same Orca Chat must still return to agy:002.
      await seedQuota(h, {
        main: { gemini7d: 2, gemini5h: 0, claude7d: 5, claude5h: 0 },
        '002': { gemini7d: 90, gemini5h: 80, claude7d: 90, claude5h: 0 },
      })
      const woken = await sideby(h, ['run', 'ag', '--', 'acp', '--dangerously-skip-permissions'], orcaEnv)
      assert.equal(woken.code, 0, woken.err)
      assert.match(woken.err, new RegExp(`Orca chat ${SID} is in agy:002; starting it there`))
      assert.equal((await readHostLog(h, 'agy'))[2]?.env.SIDEBY_ACCOUNT, 'agy:002')

      // A shell command inside that Orca Chat (no `acp`) still picks by current quota (agy:main).
      const insideShell = await sideby(h, ['run', 'ag', '--', '-p', 'hi'], orcaEnv)
      assert.equal(insideShell.code, 0, insideShell.err)
      assert.match(insideShell.err, /ag → agy:main/)
      assert.equal((await readHostLog(h, 'agy'))[3]?.env.SIDEBY_ACCOUNT, 'agy:main')

      // Removing the bound account makes the next wake pick fresh and rebind cleanly.
      await rm(h.path('.gemini/antigravity-cli-002'), { recursive: true, force: true })
      const rebound = await sideby(h, ['run', 'ag', '--', 'acp', '--dangerously-skip-permissions'], orcaEnv)
      assert.equal(rebound.code, 0, rebound.err)
      assert.match(rebound.err, /ag → agy:main/)
      const saved = JSON.parse(await readFile(orcaChatBindingsFile(h.path('.local/state/sideby')), 'utf8'))
      assert.equal(saved.bindings[SID].account, 'agy:main')
    })
  })
})
