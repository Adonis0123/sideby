// Run Links (spec §3.32 step 2b, ADR-0041): reading an orchestrator's Session Index and checking its board files.
import assert from 'node:assert/strict'
import { chmod, lstat, rename, rm, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import type { ExecResult } from './desktop-app.ts'
import { UserError } from './errors.ts'
import {
  boardsCheck,
  byRole,
  checkedEntry,
  dispatchStateDir,
  INDEX_MAX_BYTES,
  openRunBoard,
  parseSessionIndex,
  type RunEntry,
  runsForSessions,
  stillTheBoard,
  withRuns,
} from './run-link.ts'

const SID = '61230c3d-0000-4000-8000-000000000001'
const STATE = '.local/state/agent-dispatch'

/** `file://` as the orchestrator writes it: Python's `quote` of the absolute path, then `#lane-<id>`. */
const fileUrl = (path: string, lane?: string) =>
  `file://${path.replaceAll(' ', '%20')}${lane ? `#lane-${lane}` : ''}`

/** One index entry as the orchestrator writes it (`index_entries`). */
function entry(board: string, over: Record<string, unknown> = {}, lane: string | null = 'D2') {
  return {
    run: '20261020-145836-fcf2',
    runTitle: 'Run board for every repo',
    board,
    lane,
    laneTitle: lane ? 'sideby run link' : null,
    role: lane ? 'write' : 'coordinator',
    url: fileUrl(board, lane ?? undefined),
    ...over,
  }
}

const index = (sessions: Record<string, unknown[]>) =>
  JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    generatedAt: '2026-10-20T07:00:00Z',
    sessions: Object.fromEntries(Object.entries(sessions).map(([id, entries]) => [id, { entries }])),
  })

/** A board file in the fake HOME's boards folder; returns its absolute path. */
const board = (h: FakeHome, name = 'r1.html') =>
  h.write(`${STATE}/boards/${name}`, '<!doctype html>\n', 0o600)

describe('session index contract', () => {
  it('parses the index the orchestrator writes: revision, generatedAt, entries, a coordinator with no lane', () => {
    const b = '/s/agent-dispatch/boards/20261020-145836-fcf2.html'
    const parsed = parseSessionIndex(index({ [SID]: [entry(b, {}, null), entry(b)] }))
    assert.deepEqual(parsed?.get(SID), [
      { title: 'Run board for every repo', role: 'coordinator', board: b, url: `file://${b}` },
      {
        title: 'Run board for every repo',
        laneTitle: 'sideby run link',
        role: 'write',
        board: b,
        url: `file://${b}#lane-D2`,
      },
    ])
  })

  it('ignores another version, bad JSON and entries without a title, board or url', () => {
    assert.equal(parseSessionIndex(JSON.stringify({ schemaVersion: 2, sessions: {} })), undefined)
    assert.equal(parseSessionIndex('not json'), undefined)
    const parsed = parseSessionIndex(
      index({
        a: [{ runTitle: 'No board', url: 'file:///x.html' }],
        b: [{ board: '/x.html', url: 'file:///x.html' }],
        c: [{ runTitle: 'Line\nbreak\u0007', board: '/x.html', url: 'file:///x.html' }],
      }),
    )
    assert.deepEqual([...(parsed?.keys() ?? [])], ['c'])
    assert.equal(parsed?.get('c')?.[0]?.title, 'Line break')
  })

  it('orders several runs by role: coordinator, write, review, research, then the rest', () => {
    const e = (role: string) => ({ title: role, role, board: '/b.html', url: 'file:///b.html' }) as RunEntry
    assert.deepEqual(
      byRole([e('worker'), e('review'), e('research'), e('write'), e('coordinator'), e('subagent')]).map(
        (x) => x.role,
      ),
      ['coordinator', 'write', 'review', 'research', 'worker', 'subagent'],
    )
  })

  it('finds the state folder by AGENT_DISPATCH_STATE_DIR, then XDG_STATE_HOME, then ~/.local/state', () => {
    assert.equal(dispatchStateDir({ AGENT_DISPATCH_STATE_DIR: '/s/ad', XDG_STATE_HOME: '/x' }, '/h'), '/s/ad')
    assert.equal(dispatchStateDir({ XDG_STATE_HOME: '/x' }, '/h'), '/x/agent-dispatch')
    assert.equal(
      dispatchStateDir({ AGENT_DISPATCH_STATE_DIR: 'rel', XDG_STATE_HOME: 'rel' }, '/h'),
      '/h/.local/state/agent-dispatch',
    )
  })
})

describe('run links', () => {
  it('ties a session to its Run when the board file checks out, with the other runs after it', async () => {
    await withFakeHome(async (h) => {
      const b1 = await board(h, 'r 1.html')
      const b2 = await board(h, 'r2.html')
      await h.write(
        `${STATE}/session-index.json`,
        index({
          [SID]: [
            entry(b2, { runTitle: 'Second', role: 'review' }, 'R'),
            entry(b1),
            entry(b2, { runTitle: 'Third', role: 'subagent' }, 'S'),
          ],
        }),
      )
      const runs = await runsForSessions(h.env, h.home, [SID, 'unknown'])
      assert.deepEqual(Object.fromEntries(runs), {
        [SID]: {
          title: 'Run board for every repo',
          laneTitle: 'sideby run link',
          role: 'write',
          board: b1,
          url: fileUrl(b1, 'D2'),
          others: [
            { title: 'Second', laneTitle: 'sideby run link', role: 'review', board: b2 },
            { title: 'Third', laneTitle: 'sideby run link', role: 'subagent', board: b2 },
          ],
        },
      })
      const listed = await withRuns(h.env, h.home, [{ sessionId: SID }, { sessionId: 'x' }])
      assert.equal(listed[0]!.run?.board, b1)
      assert.equal('run' in listed[1]!, false)
    })
  })

  it('leaves out a board outside the boards folder, a link, a wrong owner or name, and a url that differs', async () => {
    await withFakeHome(async (h) => {
      const good = await board(h)
      const outside = await h.write(`${STATE}/r-outside.html`, 'x', 0o600)
      const deeper = await h.write(`${STATE}/boards/sub/r.html`, 'x', 0o600)
      const notHtml = await board(h, 'r.txt')
      const link = h.path(`${STATE}/boards/link.html`)
      await symlink(good, link)
      const cases: Record<string, unknown> = {
        outside: entry(outside),
        deeper: entry(deeper),
        link: entry(link),
        'not-html': entry(notHtml),
        relative: entry('boards/r1.html'),
        dotdot: entry(h.path(`${STATE}/boards/../r-outside.html`)),
        'other-file': entry(good, { url: fileUrl(h.path(`${STATE}/boards/r2.html`)) }),
        'http-url': entry(good, { url: 'http://127.0.0.1:17420/run/r1' }),
        'bad-fragment': entry(good, { url: `${fileUrl(good)}#javascript:x` }),
        query: entry(good, { url: `${fileUrl(good)}?x=1` }),
        host: entry(good, { url: `file://example.com${good}` }),
        missing: entry(h.path(`${STATE}/boards/gone.html`)),
      }
      await h.write(
        `${STATE}/session-index.json`,
        index(Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, [v]]))),
      )
      assert.deepEqual([...(await runsForSessions(h.env, h.home, Object.keys(cases))).keys()], [])
      // The same good entry passes, and fails for another owner.
      await h.write(`${STATE}/session-index.json`, index({ [SID]: [entry(good)] }))
      assert.equal((await runsForSessions(h.env, h.home, [SID])).size, 1)
      const uid = process.getuid!()
      assert.equal((await runsForSessions(h.env, h.home, [SID], uid + 1)).size, 0)
    })
  })

  it('shows nothing without an index, a boards folder, or a usable index file', async () => {
    await withFakeHome(async (h) => {
      assert.equal((await runsForSessions(h.env, h.home, [SID])).size, 0)
      const file = `${STATE}/session-index.json`
      // No boards folder at all.
      await h.write(file, index({ [SID]: [entry(h.path(`${STATE}/boards/r1.html`))] }))
      assert.equal((await runsForSessions(h.env, h.home, [SID])).size, 0)
      const good = await board(h)
      // Too big: ignored before parsing.
      const big = JSON.stringify({
        schemaVersion: 1,
        sessions: { [SID]: { entries: [entry(good)] } },
        pad: 'x'.repeat(INDEX_MAX_BYTES),
      })
      await h.write(file, big)
      assert.equal((await runsForSessions(h.env, h.home, [SID])).size, 0)
      // A link at the index is not followed.
      const real = await h.write('elsewhere.json', index({ [SID]: [entry(good)] }))
      await rm(h.path(file))
      await symlink(real, h.path(file))
      assert.equal((await runsForSessions(h.env, h.home, [SID])).size, 0)
      // A boards folder that is a link is not used.
      await rm(h.path(file))
      await h.write('real-boards/r1.html', 'x', 0o600)
      await rm(h.path(`${STATE}/boards`), { recursive: true })
      await symlink(h.path('real-boards'), h.path(`${STATE}/boards`))
      await h.write(file, index({ [SID]: [entry(h.path(`${STATE}/boards/r1.html`))] }))
      assert.equal((await runsForSessions(h.env, h.home, [SID])).size, 0)
    })
  })

  it('opens the board found again from the index with the default program, never a path it was given', async () => {
    await withFakeHome(async (h) => {
      const good = await board(h)
      await chmod(good, 0o600)
      await h.write(`${STATE}/session-index.json`, index({ [SID]: [entry(good)] }))
      const calls: { cmd: string; args: string[] }[] = []
      const exec = async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
        calls.push({ cmd, args: [...args] })
        return { code: 0, stdout: '', stderr: '' }
      }
      const rt = await createRuntime({ env: h.env, desktop: { platform: 'darwin', exec } })
      const r = await openRunBoard(rt, SID)
      assert.deepEqual(r, { board: good, command: ['/usr/bin/open', good] })
      assert.deepEqual(calls, [{ cmd: '/usr/bin/open', args: [good] }])
      await assert.rejects(openRunBoard(rt, 'not-in-the-index'), (err: unknown) => {
        assert.ok(err instanceof UserError && err.code === 'no-run', String(err))
        return true
      })
      assert.equal(calls.length, 1)
    })
  })

  it('does not open a board swapped for a link or another file after it was checked', async () => {
    await withFakeHome(async (h) => {
      const good = await board(h)
      const outside = await h.write('secret.html', 'not a board', 0o600)
      const check = (await boardsCheck(h.env, h.home))!
      assert.ok(await checkedEntry(parseSessionIndex(index({ [SID]: [entry(good)] }))!.get(SID)![0]!, check))
      const st = await lstat(good)
      const id = { dev: st.dev, ino: st.ino }
      assert.equal(await stillTheBoard(good, check, id), true)
      // Swapped for a link to a file outside the boards folder. The old file is moved aside rather than removed,
      // so the next file cannot reuse its inode number (Linux hands a freed one out at once).
      await rename(good, `${good}-old`)
      await symlink(outside, good)
      assert.equal(await stillTheBoard(good, check, id), false)
      // Swapped for another regular file of the same name.
      await rm(good)
      await h.write(`${STATE}/boards/r1.html`, 'new', 0o600)
      assert.equal(await stillTheBoard(good, check, id), false)
      // The boards folder itself swapped for a link to a look-alike folder.
      const fresh = await lstat(good)
      await h.write('lookalike/r1.html', 'x', 0o600)
      await rename(h.path(`${STATE}/boards`), h.path(`${STATE}/boards-old`))
      await symlink(h.path('lookalike'), h.path(`${STATE}/boards`))
      assert.equal(await stillTheBoard(good, check, { dev: fresh.dev, ino: fresh.ino }), false)
    })
  })
})
