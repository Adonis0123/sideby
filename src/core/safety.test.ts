// Regression tests for the Codex acceptance review (2026-10-05): every finding has a test here or next to it.
import assert from 'node:assert/strict'
import { lstat, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { asBuiltin, demoFamily, demoPlugin, seedDemoMain } from '../../testing/demo.ts'
import { snapshot, withFakeHome } from '../../testing/index.ts'
import { claudeStatusline, redactLine, statusLineDiff, unifiedDiff } from '../quota/claude-statusline.ts'
import { createRuntime } from '../runtime.ts'
import type { Plugin } from '../types.ts'
import { assertInside, writeFileAtomic, writeIfUnchanged } from './fs-safe.ts'

const SECRET = 'FAKE-SECRET-VALUE-4242'

describe('writes stay inside the account', () => {
  it('a repair never follows a linked parent directory out of the account', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write('.demo/custom/item.json', '{"v":"main"}')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ extraSharedItems: { demo: [{ path: 'custom/item.json', mode: 'copy' }] } }),
      )
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await rt.createAccount('demo', 'work')
      await rm(h.path('.demo-work/custom'), { recursive: true })
      await h.write('elsewhere/item.json', '{"v":"other account"}')
      await symlink(h.path('elsewhere'), h.path('.demo-work/custom'))
      const before = await snapshot(h.path('elsewhere'))
      const r = await rt.doctor({ target: 'demo:work', fix: true })
      const fix = r.fixes.find((f) => f.item === 'custom/item.json')!
      assert.equal(fix.ok, false)
      assert.match(fix.message, /outside the account directory/)
      assert.deepEqual(await snapshot(h.path('elsewhere')), before)
    })
  })

  it('rejects shared item paths that climb out, in plugins and in the config', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const def = demoFamily({ sharedItems: [{ path: '../escape', mode: 'link' }] })
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(def))] })
      await h.mkdir('.demo-work')
      const r = await rt.doctor({ target: 'demo:work' })
      assert.equal(r.accounts[0]!.findings[0]!.code, 'path.invalid')
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ extraSharedItems: { demo: [{ path: '../x', mode: 'link' }] } }),
      )
      await assert.rejects(
        createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] }),
        /extraSharedItems/,
      )
    })
  })

  it('assertInside accepts nested new paths and refuses .. and linked parents', async () => {
    await withFakeHome(async (h) => {
      const root = await h.mkdir('acct')
      await assertInside(root, join(root, 'a/b/c.json'))
      await assert.rejects(assertInside(root, join(root, '../x')), /outside/)
      await h.mkdir('out')
      await symlink(h.path('out'), join(root, 'l'))
      await assert.rejects(assertInside(root, join(root, 'l/new/file')), /parent directory is a link/)
    })
  })
})

describe('conditional writes', () => {
  it('re-checks right before the rename and leaves no temp file when the check fails', async () => {
    await withFakeHome(async (h) => {
      const p = await h.write('f.json', 'one')
      assert.equal(await writeFileAtomic(p, 'two', 0o600, async () => false), false)
      assert.equal(await readFile(p, 'utf8'), 'one')
      assert.deepEqual(await readdir(h.home), ['f.json'])
      assert.equal(await writeIfUnchanged(p, 'not-the-hash', 'three'), false)
      assert.equal(await readFile(p, 'utf8'), 'one')
    })
  })
})

describe('credential parse errors', () => {
  it('creating an account never echoes the content of an unparsable credential file', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      await h.write('.demo.json', SECRET, 0o600)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      const res = await rt.createAccount('demo', 'work')
      const step = res.steps.find((s) => s.item === '.demo.json')!
      assert.equal(step.ok, false)
      assert.match(step.message!, /not valid JSON/)
      assert.doesNotMatch(JSON.stringify(res), new RegExp(SECRET))
    })
  })

  it('status line diffs redact secret-looking values in context lines', () => {
    const before = `{\n  "env": {\n    "ANTHROPIC_AUTH_TOKEN": "${SECRET}"\n  },\n  "model": "opus"\n}\n`
    const after = `{\n  "env": {\n    "ANTHROPIC_AUTH_TOKEN": "${SECRET}"\n  },\n  "model": "opus",\n  "statusLine": { "command": "sideby statusline-tap" }\n}\n`
    const diff = unifiedDiff(before, after, 'settings.json')
    assert.match(diff, /statusline-tap/)
    assert.doesNotMatch(diff, new RegExp(SECRET))
    assert.equal(redactLine('"model": "opus"'), '"model": "opus"')
  })
})

describe('status line diffs never show the rest of settings.json', () => {
  it('setup and a refused teardown show only the statusLine object', async () => {
    await withFakeHome(async (h) => {
      const settings = {
        env: { MY_KEY: SECRET, ANTHROPIC_AUTH_TOKEN: SECRET },
        tokens: [SECRET],
        auth: { value: SECRET },
        statusLine: { type: 'command', command: 'my-status' },
      }
      await h.write('.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`)
      await writeFile(join(h.bin, 'sideby'), '#!/bin/sh\n', { mode: 0o755 })
      const ctx = { home: h.home, now: new Date(), stateDir: h.path('.local/state/sideby'), env: h.env }
      const plan = await claudeStatusline.plan(ctx)
      assert.equal(plan.status, 'ready')
      assert.match(plan.diff, /statusline-tap/)
      assert.doesNotMatch(plan.diff, new RegExp(SECRET))
      assert.equal((await claudeStatusline.apply(ctx)).status, 'enabled')
      const file = h.path('.claude/settings.json')
      const edited = JSON.parse(await readFile(file, 'utf8'))
      edited.env.ANOTHER = SECRET
      await writeFile(file, JSON.stringify(edited, null, 2))
      const down = await claudeStatusline.teardown(ctx)
      assert.equal(down.ok, false)
      assert.match(down.diff ?? '', /my-status/)
      assert.doesNotMatch(`${down.message}${down.diff}`, new RegExp(SECRET))
    })
  })
})

describe('json-key null and links where the host refuses them', () => {
  it('an explicit null is not a missing key: reported, never overwritten', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await rt.createAccount('demo', 'work')
      const acc = h.path('.demo-work/.demo.json')
      await writeFile(acc, '{"servers":null}', { mode: 0o600 })
      for (const force of [false, true]) {
        const r = await rt.doctor({ target: 'demo:work', fix: true, force })
        assert.ok(r.accounts[0]!.findings.some((f) => f.code === 'json-key.not-object'))
        assert.equal(await readFile(acc, 'utf8'), '{"servers":null}')
      }
    })
  })

  it('a copy-only item linked to another existing directory fails instead of warning', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await rt.createAccount('demo', 'work')
      await rm(h.path('.demo-work/hooks'), { recursive: true })
      await mkdir(h.path('other-hooks'))
      await symlink(h.path('other-hooks'), h.path('.demo-work/hooks'))
      const f = (await rt.doctor({ target: 'demo:work' })).accounts[0]!.findings.find(
        (x) => x.item === 'hooks',
      )!
      assert.equal(f.level, 'fail')
      assert.equal(f.code, 'symlink-forbidden')
      assert.equal(f.fixable, false)
    })
  })

  it('still reports a dangling link when the main account has nothing to share', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await rt.createAccount('demo', 'work')
      await rm(h.path('.demo/rules.md'))
      await rm(h.path('.demo-work/rules.md'))
      await symlink(h.path('gone'), h.path('.demo-work/rules.md'))
      const r = await rt.doctor({ target: 'demo:work' })
      assert.equal(r.accounts[0]!.findings.find((f) => f.item === 'rules.md')!.code, 'link.dangling')
      assert.equal(r.status, 'issues')
    })
  })
})

describe('first-day paths', () => {
  it('an account created from a minimal main account can be found and signed in right away', async () => {
    await withFakeHome(async (h) => {
      await h.write('.demo/auth.json', '{}', 0o600)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      const res = await rt.createAccount('demo', 'work')
      assert.equal(res.ok, true)
      assert.deepEqual(await readdir(h.path('.demo-work')), [])
      const launch = await rt.prepareLaunch('demo:work', [], 'login')
      assert.deepEqual(launch.args, ['login'])
    })
  })

  it('an API account of a family where proxy.env does not mean API is reported consistently', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const def = demoFamily({ secretFileMeansApi: false })
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin(def))] })
      const res = await rt.createAccount('demo', 'keys', { api: true })
      assert.equal(res.account.kind, 'subscription')
      assert.equal((await rt.resolve('demo:keys')).kind, 'subscription')
    })
  })

  it('a plugin that fails while registering leaves no family and no hook behind', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const broken: Plugin = {
        name: 'broken',
        register(api) {
          api.on('launch.before', () => {
            throw api.abort('broken plugin is still active')
          })
          api.family(demoFamily({ id: 'half', layout: { main: '.half', account: '.half-<name>' } }))
          throw new Error('boom')
        },
      }
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin()), asBuiltin(broken)] })
      assert.match(rt.pluginErrors.map((e) => e.message).join(), /boom/)
      assert.equal(rt.families.has('half'), false)
      const launch = await rt.prepareLaunch('demo:main', [], 'run')
      assert.equal(launch.bin, 'demo')
      assert.ok((await lstat(h.path('.demo'))).isDirectory())
    })
  })
})

describe('OCR review regressions (2026-10-05)', () => {
  it('a broken entry in the plugins directory does not hide the plugins after it', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const dir = h.path('.config/sideby/plugins')
      await mkdir(dir, { recursive: true })
      await symlink(h.path('nowhere'), join(dir, 'a-broken'))
      await h.write(
        '.config/sideby/plugins/b-good/plugin.json',
        JSON.stringify({ name: 'b-good', version: '1.0.0' }),
      )
      await h.write(
        '.config/sideby/plugins/b-good/index.ts',
        "export default { name: 'b-good', register() {} }\n",
      )
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      assert.ok(rt.plugins.some((p) => p.name === 'b-good'))
      assert.match(JSON.stringify(rt.pluginErrors), /a-broken/)
    })
  })

  it('refuses a plugin when any file it could import is writable by others', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/plugins/p/plugin.json', JSON.stringify({ name: 'p', version: '1.0.0' }))
      await h.write(
        '.config/sideby/plugins/p/index.ts',
        "import './lib.ts'\nexport default { name: 'p', register() {} }\n",
      )
      await h.write('.config/sideby/plugins/p/lib.ts', 'export {}\n', 0o666)
      const rt = await createRuntime({ env: h.env, builtins: [] })
      assert.equal(rt.plugins.length, 0)
      assert.match(JSON.stringify(rt.pluginErrors), /lib\.ts is writable by group or others/)
    })
  })

  it('a doctor.check that returns a non-array becomes a finding instead of crashing doctor', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const odd: Plugin = {
        name: 'odd',
        register(api) {
          api.on('doctor.check', () => ({ level: 'warn' }) as never)
        },
      }
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin()), asBuiltin(odd)] })
      const r = await rt.doctor()
      assert.ok(r.accounts[0]!.findings.some((f) => f.code === 'plugin.error' && f.source === 'odd'))
    })
  })

  it('rejects alias names that are not safe shell function names, and json-key items in the config', async () => {
    await withFakeHome(async (h) => {
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ aliases: { 'x;rm -rf ~': 'claude:main' } }),
      )
      await assert.rejects(createRuntime({ env: h.env, builtins: [] }), /must match/)
      await h.write(
        '.config/sideby/config.json',
        JSON.stringify({ extraSharedItems: { demo: [{ path: 'a.json', mode: 'json-key' }] } }),
      )
      await assert.rejects(createRuntime({ env: h.env, builtins: [] }), /extraSharedItems/)
    })
  })

  it('a failed copy leaves no temp directory behind', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await rt.createAccount('demo', 'work')
      const { execFileSync } = await import('node:child_process')
      execFileSync('mkfifo', [h.path('.demo/hooks/pipe')])
      await rm(h.path('.demo-work/hooks'), { recursive: true })
      await rt.doctor({ target: 'demo:work', fix: true })
      const left = (await readdir(h.path('.demo-work'))).filter((e) => e.includes('.sideby-'))
      assert.deepEqual(left, [])
    })
  })

  it('a Secret File that is a link is refused at launch, as Doctor reports it', async () => {
    await withFakeHome(async (h) => {
      await seedDemoMain(h.write)
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await rt.createAccount('demo', 'work')
      await h.write('real.env', 'DEMO_API_KEY=x\n', 0o600)
      await symlink(h.path('real.env'), h.path('.demo-work/proxy.env'))
      const rt2 = await createRuntime({ env: h.env, builtins: [asBuiltin(demoPlugin())] })
      await assert.rejects(rt2.prepareLaunch('demo:work', [], 'run'), /must be a regular file/)
    })
  })
})

describe('OCR review regressions, CLI side (2026-10-05)', () => {
  it('rejects aliases that would shadow shell builtins or sideby, and invalid family ids', async () => {
    await withFakeHome(async (h) => {
      for (const alias of ['command', 'cd', 'sideby']) {
        await h.write('.config/sideby/config.json', JSON.stringify({ aliases: { [alias]: 'claude:main' } }))
        await assert.rejects(createRuntime({ env: h.env, builtins: [] }), /shell keyword, builtin or sideby/)
      }
      await h.write('.config/sideby/config.json', '{}')
      const bad = demoPlugin(demoFamily({ id: 'Bad Id' }))
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(bad)] })
      assert.match(rt.pluginErrors.map((e) => e.message).join(), /family id "Bad Id"/)
    })
  })
})

describe('Codex round 3 (2026-10-05)', () => {
  it('trusts plugin files at any depth and survives link cycles', async () => {
    await withFakeHome(async (h) => {
      const deep = `.config/sideby/plugins/p/${Array.from({ length: 12 }, (_, i) => `d${i}`).join('/')}`
      await h.write('.config/sideby/plugins/p/plugin.json', JSON.stringify({ name: 'p', version: '1.0.0' }))
      await h.write('.config/sideby/plugins/p/index.ts', "export default { name: 'p', register() {} }\n")
      await h.write(`${deep}/evil.ts`, 'export {}\n', 0o666)
      await symlink(h.path('.config/sideby/plugins/p'), h.path('.config/sideby/plugins/p/loop'))
      const rt = await createRuntime({ env: h.env, builtins: [] })
      assert.equal(rt.plugins.length, 0)
      assert.match(rt.pluginErrors.map((e) => e.message).join(), /evil\.ts is writable by group or others/)
    })
  })

  it('redacts every statusLine field sideby does not own', () => {
    const before = {
      type: 'command',
      command: 'my-status',
      padding: 0,
      env: { K: SECRET },
      args: [SECRET],
      extra: SECRET,
    }
    const diff = statusLineDiff(before, { ...before, command: 'sideby statusline-tap' }, 'settings.json')
    assert.match(diff, /my-status/)
    assert.doesNotMatch(diff, new RegExp(SECRET))
  })
})

describe('Grok hardening review, round 1 (2026-10-05)', () => {
  it('a plugin entry outside the plugin directory is refused, even when trusted', async () => {
    await withFakeHome(async (h) => {
      await h.write(
        '.config/sideby/plugins/p/plugin.json',
        JSON.stringify({ name: 'p', version: '1.0.0', main: '../outside.ts' }),
      )
      await h.write(
        '.config/sideby/plugins/outside.ts',
        "export default { name: 'p', register() {} }\n",
        0o666,
      )
      const rt = await createRuntime({ env: h.env, builtins: [] })
      assert.equal(rt.plugins.length, 0)
      assert.match(rt.pluginErrors.map((e) => e.message).join(), /outside the plugin directory/)
    })
  })

  it('a write that fails before the rename leaves the target untouched and no temp file', async () => {
    await withFakeHome(async (h) => {
      const p = await h.write('settings.json', 'original', 0o644)
      await assert.rejects(writeFileAtomic(p, 'new', Number.NaN))
      assert.equal(await readFile(p, 'utf8'), 'original')
      assert.deepEqual(await readdir(h.home), ['settings.json'])
      await writeFileAtomic(p, 'new', 0o600)
      const { stat } = await import('node:fs/promises')
      assert.equal((await stat(p)).mode & 0o777, 0o600)
    })
  })
})

describe('hardening round 3 (2026-10-05)', () => {
  it('mergeDoctorHistory keeps Family-level findings of untouched Families on a targeted run', async () => {
    const { mergeDoctorHistory } = await import('./last-doctor.ts')
    const f = (account: string, code: string) => ({
      level: 'fail' as const,
      account,
      item: 'x',
      code,
      message: 'm',
      source: 'core',
      fixable: false,
    })
    const t1 = new Date('2026-10-05T00:00:00Z')
    const first = mergeDoctorHistory(
      undefined,
      {
        status: 'issues',
        accounts: [],
        general: [f('a:main', 'main.missing'), f('b:main', 'main.missing')],
        fixes: [],
      },
      { kind: 'all' },
      t1,
    )
    const second = mergeDoctorHistory(
      first,
      {
        status: 'ok',
        accounts: [
          {
            ref: 'a:w',
            family: 'a',
            name: 'w',
            kind: 'subscription',
            dir: '/x',
            shared: { ok: 0, total: 0 },
            backups: 0,
            findings: [],
          },
        ],
        general: [],
        fixes: [],
      },
      { kind: 'account', ref: 'a:w' },
      new Date('2026-10-05T01:00:00Z'),
    )
    assert.deepEqual(second.general.a!.findings, [])
    assert.equal(second.general.b!.findings[0]!.code, 'main.missing')
    assert.deepEqual(second.accounts['a:w']!.findings, [])
  })

  it('inspectSecretFile reports type and mode only', async () => {
    const { inspectSecretFile } = await import('./secret-file.ts')
    await withFakeHome(async (h) => {
      assert.deepEqual(await inspectSecretFile(h.path('none')), { kind: 'missing' })
      const ok = await h.write('ok.env', 'A=1', 0o600)
      assert.deepEqual(await inspectSecretFile(ok), { kind: 'ok' })
      const loose = await h.write('loose.env', 'A=1', 0o644)
      assert.deepEqual(await inspectSecretFile(loose), { kind: 'mode', mode: 0o644 })
      await symlink(ok, h.path('link.env'))
      assert.deepEqual(await inspectSecretFile(h.path('link.env')), { kind: 'not-file' })
    })
  })

  it('a wrapped status line command decodes back to the exact original and runs it', async () => {
    const { wrapCommand } = await import('../quota/claude-statusline.ts')
    const { runStatuslineTap } = await import('../quota/statusline-tap.ts')
    const { Readable, Writable } = await import('node:stream')
    const original = `printf '%s|' "a b" 'q"t' && printf 'é✓\\n'`
    const argv = wrapCommand(original).split(' ').slice(2)
    let out = ''
    const sink = new Writable({
      write(c, _e, cb) {
        out += c.toString()
        cb()
      },
    })
    await withFakeHome(async (h) => {
      assert.equal(await runStatuslineTap(argv, h.env, Readable.from(['{}']), sink, sink), 0)
    })
    assert.equal(out, 'a b|q"t|é✓\n')
  })
})

describe('Grok hardening review, round 3 (2026-10-05)', () => {
  it('creating an account never follows a symlinked intermediate directory', async () => {
    await withFakeHome(async (h) => {
      const { piPlugin } = await import('../families/pi/index.ts')
      await h.write('.pi/agent/AGENTS.md', '# rules\n')
      await h.mkdir('elsewhere')
      await symlink(h.path('elsewhere'), h.path('.pi-work'))
      const before = await snapshot(h.path('elsewhere'))
      const rt = await createRuntime({ env: h.env, builtins: [asBuiltin(piPlugin)] })
      await assert.rejects(rt.createAccount('pi', 'work'), /not a real directory/)
      assert.deepEqual(await snapshot(h.path('elsewhere')), before)
      assert.ok((await lstat(h.path('.pi-work'))).isSymbolicLink())
    })
  })
})
