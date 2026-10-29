// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell commands, not templates
// `sideby unattended-hook` (spec §3.37): silent while Unattended Mode is off; while on it refuses the Host's ask tool
// with exit 2 and a reason and keeps the question, and answers Claude Code's permission requests with a denial on
// stdout and keeps the request. It does nothing whenever it cannot tell, and imports only leaf modules.
import assert from 'node:assert/strict'
import { readdir, readFile, symlink } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { type FakeHome, withFakeHome } from '../../testing/index.ts'
import { resolvePaths } from '../core/paths.ts'
import { listPendingDecisions } from '../core/unattended-pending.ts'
import { writeUnattendedOverride } from '../core/unattended-state.ts'
import {
  commandProgram,
  endingQuestion,
  permissionText,
  QUESTION_PATTERNS,
  questionText,
  runUnattendedHook,
} from './hook.ts'

const now = new Date(2026, 9, 26, 12)
const sink = () => {
  const lines: string[] = []
  return { lines, write: (s: string) => lines.push(s) }
}
const ask = (tool = 'AskUserQuestion') =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: tool,
    tool_input: {
      questions: [{ header: 'Plan', question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }],
    },
    session_id: 's1',
    cwd: '/tmp/project',
  })
const bash = (command: string) =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command } })
/** A permission request as Claude Code 2.1.312 sends it, from the main session or (with `agent`) a subagent. */
const permission = (command: string, agent?: { id: string; type: string }) =>
  JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: 's1',
    cwd: '/tmp/project',
    permission_mode: 'bypassPermissions',
    tool_name: 'Bash',
    tool_input: { command, description: 'Find top-level statements' },
    ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
  })

/** A Stop as Claude Code and Codex send it at the end of a turn. */
const stopInput = (message: string, active = false) =>
  JSON.stringify({
    hook_event_name: 'Stop',
    session_id: 's1',
    cwd: '/tmp/project',
    stop_hook_active: active,
    last_assistant_message: message,
  })
const ASKED = '改完了登录页，测试都过了。\n\n需要你拍板\n\n1. 旧接口现在删掉吗？\n2. 还是留到下个版本？'
const REPORT =
  'Done: the login page uses the new client and `pnpm check` passes.\n\nDeferred: publishing v0.31 (recorded with sideby unattended defer).'

async function turnOn(h: FakeHome) {
  await h.write('.config/sideby/config.json', '{"unattended":{}}')
  await writeUnattendedOverride(resolvePaths(h.env).stateDir, {
    mode: 'on',
    at: new Date(now.getTime() - 60_000).toISOString(),
    until: new Date(now.getTime() + 3_600_000).toISOString(),
  })
}

const run = (h: FakeHome, argv: string[], input: string, env: Record<string, string> = {}) => {
  const out = sink()
  const err = sink()
  return runUnattendedHook(argv, { ...h.env, ...env }, input, { out, err }, { now: () => now }).then(
    (code) => ({ code, err: err.lines.join(''), ...(out.lines.length ? { out: out.lines.join('') } : {}) }),
  )
}
const quiet = sink()

describe('unattended hook', () => {
  it('allows everything, silently, while Unattended Mode is off', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', '{"unattended":{}}')
      assert.deepEqual(await run(h, ['claude', 'PreToolUse'], ask()), { code: 0, err: '' })
      // Claude Code then shows its permission prompt as usual.
      assert.deepEqual(await run(h, ['claude', 'PermissionRequest'], permission('rm -f $D/*')), {
        code: 0,
        err: '',
      })
      assert.deepEqual(await listPendingDecisions(resolvePaths(h.env).stateDir), [])
    })
  })

  it("refuses Claude's question with the reason, and keeps it as a Pending Decision", async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const r = await run(h, ['claude', 'PreToolUse'], ask(), { SIDEBY_ACCOUNT: 'claude:work' })
      assert.equal(r.code, 2)
      assert.match(r.err, /recommended option/)
      assert.match(r.err, /sideby unattended defer/)
      const [d, ...more] = await listPendingDecisions(resolvePaths(h.env).stateDir)
      assert.equal(more.length, 0)
      assert.equal(d?.kind, 'question')
      assert.equal(d?.family, 'claude')
      assert.equal(d?.account, 'claude:work')
      assert.equal(d?.sessionId, 's1')
      assert.equal(d?.cwd, '/tmp/project')
      assert.equal(d?.text, 'Plan: Which?\n- A\n- B')
      // Asked again: refused again, kept once.
      assert.equal((await run(h, ['claude', 'PreToolUse'], ask())).code, 2)
      assert.equal((await listPendingDecisions(resolvePaths(h.env).stateDir)).length, 1)
    })
  })

  it("refuses Codex's request_user_input, and leaves everything else of Codex alone", async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const r = await run(h, ['codex', 'PreToolUse'], ask('request_user_input'), { LANG: 'zh_CN.UTF-8' })
      assert.equal(r.code, 2)
      assert.match(r.err, /无人值守已开启/)
      assert.equal((await listPendingDecisions(resolvePaths(h.env).stateDir))[0]?.family, 'codex')
      assert.deepEqual(await run(h, ['codex', 'PreToolUse'], bash('rm -f $D/*')), { code: 0, err: '' })
      assert.equal((await run(h, ['codex', 'PreToolUse'], ask())).code, 0)
      // Codex has no permission hook of sideby's; a call for one does nothing.
      assert.deepEqual(await run(h, ['codex', 'PermissionRequest'], permission('rm -f x')), {
        code: 0,
        err: '',
      })
    })
  })

  it("answers Claude Code's permission request with a denial on stdout, and keeps the request", async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const command = 'grep -n "^  [a-zA-Z$(]" a.ts'
      const r = await run(h, ['claude', 'PermissionRequest'], permission(command), {
        SIDEBY_ACCOUNT: 'claude:work',
      })
      // Exit 2 is not honored for this event: the decision is JSON on stdout, with exit 0 and nothing on stderr.
      assert.equal(r.code, 0)
      assert.equal(r.err, '')
      const answer = JSON.parse(r.out!)
      assert.equal(answer.hookSpecificOutput.hookEventName, 'PermissionRequest')
      assert.equal(answer.hookSpecificOutput.decision.behavior, 'deny')
      const message: string = answer.hookSpecificOutput.decision.message
      assert.match(message, /wanted a person to confirm this action, and nobody is here/)
      assert.match(message, /"\$\{VAR:\?\}"/)
      assert.match(message, /sideby unattended defer "<what and why>"/)
      assert.match(message, /kept this request/)
      const [d, ...more] = await listPendingDecisions(resolvePaths(h.env).stateDir)
      assert.equal(more.length, 0)
      assert.equal(d?.kind, 'permission')
      assert.equal(d?.family, 'claude')
      assert.equal(d?.account, 'claude:work')
      assert.equal(d?.sessionId, 's1')
      assert.equal(d?.cwd, '/tmp/project')
      assert.equal(d?.text, 'Bash: grep\n(Find top-level statements)')
      assert.equal(d?.agentId, undefined)
      // The same request again: denied again, kept once.
      assert.equal(
        JSON.parse((await run(h, ['claude', 'PermissionRequest'], permission(command))).out!)
          .hookSpecificOutput.decision.behavior,
        'deny',
      )
      assert.equal((await listPendingDecisions(resolvePaths(h.env).stateDir)).length, 1)
    })
  })

  it('keeps which subagent a permission request came from', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const r = await run(
        h,
        ['claude', 'PermissionRequest'],
        permission('rm -rf build', { id: 'a1b2c3', type: 'general-purpose' }),
      )
      assert.equal(JSON.parse(r.out!).hookSpecificOutput.decision.behavior, 'deny')
      const [d] = await listPendingDecisions(resolvePaths(h.env).stateDir)
      assert.equal(d?.agentId, 'a1b2c3')
      assert.equal(d?.agentType, 'general-purpose')
      // Anything but a plain id is left out.
      await run(h, ['claude', 'PermissionRequest'], permission('ls', { id: 'a b', type: 'x'.repeat(65) }))
      const odd = (await listPendingDecisions(resolvePaths(h.env).stateDir)).find((x) =>
        x.text.startsWith('Bash: ls'),
      )
      assert.equal(odd?.agentId, undefined)
      assert.equal(odd?.agentType, undefined)
      await run(h, ['claude', 'PermissionRequest'], permission('pwd', { id: 'id\nnext', type: 'Explore:v2' }))
      const other = (await listPendingDecisions(resolvePaths(h.env).stateDir)).find((x) =>
        x.text.startsWith('Bash: pwd'),
      )
      assert.equal(other?.agentId, undefined)
      assert.equal(other?.agentType, 'Explore:v2')
    })
  })

  it('keeps a short summary of a permission request, never the whole input', () => {
    // Bash: the program and the model's description only, never an argument.
    assert.equal(permissionText('Bash', { command: 'rm -rf build' }), 'Bash: rm')
    assert.equal(
      permissionText('Bash', { command: 'rm -rf build', description: 'Clear the build' }),
      'Bash: rm\n(Clear the build)',
    )
    assert.equal(permissionText('Bash', { command: '"$(which rm)" -rf x', description: 'd' }), 'Bash\n(d)')
    assert.equal(
      permissionText('Write', { file_path: '/etc/hosts', content: 'secret body' }),
      'Write: /etc/hosts',
    )
    assert.equal(
      permissionText('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' }),
      'Edit: a.ts',
    )
    assert.equal(
      permissionText('NotebookEdit', { notebook_path: 'n.ipynb', new_source: 'x' }),
      'NotebookEdit: n.ipynb',
    )
    // WebFetch: the host only, so a token in the address or the prompt is not kept.
    assert.equal(
      permissionText('WebFetch', { url: 'https://api.example.com/v1/x?token=abc', prompt: 'p' }),
      'WebFetch: api.example.com',
    )
    assert.equal(permissionText('WebFetch', { url: 'not a url' }), 'WebFetch')
    // Any other tool, MCP ones included: its name only.
    const mcp = { url: 'https://api.example.com', headers: { Authorization: 'Bearer sk-live-123' } }
    assert.equal(permissionText('mcp__http__request', mcp), 'mcp__http__request')
    assert.equal(permissionText('Glob', { pattern: '**/*.env' }), 'Glob')
    assert.equal(permissionText('ExitPlanMode', {}), 'ExitPlanMode')
    assert.equal(permissionText('Bash', {}), 'Bash')
  })

  it('tells the program a command runs, by its name only, or nothing', () => {
    assert.equal(commandProgram('curl -s https://example.com'), 'curl')
    assert.equal(commandProgram('/usr/bin/rm -rf x'), 'rm')
    assert.equal(commandProgram('./scripts/build.sh --fast'), 'build.sh')
    assert.equal(commandProgram('GH_TOKEN=abc LANG=C gh pr list'), 'gh')
    assert.equal(commandProgram('sudo -u root rm -rf /var/x'), 'rm')
    assert.equal(commandProgram('env -i PATH=/bin nice -n 10 make'), 'make')
    assert.equal(commandProgram('command -p ls'), 'ls')
    for (const unclear of [
      '"$BIN" x',
      '$(which rm) x',
      '(cd a && rm x)',
      'KEY="a b" run',
      '{ rm x; }',
      '',
      'sudo',
    ])
      assert.equal(commandProgram(unclear), undefined, unclear)
  })

  it('keeps no value of a token, password or header of a refused request anywhere in the Pending Decision', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const SECRET = 'S3cr3tV4lue'
      const commands = [
        `curl -H 'X-Api-Key: ${SECRET}' https://api.example.com`,
        `curl -d '{"password":"${SECRET}"}' https://api.example.com/login`,
        `mysql -p'${SECRET}' app`,
        `psql --password 'abc'"${SECRET}" -h db`,
        `git clone me:${SECRET}@example.com:o/r.git`,
        `curl -H "Authorization: Bearer ${SECRET}" https://api.example.com`,
        `OPENAI_API_KEY=sk-live-${SECRET} node a.js`,
      ]
      for (const [n, command] of commands.entries())
        await run(
          h,
          ['claude', 'PermissionRequest'],
          JSON.stringify({
            hook_event_name: 'PermissionRequest',
            session_id: `s${n}`,
            tool_name: 'Bash',
            tool_input: { command },
          }),
        )
      const mcp = JSON.stringify({
        hook_event_name: 'PermissionRequest',
        session_id: 'm',
        tool_name: 'mcp__http__request',
        tool_input: { url: 'https://api.example.com', headers: { Authorization: `Bearer ${SECRET}` } },
      })
      assert.equal(
        JSON.parse((await run(h, ['claude', 'PermissionRequest'], mcp)).out!).hookSpecificOutput.decision
          .behavior,
        'deny',
      )
      const stateDir = resolvePaths(h.env).stateDir
      const kept = await listPendingDecisions(stateDir)
      assert.deepEqual(kept.map((d) => d.text).sort(), [
        'Bash: curl',
        'Bash: curl',
        'Bash: curl',
        'Bash: git',
        'Bash: mysql',
        'Bash: node',
        'Bash: psql',
        'mcp__http__request',
      ])
      assert.doesNotMatch(JSON.stringify(kept), new RegExp(SECRET))
      for (const f of await readdir(join(stateDir, 'unattended/pending')))
        assert.doesNotMatch(
          await readFile(join(stateDir, 'unattended/pending', f), 'utf8'),
          new RegExp(SECRET),
        )
    })
  })

  it('is on for a session started with --unattended, whatever the Schedule says', async () => {
    await withFakeHome(async (h) => {
      assert.equal((await run(h, ['claude', 'PreToolUse'], ask(), { SIDEBY_UNATTENDED: '1' })).code, 2)
    })
  })

  it('follows the Schedule on every call', async () => {
    await withFakeHome(async (h) => {
      const slot = { days: ['mon'], start: '11:00', end: '13:00' }
      await h.write('.config/sideby/config.json', JSON.stringify({ unattended: { schedule: [slot] } }))
      assert.equal((await run(h, ['claude', 'PreToolUse'], ask())).code, 2)
      await h.write('.config/sideby/config.json', JSON.stringify({ unattended: { schedule: [] } }))
      assert.equal((await run(h, ['claude', 'PreToolUse'], ask())).code, 0)
    })
  })

  it('allows whenever it cannot tell: bad input, other events, a broken config', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      assert.deepEqual(await run(h, ['claude', 'PreToolUse'], 'not json'), { code: 0, err: '' })
      assert.deepEqual(await run(h, ['claude', 'Stop'], ask()), { code: 0, err: '' })
      assert.deepEqual(await run(h, ['grok', 'PreToolUse'], ask()), { code: 0, err: '' })
      assert.deepEqual(await run(h, [], ask()), { code: 0, err: '' })
      await h.write('.config/sideby/config.json', '{broken')
      await h.write('.local/state/sideby/unattended/override.json', '[]')
      assert.deepEqual(await run(h, ['claude', 'PreToolUse'], ask()), { code: 0, err: '' })
    })
  })

  it('refuses once it has decided to, even when keeping the question or writing the reason fails', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      // A file where the pending folder should be: keeping fails, refusing does not.
      await h.write('.local/state/sideby/unattended/pending', 'x')
      const r = await run(h, ['claude', 'PreToolUse'], ask())
      assert.equal(r.code, 2)
      assert.match(r.err, /could not keep this question/)
      // The Host closed stderr: the call is still refused.
      const broken = {
        write() {
          throw new Error('EPIPE')
        },
      }
      const env = { ...h.env }
      assert.equal(
        await runUnattendedHook(
          ['claude', 'PreToolUse'],
          env,
          ask(),
          { out: quiet, err: broken },
          { now: () => now },
        ),
        2,
      )
      // A permission request is still answered when keeping it fails, without saying it was kept.
      const p = await run(h, ['claude', 'PermissionRequest'], permission('rm -rf build'))
      const message = JSON.parse(p.out!).hookSpecificOutput.decision.message
      assert.equal(p.code, 0)
      assert.doesNotMatch(message, /kept this request/)
      // Claude Code closed stdout: nothing reached it, so it shows its prompt; the hook does not fail.
      assert.equal(
        await runUnattendedHook(
          ['claude', 'PermissionRequest'],
          env,
          permission('rm -rf build'),
          { out: broken, err: quiet },
          {
            now: () => now,
          },
        ),
        0,
      )
    })
  })

  it('allows, silently, when it fails before deciding', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const err = sink()
      const input = {
        async *[Symbol.asyncIterator]() {
          yield '{"tool_name":'
          throw new Error('stdin closed')
        },
      }
      const out = sink()
      assert.equal(
        await runUnattendedHook(['claude', 'PreToolUse'], h.env, input, { out, err }, { now: () => now }),
        0,
      )
      assert.deepEqual(err.lines, [])
      assert.equal(
        await runUnattendedHook(
          ['claude', 'PermissionRequest'],
          h.env,
          input,
          { out, err },
          { now: () => now },
        ),
        0,
      )
      assert.deepEqual([out.lines, err.lines], [[], []])
      assert.deepEqual(await run(h, ['claude', 'PermissionRequest'], 'not json'), { code: 0, err: '' })
    })
  })

  it('keeps nothing through a linked folder, and still refuses', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const outside = await h.mkdir('elsewhere')
      await symlink(outside, h.path('.local/state/sideby/unattended/pending'))
      const r = await run(h, ['claude', 'PreToolUse'], ask())
      assert.equal(r.code, 2)
      assert.match(r.err, /could not keep this question/)
      assert.deepEqual(await readdir(outside), [])
    })
  })

  it('says there is no end when the Schedule covers every hour', async () => {
    await withFakeHome(async (h) => {
      const always = { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], start: '00:00', end: '00:00' }
      await h.write('.config/sideby/config.json', JSON.stringify({ unattended: { schedule: [always] } }))
      const r = await run(h, ['claude', 'PreToolUse'], ask())
      assert.equal(r.code, 2)
      assert.match(r.err, /on with no end set/)
    })
  })

  it('reads the question from either Host, and keeps any other input as it is', () => {
    assert.equal(
      questionText({ questions: [{ question: 'Q1', options: ['x', { label: 'y' }] }, { prompt: 'Q2' }] }),
      'Q1\n- x\n- y\n\nQ2',
    )
    assert.equal(questionText({ foo: 1 }), '{"foo":1}')
  })
})

describe('unattended hook at the end of a turn', () => {
  it('keeps a turn that ended on a question going once, with the reason, and keeps the question', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const r = await run(h, ['claude', 'Stop'], stopInput(ASKED), { SIDEBY_ACCOUNT: 'claude:work' })
      assert.equal(r.code, 0)
      assert.equal(r.err, '')
      const answer = JSON.parse(r.out!)
      assert.equal(answer.decision, 'block')
      assert.match(answer.reason, /Nobody is here to answer/)
      assert.match(answer.reason, /recommended option/)
      assert.match(answer.reason, /sideby unattended defer "<one sentence>"/)
      assert.match(answer.reason, /final report/)
      assert.match(answer.reason, /kept your question/)
      const [d, ...more] = await listPendingDecisions(resolvePaths(h.env).stateDir)
      assert.equal(more.length, 0)
      assert.equal(d?.kind, 'question')
      assert.equal(d?.family, 'claude')
      assert.equal(d?.account, 'claude:work')
      assert.equal(d?.sessionId, 's1')
      assert.equal(d?.cwd, '/tmp/project')
      assert.equal(d?.text, '需要你拍板\n\n1. 旧接口现在删掉吗？\n2. 还是留到下个版本？')
      // Inline code is kept as written in the Pending Decision.
      await run(
        h,
        ['claude', 'Stop'],
        stopInput('改好了。\n\n要不要改 `~/coding/sideby` 的 `network-hook`？'),
      )
      const texts = (await listPendingDecisions(resolvePaths(h.env).stateDir)).map((x) => x.text)
      assert.ok(texts.includes('要不要改 `~/coding/sideby` 的 `network-hook`？'), texts.join(' | '))
      // The same question again: kept once.
      assert.equal(JSON.parse((await run(h, ['claude', 'Stop'], stopInput(ASKED))).out!).decision, 'block')
      assert.equal((await listPendingDecisions(resolvePaths(h.env).stateDir)).length, 2)
    })
  })

  it('says it in Chinese, and does the same for Codex', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const r = await run(h, ['codex', 'Stop'], stopInput('Want me to open the PR now?'), {
        LANG: 'zh_CN.UTF-8',
      })
      assert.equal(r.code, 0)
      const answer = JSON.parse(r.out!)
      assert.equal(answer.decision, 'block')
      assert.match(answer.reason, /没人能回答/)
      assert.match(answer.reason, /最终汇报/)
      assert.equal((await listPendingDecisions(resolvePaths(h.env).stateDir))[0]?.family, 'codex')
    })
  })

  it('lets the turn end: already kept going once, Unattended Mode off, a finished report, bad input', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', '{"unattended":{}}')
      assert.deepEqual(await run(h, ['claude', 'Stop'], stopInput(ASKED)), { code: 0, err: '' })
      await turnOn(h)
      assert.deepEqual(await run(h, ['claude', 'Stop'], stopInput(ASKED, true)), { code: 0, err: '' })
      assert.deepEqual(await run(h, ['claude', 'Stop'], stopInput(REPORT)), { code: 0, err: '' })
      assert.deepEqual(await run(h, ['claude', 'Stop'], stopInput('')), { code: 0, err: '' })
      assert.deepEqual(await run(h, ['claude', 'Stop'], 'not json'), { code: 0, err: '' })
      assert.deepEqual(await run(h, ['claude', 'Stop'], '[1]'), { code: 0, err: '' })
      // No `stop_hook_active` at all: it cannot tell whether it already kept this turn going.
      assert.deepEqual(
        await run(h, ['claude', 'Stop'], JSON.stringify({ last_assistant_message: 'Should I go on?' })),
        { code: 0, err: '' },
      )
      assert.deepEqual(await run(h, ['grok', 'Stop'], stopInput(ASKED)), { code: 0, err: '' })
      assert.deepEqual(await listPendingDecisions(resolvePaths(h.env).stateDir), [])
    })
  })

  it('still keeps the turn going when keeping the question fails, and says so', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      await h.write('.local/state/sideby/unattended/pending', 'x')
      const r = await run(h, ['claude', 'Stop'], stopInput(ASKED))
      const answer = JSON.parse(r.out!)
      assert.equal(answer.decision, 'block')
      assert.match(answer.reason, /could not keep your question/)
    })
  })
})

describe('telling a question at the end of a message', () => {
  it('finds the asks of both languages', () => {
    const asks = [
      ASKED,
      '## 需要你拍板\n\n用 A 还是 B',
      '**需要你拍板**：\n- 删掉旧表\n- 保留',
      '**需要你拍板**：今天的导出卡片正式发版时，是接受这一次缓存期内显示兜底文字，还是让 claude:work 给 `director-export` 单独挂一个新地址？我建议接受：影响有时限、不丢数据，而换地址在 ChatGPT 上有已知风险。\n\n另外，sideby 待决清单里的「轻卡片改造」那条已经过时，可以忽略。',
      'Needs your decision: ship today or wait for the review.\n\nThe rest is done.',
      'All done except the migration.\n\nShould I run it against staging?',
      'Tests pass. Want me to open a PR',
      'I found two ways.\n\nWhich do you prefer:\n1. Keep the cache\n2. Drop it',
      'Let me know which option you want.',
      'Let me know if you would like me to push it.',
      'Would you like me to delete the old files as well',
      'The build is fixed (see `a?b`). Is this what you wanted? ',
      '改好了。\n\n要不要顺便把旧配置也删了',
      '两个方案都能用，你来决定。',
      '你回来后选一个：\n\n1. 先发布\n2. 先补测试',
      '部署前请确认环境变量。',
      '这样改可以吗（不改也行）',
      '还差最后一步，要现在推送吗？）',
      'Two ways to go.\nWhich one?\n- Keep the cache\n- Drop it',
    ]
    for (const m of asks) assert.ok(endingQuestion(m), m)
  })

  it('lets a finished report end, in both languages', () => {
    const reports = [
      REPORT,
      'Done. All 42 tests pass.\n\nLet me know if you have any questions.',
      'Why did it fail? The cache key left out the locale.\n\nFixed it and added a test; `pnpm check` passes.',
      'Fixed the regex `^a?$` and the parser:\n\n```ts\nconst ok = x?.y ?? z\n```',
      '已完成：登录页改用新客户端，pnpm check 通过。\n\n已跳过：发布 v0.31（已用 sideby unattended defer 记下）。',
      '为什么会失败？缓存键里少了语言。\n\n已修复并补了测试。',
      '我按推荐选了方案 A，理由写在上面。如有问题随时告诉我。',
      'Why did it fail?\nFixed the cache key; all tests pass.',
      '已完成，无需你来决定。',
      'Nothing left to do: no need to confirm anything.',
      '全部改完，不用你确认。',
      'Done.\n\n> Should I also delete the old branch?\n\nLeft the branch as it is.',
      'Done; the check is below.\n\n~~~sh\nwhich node || echo "Want me to install it?"\n~~~',
      '',
      '   ',
    ]
    for (const m of reports) assert.equal(endingQuestion(m), undefined, m)
  })

  it('keeps the question as written, inline code included', () => {
    assert.equal(
      endingQuestion('改好了。\n\n要不要改 `~/coding/sideby` 的 `network-hook`？'),
      '要不要改 `~/coding/sideby` 的 `network-hook`？',
    )
    assert.equal(
      endingQuestion('Done.\n\nShould I run `pnpm release patch`?\r\n- yes\r\n- no'),
      // The last paragraph is a list, so the one before it is kept too.
      'Done.\n\nShould I run `pnpm release patch`?\n- yes\n- no',
    )
    assert.equal(
      endingQuestion('**需要你拍板**：用 `~~~` 还是 `\u0060\u0060\u0060`？\n\n```sh\necho hi\n```\n\n旁注。'),
      '**需要你拍板**：用 `~~~` 还是 `\u0060\u0060\u0060`？\n\n```sh\necho hi\n```\n\n旁注。',
    )
  })

  it('reads only the end of a long message', () => {
    const early = `Should I keep the old API?\n\n${'Done with the rest. '.repeat(40)}`
    assert.equal(endingQuestion(early), undefined)
    assert.ok(endingQuestion(`${'x'.repeat(5000)}\n\nWant me to go on?`))
  })

  it('keeps every pattern working on an example of its own', () => {
    const examples = [
      'want me to',
      'should I',
      'would you like',
      'do you want',
      'let me know whether',
      'which do you prefer',
      'your call',
      'please confirm',
      "when you're back",
      'waiting for your',
      '要不要',
      '你来决定',
      '等你回来',
      '请确认',
      '你看呢',
    ]
    assert.equal(examples.length, QUESTION_PATTERNS.length)
    for (const [i, p] of QUESTION_PATTERNS.entries()) assert.match(examples[i]!, p)
  })
})

describe('unattended hook on an MCP form', () => {
  const form = JSON.stringify({
    hook_event_name: 'Elicitation',
    session_id: 's1',
    cwd: '/tmp/project',
    mcp_server_name: 'issue-tracker',
    message: 'Which project key?',
    mode: 'form',
    requested_schema: { type: 'object', properties: { key: { type: 'string', default: 'SECRET-1' } } },
  })

  it('declines it while on and keeps what the server asked, never the form itself', async () => {
    await withFakeHome(async (h) => {
      await turnOn(h)
      const r = await run(h, ['claude', 'Elicitation'], form)
      assert.equal(r.code, 0)
      assert.equal(r.err, '')
      assert.deepEqual(JSON.parse(r.out!), {
        hookSpecificOutput: { hookEventName: 'Elicitation', action: 'decline' },
      })
      const [d] = await listPendingDecisions(resolvePaths(h.env).stateDir)
      assert.equal(d?.kind, 'question')
      assert.equal(d?.text, 'MCP issue-tracker: Which project key?')
      assert.doesNotMatch(JSON.stringify(d), /SECRET-1/)
    })
  })

  it('leaves it to the dialog while off, on bad input, and in Codex', async () => {
    await withFakeHome(async (h) => {
      await h.write('.config/sideby/config.json', '{"unattended":{}}')
      assert.deepEqual(await run(h, ['claude', 'Elicitation'], form), { code: 0, err: '' })
      await turnOn(h)
      assert.deepEqual(await run(h, ['claude', 'Elicitation'], 'not json'), { code: 0, err: '' })
      assert.deepEqual(await run(h, ['codex', 'Elicitation'], form), { code: 0, err: '' })
    })
  })
})

describe('unattended hook imports', () => {
  it('reaches only leaf modules: never the Runtime, a Family index or core/accounts.ts', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const seen = new Set<string>()
    const walk = async (file: string) => {
      if (seen.has(file)) return
      seen.add(file)
      const text = await readFile(file, 'utf8')
      for (const m of text.matchAll(/^import (?!type )[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm))
        await walk(resolve(dirname(file), m[1]!))
    }
    await walk(join(root, 'unattended/hook.ts'))
    assert.ok(seen.has(join(root, 'core/unattended-state.ts')), 'the walk follows imports')
    const allowed = new Set([
      'unattended/hook.ts',
      'core/unattended-state.ts',
      'core/unattended-pending.ts',
      'core/fs-safe.ts',
      'core/paths.ts',
    ])
    assert.deepEqual(
      [...seen].map((f) => relative(root, f)).filter((f) => !allowed.has(f)),
      [],
    )
  })
})
