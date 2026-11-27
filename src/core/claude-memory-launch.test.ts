// Shared Project Memory at Launch (spec §3.44, ADR-0081): only with config `claude.shareMemory`, only for an interactive
// Claude session of an account other than the main one, as `autoMemoryDirectory` in sideby's one `--settings` file.
import assert from 'node:assert/strict'
import { chmod, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, it } from 'node:test'
import { type FakeHome, fakeHost, readHostLog, withFakeHome } from '../../testing/index.ts'
import { claudeFamily, claudePlugin } from '../families/claude/index.ts'
import { claudeProjectDirName } from '../families/claude/layout.ts'
import { MESSAGES } from '../panel/i18n.ts'
import { findingSentence } from '../panel/page-logic.ts'
import { createRuntime } from '../runtime.ts'
import type { LiveRuns } from './claude-memory.ts'
import { runWithHandoff } from './handoff-run.ts'
import { withClaudeSessionHooks } from './session-hooks.ts'

const builtins = [{ plugin: claudePlugin, version: '0.1.0', description: '', defaultEnabled: true }]

async function setup(h: FakeHome, config: object, cwd = 'code/app') {
  await h.mkdir(cwd)
  await h.write('.claude/settings.json', '{}\n')
  await h.write('.claude-work/settings.json', '{}\n')
  await h.write('.config/sideby/config.json', JSON.stringify(config))
  return createRuntime({ env: h.env, builtins, trust: { cwd: () => h.path(cwd), print: () => {} } })
}

/** The `--settings` files in a Launch's arguments, read. */
async function settingsFiles(args: readonly string[]): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < args.length; i++)
    if (args[i] === '--settings')
      out.push(JSON.parse(await readFile(args[i + 1]!, 'utf8')) as Record<string, unknown>)
  return out
}

const memoryOf = (h: FakeHome, cwd: string) =>
  h.path('.claude/projects', claudeProjectDirName(h.path(cwd)), 'memory')

describe('shared memory at Launch', () => {
  it('passes nothing while config claude.shareMemory is off', async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, {})
      const p = await rt.prepareLaunch('claude:work', [], 'run')
      assert.equal((await settingsFiles(p.args))[0]?.autoMemoryDirectory, undefined)
    })
  })

  it("passes the main account's memory folder of the project, in one --settings file per project", async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { claude: { shareMemory: true } })
      const p = await rt.prepareLaunch('claude:work', ['--model', 'opus'], 'run')
      assert.equal((await settingsFiles(p.args))[0]?.autoMemoryDirectory, memoryOf(h, 'code/app'))
      // Kept as sideby's own session settings, so Auto Handoff never takes it for the user's `--settings`.
      assert.deepEqual(
        p.sessionHookArgs,
        p.args.slice(p.args.indexOf('--settings'), p.args.indexOf('--settings') + 2),
      )
      assert.equal(p.notice, undefined)
      const other = await setup(h, { claude: { shareMemory: true } }, 'code/other')
      const q = await other.prepareLaunch('claude:work', [], 'run')
      assert.notEqual(q.sessionHookArgs![1], p.sessionHookArgs![1])
      assert.equal((await settingsFiles(q.args))[0]?.autoMemoryDirectory, memoryOf(h, 'code/other'))
    })
  })

  it("goes into the same file as sideby's session hooks, never as a second --settings", async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { claude: { shareMemory: true }, unattended: {} })
      const p = await rt.prepareLaunch('claude:work', [], 'run')
      assert.equal(p.args.filter((a) => a === '--settings').length, 1)
      const [file] = await settingsFiles(p.args)
      assert.equal(file?.autoMemoryDirectory, memoryOf(h, 'code/app'))
      assert.ok(file?.hooks && typeof file.hooks === 'object')
      // Auto Handoff merges sideby's session file into its own: the folder comes along.
      const merged = await withClaudeSessionHooks(['--settings', h.path('handoff.json')], p.sessionHookArgs!)
      assert.equal((await settingsFiles(merged))[0]?.autoMemoryDirectory, memoryOf(h, 'code/app'))
    })
  })

  it("adds no second --settings next to the user's own, and says so once", async () => {
    await withFakeHome(async (h) => {
      const rt = await setup(h, { claude: { shareMemory: true } })
      const own = h.path('mine.json')
      const p = await rt.prepareLaunch('claude:work', ['--settings', own], 'run')
      assert.deepEqual(
        p.args.filter((a, i) => a === '--settings' || p.args[i - 1] === '--settings'),
        ['--settings', own],
      )
      assert.equal(p.notice?.match(/own memory instead of the shared one/g)?.length, 1)
    })
  })

  for (const [what, ref, args, command] of [
    ['a headless run (-p)', 'claude:work', ['-p', 'hi'], 'run'],
    ['a headless run in a group of short flags (-cp)', 'claude:work', ['-cp', 'hi'], 'run'],
    ['a sign-in', 'claude:work', [], 'login'],
    ['the main account (that folder is already its own)', 'claude:main', [], 'run'],
  ] as const)
    it(`passes nothing for ${what}`, async () => {
      await withFakeHome(async (h) => {
        const rt = await setup(h, { claude: { shareMemory: true } })
        const p = await rt.prepareLaunch(ref, [...args], command)
        assert.equal((await settingsFiles(p.args))[0]?.autoMemoryDirectory, undefined)
        assert.equal(p.notice, undefined)
      })
    })

  it('says why when it cannot tell the project, and starts the session anyway', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/super/.git/modules/lib')
      await h.write('code/super/lib/.git', 'gitdir: ../.git/modules/lib\n')
      const rt = await setup(h, { claude: { shareMemory: true } }, 'code/super/lib')
      const p = await rt.prepareLaunch('claude:work', [], 'run')
      assert.equal((await settingsFiles(p.args))[0]?.autoMemoryDirectory, undefined)
      assert.match(
        p.notice ?? '',
        /own memory instead of the shared one \(~\/code\/super\/lib\/\.git is not a linked worktree/,
      )
    })
  })

  it('an Auto Handoff hop gets the folder in the one --settings file its Host starts with', async () => {
    await withFakeHome(async (h) => {
      const seen = join(h.bin, 'seen.jsonl')
      // Each start records the memory folder its `--settings` file names; the first marks itself ready.
      await fakeHost(h, 'claude', {
        sleep: 20,
        onStart: `
const args = process.argv.slice(2)
const at = args.indexOf('--settings')
const s = at >= 0 ? JSON.parse(fs.readFileSync(args[at + 1], 'utf8')) : {}
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify({ dir: process.env.CLAUDE_CONFIG_DIR, memory: s.autoMemoryDirectory || null, settings: args.filter((a) => a === '--settings').length, hooks: Boolean(s.hooks) }) + '\\n')
if (process.argv.includes('--')) process.exit(0)
if (process.env.SIDEBY_HANDOFF_DIR) fs.writeFileSync(path.join(process.env.SIDEBY_HANDOFF_DIR, 'ready.json'),
  JSON.stringify({ runId: process.env.SIDEBY_HANDOFF_RUN, at: new Date().toISOString(), trigger: 'manual', sessionId: 's1' }))
`,
      })
      // Two logins, so the hop may move between them; the hop's order names claude:002, not the main account.
      const login = (email: string) =>
        `${JSON.stringify({ oauthAccount: { emailAddress: email }, projects: {} })}\n`
      await h.write('.claude-001/.claude.json', login('me@example.com'), 0o600)
      await h.write('.claude-002/.claude.json', login('work@example.com'), 0o600)
      const rt = await setup(h, {
        claude: { shareMemory: true },
        handoff: {
          auto: true,
          sameFamily: true,
          countdownSeconds: 0,
          families: { claude: { policy: 'order', order: ['claude:002'] } },
        },
      })
      await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\necho ok\n')
      await chmod(join(h.bin, 'sideby'), 0o755)
      const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {} })
      assert.equal(await runWithHandoff(rt, 'claude:001', [], { err: () => {}, stdin }), 0)
      assert.equal((await readHostLog(h, 'claude')).filter((r) => r.argv).length, 2)
      const starts = (await readFile(seen, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>)
      const memory = memoryOf(h, 'code/app')
      assert.deepEqual(starts, [
        { dir: h.path('.claude-001'), memory, settings: 1, hooks: true },
        { dir: h.path('.claude-002'), memory, settings: 1, hooks: true },
      ])
    })
  })

  it('`memoryStatus` while off does not even list the accounts (which walks the Host folders)', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-work/settings.json', '{}\n')
      await h.write('.claude-work/projects/-p/memory/a.md', 'a\n')
      // Listing the accounts reads each Family's account folder pattern (`layout.account`); the main folder's name
      // (`layout.main`) is all memory status needs while off. The layout object is kept by reference: count the reads.
      let asks = 0
      let counting = false
      const layout = new Proxy(claudeFamily.layout, {
        get(target, key, receiver) {
          if (counting && key === 'account') asks++
          return Reflect.get(target, key, receiver)
        },
      })
      const spied = { ...claudeFamily, layout }
      const rt = await createRuntime({
        env: h.env,
        builtins: [
          {
            plugin: { name: 'claude', register: (api) => api.family(spied) },
            version: '0.1.0',
            description: '',
            defaultEnabled: true,
          },
        ],
      })
      counting = true
      const off = await rt.memoryStatus(h.home)
      assert.equal(asks, 0)
      assert.equal(off.projects, undefined)
      await rt.memorySet(true, { apply: true })
      const on = await rt.memoryStatus(h.home)
      // The same call while on does list them: the count above would have caught it.
      assert.ok(asks > 0)
      assert.deepEqual(on.projects?.[0]?.pending, [{ account: 'claude:work', files: 1 }])
    })
  })
})

describe('the memory finding in the Panel', () => {
  it('reaches the Panel with its params and reads in Chinese, naming the session that holds the project', async () => {
    await withFakeHome(async (h) => {
      const app = await h.mkdir('code/app')
      const name = claudeProjectDirName(app)
      await h.write('.claude/settings.json', '{}\n')
      await h.write('.claude-work/settings.json', '{}\n')
      await h.write(`.claude-work/projects/${name}/memory/a.md`, 'a\n')
      // The main account's index lists a note that is not there.
      await h.write('.claude/projects/-code-site/memory/MEMORY.md', '- [Gone](gone.md)\n')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ claude: { shareMemory: true }, aliases: { ccw: 'claude:work' } }),
      )
      let live: LiveRuns = {
        runs: [{ cwd: app, sessionId: 'ad73ceaf-0001-4000-8000-000000000001', title: 'tidy login' }],
      }
      const rt = await createRuntime({ env: h.env, builtins, memory: { liveRuns: async () => live } })
      type Sent = { code: string; item: string; fixable: boolean; params?: Record<string, string | number> }
      // What the Panel gets: the report as JSON.
      const finding = async () => {
        const report = JSON.parse(JSON.stringify(await rt.doctor({ target: 'claude' }))) as {
          accounts: { findings: Sent[] }[]
        }
        return report.accounts.flatMap((a) => a.findings).find((f) => f.code === 'memory.unfolded')!
      }
      const waiting = await finding()
      assert.equal(waiting.fixable, false)
      const zhWaiting = `这个账号有 1 个项目的记忆还没移进主账号，但这个账号有会话正在里面运行。等这些会话结束后再修复：${name} (ccw · tidy login · ad73ceaf)。`
      assert.equal(findingSentence(waiting, MESSAGES.zh, MESSAGES.en), zhWaiting)
      // What the Panel shows on load: the last check, read back from Doctor's history.
      await rt.doctorWithHistory({ target: 'claude' })
      const history = JSON.parse(JSON.stringify(await rt.doctorHistory())) as {
        accounts: Record<string, { findings: Sent[] }>
        general: Record<string, { findings: Sent[] }>
      }
      const kept = history.accounts['claude:work']!.findings.find((f) => f.code === 'memory.unfolded')!
      assert.equal(findingSentence(kept, MESSAGES.zh, MESSAGES.en), zhWaiting)
      const index = Object.values(history.general)
        .flatMap((e) => e.findings)
        .find((f) => f.code === 'memory.index')!
      assert.equal(
        findingSentence(index, MESSAGES.zh, MESSAGES.en),
        '主账号里 1 个项目的记忆索引（MEMORY.md）和文件对不上：-code-site。Claude 只读 MEMORY.md 里列出的记忆；可以在那个项目里让 Claude 整理记忆索引。',
      )
      live = { unknown: 'a record Claude Code is rewriting' }
      const unknown = await finding()
      assert.equal(unknown.fixable, false)
      assert.match(
        findingSentence(unknown, MESSAGES.zh, MESSAGES.en),
        /sideby 现在看不出这个账号有哪些会话在运行，所以先不移/,
      )
      live = { runs: [] }
      const ready = await finding()
      assert.equal(ready.fixable, true)
      assert.equal(
        findingSentence(ready, MESSAGES.zh, MESSAGES.en),
        `这个账号有 1 个项目的记忆只存在自己这里，其他 Claude 账号看不到：${name}。`,
      )
    })
  })
})
