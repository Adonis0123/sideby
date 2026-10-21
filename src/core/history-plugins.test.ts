// Session History with Plugins (spec §3.33, ADR-0044): a plugin Family's session reader, Project Categories from a
// Plugin, and the grouped list (project, category, day) with folded groups.
import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin } from '../../testing/demo.ts'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { checkParsed } from '../families/history.ts'
import { BUILTIN_PLUGINS } from '../families/index.ts'
import { SESSION_TEXT_MAX, TITLE_MAX } from '../families/shared/history-text.ts'
import { createRuntime } from '../runtime.ts'
import type { FamilyHistory, HistoryMessage, Plugin, ProjectCategoriesDef } from '../types.ts'
import { closeHistory, historyProjects, historyShow, searchHistory } from './history.ts'

const ID1 = 'demo-0001'
const ID2 = 'demo-0002'
const ID3 = 'demo-0003'
const DAY = 86_400_000

interface Rec {
  cwd: string
  title: string
  at: number
  said: string
}

/** Reads `<account>/sessions/<id>.json`, one Session each. */
const demoHistory: FamilyHistory = {
  async list(account) {
    const dir = join(account.dir, 'sessions')
    let names: string[]
    try {
      names = await readdir(dir)
    } catch {
      return []
    }
    return Promise.all(
      names.map(async (n) => {
        const st = await stat(join(dir, n))
        return { path: join(dir, n), sig: `${st.size}:${st.mtimeMs}`, mtimeMs: st.mtimeMs }
      }),
    )
  },
  async parse(file) {
    const r = JSON.parse(await readFile(file.path, 'utf8')) as Rec
    return {
      sessionId: file.path
        .split('/')
        .pop()!
        .replace(/\.json$/, ''),
      cwd: r.cwd,
      title: r.title,
      titleFrom: 'host',
      updatedAt: new Date(r.at).toISOString(),
      startedAt: new Date(r.at).toISOString(),
      messages: 2,
      script: false,
      prompts: [r.said],
      replies: ['done'],
    }
  },
  async *messages(path): AsyncGenerator<HistoryMessage> {
    const r = JSON.parse(await readFile(path, 'utf8')) as Rec
    yield { role: 'user', text: r.said }
    yield { role: 'assistant', text: 'done' }
  },
  resumeArgs: (id) => ['--continue-chat', id],
}

async function seed(h: FakeHome) {
  await h.write('.demo/rules.md', 'rules\n')
  const app = await h.mkdir('code/app')
  const web = await h.mkdir('code/web')
  const tool = await h.mkdir('code/tool')
  const rec = (r: Rec) => `${JSON.stringify(r)}\n`
  const now = Date.now()
  await h.write(
    `.demo/sessions/${ID1}.json`,
    rec({ cwd: app, title: 'Fix login', at: now - 60_000, said: 'fix the login page' }),
  )
  await h.write(
    `.demo/sessions/${ID2}.json`,
    rec({ cwd: web, title: 'Dark mode', at: now - 3 * DAY, said: 'add dark mode' }),
  )
  await h.write(
    `.demo/sessions/${ID3}.json`,
    rec({ cwd: tool, title: 'Old tool', at: now - 90 * DAY, said: 'old login tool' }),
  )
  return { app, web, tool }
}

async function withDemo(
  opts: { categories?: ProjectCategoriesDef; history?: FamilyHistory | null },
  fn: (
    rt: Awaited<ReturnType<typeof createRuntime>>,
    dirs: Awaited<ReturnType<typeof seed>>,
  ) => Promise<void>,
) {
  await withFakeHome(async (h) => {
    const dirs = await seed(h)
    const def = demoFamily(opts.history === null ? {} : { history: opts.history ?? demoHistory })
    const cats = opts.categories
    const rt = await createRuntime({
      env: h.env,
      builtins: [
        ...BUILTIN_PLUGINS,
        asBuiltin(demoPlugin(def, cats ? (api) => api.projectCategories(cats) : undefined)),
      ],
    })
    try {
      await fn(rt, dirs)
    } finally {
      await closeHistory(rt)
    }
  })
}

describe('Session History from a plugin Family', () => {
  it('lists, searches and opens the sessions its reader gives, with its own command to continue', async () => {
    await withDemo({}, async (rt, { app }) => {
      const r = await searchHistory(rt, { since: 'all' }, { wait: true })
      assert.deepEqual(
        r.sessions.map((s) => s.sessionId),
        [ID1, ID2, ID3],
      )
      const s = r.sessions[0]!
      assert.equal(s.account, 'demo:main')
      assert.equal(s.project, app)
      assert.match(s.continueCommand, /sideby run demo:main -- --continue-chat demo-0001$/)
      const found = await searchHistory(rt, { q: 'login', since: 'all' })
      assert.deepEqual(found.sessions.map((x) => x.sessionId).sort(), [ID1, ID3])
      const shown = await historyShow(rt, ID1)
      assert.deepEqual(
        shown.messages.map((m) => m.text),
        ['fix the login page', 'done'],
      )
    })
  })

  it('says the plugin gives no reader when its Family has none', async () => {
    await withDemo({ history: null }, async (rt) => {
      const r = await searchHistory(rt, { since: 'all' }, { wait: true })
      assert.equal(r.total, 0)
      const src = r.sources.find((x) => x.account === 'demo:main')
      assert.equal(src?.reason, 'unsupported')
      assert.match(src?.note ?? '', /plugin gives no session reader/)
    })
  })

  it('counts a session its reader gives in the wrong shape as unreadable, and keeps the others', async () => {
    const bad: FamilyHistory = {
      ...demoHistory,
      async parse(file, account) {
        const p = await demoHistory.parse(file, account)
        return file.path.endsWith(`${ID2}.json`) ? ({ ...p, prompts: 'not a list' } as never) : p
      },
    }
    await withDemo({ history: bad }, async (rt) => {
      const r = await searchHistory(rt, { since: 'all' }, { wait: true })
      assert.deepEqual(r.sessions.map((s) => s.sessionId).sort(), [ID1, ID3])
      assert.ok(r.problems.some((p) => /1 session file could not be read/.test(p)))
    })
  })

  it('cuts what a plugin reader gives to the built-in limits and names the Family when the shape is wrong', () => {
    const base = {
      sessionId: 'x1',
      titleFrom: 'host' as const,
      messages: 2.7,
      script: false,
      replies: ['ok'],
    }
    const p = checkParsed('demo', {
      ...base,
      title: 't'.repeat(500),
      prompts: ['a'.repeat(SESSION_TEXT_MAX + 10)],
    })!
    assert.ok((p.title ?? '').length <= TITLE_MAX)
    assert.equal(p.prompts[0]!.length, SESSION_TEXT_MAX)
    assert.deepEqual(p.replies, [])
    assert.equal(p.cut, true)
    assert.equal(p.messages, 2)
    assert.throws(
      () => checkParsed('demo', { ...base, prompts: [], messages: Number.NaN }),
      /family demo: history.parse returned a messages count/,
    )
    assert.throws(
      () => checkParsed('demo', { ...base, sessionId: '', prompts: [] }),
      /family demo: .*no sessionId/,
    )
    assert.equal(checkParsed('demo', undefined), undefined)
  })

  it('drops a reader that is missing a function, and names the Family', async () => {
    const bad = { list: demoHistory.list, parse: demoHistory.parse } as unknown as FamilyHistory
    await withDemo({ history: bad }, async (rt) => {
      assert.ok(rt.pluginErrors.some((e) => /family demo: history needs/.test(e.message)))
      const r = await searchHistory(rt, { since: 'all' }, { wait: true })
      assert.equal(r.total, 0)
    })
  })
})

describe('Session History groups and Project Categories', () => {
  it('groups by project, newest group first, and leaves a folded group out of the page but counts it', async () => {
    await withDemo({}, async (rt, { app, web, tool }) => {
      await searchHistory(rt, { since: 'all' }, { wait: true })
      const r = await searchHistory(rt, { since: 'all', group: 'project' })
      assert.deepEqual(
        r.groups?.map((g) => [g.key, g.sessions]),
        [
          [app, 1],
          [web, 1],
          [tool, 1],
        ],
      )
      assert.deepEqual(
        r.sessions.map((s) => s.group),
        [app, web, tool],
      )
      const folded = await searchHistory(rt, { since: 'all', group: 'project', collapsed: [web] })
      assert.equal(folded.total, 2)
      assert.deepEqual(
        folded.sessions.map((s) => s.sessionId),
        [ID1, ID3],
      )
      assert.equal(folded.groups?.find((g) => g.key === web)?.collapsed, true)
    })
  })

  it('groups by day in time order even when an older session matches better', async () => {
    await withDemo({}, async (rt) => {
      await searchHistory(rt, { since: 'all' }, { wait: true })
      const r = await searchHistory(rt, { q: 'login', since: 'all', group: 'day' })
      assert.deepEqual(
        r.groups?.map((g) => g.key),
        ['today', 'older'],
      )
    })
  })

  it('groups and filters by the categories a Plugin gives, and lists them with the projects', async () => {
    const categories: ProjectCategoriesDef = {
      label: 'Workspace',
      categoriesOf: (projects) =>
        Object.fromEntries(
          projects
            .filter((p) => !p.endsWith('/tool'))
            .map((p) => [p, p.endsWith('/app') ? 'Product' : 'Site']),
        ),
    }
    await withDemo({ categories }, async (rt, { app, web }) => {
      await searchHistory(rt, { since: 'all' }, { wait: true })
      const r = await searchHistory(rt, { since: 'all', group: 'category' })
      assert.deepEqual(r.categories, { label: 'Workspace', from: 'demo-family' })
      assert.deepEqual(
        r.groups?.map((g) => [g.key, g.label]),
        [
          ['Product', 'Product'],
          ['Site', 'Site'],
          ['', 'No category'],
        ],
      )
      const site = await searchHistory(rt, { since: 'all', category: 'Site' })
      assert.deepEqual(
        site.sessions.map((s) => s.sessionId),
        [ID2],
      )
      await assert.rejects(searchHistory(rt, { since: 'all', category: 'Nope' }), /no category named "Nope"/)
      const p = await historyProjects(rt, { since: 'all' })
      assert.equal(p.projects.find((x) => x.project === app)?.category, 'Product')
      assert.equal(p.projects.find((x) => x.project === web)?.category, 'Site')
    })
  })

  it('keeps listing when the categories fail, and says what to do', async () => {
    const categories: ProjectCategoriesDef = {
      categoriesOf: () => {
        throw new Error('boom')
      },
    }
    await withDemo({ categories }, async (rt) => {
      await searchHistory(rt, { since: 'all' }, { wait: true })
      const r = await searchHistory(rt, { since: 'all', group: 'category' })
      assert.equal(r.total, 3)
      assert.ok(
        r.problems.some((p) => /demo-family: project categories failed \(boom\); fix the plugin/.test(p)),
      )
    })
  })

  it('uses the first Plugin that gives categories and names it to a second one', async () => {
    await withFakeHome(async (h) => {
      const second: Plugin = {
        name: 'second-sorter',
        register(api) {
          api.projectCategories({ categoriesOf: () => ({}) })
        },
      }
      const rt = await createRuntime({
        env: h.env,
        builtins: [
          ...BUILTIN_PLUGINS,
          asBuiltin(demoPlugin(demoFamily(), (api) => api.projectCategories({ categoriesOf: () => ({}) }))),
          asBuiltin(second),
        ],
      })
      assert.ok(
        rt.pluginErrors.some((e) =>
          /project categories already come from demo-family; this one is not used/.test(e.message),
        ),
      )
    })
  })

  it('asks to add a Plugin when a category is asked for and none gives them', async () => {
    await withDemo({}, async (rt) => {
      await searchHistory(rt, { since: 'all' }, { wait: true })
      await assert.rejects(
        searchHistory(rt, { since: 'all', category: 'Site' }),
        /no plugin sorts projects into categories/,
      )
    })
  })
})
