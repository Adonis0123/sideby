// `sideby history` (spec §3.33): the four --json outputs match their schemas, errors are JSON with a code, and the exit
// codes are 1 for an unknown session or project and 2 for a malformed command line.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { UserError } from '../core/errors.ts'
import { parseArgs, UsageError } from './args.ts'
import { cmdHistory } from './commands.ts'
import { OUTPUT_SCHEMAS } from './json-schemas.ts'

const MAIN = fileURLToPath(new URL('./main.ts', import.meta.url))
const SID = 'aaaa1111-0000-4000-8000-000000000001'

function sideby(
  h: FakeHome,
  args: string[],
  cwd?: string,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [MAIN, ...args], {
      env: h.env as NodeJS.ProcessEnv,
      ...(cwd ? { cwd } : {}),
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d: Buffer) => (out += d))
    child.stderr.on('data', (d: Buffer) => (err += d))
    child.on('exit', (code) => resolve({ code, out, err }))
  })
}

/**
 * `sideby history <args>` in this process, with the fake HOME as process.env (cmdHistory builds its own Runtime).
 * main() exits 2 for the UsageError it may reject with and 1 for any other error.
 */
async function inProcess(h: FakeHome, args: string[]): Promise<number> {
  const env = process.env
  process.env = { ...h.env } as NodeJS.ProcessEnv
  try {
    const parsed = parseArgs(
      args,
      ['json', 'scripts', 'tools', 'clear', 'help'],
      ['project', 'category', 'group', 'family', 'account', 'since', 'limit', 'offset', 'before'],
    )
    return await cmdHistory(parsed, { out: () => {}, err: () => {} })
  } finally {
    process.env = env
  }
}

function checked(name: string, text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text)
  const schema = OUTPUT_SCHEMAS[name]!
  assert.ok(
    Value.Check(schema, data),
    `${name}: ${JSON.stringify([...Value.Errors(schema, data)].slice(0, 3))}`,
  )
  return data as Record<string, unknown>
}

function errorJson(text: string): Record<string, unknown> {
  const data = JSON.parse(text) as Record<string, unknown>
  assert.equal(data.schemaVersion, 1)
  assert.equal(typeof data.error, 'string')
  assert.equal(typeof data.code, 'string')
  return data
}

async function seed(h: FakeHome) {
  await h.write('.claude/settings.json', '{}')
  const app = await h.mkdir('code/app')
  await h.mkdir('code/app/.git')
  const at = new Date(Date.now() - 60_000).toISOString()
  await h.write(
    `.claude/projects/-code-app/${SID}.jsonl`,
    [
      {
        type: 'user',
        sessionId: SID,
        cwd: app,
        entrypoint: 'cli',
        timestamp: at,
        message: { content: '修一下登录页面' },
      },
      {
        type: 'assistant',
        sessionId: SID,
        timestamp: at,
        message: {
          content: [
            { type: 'text', text: 'Fixed the login page.' },
            { type: 'tool_use', name: 'Edit', input: {} },
          ],
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n'),
  )
}

describe('sideby history --json', () => {
  it('lists, searches, shows, lists projects and reports the index', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const list = await sideby(h, ['history', '--json'])
      assert.equal(list.code, 0, list.err)
      const l = checked('history', list.out)
      assert.equal(l.schemaVersion, 1)
      assert.deepEqual(
        (l.sessions as { sessionId: string }[]).map((s) => s.sessionId),
        [SID],
      )
      const found = checked(
        'history',
        (await sideby(h, ['history', '登录页', '--since', '7d', '--json'])).out,
      )
      assert.match((found.sessions as { snippet?: string }[])[0]?.snippet ?? '', /登录页/)
      const none = checked('history', (await sideby(h, ['history', 'nothing-like-this', '--json'])).out)
      assert.deepEqual(none.sessions, [])

      const show = await sideby(h, ['history', 'show', SID.slice(0, 8), '--json'])
      assert.equal(show.code, 0, show.err)
      const s = checked('history-show', show.out)
      assert.deepEqual(
        (s.messages as { role: string; text: string }[]).map((m) => [m.role, m.text]),
        [
          ['user', '修一下登录页面'],
          ['assistant', 'Fixed the login page.'],
          ['tool', 'Edit'],
        ],
      )

      const projects = await sideby(h, ['history', 'projects', '--json'])
      assert.equal(projects.code, 0, projects.err)
      const p = checked('history-projects', projects.out)
      assert.deepEqual(
        (p.projects as { name: string; sessions: number }[]).map((x) => [x.name, x.sessions]),
        [['app', 1]],
      )

      const index = await sideby(h, ['history', 'index', '--json'])
      assert.equal(index.code, 0, index.err)
      const i = checked('history-index', index.out)
      assert.equal(i.enabled, true)
      assert.equal(i.sessions, 1)
      const clear = checked('history-index', (await sideby(h, ['history', 'index', '--clear', '--json'])).out)
      assert.equal(clear.cleared, true)
    })
  })

  it('groups by project and day, and asks for a plugin when a category is named', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const gp = await sideby(h, ['history', '--group', 'project', '--json'])
      const byProject = checked('history', gp.out)
      const groups = byProject.groups as { key: string; sessions: number }[]
      assert.equal(groups.length, 1)
      assert.equal(groups[0]!.sessions, 1)
      const byDay = checked('history', (await sideby(h, ['history', '--group', 'day', '--json'])).out)
      assert.deepEqual(
        (byDay.groups as { key: string }[]).map((g) => g.key),
        ['today'],
      )
      const plain = await sideby(h, ['history', '--group', 'day'])
      assert.equal(plain.code, 0, plain.err)
      assert.match(plain.out, /Today/)
      const cat = await sideby(h, ['history', '--category', 'Site', '--json'])
      assert.equal(cat.code, 1, cat.out)
      assert.match(String(errorJson(cat.out).error), /no plugin sorts projects into categories/)
    })
  })

  it('finds a project from a folder inside it, a quoted phrase, and pages with --offset', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const sub = await h.mkdir('code/app/src/deep')
      const ids = (out: string) =>
        (checked('history', out).sessions as { sessionId: string }[]).map((s) => s.sessionId)
      assert.deepEqual(ids((await sideby(h, ['history', '--project', '.', '--json'], sub)).out), [SID])
      assert.deepEqual(ids((await sideby(h, ['history', '--project', sub, '--json'])).out), [SID])
      assert.deepEqual(ids((await sideby(h, ['history', '"login page"', '--json'])).out), [SID])
      assert.deepEqual(ids((await sideby(h, ['history', '"page login"', '--json'])).out), [])
      const paged = checked('history', (await sideby(h, ['history', '--offset', '1', '--json'])).out)
      assert.deepEqual(paged.sessions, [])
      assert.equal(paged.total, 1)
      const after = await sideby(h, ['history', '--offset', '1'])
      assert.match(after.out, /leave out --offset/)
      const narrowed = await sideby(h, ['history', 'nothing-like-this', '--since', 'today'])
      assert.match(narrowed.out, /Try --since all; fewer or shorter words; --tools/)
    })
  })

  it('lists a session once when two accounts link to one projects folder', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.write('.claude-work/settings.json', '{}')
      await symlink(h.path('.claude/projects'), h.path('.claude-work/projects'))
      const r = checked('history', (await sideby(h, ['history', '--json'])).out)
      assert.equal((r.sessions as unknown[]).length, 1)
      const show = await sideby(h, ['history', 'show', SID.slice(0, 8), '--json'])
      assert.equal(show.code, 0, show.out)
    })
  })

  it('prints the empty state and the plain table', async () => {
    await withFakeHome(async (h) => {
      await h.write('.claude/settings.json', '{}')
      const empty = await sideby(h, ['history'])
      assert.equal(empty.code, 0, empty.err)
      assert.match(empty.out, /No session records yet/)
      await seed(h)
      const table = await sideby(h, ['history', 'login'])
      assert.equal(table.code, 0, table.err)
      assert.match(table.out, /UPDATED\s+ACCOUNT\s+SESSION/)
      assert.match(table.out, /aaaa1111/)
    })
  })

  it('exits 1 with an error JSON for an unknown session, project or account', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const r = await sideby(h, ['history', 'show', 'ffff0000-nope', '--json'])
      assert.equal(r.code, 1, `${r.out}${r.err}`)
      errorJson(r.out)
      for (const args of [
        ['--project', 'nope', '--json'],
        ['--account', 'claude:nope', '--json'],
        ['--family', 'nope', '--json'],
      ])
        await assert.rejects(
          inProcess(h, args),
          (e: unknown) => e instanceof UserError && !(e instanceof UsageError),
          args.join(' '),
        )
    })
  })

  it('exits 2 with an error JSON for a malformed command line', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const r = await sideby(h, ['history', '--since', '3d', '--json'])
      assert.equal(r.code, 2, `${r.out}${r.err}`)
      assert.equal(errorJson(r.out).code, 'usage')
      for (const args of [
        ['--limit', '0', '--json'],
        ['--limit', '501', '--json'],
        ['--offset', '-1', '--json'],
        ['show', '--json'],
        ['show', SID, '--before', 'x', '--json'],
        ['projects', 'extra', '--json'],
        ['--nope', '--json'],
        ['--clear', '--json'],
        ['index', '--tools', '--json'],
        ['show', SID, '--project', 'x', '--json'],
        ['projects', '--since', '3d', '--json'],
        ['--group', 'week', '--json'],
        ['--group', 'project', '--tools', '--json'],
      ])
        await assert.rejects(inProcess(h, args), UsageError, args.join(' '))
    })
  })
})
