import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fakeHost, readHostLog, withFakeHome } from '../../testing/index.ts'
import { checkSchema, sideby, sidebySpawn } from './cli-test-helpers.ts'

describe('sideby update (spec §3.23)', () => {
  /** A registry on localhost answering `latest`, so the test never leaves the machine. */
  async function fakeRegistry(latest: string) {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/-/package/sideby/dist-tags' ? 200 : 404, {
        'content-type': 'application/json',
      })
      res.end(JSON.stringify({ latest }))
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as import('node:net').AddressInfo
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) }
  }

  it('says when this is the newest version, and names the command where it cannot update itself', async () => {
    await withFakeHome(async (h) => {
      const { packageVersion } = await import('../core/version.ts')
      const same = await fakeRegistry(packageVersion())
      try {
        const r = await sidebySpawn(h, ['update', '--json'], { SIDEBY_UPDATE_REGISTRY: same.url })
        assert.equal(r.code, 0, r.err)
        const data = checkSchema('update', r.out)
        assert.equal(data.available, false)
      } finally {
        await same.close()
      }
      const newer = await fakeRegistry('99.0.0')
      try {
        // These tests run from the source checkout, which sideby never updates itself.
        const r = await sidebySpawn(h, ['update', '--json'], { SIDEBY_UPDATE_REGISTRY: newer.url })
        assert.equal(r.code, 1)
        const data = checkSchema('update', r.out)
        assert.deepEqual(
          [data.available, data.canRun, data.command],
          [true, false, 'git pull && pnpm install'],
        )
        const text = await sidebySpawn(h, ['update'], { SIDEBY_UPDATE_REGISTRY: newer.url })
        assert.match(text.err, /cannot update itself: it runs from a source checkout/)
        // The cache now knows 99.0.0, but without a terminal no command prints a notice.
        const list = await sidebySpawn(h, ['list'], { SIDEBY_NO_UPDATE_NOTIFIER: '' })
        assert.doesNotMatch(list.err, /is available/)
      } finally {
        await newer.close()
      }
    })
  })

  it('--skill updates only the installed skill, even with a newer sideby out, and asks no registry', async () => {
    await withFakeHome(async (h) => {
      // Checked just now, so no Update Check starts: the last check knows of a newer sideby.
      const now = new Date().toISOString()
      await h.write(
        '.local/state/sideby/update.json',
        JSON.stringify({ checkedAt: now, triedAt: now, latest: '99.0.0' }),
      )
      await h.write('.agents/skills/sideby/SKILL.md', '---\nname: sideby\nmetadata:\n  version: 0.0.1\n---\n')
      await fakeHost(h, 'npx')
      await fakeHost(h, 'npm')
      // A registry that cannot be reached: --skill never asks it.
      const env = { SIDEBY_UPDATE_REGISTRY: 'http://127.0.0.1:9' }
      const preview = await sideby(h, ['update', '--skill', '--json'], env)
      assert.equal(preview.code, 10, preview.err)
      assert.equal(checkSchema('update', preview.out).updated, false)
      assert.deepEqual(await readHostLog(h, 'npx'), [])
      const r = await sideby(h, ['update', '--skill', '--yes', '--json'], env)
      assert.equal(r.code, 0, r.err)
      const data = checkSchema('update', r.out)
      assert.deepEqual(
        [data.available, data.latest, data.updated, data.skillUpdated],
        [true, '99.0.0', false, true],
      )
      assert.deepEqual(
        (await readHostLog(h, 'npx')).map((x) => x.argv),
        [['-y', 'skills', 'update', 'sideby', '-g', '-y']],
      )
      assert.deepEqual(await readHostLog(h, 'npm'), [], 'the CLI is never installed')
      const text = await sideby(h, ['update', '--skill', '--yes'], env)
      assert.match(text.out, /99\.0\.0 is available; updating sideby itself is separate: `sideby update`/)
    })
  })

  it('a full update whose skill update fails says why in the JSON (skillMessage)', async () => {
    await withFakeHome(async (h) => {
      // In this process: a child runs from the source checkout, which sideby never updates itself.
      const { cmdUpdate } = await import('./commands.ts')
      const { parseArgs } = await import('./args.ts')
      const { bindUpdateDeps } = await import('../core/update.ts')
      await h.write('.agents/skills/sideby/SKILL.md', '---\nname: sideby\nmetadata:\n  version: 0.0.1\n---\n')
      const unbind = bindUpdateDeps({
        fetch: (async () => new Response(JSON.stringify({ latest: '99.0.0' }))) as typeof fetch,
        packageDir: async () => join(h.home, '.nvm/versions/node/v22/lib/node_modules/sideby'),
        writable: async () => true,
        alive: () => false,
        // The install succeeds; the skills tool fails.
        exec: async (file) => ({ code: file === 'npx' ? 1 : 0, output: '' }),
        appInstalled: async () => false,
        autostartInstalled: async () => false,
      })
      const env = process.env
      const { SIDEBY_NO_UPDATE_NOTIFIER: _off, ...fake } = h.env
      process.env = fake as NodeJS.ProcessEnv
      const out: string[] = []
      try {
        const code = await cmdUpdate(parseArgs(['--yes', '--json'], ['json', 'yes']), {
          out: (s) => out.push(s),
          err: () => {},
        })
        assert.equal(code, 0, out.join('\n'))
      } finally {
        process.env = env
        unbind()
      }
      const data = checkSchema('update', out.join('\n'))
      assert.deepEqual([data.updated, data.skillUpdated], [true, false])
      assert.match(String(data.skillMessage), /run it yourself/)
    })
  })

  it('reports a registry it cannot reach as an error with what to do', async () => {
    await withFakeHome(async (h) => {
      const r = await sideby(h, ['update', '--json'], { SIDEBY_UPDATE_REGISTRY: 'http://127.0.0.1:9' })
      assert.equal(r.code, 1)
      const data = checkSchema('error', r.out)
      assert.match(String(data.error), /could not reach http:\/\/127\.0\.0\.1:9/)
    })
  })
})
