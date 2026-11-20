// Carried trust (spec §3.43, ADR-0078): which folder an Account trusts by Claude Code's rules, copying exactly one
// mark from another Account, never creating trust nobody gave, never writing what the json-key rules forbid, and an
// undo that takes back only what still holds sideby's write.
import assert from 'node:assert/strict'
import { chmod, mkdir, readdir, readFile, realpath, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, snapshot, withFakeHome } from '../../testing/index.ts'
import { claudeJsonOf } from '../families/claude/index.ts'
import type { Account } from '../types.ts'
import {
  carryLine,
  carryTrust,
  readCarries,
  readTrustKeys,
  type TrustContext,
  trustRoot,
  trustStatus,
  undoCarries,
} from './claude-trust.ts'

const MARKER = 'not-a-secret-marker-only-for-this-test'

const acct = (h: FakeHome, name: string, kind: Account['kind'] = 'subscription'): Account => ({
  family: 'claude',
  name,
  ref: `claude:${name}`,
  dir: h.path(name === 'main' ? '.claude' : `.claude-${name}`),
  isMain: name === 'main',
  kind,
})

const stateDir = (h: FakeHome) => h.path('.local/state/sideby')
const ctxOf = (h: FakeHome, accounts: Account[]): TrustContext => ({
  accounts,
  jsonOf: claudeJsonOf,
  home: h.home,
  stateDir: stateDir(h),
})
const now = new Date('2026-11-18T10:00:00.000Z')

/** A `.claude.json` as Claude Code writes it: a login, settings, and a `projects` map. */
const claudeJson = (projects: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      numStartups: 3,
      oauthAccount: { emailAddress: 'me@example.com', accessToken: MARKER },
      projects,
      userID: MARKER,
      ...extra,
    },
    null,
    2,
  )}\n`

/** Main and work, each with `.claude.json`; main trusts `trusted` (paths under HOME). */
async function twoAccounts(h: FakeHome, trusted: string[], workProjects: Record<string, unknown> = {}) {
  const main = acct(h, 'main')
  const work = acct(h, 'work')
  await h.mkdir('.claude')
  await h.write(
    '.claude.json',
    claudeJson(
      Object.fromEntries([
        ...trusted.map((p) => [p, { allowedTools: [MARKER], hasTrustDialogAccepted: true }]),
        [h.path('elsewhere'), { hasTrustDialogAccepted: true, history: [MARKER] }],
      ]),
    ),
    0o600,
  )
  await h.write('.claude-work/.claude.json', claudeJson(workProjects), 0o600)
  return { main, work, ctx: ctxOf(h, [main, work]) }
}

/** What changed outside sideby's own state folder. */
const hostChanges = (before: Map<string, string>, after: Map<string, string>) =>
  diffSnapshots(before, after).filter((p) => p !== '.local' && !p.startsWith('.local/'))

const projectsOf = async (file: string) =>
  (JSON.parse(await readFile(file, 'utf8')) as { projects: Record<string, unknown> }).projects

/** A main checkout at `code/repo` and its linked worktree at `code/repo-wt`, laid out as `git worktree add` does. */
async function worktree(h: FakeHome, opts: { backTo?: string } = {}) {
  await h.mkdir('code/repo/.git/worktrees/wt')
  await h.mkdir('code/repo/src')
  await h.mkdir('code/repo-wt/src')
  await h.write('code/repo-wt/.git', `gitdir: ${h.path('code/repo/.git/worktrees/wt')}\n`)
  await h.write('code/repo/.git/worktrees/wt/gitdir', `${opts.backTo ?? h.path('code/repo-wt/.git')}\n`)
  await h.write('code/repo/.git/worktrees/wt/commondir', '../..\n')
}

describe('which key trusts a folder (Claude Code rules)', () => {
  it('a plain folder counts its own path and every parent; a git checkout only its root', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app/sub')
      await h.mkdir('code/repo/.git')
      await h.mkdir('code/repo/src')
      assert.deepEqual(await trustRoot(h.path('code/app/sub')), {
        kind: 'folder',
        folder: h.path('code/app/sub'),
        path: h.path('code/app/sub'),
      })
      assert.deepEqual(await trustRoot(h.path('code/repo/src')), {
        kind: 'git',
        folder: h.path('code/repo/src'),
        path: h.path('code/repo'),
      })
    })
  })

  it("a linked worktree uses its main checkout's root; one whose gitdir does not point back is unclear", async () => {
    await withFakeHome(async (h) => {
      await worktree(h)
      const r = await trustRoot(h.path('code/repo-wt/src'))
      assert.deepEqual([r.kind, 'path' in r ? r.path : null], ['git', h.path('code/repo')])
    })
    await withFakeHome(async (h) => {
      await h.mkdir('other')
      await worktree(h, { backTo: h.path('other/.git') })
      assert.equal((await trustRoot(h.path('code/repo-wt/src'))).kind, 'unclear')
    })
  })

  it('a submodule (gitdir under modules/) is unclear', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/super/.git/modules/lib')
      await h.mkdir('code/super/lib')
      await h.write('code/super/lib/.git', 'gitdir: ../.git/modules/lib\n')
      assert.equal((await trustRoot(h.path('code/super/lib'))).kind, 'unclear')
    })
  })
})

describe('carryTrust', () => {
  it('copies the narrowest parent key of a plain folder, adding only that one field', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app/sub')
      const { work, ctx } = await twoAccounts(h, [h.path('code'), h.path('code/app')], {
        [h.path('kept')]: { hasTrustDialogAccepted: false, allowedTools: [] },
      })
      const file = claudeJsonOf(work)
      const before = await snapshot(h.home)
      const r = await carryTrust(ctx, work, h.path('code/app/sub'), { now })
      assert.deepEqual(r, { status: 'carried', key: h.path('code/app'), from: 'claude:main' })
      assert.deepEqual(hostChanges(before, await snapshot(h.home)), ['.claude-work/.claude.json'])
      // Every other key and its order is kept, and the new entry is only the field.
      assert.equal(
        await readFile(file, 'utf8'),
        claudeJson({
          [h.path('kept')]: { hasTrustDialogAccepted: false, allowedTools: [] },
          [h.path('code/app')]: { hasTrustDialogAccepted: true },
        }),
      )
      assert.deepEqual(
        (await readCarries(stateDir(h))).map(({ record: _r, ...c }) => c),
        [
          {
            version: 1,
            account: 'claude:work',
            file,
            real: await realpath(file),
            key: h.path('code/app'),
            before: 'no-entry',
            from: 'claude:main',
            at: now.toISOString(),
          },
        ],
      )
      assert.equal(
        carryLine(r, 'claude:work', (p) => p.replace(h.home, '~')),
        'claude:work now trusts ~/code/app, as claude:main does (claude.carryTrust; undo: sideby trust undo)',
      )
      // The second start finds it trusted and writes nothing.
      assert.deepEqual(await carryTrust(ctx, work, h.path('code/app/sub'), { now }), { status: 'already' })
    })
  })

  it('gives the Main Account the trust another account holds, in ~/.claude.json', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const main = acct(h, 'main')
      const work = acct(h, 'work')
      await h.mkdir('.claude')
      await h.write('.claude.json', claudeJson({}), 0o600)
      await h.write(
        '.claude-work/.claude.json',
        claudeJson({ [key]: { hasTrustDialogAccepted: true } }),
        0o600,
      )
      const before = await snapshot(h.home)
      const r = await carryTrust(ctxOf(h, [main, work]), main, key, { now })
      assert.deepEqual(r, { status: 'carried', key, from: 'claude:work' })
      assert.deepEqual(hostChanges(before, await snapshot(h.home)), ['.claude.json'])
      assert.equal(
        await readFile(h.path('.claude.json'), 'utf8'),
        claudeJson({ [key]: { hasTrustDialogAccepted: true } }),
      )
    })
  })

  it("gives a linked worktree the main checkout's trust", async () => {
    await withFakeHome(async (h) => {
      await worktree(h)
      const { work, ctx } = await twoAccounts(h, [h.path('code/repo')])
      const r = await carryTrust(ctx, work, h.path('code/repo-wt/src'), { now })
      assert.deepEqual(r, { status: 'carried', key: h.path('code/repo'), from: 'claude:main' })
      assert.deepEqual((await projectsOf(claudeJsonOf(work)))[h.path('code/repo')], {
        hasTrustDialogAccepted: true,
      })
    })
  })

  it('sets the field on an existing entry, keeping its other fields and their place', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key], {
        [key]: { allowedTools: [MARKER], hasTrustDialogAccepted: false, lastCost: 1 },
      })
      assert.equal((await carryTrust(ctx, work, key, { now })).status, 'carried')
      const text = await readFile(claudeJsonOf(work), 'utf8')
      assert.equal(
        text,
        claudeJson({ [key]: { allowedTools: [MARKER], hasTrustDialogAccepted: true, lastCost: 1 } }),
      )
      assert.equal((await readCarries(stateDir(h)))[0]?.before, 'false')
    })
  })

  describe('writes nothing', () => {
    // Only sideby's own state folder (its lock, its records) may change.
    const unchanged = async (h: FakeHome, fn: () => Promise<unknown>) => {
      const before = await snapshot(h.home)
      const r = await fn()
      assert.deepEqual(hostChanges(before, await snapshot(h.home)), [])
      assert.deepEqual(await readCarries(stateDir(h)), [])
      return r
    }

    it('when no other account trusts the folder', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('code/app')
        const { work, ctx } = await twoAccounts(h, [])
        assert.deepEqual(await unchanged(h, () => carryTrust(ctx, work, h.path('code/app'), { now })), {
          status: 'none',
        })
      })
    })

    it('when the account already trusts it', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('code/app')
        const key = h.path('code/app')
        const { work, ctx } = await twoAccounts(h, [key], { [key]: { hasTrustDialogAccepted: true } })
        assert.deepEqual(await unchanged(h, () => carryTrust(ctx, work, key, { now })), { status: 'already' })
      })
    })

    it('for a key that is HOME or the filesystem root', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('code/app')
        const { work, ctx } = await twoAccounts(h, [h.home, '/'])
        assert.deepEqual(await unchanged(h, () => carryTrust(ctx, work, h.path('code/app'), { now })), {
          status: 'none',
        })
        assert.deepEqual(await unchanged(h, () => carryTrust(ctx, work, h.home, { now })), { status: 'none' })
      })
    })

    it('for a git repository inside a trusted plain folder: a parent never covers a nested repository', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('code/repo/.git')
        await h.mkdir('code/repo/src')
        const { work, ctx } = await twoAccounts(h, [h.path('code'), h.path('code/repo/src')])
        assert.deepEqual(await unchanged(h, () => carryTrust(ctx, work, h.path('code/repo/src'), { now })), {
          status: 'none',
        })
      })
    })

    it('in a worktree whose gitdir does not point back', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('other')
        await worktree(h, { backTo: h.path('other/.git') })
        const { work, ctx } = await twoAccounts(h, [
          h.path('code/repo'),
          h.path('code'),
          h.path('code/repo-wt'),
        ])
        assert.deepEqual(
          await unchanged(h, () => carryTrust(ctx, work, h.path('code/repo-wt/src'), { now })),
          {
            status: 'no-root',
          },
        )
      })
    })

    it('through a symlinked .claude.json', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('code/app')
        const { work, ctx } = await twoAccounts(h, [h.path('code/app')])
        await h.write('elsewhere.json', claudeJson({}), 0o600)
        const file = claudeJsonOf(work)
        await writeFile(file, '') // replaced by the link below
        const { rm } = await import('node:fs/promises')
        await rm(file)
        await symlink(h.path('elsewhere.json'), file)
        const r = await unchanged(h, () => carryTrust(ctx, work, h.path('code/app'), { now }))
        assert.deepEqual(
          [(r as { status: string }).status, (r as { why: string }).why],
          ['skipped', `${file} is a link`],
        )
      })
    })

    it('when projects or the entry is not an object, or the file is not a JSON object', async () => {
      for (const text of [
        (k: string) => claudeJson({ x: 1 }).replace('"projects": {\n    "x": 1\n  }', `"projects": ["${k}"]`),
        (k: string) => claudeJson({ [k]: 'yes' }),
        (k: string) => claudeJson({ [k]: { hasTrustDialogAccepted: 'yes' } }),
        () => '[1, 2]\n',
        () => `{ "oauthAccount": "${MARKER}", `,
      ])
        await withFakeHome(async (h) => {
          await h.mkdir('code/app')
          const key = h.path('code/app')
          const { work, ctx } = await twoAccounts(h, [key])
          await h.write('.claude-work/.claude.json', text(key), 0o600)
          const r = (await unchanged(h, () => carryTrust(ctx, work, key, { now }))) as {
            status: string
            why: string
          }
          assert.equal(r.status, 'skipped')
          assert.ok(!r.why.includes(MARKER), 'an error never quotes the file')
        })
    })

    it('when the file changed between reading and writing it', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('code/app')
        const key = h.path('code/app')
        const { work, ctx } = await twoAccounts(h, [key])
        const file = claudeJsonOf(work)
        const theirs = claudeJson({}, { numStartups: 4 })
        const r = await carryTrust(ctx, work, key, {
          now,
          hooks: { afterRead: () => writeFile(file, theirs) },
        })
        assert.deepEqual(
          [r.status, (r as { why?: string }).why],
          ['skipped', `${file} changed while sideby was writing it`],
        )
        assert.equal(await readFile(file, 'utf8'), theirs)
        assert.deepEqual(await readCarries(stateDir(h)), [])
      })
    })

    it('when the account has no .claude.json yet: it is never created', async () => {
      await withFakeHome(async (h) => {
        await h.mkdir('code/app')
        const { ctx } = await twoAccounts(h, [h.path('code/app')])
        const lab = acct(h, 'lab')
        await h.mkdir('.claude-lab/projects')
        const r = await unchanged(h, () =>
          carryTrust({ ...ctx, accounts: [...ctx.accounts, lab] }, lab, h.path('code/app'), { now }),
        )
        assert.equal((r as { status: string }).status, 'skipped')
      })
    })
  })
})

describe('reading trust', () => {
  it('keeps only the keys whose field is true; no other value of the file', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const { main, ctx } = await twoAccounts(h, [h.path('code/app')])
      const read = await readTrustKeys(claudeJsonOf(main))
      assert.deepEqual(read, { status: 'ok', keys: new Set([h.path('code/app'), h.path('elsewhere')]) })
      // `sideby trust` shows only booleans for the folder asked about, never another projects key or value.
      const st = await trustStatus(ctx, true, h.path('code/app'))
      const text = JSON.stringify(st)
      assert.ok(!text.includes(MARKER) && !text.includes('me@example.com'))
      assert.ok(!text.includes(h.path('elsewhere')), 'another projects key never reaches an output')
      assert.deepEqual(st.accounts, [
        { ref: 'claude:main', trusts: true },
        { ref: 'claude:work', trusts: false, carryFrom: 'claude:main' },
      ])
      // Off, nothing of .claude.json is read.
      assert.deepEqual(await trustStatus(ctx, false, h.path('code/app')), { on: false, carried: [] })
    })
  })
})

describe('undoCarries', () => {
  it('takes back only marks that still hold what sideby wrote, keeping what Claude Code added since', async () => {
    await withFakeHome(async (h) => {
      for (const d of ['a', 'b', 'c', 'd']) await h.mkdir(`code/${d}`)
      const k = (d: string) => h.path(`code/${d}`)
      const { work, ctx } = await twoAccounts(h, ['a', 'b', 'c', 'd'].map(k), {
        [k('d')]: { hasTrustDialogAccepted: false, allowedTools: [] },
      })
      const file = claudeJsonOf(work)
      const original = await readFile(file, 'utf8')
      for (const d of ['a', 'b', 'c', 'd'])
        assert.equal((await carryTrust(ctx, work, k(d), { now })).status, 'carried')
      // Since then: Claude Code used b (added its own fields), the user un-trusted c by hand.
      const p = await projectsOf(file)
      p[k('b')] = { hasTrustDialogAccepted: true, lastCost: 2 }
      p[k('c')] = { hasTrustDialogAccepted: false }
      const obj = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      await writeFile(file, `${JSON.stringify({ ...obj, projects: p }, null, 2)}\n`)
      const preview = await undoCarries(stateDir(h), { apply: false })
      assert.deepEqual(
        preview.map((x) => [x.key, x.status]),
        [
          [k('a'), 'undo'],
          [k('b'), 'undo'],
          [k('c'), 'changed'],
          [k('d'), 'undo'],
        ],
      )
      assert.equal((await readCarries(stateDir(h))).length, 4, 'a preview keeps every record')
      const done = await undoCarries(stateDir(h), { apply: true })
      assert.deepEqual(
        done.map((x) => x.status),
        ['undone', 'undone', 'changed', 'undone'],
      )
      assert.deepEqual(await projectsOf(file), {
        [k('d')]: { hasTrustDialogAccepted: false, allowedTools: [] },
        [k('b')]: { lastCost: 2 },
        [k('c')]: { hasTrustDialogAccepted: false },
      })
      assert.deepEqual(await readCarries(stateDir(h)), [])
      assert.deepEqual(await undoCarries(stateDir(h), { apply: true }), [])
      // With nothing changed in between, the file comes back byte for byte.
      await writeFile(file, original)
      await carryTrust(ctx, work, k('a'), { now })
      await undoCarries(stateDir(h), { apply: true })
      assert.equal(await readFile(file, 'utf8'), original)
    })
  })

  it('keeps the record of a carry made while an undo ran, so a later undo still finds it', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/a')
      await h.mkdir('code/b')
      const [ka, kb] = [h.path('code/a'), h.path('code/b')]
      const { work, ctx } = await twoAccounts(h, [ka, kb])
      await carryTrust(ctx, work, ka, { now })
      await carryTrust(ctx, work, kb, { now })
      const second = (await readCarries(stateDir(h))).find((c) => c.key === kb)!
      // While the first is undone, a Launch carries b anew: its record replaces the one the undo listed.
      const newer = { ...JSON.parse(await readFile(second.record, 'utf8')), at: '2026-11-18T11:00:00.000Z' }
      const done = await undoCarries(stateDir(h), {
        apply: true,
        hooks: {
          afterRead: async () => {
            await writeFile(second.record, `${JSON.stringify(newer, null, 2)}\n`)
          },
        },
      })
      assert.deepEqual(
        done.map((x) => [x.key, x.status]),
        [
          [ka, 'undone'],
          [kb, 'busy'],
        ],
      )
      assert.deepEqual(
        (await readCarries(stateDir(h))).map((c) => [c.key, c.at]),
        [[kb, '2026-11-18T11:00:00.000Z']],
      )
      assert.equal(
        ((await projectsOf(claudeJsonOf(work)))[kb] as Record<string, unknown>).hasTrustDialogAccepted,
        true,
      )
    })
  })

  it('leaves the mark alone when its record cannot be set aside, so no stale record outlives an undo', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      await carryTrust(ctx, work, key, { now })
      const dir = join(stateDir(h), 'trust', 'carried')
      await chmod(dir, 0o500)
      try {
        const [r] = await undoCarries(stateDir(h), { apply: true })
        assert.equal(r?.status, 'blocked')
      } finally {
        await chmod(dir, 0o700)
      }
      assert.equal(
        ((await projectsOf(claudeJsonOf(work)))[key] as Record<string, unknown>).hasTrustDialogAccepted,
        true,
      )
      assert.equal((await readCarries(stateDir(h))).length, 1)
    })
  })

  it('undoes only the carries a confirmation names, as they were shown', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/a')
      await h.mkdir('code/b')
      const [ka, kb] = [h.path('code/a'), h.path('code/b')]
      const { work, ctx } = await twoAccounts(h, [ka, kb])
      await carryTrust(ctx, work, ka, { now })
      const shown = (await undoCarries(stateDir(h), { apply: false })).map(({ id, at }) => ({ id, at }))
      await carryTrust(ctx, work, kb, { now })
      const done = await undoCarries(stateDir(h), { apply: true, only: shown })
      assert.deepEqual(
        done.map((x) => [x.key, x.status]),
        [[ka, 'undone']],
      )
      assert.deepEqual(
        (await readCarries(stateDir(h))).map((c) => c.key),
        [kb],
      )
    })
  })

  it('leaves the mark alone once the account folder leads to another account', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      await carryTrust(ctx, work, key, { now })
      // Since then the work folder was replaced by a link to another account that trusts the same folder itself.
      await h.write(
        '.claude-other/.claude.json',
        claudeJson({ [key]: { hasTrustDialogAccepted: true } }),
        0o600,
      )
      await rename(work.dir, h.path('.claude-work-old'))
      await symlink(h.path('.claude-other'), work.dir)
      const before = await readFile(h.path('.claude-other/.claude.json'), 'utf8')
      const [r] = await undoCarries(stateDir(h), { apply: true })
      assert.equal(r?.status, 'blocked')
      assert.equal(await readFile(h.path('.claude-other/.claude.json'), 'utf8'), before)
      assert.equal((await readCarries(stateDir(h))).length, 1)
    })
  })

  it('lists a record an undo set aside and could not put back, and never undoes with it', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      await carryTrust(ctx, work, key, { now })
      const [c] = await readCarries(stateDir(h))
      await rename(c!.record, `${c!.record}.undoing`)
      const before = await readFile(claudeJsonOf(work), 'utf8')
      const [r] = await undoCarries(stateDir(h), { apply: true })
      assert.equal(r?.status, 'blocked')
      assert.match(r?.why ?? '', /stopped halfway/)
      assert.equal(await readFile(claudeJsonOf(work), 'utf8'), before)
      assert.equal((await readCarries(stateDir(h))).length, 1)
    })
  })

  it('a second carry of a folder drops the earlier record first, so a failed new record leaves none to misuse', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      const file = claudeJsonOf(work)
      await carryTrust(ctx, work, key, { now })
      // The user turns it off by hand; the next Launch carries it again, but its record cannot be written.
      const p = await projectsOf(file)
      p[key] = { hasTrustDialogAccepted: false }
      const obj = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      await writeFile(file, `${JSON.stringify({ ...obj, projects: p }, null, 2)}\n`)
      const [old] = await readCarries(stateDir(h))
      // A folder where the new record goes makes its write fail.
      const r = await carryTrust(ctx, work, key, {
        now,
        hooks: { afterRead: async () => void (await mkdir(old!.record)) },
      })
      assert.equal(r.status, 'carried')
      assert.equal((r as { recordProblem?: boolean }).recordProblem, true)
      assert.deepEqual(await readCarries(stateDir(h)), [])
      assert.deepEqual(await undoCarries(stateDir(h), { apply: true }), [])
      assert.equal(((await projectsOf(file))[key] as Record<string, unknown>).hasTrustDialogAccepted, true)
    })
  })

  it('two Launches carrying the same folder at once keep one record', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      const rs = await Promise.all([carryTrust(ctx, work, key, { now }), carryTrust(ctx, work, key, { now })])
      assert.deepEqual(rs.map((r) => r.status).sort(), ['already', 'carried'])
      assert.equal((await readCarries(stateDir(h))).length, 1)
      assert.equal(
        ((await projectsOf(claudeJsonOf(work)))[key] as Record<string, unknown>).hasTrustDialogAccepted,
        true,
      )
    })
  })

  it('does not carry when its record folder is not safe to use, leaving the file as it is', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      const file = claudeJsonOf(work)
      await carryTrust(ctx, work, key, { now })
      const p = await projectsOf(file)
      p[key] = { hasTrustDialogAccepted: false }
      const obj = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      await writeFile(file, `${JSON.stringify({ ...obj, projects: p }, null, 2)}\n`)
      const before = await readFile(file, 'utf8')
      const dir = join(stateDir(h), 'trust')
      await chmod(dir, 0o770)
      try {
        assert.equal((await carryTrust(ctx, work, key, { now })).status, 'skipped')
      } finally {
        await chmod(dir, 0o700)
      }
      assert.equal(await readFile(file, 'utf8'), before)
      assert.equal((await readCarries(stateDir(h))).length, 1)
    })
  })

  it('does not carry when the target file cannot be read now, and keeps the earlier record', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      const file = claudeJsonOf(work)
      await carryTrust(ctx, work, key, { now })
      const p = await projectsOf(file)
      p[key] = { hasTrustDialogAccepted: false }
      const obj = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
      await writeFile(file, `${JSON.stringify({ ...obj, projects: p }, null, 2)}\n`)
      // The next Launch finds the file unreadable: nothing may change, and the earlier record must stay.
      await chmod(file, 0o000)
      try {
        assert.equal((await carryTrust(ctx, work, key, { now })).status, 'skipped')
      } finally {
        await chmod(file, 0o600)
      }
      assert.equal((await readCarries(stateDir(h))).length, 1)
    })
  })

  it('keeps the record when the account folder cannot be entered, and says it is blocked', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      await carryTrust(ctx, work, key, { now })
      await chmod(work.dir, 0o000)
      try {
        const [r] = await undoCarries(stateDir(h), { apply: true })
        assert.equal(r?.status, 'blocked')
        assert.equal((await readCarries(stateDir(h))).length, 1)
      } finally {
        await chmod(work.dir, 0o700)
      }
      assert.equal(
        ((await projectsOf(claudeJsonOf(work)))[key] as Record<string, unknown>).hasTrustDialogAccepted,
        true,
      )
    })
  })

  it('keeps the record of a file that changed while it was writing, for another try', async () => {
    await withFakeHome(async (h) => {
      await h.mkdir('code/app')
      const key = h.path('code/app')
      const { work, ctx } = await twoAccounts(h, [key])
      await carryTrust(ctx, work, key, { now })
      const file = claudeJsonOf(work)
      const [r] = await undoCarries(stateDir(h), {
        apply: true,
        hooks: { afterRead: async () => writeFile(file, `${await readFile(file, 'utf8')} `) },
      })
      assert.equal(r?.status, 'busy')
      assert.equal((await readCarries(stateDir(h))).length, 1)
      assert.ok((await readdir(join(stateDir(h), 'trust', 'carried'))).length === 1)
    })
  })
})
