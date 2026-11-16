// Attended Sessions' store and the transcript reader (spec §3.37 "有人在的会话", ADR-0075).
import assert from 'node:assert/strict'
import { appendFile, readdir, readFile, symlink } from 'node:fs/promises'
import { describe, it } from 'node:test'
import { withFakeHome } from '../../testing/index.ts'
import { resolvePaths } from './paths.ts'
import { unattendedStatus } from './unattended.ts'
import {
  ATTENDED_MS,
  listAttended,
  markAttended,
  markTold,
  ownTranscript,
  promptOrigin,
  readAttended,
} from './unattended-attended.ts'

const T0 = Date.UTC(2026, 10, 16, 15)
const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`

describe('transcript origin of a prompt', () => {
  it('waits for the line Claude Code writes after the hook starts, and reads only from just before the end', async () => {
    await withFakeHome(async (h) => {
      // An earlier line about the same id far back is out of reach; the one written later is found.
      const file = await h.write(
        't/s1.jsonl',
        line({ type: 'user', promptId: 'p1', origin: { kind: 'peer' } }),
      )
      await appendFile(file, 'x'.repeat(300 * 1024).concat('\n'))
      let t = 0
      const got = await promptOrigin(file, 'p1', {
        clock: () => t,
        sleep: async (ms) => {
          if (t === 0)
            await appendFile(file, line({ type: 'user', promptId: 'p1', origin: { kind: 'human' } }))
          t += ms
        },
      })
      assert.equal(got?.origin, 'human')
    })
  })

  it('reads a line written before the hook started whole, even one longer than the part read back', async () => {
    await withFakeHome(async (h) => {
      const quick = () => {
        let t = 0
        return { clock: () => (t += 1000), sleep: async () => {} }
      }
      const at = '2026-11-16T15:00:00.000Z'
      const earlier = line({ type: 'assistant', message: { content: 'earlier' } }).repeat(100)
      const picture = {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(300 * 1024) },
      }
      const withPicture = await h.write(
        't/picture.jsonl',
        earlier +
          line({
            type: 'user',
            promptId: 'p1',
            origin: { kind: 'human' },
            timestamp: at,
            message: { content: [{ type: 'text', text: 'look' }, picture] },
          }),
      )
      assert.deepEqual(await promptOrigin(withPicture, 'p1', quick()), {
        origin: 'human',
        at: Date.parse(at),
        text: 'look',
      })
      const long = 'a long log\n'.repeat(30_000)
      const longText = await h.write(
        't/long.jsonl',
        earlier +
          line({
            type: 'user',
            promptId: 'p2',
            origin: { kind: 'human' },
            timestamp: at,
            message: { content: long },
          }) +
          line({ type: 'assistant', message: { content: 'reading it' } }),
      )
      assert.equal((await promptOrigin(longText, 'p2', quick()))?.text, long)
    })
  })

  it('reads a transcript that did not exist yet from its start', async () => {
    await withFakeHome(async (h) => {
      const file = h.path('t', 'new.jsonl')
      let t = 0
      const got = await promptOrigin(file, 'p1', {
        clock: () => t,
        sleep: async (ms) => {
          if (t === 100)
            await h.write('t/new.jsonl', line({ type: 'user', promptId: 'p1', origin: { kind: 'human' } }))
          t += ms
        },
      })
      assert.equal(got?.origin, 'human')
    })
  })

  it('answers other for anything but a person, and nothing for a line it cannot trust', async () => {
    await withFakeHome(async (h) => {
      const quick = {
        clock: (() => {
          let t = 0
          return () => (t += 1000)
        })(),
        sleep: async () => {},
      }
      const one = async (rec: Record<string, unknown>, name = 'a.jsonl') =>
        (await promptOrigin(await h.write(`t/${name}`, line(rec)), 'p1', quick))?.origin
      assert.equal(
        await one({ type: 'user', promptId: 'p1', origin: { kind: 'peer', from: 'unknown' } }),
        'other',
      )
      assert.equal(
        await one({ type: 'user', promptId: 'p1', origin: { kind: 'task-notification' } }),
        'other',
      )
      assert.equal(await one({ type: 'user', promptId: 'p1', promptSource: 'sdk' }), undefined)
      assert.equal(await one({ type: 'assistant', promptId: 'p1', origin: { kind: 'human' } }), undefined)
      assert.equal(
        await one({ type: 'user', promptId: 'p2', origin: { kind: 'human' }, note: 'p1' }),
        undefined,
      )
      // Not a transcript path, or a link in its place.
      assert.equal(await promptOrigin('relative/a.jsonl', 'p1', quick), undefined)
      assert.equal(await promptOrigin(h.path('t', 'a.json'), 'p1', quick), undefined)
      const real = await h.write(
        't/real.jsonl',
        line({ type: 'user', promptId: 'p1', origin: { kind: 'human' } }),
      )
      await symlink(real, h.path('t', 'link.jsonl'))
      assert.equal(await promptOrigin(h.path('t', 'link.jsonl'), 'p1', quick), undefined)
    })
  })

  it("gives the line's time and text, and leaves out what is not one", async () => {
    await withFakeHome(async (h) => {
      const quick = { clock: () => 0, sleep: async () => {} }
      const at = '2026-11-16T15:00:00.000Z'
      const got = async (rec: Record<string, unknown>) =>
        promptOrigin(await h.write('t/a.jsonl', line({ type: 'user', promptId: 'p1', ...rec })), 'p1', quick)
      assert.deepEqual(
        await got({ origin: { kind: 'human' }, timestamp: at, message: { role: 'user', content: 'typed' } }),
        { origin: 'human', at: Date.parse(at), text: 'typed' },
      )
      // A prompt with a picture: its text blocks, joined.
      assert.deepEqual(
        await got({
          origin: { kind: 'human' },
          timestamp: at,
          message: {
            content: [
              { type: 'text', text: 'look' },
              { type: 'image', source: {} },
              { type: 'text', text: 'here' },
            ],
          },
        }),
        { origin: 'human', at: Date.parse(at), text: 'look\nhere' },
      )
      assert.deepEqual(await got({ origin: { kind: 'human' }, timestamp: 'soon', message: { content: 7 } }), {
        origin: 'human',
      })
    })
  })

  it("believes only the session's own transcript in the account's projects folder", async () => {
    await withFakeHome(async (h) => {
      const own = await h.write('.claude/projects/p/s1.jsonl', '')
      const env = { HOME: h.path() }
      assert.equal(await ownTranscript(own, 's1', env), true)
      // Another session's file, a file elsewhere, a relative path, or a folder that is not there.
      assert.equal(await ownTranscript(own, 's2', env), false)
      assert.equal(await ownTranscript(await h.write('elsewhere/p/s1.jsonl', ''), 's1', env), false)
      assert.equal(await ownTranscript(await h.write('.claude/s1.jsonl', ''), 's1', env), false)
      assert.equal(await ownTranscript('.claude/projects/p/s1.jsonl', 's1', env), false)
      // An account's own config folder, and a projects folder reached through a link.
      const work = await h.write('.claude-work/projects/q/s1.jsonl', '')
      assert.equal(
        await ownTranscript(work, 's1', { ...env, CLAUDE_CONFIG_DIR: h.path('.claude-work') }),
        true,
      )
      assert.equal(
        await ownTranscript(own, 's1', { ...env, CLAUDE_CONFIG_DIR: h.path('.claude-work') }),
        false,
      )
      await symlink(h.path('.claude'), h.path('linked'))
      assert.equal(await ownTranscript(h.path('linked', 'projects', 'p', 's1.jsonl'), 's1', env), true)
    })
  })
})

describe('Attended Session records', () => {
  it('keeps a stretch going while it counts, starts a new one after it ran out, and keeps nothing of the prompt', async () => {
    await withFakeHome(async (h) => {
      const state = resolvePaths(h.env).stateDir
      const who = { sessionId: 's1', family: 'claude', account: 'claude:work', cwd: '/work/p' }
      const first = await markAttended(state, who, new Date(T0))
      assert.equal(first.since, new Date(T0).toISOString())
      await markTold(state, 's1', first.since, new Date(T0 + 1000))
      // Renewed inside the 30 minutes: same stretch, still told.
      const second = await markAttended(state, who, new Date(T0 + 20 * 60_000))
      assert.deepEqual([second.since, Boolean(second.toldAt)], [first.since, true])
      assert.equal((await readAttended(state, 's1', new Date(T0 + 49 * 60_000)))?.at, second.at)
      assert.equal(await readAttended(state, 's1', new Date(T0 + 20 * 60_000 + ATTENDED_MS)), undefined)
      // An older prompt than the one noted changes nothing.
      assert.deepEqual(await markAttended(state, who, new Date(T0 + 10 * 60_000)), second)
      assert.equal((await readAttended(state, 's1', new Date(T0 + 49 * 60_000)))?.at, second.at)
      // A told mark for an older stretch does not carry over.
      const third = await markAttended(state, who, new Date(T0 + 60 * 60_000))
      assert.deepEqual([third.since, third.toldAt], [new Date(T0 + 60 * 60_000).toISOString(), undefined])
      await markTold(state, 's1', first.since, new Date(T0 + 61 * 60_000))
      assert.equal((await readAttended(state, 's1', new Date(T0 + 61 * 60_000)))?.toldAt, undefined)
      const files = await readdir(`${state}/unattended/attended`)
      assert.equal(files.length, 1)
      assert.match(files[0]!, /^[0-9a-f]{32}\.json$/)
      assert.deepEqual(
        Object.keys(JSON.parse(await readFile(`${state}/unattended/attended/${files[0]}`, 'utf8'))).sort(),
        ['account', 'at', 'cwd', 'family', 'sessionId', 'since'],
      )
    })
  })

  it('lists the sessions that count now, latest end first, in the status, and removes long-expired ones', async () => {
    await withFakeHome(async (h) => {
      const paths = resolvePaths(h.env)
      await h.write('.config/sideby/config.json', '{"unattended":{}}')
      await markAttended(paths.stateDir, { sessionId: 'old', family: 'claude' }, new Date(T0 - 3 * 3600_000))
      await markAttended(paths.stateDir, { sessionId: 'a', family: 'claude' }, new Date(T0 - 10 * 60_000))
      await markAttended(
        paths.stateDir,
        { sessionId: 'b', family: 'claude', account: 'claude:work' },
        new Date(T0),
      )
      const s = await unattendedStatus({ paths, families: ['claude'], now: new Date(T0 + 60_000) })
      assert.deepEqual(
        s.attended.map((x) => [x.sessionId, x.until]),
        [
          ['b', new Date(T0 + ATTENDED_MS).toISOString()],
          ['a', new Date(T0 - 10 * 60_000 + ATTENDED_MS).toISOString()],
        ],
      )
      assert.equal((await readdir(`${paths.stateDir}/unattended/attended`)).length, 2)
      assert.deepEqual(await listAttended(paths.stateDir, new Date(T0 + ATTENDED_MS)), [])
    })
  })

  it('a told mark written while a prompt renews the stretch keeps the renewed time', async () => {
    await withFakeHome(async (h) => {
      const state = resolvePaths(h.env).stateDir
      const who = { sessionId: 's1', family: 'claude' }
      const first = await markAttended(state, who, new Date(T0))
      let renewal: Promise<unknown> | undefined
      // Between the told mark's read and its write, a prompt at T0 + 29 minutes renews the stretch to T0 + 59.
      await markTold(state, 's1', first.since, new Date(T0 + 60_000), {
        beforeWrite: async () => {
          renewal = markAttended(state, who, new Date(T0 + 29 * 60_000))
          await new Promise((r) => setTimeout(r, 150))
        },
      })
      await renewal
      const r = await readAttended(state, 's1', new Date(T0 + 45 * 60_000))
      assert.deepEqual(
        [r?.at, r?.since, r?.toldAt],
        [new Date(T0 + 29 * 60_000).toISOString(), first.since, new Date(T0 + 60_000).toISOString()],
      )
      // The lock is gone once both are done.
      assert.deepEqual(
        (await readdir(`${state}/unattended/attended`)).filter((f) => !f.endsWith('.json')),
        [],
      )
    })
  })

  it('neither reads nor writes through a folder someone else could change', async () => {
    await withFakeHome(async (h) => {
      const state = resolvePaths(h.env).stateDir
      await h.mkdir('elsewhere')
      await h.mkdir('.local/state/sideby/unattended')
      await symlink(h.path('elsewhere'), `${state}/unattended/attended`)
      await assert.rejects(markAttended(state, { sessionId: 's1', family: 'claude' }, new Date(T0)))
      assert.equal(await readAttended(state, 's1', new Date(T0)), undefined)
      assert.deepEqual(await listAttended(state, new Date(T0)), [])
      assert.deepEqual(await readdir(h.path('elsewhere')), [])
    })
  })
})
