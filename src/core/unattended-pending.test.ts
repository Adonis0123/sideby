// Pending Decisions (spec §3.37): one file each (folder 700, files 600), kept until marked done, deleted 30 days after.
import assert from 'node:assert/strict'
import { chmod, readdir, stat, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import {
  addPendingDecision,
  findPendingDecision,
  listPendingDecisions,
  markPendingDone,
  PENDING_TEXT_MAX,
  pendingDir,
} from './unattended-pending.ts'

const at = (day: number, hour: number) => new Date(2026, 9, day, hour)

describe('Pending Decisions', () => {
  it('keeps each one in a file of the user, with only the fields given', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      const d = await addPendingDecision(
        dir,
        { kind: 'deferred', family: 'claude', text: '  deploy left  ' },
        at(26, 2),
      )
      assert.deepEqual(Object.keys(d).sort(), ['at', 'family', 'id', 'kind', 'text'])
      assert.equal(d.text, 'deploy left')
      assert.equal((await stat(pendingDir(dir))).mode & 0o777, 0o700)
      assert.equal((await stat(join(dir, 'unattended'))).mode & 0o777, 0o700)
      assert.equal((await stat(join(pendingDir(dir), `${d.id}.json`))).mode & 0o777, 0o600)
      const q = await addPendingDecision(
        dir,
        {
          kind: 'question',
          family: 'codex',
          account: 'codex:team',
          sessionId: 's1',
          cwd: '/tmp/p',
          text: 'Which?',
        },
        at(26, 3),
      )
      assert.deepEqual(await listPendingDecisions(dir, { now: at(26, 4) }), [d, q])
    })
  })

  it('cuts text at 4000 characters without splitting one', async () => {
    await withFakeHome(async (h) => {
      const d = await addPendingDecision(h.path('state'), {
        kind: 'deferred',
        family: 'claude',
        text: '字'.repeat(5000),
      })
      assert.equal([...d.text].length, PENDING_TEXT_MAX)
      assert.ok(d.text.endsWith('…'))
    })
  })

  it('keeps one copy of a question asked twice in a session, with dedupe', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      const input = { kind: 'question' as const, family: 'claude', sessionId: 's1', text: 'Which?' }
      const a = await addPendingDecision(dir, input, at(26, 2), { dedupe: true })
      const b = await addPendingDecision(dir, input, at(26, 3), { dedupe: true })
      assert.equal(a.id, b.id)
      await addPendingDecision(dir, { ...input, sessionId: 's2' }, at(26, 3), { dedupe: true })
      assert.equal((await listPendingDecisions(dir)).length, 2)
    })
  })

  it('marks one or all done, lists done ones with all, and deletes them 30 days later', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      const a = await addPendingDecision(dir, { kind: 'deferred', family: 'claude', text: 'a' }, at(1, 1))
      const b = await addPendingDecision(dir, { kind: 'deferred', family: 'claude', text: 'b' }, at(1, 2))
      const c = await addPendingDecision(dir, { kind: 'deferred', family: 'claude', text: 'c' }, at(1, 3))
      const [doneA] = await markPendingDone(dir, a.id.slice(0, 10), at(2, 0))
      assert.equal(doneA?.doneAt, at(2, 0).toISOString())
      assert.deepEqual(
        (await listPendingDecisions(dir, { now: at(2, 1) })).map((d) => d.id),
        [b.id, c.id],
      )
      assert.equal((await markPendingDone(dir, 'all', at(3, 0))).length, 2)
      assert.equal((await listPendingDecisions(dir, { now: at(3, 1) })).length, 0)
      assert.equal((await listPendingDecisions(dir, { all: true, now: at(3, 1) })).length, 3)
      // a was marked on the 2nd: gone after 30 days; b and c (the 3rd) stay one more day.
      const later = new Date(at(2, 0).getTime() + 30 * 24 * 60 * 60 * 1000 + 1000)
      assert.deepEqual(
        (await listPendingDecisions(dir, { all: true, now: later })).map((d) => d.id),
        [b.id, c.id],
      )
      assert.equal((await readdir(pendingDir(dir))).length, 2)
      await assert.rejects(markPendingDone(dir, 'nope'), /pending --all/)
      assert.equal(await findPendingDecision(dir, 'mv'), undefined)
    })
  })

  it('skips a file that is not a Pending Decision', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      await h.write('state/unattended/pending/abcdefgh-123456.json', '{"id":"abcdefgh-123456"}')
      await h.write('state/unattended/pending/notes.txt', 'x')
      assert.deepEqual(await listPendingDecisions(dir, { all: true }), [])
    })
  })

  it('never reads or writes through a linked folder, a linked file or a folder others can write to', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      const input = { kind: 'deferred' as const, family: 'claude', text: 'x' }
      // `<state>/unattended` is a link to a folder elsewhere.
      const outside = await h.mkdir('elsewhere')
      await h.mkdir('state')
      await symlink(outside, join(dir, 'unattended'))
      await assert.rejects(addPendingDecision(dir, input), /real folder you own/)
      assert.deepEqual(await readdir(outside), [])
      // `pending` is the link, and the folder it points to holds a valid record: nothing is read from it.
      await h.write(
        'elsewhere2/abcdefgh-123456.json',
        JSON.stringify({
          id: 'abcdefgh-123456',
          at: '2026-10-26T00:00:00.000Z',
          kind: 'deferred',
          family: 'claude',
          text: 'planted',
        }),
      )
      await h.mkdir('state2/unattended')
      await symlink(h.path('elsewhere2'), h.path('state2/unattended/pending'))
      assert.deepEqual(await listPendingDecisions(h.path('state2'), { all: true }), [])
      await assert.rejects(addPendingDecision(h.path('state2'), input), /real folder you own/)
      assert.deepEqual(await readdir(h.path('elsewhere2')), ['abcdefgh-123456.json'])
      // A folder group members can write to is refused too.
      await h.mkdir('state3/unattended')
      await chmod(h.path('state3/unattended'), 0o770)
      await assert.rejects(addPendingDecision(h.path('state3'), input), /real folder you own/)
    })
  })

  it('narrows an existing folder others can read to 700, and skips a record that is a link', async () => {
    await withFakeHome(async (h) => {
      const dir = h.path('state')
      await h.mkdir('state/unattended/pending')
      await chmod(h.path('state/unattended'), 0o755)
      await chmod(h.path('state/unattended/pending'), 0o755)
      const d = await addPendingDecision(dir, { kind: 'deferred', family: 'claude', text: 'kept' }, at(26, 2))
      assert.equal((await stat(h.path('state/unattended'))).mode & 0o777, 0o700)
      assert.equal((await stat(pendingDir(dir))).mode & 0o777, 0o700)
      const planted = await h.write(
        'elsewhere/x.json',
        JSON.stringify({
          id: 'abcdefgh-654321',
          at: '2026-10-26T00:00:00.000Z',
          kind: 'deferred',
          family: 'claude',
          text: 'planted',
        }),
      )
      await symlink(planted, join(pendingDir(dir), 'abcdefgh-654321.json'))
      assert.deepEqual(await listPendingDecisions(dir, { now: at(26, 3) }), [d])
    })
  })
})
