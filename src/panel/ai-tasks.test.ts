// Panel routes for AI Tasks (spec §3.28): ask, prompt, login, key, try and the terminal choice. Terminals never
// open for real: `exec` is replaced through createRuntime's `desktop` option, and the Host is a fake binary.
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { diffSnapshots, type FakeHome, fakeHost, snapshot, withFakeHome } from '../../testing/index.ts'
import type { ExecResult } from '../core/desktop-app.ts'
import { createRuntime } from '../runtime.ts'
import { createPanelHandler } from './handler.ts'

// Joined at run time so the source never holds a key-shaped string (leak-check).
const KEY = ['fictional', 'panel', 'value', '42'].join('-')
const SK = ['sk', 'abcdefghijklmnopqrstuv'].join('-')

interface Exec {
  calls: { cmd: string; args: string[] }[]
  code: number
}

async function seed(h: FakeHome) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
  await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://api.example.com\n', 0o600)
  await h.mkdir('apps/Terminal.app')
}

function runtimeFor(h: FakeHome, exec: Exec) {
  return () =>
    createRuntime({
      env: h.env,
      desktop: {
        platform: 'darwin',
        appDirs: [h.path('apps')],
        exec: async (cmd: string, args: readonly string[]): Promise<ExecResult> => {
          exec.calls.push({ cmd, args: [...args] })
          return { code: exec.code, stdout: '', stderr: '' }
        },
      },
    })
}

async function serve(h: FakeHome, exec: Exec, readOnly = false) {
  let handler: ReturnType<typeof createPanelHandler> | undefined
  const server = createServer((req, res) => {
    void handler!(req, res).then((done) => {
      if (!done) res.writeHead(404).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  handler = createPanelHandler({
    runtime: runtimeFor(h, exec),
    allowedHosts: [`127.0.0.1:${port}`],
    readOnly,
  })
  const good = { origin: `http://127.0.0.1:${port}`, 'x-sideby-token': handler.token }
  const close = () =>
    new Promise<void>((r) => {
      server.close(() => r())
      server.closeAllConnections()
    })
  return { port, good, close }
}

function request(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.on('data', (d: Buffer) => (text += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string>) {
  const r = await request(
    port,
    'POST',
    path,
    { 'content-type': 'application/json', ...headers },
    typeof body === 'string' ? body : JSON.stringify(body),
  )
  return { status: r.status, text: r.text, body: JSON.parse(r.text || '{}') as Record<string, unknown> }
}

/** Everything the process writes to stdout and stderr while `fn` runs, so a test can prove a value was not logged. */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  let logged = ''
  const tap = (chunk: unknown) => {
    logged += String(chunk)
    return true
  }
  process.stdout.write = tap as typeof process.stdout.write
  process.stderr.write = tap as typeof process.stderr.write
  try {
    return { result: await fn(), logged }
  } finally {
    process.stdout.write = out
    process.stderr.write = err
  }
}

const WRITES = ['/api/ask', '/api/login', '/api/key', '/api/try', '/api/terminal']

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])

/** Sends `parts` as the raw body of an upload, chunked unless a content-length header is given. */
function upload(
  port: number,
  headers: Record<string, string>,
  parts: Iterable<Buffer>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/ask/attach', headers },
      (res) => {
        let text = ''
        res.on('data', (d: Buffer) => (text += d))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text || '{}') }))
      },
    )
    // The server may answer and close before the whole body is sent.
    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EPIPE' && err.code !== 'ECONNRESET') reject(err)
    })
    for (const p of parts) req.write(p)
    req.end()
  })
}

describe('AI Task routes', () => {
  it('keep the Host, Origin and token checks, and a read-only Panel refuses every write but the prompt', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const exec: Exec = { calls: [], code: 0 }
      const rw = await serve(h, exec)
      const ro = await serve(h, exec, true)
      try {
        for (const path of [...WRITES, '/api/ask/prompt']) {
          const body = { account: 'claude:api', value: KEY }
          assert.equal(
            (await post(rw.port, path, body, { 'x-sideby-token': rw.good['x-sideby-token'] })).status,
            403,
            path,
          )
          assert.equal((await post(rw.port, path, body, { origin: rw.good.origin })).status, 403, path)
          assert.equal(
            (await post(rw.port, path, body, { ...rw.good, origin: 'http://evil.example' })).status,
            403,
            path,
          )
          const host = await request(rw.port, 'POST', path, { ...rw.good, host: 'evil.example:80' }, '{}')
          assert.equal(host.status, 403, path)
        }
        for (const path of WRITES) {
          const r = await post(ro.port, path, { account: 'claude:api', value: KEY }, ro.good)
          assert.equal(r.status, 403, path)
          assert.match(String(r.body.error), /read-only/)
        }
        const prompt = await post(ro.port, '/api/ask/prompt', { task: 'fix' }, ro.good)
        assert.equal(prompt.status, 200)
        assert.match(String(prompt.body.prompt), /sideby doctor/)
        assert.equal(prompt.body.account, 'claude:main')
        assert.equal(
          (await request(rw.port, 'GET', '/api/terminals', { host: 'evil.example:80' })).status,
          403,
        )
        assert.equal(exec.calls.length, 0)
        assert.deepEqual(await readdir(h.path('.local/state/sideby')).catch(() => []), [])
      } finally {
        await rw.close()
        await ro.close()
      }
    })
  })

  it('frees a staged upload the person removed, and skips an id that is already gone', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      const staging = h.path('.local/state/sideby/ai/attachments/staging')
      try {
        const up = await upload(s.port, s.good, [PNG])
        assert.equal(up.status, 200)
        assert.equal((await readdir(staging)).length, 1)
        const r = await post(s.port, '/api/ask/attach/remove', { ids: [up.body.id] }, s.good)
        assert.deepEqual(r.body, { removed: 1 })
        assert.equal((await readdir(staging)).length, 0)
        const again = await post(s.port, '/api/ask/attach/remove', { ids: [up.body.id, 'nope'] }, s.good)
        assert.deepEqual(again.body, { removed: 0 })
        assert.equal((await post(s.port, '/api/ask/attach/remove', { ids: 'x' }, s.good)).status, 400)
      } finally {
        await s.close()
      }
    })
  })

  it('refuse an upload once 20 files wait in staging, saying to send or remove them', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      const staging = h.path('.local/state/sideby/ai/attachments/staging')
      try {
        for (let i = 0; i < 20; i++) assert.equal((await upload(s.port, s.good, [PNG])).status, 200)
        const full = await upload(s.port, s.good, [PNG])
        assert.equal(full.status, 507)
        assert.equal(full.body.code, 'attachment-quota')
        assert.match(
          String(full.body.error),
          /at most 20 files, 400 MB.*Send your task .* or remove pending ones/,
        )
        assert.equal((await readdir(staging)).length, 20)
      } finally {
        await s.close()
      }
    })
  })

  it('take an upload only with the token and Origin, never on a read-only Panel, and refuse wrong files', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const exec: Exec = { calls: [], code: 0 }
      const rw = await serve(h, exec)
      const ro = await serve(h, exec, true)
      const staging = h.path('.local/state/sideby/ai/attachments/staging')
      try {
        const body = [PNG, Buffer.alloc(100)]
        const token = rw.good['x-sideby-token']
        assert.equal((await upload(rw.port, { 'x-sideby-token': token }, body)).status, 403)
        assert.equal((await upload(rw.port, { origin: rw.good.origin }, body)).status, 403)
        assert.equal((await upload(rw.port, { ...rw.good, origin: 'http://evil.example' }, body)).status, 403)
        assert.equal((await upload(rw.port, { ...rw.good, host: 'evil.example:80' }, body)).status, 403)
        const readOnly = await upload(ro.port, ro.good, body)
        assert.equal(readOnly.status, 403)
        assert.match(String(readOnly.body.error), /read-only/)
        assert.equal((await request(rw.port, 'GET', '/api/ask/attach', rw.good)).status, 405)
        assert.deepEqual(await readdir(staging).catch(() => []), [])

        // The browser's type is not trusted: text sent as a PNG is refused and names what is supported.
        const text = await upload(rw.port, { ...rw.good, 'content-type': 'image/png' }, [
          Buffer.from('hello'),
        ])
        assert.equal(text.status, 415)
        assert.match(String(text.body.error), /PNG, JPEG, GIF or WebP image, or an MP4, MOV or WebM video/)
        assert.ok(!JSON.stringify(text.body).includes('hello'))
        const declared = await upload(
          rw.port,
          { ...rw.good, 'content-length': String(201 * 1024 * 1024) },
          [],
        )
        assert.equal(declared.status, 413)
        assert.match(String(declared.body.error), /200 MB/)
        const bigImage = await upload(rw.port, rw.good, [PNG, ...Array(21).fill(Buffer.alloc(1024 * 1024))])
        assert.equal(bigImage.status, 413)
        assert.match(String(bigImage.body.error), /image is over 20 MB/)
        assert.deepEqual(await readdir(staging), [])

        const ok = await upload(rw.port, { ...rw.good, 'content-type': 'application/octet-stream' }, body)
        assert.equal(ok.status, 200)
        assert.deepEqual(Object.keys(ok.body).sort(), ['bytes', 'id', 'kind'])
        assert.equal(ok.body.kind, 'image')
        assert.equal(ok.body.bytes, PNG.length + 100)
        assert.deepEqual(await readdir(staging), [`${ok.body.id}.png`])

        // The upload goes into the task: the prompt lists its path and the staged copy is gone.
        const asked = await post(
          rw.port,
          '/api/ask',
          { task: 'free', text: 'what is this', attachments: [ok.body.id] },
          rw.good,
        )
        assert.equal(asked.status, 200)
        assert.equal(asked.body.opened, true)
        const id = /'([a-f0-9]{16})'/.exec(String(asked.body.command))![1]!
        const saved = h.path('.local/state/sideby/ai/attachments', id, '1.png')
        assert.deepEqual(asked.body.attachments, [{ path: saved, kind: 'image', bytes: PNG.length + 100 }])
        const task = JSON.parse(await readFile(h.path('.local/state/sideby/ask', `${id}.json`), 'utf8'))
        assert.ok(task.prompt.includes(`- ${saved} (image)`))
        assert.deepEqual(await readdir(staging), [])
        for (const attachments of [[ok.body.id], 'x', ['../x'], Array(6).fill('0123456789abcdef')]) {
          const r = await post(rw.port, '/api/ask', { task: 'free', attachments }, rw.good)
          assert.equal(r.status, 400, JSON.stringify(attachments))
          assert.equal(typeof r.body.error, 'string')
        }
      } finally {
        await rw.close()
        await ro.close()
      }
    })
  })

  it('refuse bad bodies with 400 and say what to send', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      try {
        const bad: [string, unknown][] = [
          ['/api/ask', { task: 'nope' }],
          ['/api/ask', { context: [] }],
          ['/api/ask', { context: { findings: [{}] } }],
          ['/api/ask', { context: { secret: 'x' } }],
          ['/api/ask', { terminal: 'warp' }],
          ['/api/ask', { lang: 'fr' }],
          ['/api/ask/prompt', { text: 5 }],
          ['/api/ask/prompt', { task: 'terminal', context: { terminals: 'Ghostty' } }],
          ['/api/ask/prompt', { task: 'terminal', context: { terminals: [5] } }],
          ['/api/login', {}],
          ['/api/key', { account: 'claude:api' }],
          ['/api/key', { account: 'claude:api', value: KEY, var: 'lower' }],
          ['/api/key', { value: KEY }],
          ['/api/try', {}],
          ['/api/terminal', { id: 'warp' }],
          ['/api/terminal', { custom: 'myterm --dir {cwd}' }],
          ['/api/ask', '[1]'],
          ['/api/key', 'not json'],
        ]
        for (const [path, body] of bad) {
          const r = await post(s.port, path, body, s.good)
          assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`)
          assert.equal(typeof r.body.error, 'string')
          assert.ok(!r.text.includes(KEY), path)
        }
        assert.equal(exec.calls.length, 0)
      } finally {
        await s.close()
      }
    })
  })

  it('opens the terminal with the task command, says when Automation is refused, and writes no Host file', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      try {
        const before = await snapshot(h.path('.claude'))
        const ok = await post(
          s.port,
          '/api/ask',
          { task: 'free', text: `use ${SK} please`, lang: 'en' },
          s.good,
        )
        assert.equal(ok.status, 200)
        assert.equal(ok.body.opened, true)
        assert.equal(ok.body.automation, false)
        assert.equal(ok.body.account, 'claude:main')
        assert.equal(ok.body.terminal, 'terminal')
        assert.equal(ok.body.removedSecrets, true)
        assert.match(String(ok.body.command), / ask --run '[a-f0-9]{16}' --state-dir '[^']+'$/)
        assert.equal(exec.calls[0]!.cmd, '/usr/bin/osascript')
        assert.ok(exec.calls[0]!.args.join(' ').includes(String(ok.body.command)))
        // The prompt lives in the task file, never on the command line, and the key-shaped text is gone from it.
        const id = /'([a-f0-9]{16})'/.exec(String(ok.body.command))![1]
        const task = await readFile(h.path('.local/state/sideby/ask', `${id}.json`), 'utf8')
        assert.ok(!task.includes(SK))
        assert.ok(!exec.calls[0]!.args.join(' ').includes('please'))

        exec.code = -1743
        const denied = await post(
          s.port,
          '/api/ask',
          { task: 'quota', context: { account: 'claude:main' } },
          s.good,
        )
        assert.equal(denied.body.opened, false)
        assert.equal(denied.body.automation, true)
        assert.match(String(denied.body.command), / ask --run '[a-f0-9]{16}' --state-dir '[^']+'$/)

        exec.code = 1
        const login = await post(s.port, '/api/login', { account: 'claude:main' }, s.good)
        assert.equal(login.status, 200)
        assert.equal(login.body.opened, false)
        assert.equal(login.body.automation, false)
        assert.match(String(login.body.command), / ask --run '[a-f0-9]{16}' --state-dir '[^']+'$/)
        exec.code = 0
        assert.equal((await post(s.port, '/api/login', { account: 'claude:main' }, s.good)).body.opened, true)
        assert.equal((await post(s.port, '/api/login', { account: 'claude:none' }, s.good)).status, 400)

        assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude'))), [])
      } finally {
        await s.close()
      }
    })
  })

  it('keeps an account the person picked, and offers Copy prompt when no account can run it', async () => {
    await withFakeHome(async (h) => {
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      try {
        const none = await post(
          s.port,
          '/api/ask/prompt',
          { task: 'account', context: { family: 'claude' } },
          s.good,
        )
        assert.equal(none.body.account, null)
        assert.equal(none.body.reason, 'no-accounts')
        assert.match(String(none.body.prompt), /claude/)
        const term = await post(
          s.port,
          '/api/ask/prompt',
          {
            task: 'terminal',
            lang: 'en',
            context: { terminalCustom: 'my-term {cwd} {cmd}', terminals: ['Ghostty'] },
          },
          s.good,
        )
        assert.equal(term.status, 200)
        assert.match(String(term.body.prompt), /Custom terminal command now: my-term \{cwd\} \{cmd\}/)
        assert.match(String(term.body.prompt), /Supported terminals installed here: Ghostty/)
        const open = await post(s.port, '/api/ask', {}, s.good)
        assert.equal(open.body.opened, false)
        assert.equal(open.body.command, null)
        assert.equal(exec.calls.length, 0)

        await seed(h)
        await h.write('.claude-work/settings.json', '{}')
        await h.write('.claude-work/.claude.json', '{"oauthAccount":{}}', 0o600)
        const picked = await post(s.port, '/api/ask', { account: 'claude:work' }, s.good)
        assert.equal(picked.body.account, 'claude:work')
        const config = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.deepEqual(config.ask, { account: 'claude:work' })
        // A picked API account is remembered too; only the automatic pick skips API accounts.
        await post(s.port, '/api/ask', { account: 'claude:api' }, s.good)
        const after = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.deepEqual(after.ask, { account: 'claude:api' })
        // A terminal picked in the dialog becomes the preferred one, so the next dialog starts with it.
        await h.mkdir('apps/iTerm.app')
        await post(s.port, '/api/ask', { terminal: 'iterm2' }, s.good)
        const chosen = JSON.parse(await readFile(h.path('.config/sideby/config.json'), 'utf8'))
        assert.equal(chosen.terminal?.preferred, 'iterm2')
        const next = JSON.parse(
          (await request(s.port, 'GET', '/api/terminals', { host: `127.0.0.1:${s.port}` })).text,
        )
        assert.deepEqual(next.guess, { id: 'iterm2', source: 'config' })
      } finally {
        await s.close()
      }
    })
  })

  it('writes the key into proxy.env and never answers or logs its value', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      try {
        const before = await snapshot(h.path('.claude'))
        const { result: r, logged } = await captured(() =>
          post(s.port, '/api/key', { account: 'claude:api', value: KEY }, s.good),
        )
        assert.equal(r.status, 200)
        assert.deepEqual(r.body, {
          account: 'claude:api',
          var: 'ANTHROPIC_AUTH_TOKEN',
          written: true,
          path: '~/.claude-api/proxy.env',
        })
        assert.ok(!r.text.includes(KEY))
        assert.ok(!logged.includes(KEY))
        const file = await readFile(h.path('.claude-api/proxy.env'), 'utf8')
        assert.equal(file, `ANTHROPIC_BASE_URL=https://api.example.com\nANTHROPIC_AUTH_TOKEN=${KEY}\n`)

        const other = await post(
          s.port,
          '/api/key',
          { account: 'claude:api', var: 'OTHER_KEY', value: KEY },
          s.good,
        )
        assert.equal(other.body.var, 'OTHER_KEY')
        // Refusals name what to do, never the value.
        for (const body of [
          { account: 'claude:main', value: KEY },
          { account: 'claude:api', value: `${KEY}\nX=1` },
        ]) {
          const { result: bad, logged: badLog } = await captured(() => post(s.port, '/api/key', body, s.good))
          assert.equal(bad.status, 400)
          assert.ok(!bad.text.includes(KEY))
          assert.ok(!badLog.includes(KEY))
        }
        // The state shows what the key box needs, without any value.
        const state = await request(s.port, 'GET', '/api/state', { host: `127.0.0.1:${s.port}` })
        assert.ok(!state.text.includes(KEY))
        const claude = JSON.parse(state.text).families.find((f: { id: string }) => f.id === 'claude')
        assert.equal(claude.keyVar, 'ANTHROPIC_AUTH_TOKEN')
        assert.deepEqual(claude.tryCommand, ['claude', '-p', 'Reply with OK'])
        assert.deepEqual(diffSnapshots(before, await snapshot(h.path('.claude'))), [])
      } finally {
        await s.close()
      }
    })
  })

  it('tries an account with the Host and hides the key in what it printed', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.write('.claude-api/proxy.env', `ANTHROPIC_AUTH_TOKEN=${KEY}\n`, 0o600)
      await fakeHost(h, 'claude', {
        exitCode: 1,
        onStart: 'console.log("bad key " + process.env.ANTHROPIC_AUTH_TOKEN)',
      })
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      try {
        const r = await post(s.port, '/api/try', { account: 'claude:api' }, s.good)
        assert.equal(r.status, 200)
        assert.equal(r.body.ok, false)
        assert.equal(r.body.exitCode, 1)
        assert.deepEqual(r.body.command, ['claude', '-p', 'Reply with OK'])
        assert.match(String(r.body.output), /bad key \*\*\*/)
        assert.ok(!r.text.includes(KEY))
        // The probe folder is removed afterwards.
        assert.deepEqual(
          (await readdir(h.path('.local/state/sideby/ai'))).filter((n) => n.startsWith('probe-')),
          [],
        )
        await fakeHost(h, 'claude', { exitCode: 0 })
        assert.equal((await post(s.port, '/api/try', { account: 'claude:api' }, s.good)).body.ok, true)
        assert.equal(exec.calls.length, 0)
      } finally {
        await s.close()
      }
    })
  })

  it('lists installed terminals and saves the preferred one and a custom command', async () => {
    await withFakeHome(async (h) => {
      await seed(h)
      await h.mkdir('apps/iTerm.app')
      const exec: Exec = { calls: [], code: 0 }
      const s = await serve(h, exec)
      const config = async () =>
        JSON.parse(await readFile(join(h.env.XDG_CONFIG_HOME!, 'sideby/config.json'), 'utf8'))
      try {
        const list = JSON.parse(
          (await request(s.port, 'GET', '/api/terminals', { host: `127.0.0.1:${s.port}` })).text,
        )
        assert.deepEqual(list.installed, ['terminal', 'iterm2'])
        assert.equal(list.preferred, null)
        assert.deepEqual(list.guess, { id: 'terminal', source: 'default' })
        assert.equal(list.custom, null)
        assert.ok(!JSON.stringify(list).includes(h.home), 'no local paths')

        const set = await post(s.port, '/api/terminal', { id: 'iterm2' }, s.good)
        assert.equal(set.body.preferred, 'iterm2')
        assert.deepEqual(set.body.guess, { id: 'iterm2', source: 'config' })
        assert.deepEqual((await config()).terminal, { preferred: 'iterm2' })

        const tpl = 'myterm --cwd {cwd} -e {cmd}'
        const custom = await post(s.port, '/api/terminal', { custom: tpl }, s.good)
        assert.equal(custom.body.custom, tpl)
        assert.ok((custom.body.installed as string[]).includes('custom'))
        // Saving a custom command also chooses it, as `sideby terminal --custom` does; clearing it drops that choice.
        assert.deepEqual((await config()).terminal, { preferred: 'custom', custom: tpl })

        await post(s.port, '/api/terminal', { custom: '' }, s.good)
        const unset = await post(s.port, '/api/terminal', {}, s.good)
        assert.equal(unset.body.preferred, null)
        assert.equal((await config()).terminal, undefined)
        assert.equal(exec.calls.length, 0)
      } finally {
        await s.close()
      }
    })
  })
})
