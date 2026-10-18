// Task Specs (spec §3.28 "Portal 交来的任务", ADR-0030): `sideby ask --spec -` and `sideby ask --choices`. Terminals
// never open for real: `exec` is replaced through createRuntime's `desktop` option.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readdir, readFile, rm, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Value } from 'typebox/value'
import { type FakeHome, fakeHost, readHostLog, withFakeHome } from '../../testing/index.ts'
import { parseArgs } from '../cli/args.ts'
import { type AskArgs, cmdAsk } from '../cli/commands.ts'
import { OUTPUT_SCHEMAS } from '../cli/json-schemas.ts'
import { AI_TASK_KINDS } from '../panel/page-logic.ts'
import { createRuntime, type Runtime } from '../runtime.ts'
import { readTask, setPreferredTerminal } from './ask.ts'
import { NATIVE_ATTACHMENTS, nativePromptCases } from './fixtures/native-prompt-cases.ts'
import { MAX_SPEC_BYTES, previewTaskSpec, startTaskSpec, type TaskSpec, taskChoices } from './task-spec.ts'

// Joined at run time so the source never holds a key-shaped string (leak-check).
const KEY = ['sk', 'abcdefghijklmnopqrstuv'].join('-')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom')])
const BEFORE: Record<string, string> = JSON.parse(
  await readFile(new URL('./fixtures/native-prompts.json', import.meta.url), 'utf8'),
)

interface Calls {
  args: string[][]
}

async function seed(h: FakeHome) {
  await h.write('.claude/settings.json', '{}')
  await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
  await h.mkdir('apps/Terminal.app')
}

function runtime(h: FakeHome, calls: Calls = { args: [] }) {
  return createRuntime({
    env: h.env,
    desktop: {
      platform: 'darwin',
      appDirs: [h.path('apps')],
      exec: async (_cmd, args) => {
        calls.args.push([...args])
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  })
}

async function files(h: FakeHome) {
  const png = await h.write('shots/screen.png', '')
  const mp4 = await h.write('shots/clip.mp4', '')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(png, PNG)
  await writeFile(mp4, MP4)
  return [png, mp4]
}

/** `sideby ask <argv>` with `input` on stdin; returns the exit code and what it printed. */
async function ask(rt: Runtime, argv: string[], input: string | Buffer) {
  const stdin = new PassThrough()
  stdin.end(input)
  const out: string[] = []
  const err: string[] = []
  const a = parseArgs(
    argv,
    ['json', 'print', 'choices'],
    ['task', 'account', 'terminal', 'run', 'state-dir', 'attach', 'spec'],
  ) as AskArgs
  const code = await cmdAsk(a, { out: (s) => out.push(s), err: (s) => err.push(s), stdin }, rt)
  return { code, out: out.join(''), err: err.join('') }
}

function shape(name: string, out: string) {
  const data = JSON.parse(out)
  assert.ok(
    Value.Check(OUTPUT_SCHEMAS[name]!, data),
    JSON.stringify([...Value.Errors(OUTPUT_SCHEMAS[name]!, data)]),
  )
  // Parsed again: the check above narrows `data` to unknown, and the tests read its fields.
  return JSON.parse(out)
}

async function taskFiles(rt: Runtime) {
  return (await readdir(join(rt.paths.stateDir, 'ask')).catch(() => [] as string[])).filter((f) =>
    f.endsWith('.json'),
  )
}

it('writes every native AI Task prompt word for word as before the Task Spec', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    const calls: Calls = { args: [] }
    const rt = await runtime(h, calls)
    const [png, mp4] = await files(h)
    const cases = nativePromptCases(AI_TASK_KINDS)
    assert.equal(Object.keys(BEFORE).length, cases.length)
    for (const c of cases) {
      const spec = {
        lang: c.input.lang as 'en' | 'zh',
        native: {
          task: c.input.task,
          ...(c.input.text ? { text: c.input.text } : {}),
          ...(c.input.context ? { context: c.input.context } : {}),
        },
      }
      if (!c.attachments.length) {
        const preview = await previewTaskSpec(rt, spec)
        assert.equal(preview.prompt, BEFORE[c.name], c.name)
        continue
      }
      // With attachments the task copies them; their folder is the one name that differs from the snapshot.
      const result = await startTaskSpec(rt, { ...spec, files: [png!, mp4!] })
      assert.equal(result.opened, true)
      const task = await readTask(result.task!, rt.paths)
      const prompt = task.prompt!.replaceAll(
        dirname(result.attachments[0]!.path),
        dirname(NATIVE_ATTACHMENTS[0]!.path),
      )
      assert.equal(prompt, BEFORE[c.name], c.name)
      assert.equal(task.cwd, join(rt.paths.stateDir, 'ai'))
    }
    // The CLI prints the same prompt.
    const r = await ask(
      rt,
      ['--spec', '-', '--print', '--json'],
      JSON.stringify({ specVersion: 1, lang: 'zh', native: { task: 'quota' } }),
    )
    assert.equal(r.code, 0)
    assert.equal(shape('ask-print', r.out).prompt, BEFORE['zh quota bare'])
  })
})

it('starts a Portal prompt in its folder, with keys removed and the attachments appended', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    const calls: Calls = { args: [] }
    const rt = await runtime(h, calls)
    const [png, mp4] = await files(h)
    const cwd = await h.mkdir('.config/some-tool')
    const prompt = `## What to do\nFix the sync problem.\n\n## Context\n- Note: ${KEY}\n- Quote: '$(no)' \`no\`\n`
    const spec = JSON.stringify({ specVersion: 1, lang: 'en', prompt, cwd, files: [png, mp4] })
    const preview = await ask(rt, ['--spec', '-', '--print', '--json'], spec)
    assert.equal(preview.code, 0)
    const p = shape('ask-print', preview.out)
    assert.equal(p.removedSecrets, true)
    assert.ok(!p.prompt.includes(KEY))
    assert.match(p.prompt, /\[key removed\]/)
    assert.ok(
      p.prompt.endsWith(
        `\n\n## Attached files\n- ${png} (image)\n- ${mp4} (video)\nTo see what a video shows, extract a few frames with ffmpeg first, for example \`ffmpeg -i <video> -vf fps=1 -frames:v 5 frame-%d.png\`.`,
      ),
    )
    assert.deepEqual(await taskFiles(rt), [], '--print writes no task')
    assert.deepEqual(calls.args, [], '--print opens nothing')

    const r = await ask(rt, ['--spec', '-', '--json'], spec)
    assert.equal(r.code, 0)
    const out = shape('ask', r.out)
    assert.equal(out.opened, true)
    assert.equal(out.account, 'claude:main')
    assert.equal(out.removedSecrets, true)
    assert.equal(out.attachments.length, 2)
    const task = await readTask(out.task, rt.paths)
    assert.equal(task.cwd, cwd)
    assert.ok(!task.prompt!.includes(KEY))
    assert.match(task.prompt!, /^## What to do\nFix the sync problem\./)
    assert.ok(task.prompt!.includes(`## Attached files\n- ${out.attachments[0].path} (image)`))
    assert.deepEqual(
      task.attachments,
      out.attachments.map((x: { path: string; kind: string }) => ({ path: x.path, kind: x.kind })),
    )
    // The terminal gets only the fixed command, never the prompt.
    assert.ok(!JSON.stringify(calls.args).includes('sync problem'))
    // A Chinese prompt without Markdown headings gets the plain Chinese section.
    const zh = await previewTaskSpec(rt, { lang: 'zh', prompt: '修好它', cwd, files: [png!] } as TaskSpec)
    assert.equal(zh.prompt, `修好它\n\n附件\n- ${png} (图片)`)
    assert.equal(zh.removedSecrets, false)
  })
})

it('uses sideby’s own task folder when a Portal prompt names none, and remembers a chosen account', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://api.example.com\n', 0o600)
    const rt = await runtime(h)
    const r = await startTaskSpec(rt, { prompt: 'Do it', account: 'claude:api', remember: true })
    assert.equal(r.account, 'claude:api')
    assert.equal((await readTask(r.task!, rt.paths)).cwd, join(rt.paths.stateDir, 'ai'))
    assert.equal(JSON.parse(await readFile(rt.paths.configFile, 'utf8')).ask.account, 'claude:api')
  })
})

it('refuses a task folder that is missing, a file, outside the home or a link out of it, before copying anything', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    const calls: Calls = { args: [] }
    const rt = await runtime(h, calls)
    const [png] = await files(h)
    const file = await h.write('notes.txt', 'x')
    await symlink(h.bin, h.path('out-link'))
    for (const cwd of [h.path('missing'), file, h.bin, h.path('out-link'), 'relative/dir']) {
      for (const flags of [['--json'], ['--print', '--json']]) {
        const r = await ask(
          rt,
          ['--spec', '-', ...flags],
          JSON.stringify({ specVersion: 1, prompt: 'x', cwd, files: [png] }),
        )
        assert.equal(r.code, 1, cwd)
        const e = shape('error', r.out)
        assert.equal(e.code, 'bad-cwd')
        assert.equal(e.reason, 'bad-cwd')
        assert.match(e.error, /existing folder in your home/)
      }
    }
    assert.deepEqual(await taskFiles(rt), [])
    assert.deepEqual(await readdir(join(rt.paths.stateDir, 'ai', 'attachments')).catch(() => []), [])
    assert.deepEqual(calls.args, [])
  })
})

it('checks the folder again right before the task file is written, and refuses one swapped for a link', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    const calls: Calls = { args: [] }
    const rt = await runtime(h, calls)
    const outside = await h.mkdir('../outside/work')
    // The folder passes the first check; while the Account is picked it becomes a link out of the home.
    const swapInto = async (dir: string, target: string) => {
      const orig = rt.status.bind(rt)
      rt.status = async (a) => {
        await rm(dir, { recursive: true })
        await symlink(target, dir)
        rt.status = orig
        return orig(a)
      }
    }
    const work = await h.mkdir('projects/work')
    await swapInto(work, outside)
    const r = await ask(
      rt,
      ['--spec', '-', '--json'],
      JSON.stringify({ specVersion: 1, prompt: 'x', cwd: work }),
    )
    assert.equal(r.code, 1)
    const e = shape('error', r.out)
    assert.equal(e.code, 'bad-cwd')
    assert.equal(e.reason, 'bad-cwd')
    // An ancestor swapped for a link to a copy of the same layout outside the home is caught too.
    const deep = await h.mkdir('projects/a/b')
    await h.mkdir('../outside/a/b')
    await swapInto(h.path('projects/a'), h.path('../outside/a'))
    const r2 = await ask(
      rt,
      ['--spec', '-', '--json'],
      JSON.stringify({ specVersion: 1, prompt: 'x', cwd: deep }),
    )
    assert.equal(shape('error', r2.out).code, 'bad-cwd')
    assert.deepEqual(await taskFiles(rt), [], 'no task file is written')
    assert.deepEqual(calls.args, [], 'no terminal opens')
  })
})

it('checks the folder again in `ask --run` before the Host starts', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    await fakeHost(h, 'claude', { exitCode: 4 })
    const rt = await runtime(h)
    const io = { out: () => {}, err: () => {} }
    const runArgs = (id: string) =>
      parseArgs(['--run', id], ['json', 'print', 'choices'], ['run', 'state-dir']) as AskArgs
    const work = await h.mkdir('projects/work')
    const outside = await h.mkdir('../outside/work')
    const started = await startTaskSpec(rt, { prompt: 'Do it', cwd: work })
    assert.equal(
      (await readFile(join(rt.paths.stateDir, 'ask', `${started.task}.json`), 'utf8')).includes(
        '"cwdInHome":true',
      ),
      true,
    )
    // Swapped for a link after the task was written: refused, the Host never starts.
    await rm(work, { recursive: true })
    await symlink(outside, work)
    const before = process.cwd()
    await assert.rejects(cmdAsk(runArgs(started.task!), io, rt), (err: Error & { code?: string }) => {
      assert.equal(err.code, 'bad-cwd')
      assert.match(err.message, /changed after the task was prepared/)
      return true
    })
    assert.equal(process.cwd(), before)
    assert.deepEqual(await readHostLog(h, 'claude'), [])
    // A folder that stayed put starts the Host there.
    await rm(work)
    await h.mkdir('projects/work')
    const again = await startTaskSpec(rt, { prompt: 'Do it', cwd: work })
    assert.equal(await cmdAsk(runArgs(again.task!), io, rt), 4)
    assert.equal((await readHostLog(h, 'claude')).length, 1)
  })
})

it('answers a malformed, oversized or newer Task Spec with a JSON error and its code', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    const calls: Calls = { args: [] }
    const rt = await runtime(h, calls)
    const cwd = h.home
    const cases: [string | Buffer, string, number][] = [
      [Buffer.alloc(MAX_SPEC_BYTES + 1, 0x20), 'spec-too-large', 1],
      ['{ not json', 'spec-invalid', 1],
      ['[1]', 'spec-invalid', 1],
      [JSON.stringify({ specVersion: 1, cwd }), 'spec-invalid', 1],
      [JSON.stringify({ specVersion: 1, prompt: 'x', cwd, native: { task: 'fix' } }), 'spec-invalid', 1],
      [JSON.stringify({ specVersion: 1, native: { task: 'nope' } }), 'spec-invalid', 1],
      [
        JSON.stringify({ specVersion: 1, native: { task: 'fix', context: { secret: 'x' } } }),
        'spec-invalid',
        1,
      ],
      [JSON.stringify({ specVersion: 1, native: { task: 'fix' }, cwd }), 'spec-invalid', 1],
      [JSON.stringify({ specVersion: 1, prompt: 'x', skill: 'other' }), 'spec-invalid', 1],
      [JSON.stringify({ specVersion: 1, prompt: 'x', files: ['relative.png'] }), 'spec-invalid', 1],
      [JSON.stringify({ prompt: 'x' }), 'spec-invalid', 1],
      [JSON.stringify({ specVersion: 2, prompt: 'x', cwd }), 'spec-version', 2],
    ]
    for (const [input, code, exit] of cases) {
      const r = await ask(rt, ['--spec', '-', '--json'], input)
      assert.equal(r.code, exit, `${code}: ${String(input).slice(0, 60)}`)
      const e = shape('error', r.out)
      assert.equal(e.code, code)
      assert.equal(e.reason, code)
      assert.ok(e.error.length > 10)
    }
    const newer = await ask(rt, ['--spec', '-', '--json'], JSON.stringify({ specVersion: 2 }))
    assert.match(JSON.parse(newer.out).error, /sideby update/)
    assert.deepEqual(await taskFiles(rt), [])
    assert.deepEqual(calls.args, [])
    // The command line itself: only `-`, and nothing else beside it.
    await assert.rejects(ask(rt, ['--spec', 'file.json', '--json'], '{}'), /stdin/)
    await assert.rejects(ask(rt, ['--spec', '-', 'extra', '--json'], '{}'), /on their own/)
    await assert.rejects(ask(rt, ['--spec', '-', '--task', 'fix'], '{}'), /on their own/)
    await assert.rejects(ask(rt, ['--choices', '--print'], ''), /on their own/)
  })
})

it('takes the Task Spec on the real command line and stdin', async () => {
  await withFakeHome(async (h) => {
    await seed(h)
    const main = fileURLToPath(new URL('../cli/main.ts', import.meta.url))
    const run = (args: string[], input: string) =>
      new Promise<{ code: number | null; out: string }>((resolve) => {
        const child = spawn(process.execPath, [main, ...args], {
          env: h.env as NodeJS.ProcessEnv,
          stdio: ['pipe', 'pipe', 'ignore'],
        })
        let out = ''
        child.stdout.on('data', (d) => {
          out += d
        })
        child.on('close', (code) => resolve({ code, out }))
        child.stdin.end(input)
      })
    const print = await run(
      ['ask', '--spec', '-', '--print', '--json'],
      JSON.stringify({ specVersion: 1, prompt: '## What to do\nHi', cwd: h.home }),
    )
    assert.equal(print.code, 0)
    assert.equal(shape('ask-print', print.out).prompt, '## What to do\nHi')
    const newer = await run(['ask', '--spec', '-', '--json'], JSON.stringify({ specVersion: 2 }))
    assert.equal(newer.code, 2)
    assert.equal(shape('error', newer.out).reason, 'spec-version')
    const choices = await run(['ask', '--choices', '--json'], '')
    assert.equal(choices.code, 0)
    assert.equal(shape('ask-choices', choices.out).account, 'claude:main')
  })
})

it('lists the accounts and terminals a task can use, and which it would pick', async () => {
  await withFakeHome(async (h) => {
    await h.mkdir('apps/Terminal.app')
    await h.mkdir('apps/iTerm.app')
    let rt = await runtime(h)
    const none = shape('ask-choices', (await ask(rt, ['--choices', '--json'], '')).out)
    assert.equal(none.account, null)
    assert.equal(none.reason, 'no-accounts')
    assert.match(none.detail, /sideby new/)
    assert.deepEqual(none.accounts, [])
    assert.equal(none.terminal, 'terminal')
    assert.deepEqual(none.terminals, [
      { id: 'terminal', label: 'Terminal' },
      { id: 'iterm2', label: 'iTerm2' },
    ])

    await h.write('.claude/settings.json', '{}')
    await h.write('.claude.json', '{}', 0o600)
    rt = await runtime(h)
    const out = await taskChoices(rt)
    assert.equal(out.account, null)
    assert.equal(out.reason, 'none-signed-in')
    assert.match(out.detail!, /sideby login/)
    assert.deepEqual(out.accounts, [{ ref: 'claude:main', label: 'claude:main', signedIn: false }])

    await h.write('.claude.json', '{"oauthAccount":{}}', 0o600)
    await h.write('.claude-api/proxy.env', 'ANTHROPIC_BASE_URL=https://api.example.com\n', 0o600)
    rt = await runtime(h)
    await setPreferredTerminal(rt, 'iterm2')
    const one = shape('ask-choices', (await ask(rt, ['--choices', '--json'], '')).out)
    assert.equal(one.account, 'claude:main')
    assert.equal(one.reason, null)
    assert.equal(one.detail, null)
    assert.deepEqual(one.accounts, [
      { ref: 'claude:main', label: 'claude:main', signedIn: true },
      { ref: 'claude:api', label: 'claude:api · API', signedIn: true },
    ])
    assert.equal(one.terminal, 'iterm2')
  })
})
