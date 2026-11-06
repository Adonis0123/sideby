// The Panel's `open` option and config `editor` (spec §3.30, ADR-0033 amendment): in a Portal that opens files itself,
// "Open settings.json" asks the server only where the real file is and posts that path to the Portal; on its own, the
// server opens the file with config `editor`. No test starts a program: every one goes through a fake `exec`.
import assert from 'node:assert/strict'
import { readFile, symlink } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler, type PanelHandlerOptions } from './handler.ts'
import { openBridge, openBridged } from './page-logic.ts'
import { PAGE_SCRIPT } from './page-script.ts'

const SECRET = 'fake-key-never-shown'

async function withPanel(
  h: FakeHome,
  open: PanelHandlerOptions['open'] | undefined,
  fn: (p: {
    port: number
    calls: { cmd: string; args: readonly string[] }[]
    get: (path: string) => Promise<string>
    post: (path: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  }) => Promise<void>,
) {
  const calls: { cmd: string; args: readonly string[] }[] = []
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => {
    void handler!(req, res).then((done) => {
      if (!done) res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  handler = createPanelHandler({
    runtime: () =>
      createRuntime({
        env: { ...h.env, PATH: h.bin },
        desktop: {
          platform: 'darwin',
          appDirs: [h.path('Applications')],
          exec: async (cmd, args) => {
            calls.push({ cmd, args })
            return { code: 0, stdout: '', stderr: '' }
          },
        },
      }),
    allowedHosts: [`127.0.0.1:${port}`],
    ...(open ? { open } : {}),
  })
  const send = (method: string, path: string, body?: string) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const headers: Record<string, string> = { host: `127.0.0.1:${port}` }
      if (body !== undefined)
        Object.assign(headers, {
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
          'x-sideby-token': handler!.token,
        })
      const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
        let text = ''
        res.on('data', (d: Buffer) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      })
      req.on('error', reject)
      req.end(body)
    })
  try {
    await fn({
      port,
      calls,
      get: async (path) => (await send('GET', path)).text,
      post: async (path, body) => {
        const r = await send('POST', path, JSON.stringify(body))
        return { status: r.status, body: JSON.parse(r.text || '{}') as Record<string, unknown> }
      },
    })
  } finally {
    await new Promise<void>((r) => {
      server.close(() => r())
      server.closeAllConnections()
    })
  }
}

const boot = (html: string) =>
  JSON.parse(/<script type="application\/json" id="sideby-boot">(.*?)<\/script>/s.exec(html)![1]!)

async function seed(h: FakeHome) {
  await h.write('.claude/settings.json', JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: SECRET } }))
  await h.mkdir('.claude-work')
  await symlink(h.path('.claude/settings.json'), h.path('.claude-work/settings.json'))
}

describe('Panel open bridge', () => {
  it('tells the page about the bridge only with the option, and refuses any other value', async () => {
    await withFakeHome(async (h) => {
      await withPanel(h, undefined, async ({ get }) => assert.equal(boot(await get('/')).open, null))
      await withPanel(h, { bridge: 'postMessage' }, async ({ get }) =>
        assert.deepEqual(boot(await get('/')).open, { bridge: 'postMessage' }),
      )
    })
    for (const open of [{ bridge: 'dialog' }, { bridge: 'postMessage', extra: 1 }, 'postMessage', null])
      assert.throws(
        () =>
          createPanelHandler({
            runtime: async () => {
              throw new Error('not used')
            },
            allowedHosts: ['127.0.0.1:1'],
            open: open as PanelHandlerOptions['open'],
          }),
        TypeError,
      )
  })

  it('answers the real absolute path for the bridge and starts nothing; without it the server opens the file', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await withPanel(h, { bridge: 'postMessage' }, async ({ post, calls }) => {
        const r = await post('/api/account/edit-settings', { account: 'claude:work', open: false })
        assert.equal(r.status, 200)
        assert.equal(r.body.realPath, h.path('.claude/settings.json'))
        assert.equal(r.body.path, '~/.claude-work/settings.json')
        assert.equal(r.body.target, '~/.claude/settings.json')
        assert.deepEqual(r.body.sharedWith, ['claude:main'])
        assert.equal(r.body.opened, false)
        assert.deepEqual(calls, [])
        assert.ok(!JSON.stringify(r.body).includes(SECRET))
        assert.equal(
          (await post('/api/account/edit-settings', { account: 'claude:work', open: 'no' })).status,
          400,
        )
        const opened = await post('/api/account/edit-settings', { account: 'claude:work' })
        assert.equal(opened.body.opened, true)
        assert.equal(opened.body.realPath, undefined)
        assert.deepEqual(calls, [{ cmd: '/usr/bin/open', args: ['-t', h.path('.claude/settings.json')] }])
      })
    })
  })

  it('saves config `editor` from the settings row, shows it in the state, and opens with it', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const cli = await h.write('Applications/Cursor.app/Contents/Resources/app/bin/cursor', '', 0o755)
      await withPanel(h, undefined, async ({ get, post, calls }) => {
        assert.equal(JSON.parse(await get('/api/state')).editor, 'system')
        const set = await post('/api/editor', { editor: 'cursor' })
        assert.deepEqual([set.status, set.body.editor], [200, 'cursor'])
        const config = h.path('.config/sideby/config.json')
        assert.equal(JSON.parse(await readFile(config, 'utf8')).editor, 'cursor')
        assert.equal(JSON.parse(await get('/api/state')).editor, 'cursor')
        const opened = await post('/api/account/edit-settings', { account: 'claude:main' })
        assert.equal(opened.body.editor, 'cursor')
        assert.deepEqual(calls, [
          { cmd: cli, args: ['--classic', h.path('.claude'), h.path('.claude/settings.json')] },
        ])
        for (const bad of [{ editor: 'notepad' }, {}, { editor: 3 }])
          assert.equal((await post('/api/editor', bad)).status, 400, JSON.stringify(bad))
        const back = await post('/api/editor', { editor: 'system' })
        assert.equal(back.body.editor, 'system')
        assert.equal(JSON.parse(await readFile(config, 'utf8')).editor, undefined)
      })
    })
  })

  it('posts the path to the parent at the Panel’s own origin only inside a frame with the bridge', () => {
    // The functions as the page runs them: serialized into the inline script, evaluated without Node or TypeScript.
    const ctx: { openBridge?: typeof openBridge } = {}
    runInNewContext(`${openBridged.toString()}; ${openBridge.toString()}; this.openBridge = openBridge`, ctx)
    const run = ctx.openBridge!
    const posted: { message: unknown; origin: string }[] = []
    const win = {
      parent: { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) },
      location: { origin: 'http://accounts.localhost:17420' },
    }
    const on = { open: { bridge: 'postMessage' } }
    assert.equal(run(on, '/fake-home/.claude/settings.json', win), true)
    assert.deepEqual(JSON.parse(JSON.stringify(posted)), [
      {
        message: { type: 'local-tools:open', version: 1, path: '/fake-home/.claude/settings.json' },
        origin: 'http://accounts.localhost:17420',
      },
    ])
    const self: Record<string, unknown> = { location: win.location }
    self.parent = self
    assert.equal(run({ open: null }, '/x/settings.json', win), false)
    assert.equal(run({}, '/x/settings.json', win), false)
    assert.equal(run(on, '/x/settings.json', self as unknown as typeof win), false, 'opened on its own')
    for (const bad of ['~/.claude/settings.json', 'settings.json', undefined, 3])
      assert.equal(run(on, bad, win), false, String(bad))
    assert.equal(posted.length, 1)
  })

  it('routes "Open settings.json" through the bridge before the server would open the file', () => {
    const fn = /async function editSettings\(a, file\) \{([\s\S]*?)\n {2}\}/.exec(PAGE_SCRIPT)![1]!
    assert.ok(fn.includes('const bridged = openBridged(BOOT, window)'))
    assert.ok(fn.includes('bridged ? { account: a.ref, open: false } : { account: a.ref }'))
    assert.ok(fn.includes('openBridge(BOOT, r.realPath, window)'))
  })
})
