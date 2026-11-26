// WHY: ADR-0088 tests for `deliverAgy`: Orca Chat direct delivery, caller-identity gate, pre-send drift checks,
// structured outcome mapping (`delivered` / `paste-needed` / `unknown`), ephemeral body-file cleanup, and transcript
// read receipt ENOENT-to-read transition.
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { chmod, readFile, stat } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import { type FakeHome, withFakeHome } from '../../../testing/index.ts'
import type { LiveSessionDeps, ProcessInfo } from '../../core/live-sessions-procs.ts'
import { listMessages, type MessageDeps, sendMessage } from '../../core/messages.ts'
import {
  clearOrcaAgentCache,
  ORCA_AGENT_SESSION_VAR,
  ORCA_SESSION_PREFIX,
  ORCA_STRUCTURED_VAR,
  OrcaPreSendError,
  OrcaSendTimeout,
} from '../../core/orca-chat.ts'
import { ORCA_HANDLE_VAR } from '../../panel/orca.ts'
import { createRuntime } from '../../runtime.ts'
import { agyPlugin } from './index.ts'
import { agyTranscriptPath } from './live-sessions.ts'

const MAIN = '.gemini/antigravity-cli'
const START = Date.UTC(2026, 10, 26, 10, 0, 0)
const ID_TARGET = '0f8fad5b-d9cb-469f-a165-70867728950e'
const ID_SENDER = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
const ID_OTHER = '3b1f2c90-1111-4222-8333-444444444444'
const ORCA_TARGET = 'orca-target-1'
const ORCA_SENDER = 'orca-sender-2'
const builtins = [{ plugin: agyPlugin, version: '0.1.0', description: '', defaultEnabled: true }]

async function seedDb(h: FakeHome, rows: { id: string; title: string }[]): Promise<void> {
  await h.mkdir(`${MAIN}/conversations`)
  const db = new DatabaseSync(h.path(`${MAIN}/conversation_summaries.db`))
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`CREATE TABLE conversation_summaries (conversation_id text, title text NOT NULL DEFAULT "",
    preview text NOT NULL DEFAULT "", step_count integer NOT NULL DEFAULT 0, last_modified_time datetime NOT NULL,
    workspace_uris text NOT NULL, status text NOT NULL DEFAULT "", agent_name text NOT NULL DEFAULT "",
    parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0,
    raw_summary blob, PRIMARY KEY (conversation_id))`)
  const add = db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, step_count,
    last_modified_time, workspace_uris, parent_conversation_id, nesting_depth) VALUES (?, ?, 1, '2026-11-26 10:05:00+00:00', '["file:///work/app"]', '', 0)`)
  for (const r of rows) add.run(r.id, r.title)
  db.close()
}

function twoChats(h: FakeHome): {
  procs: LiveSessionDeps
  orcaAgents: NonNullable<MessageDeps['orcaAgents']>
} {
  const list: ProcessInfo[] = [
    { pid: 501, ppid: 1, startMs: START, command: 'agy acp' },
    { pid: 502, ppid: 1, startMs: START, command: 'agy acp' },
    { pid: 601, ppid: 502, startMs: START + 1000, command: 'node sideby send' },
  ]
  const procs: LiveSessionDeps = {
    processes: async () => list,
    envVar: async (pid, name) => {
      if (pid === 501 && name === ORCA_STRUCTURED_VAR) return '1'
      if (pid === 501 && name === ORCA_AGENT_SESSION_VAR) return ORCA_TARGET
      if (pid === 502 && name === ORCA_STRUCTURED_VAR) return '1'
      if (pid === 502 && name === ORCA_AGENT_SESSION_VAR) return ORCA_SENDER
      return undefined
    },
    openFiles: async (pid) => {
      if (pid === 501) return [h.path(`${MAIN}/conversations/${ID_TARGET}.db`)]
      if (pid === 502) return [h.path(`${MAIN}/conversations/${ID_SENDER}.db`)]
      return []
    },
  }
  const orcaAgents: NonNullable<MessageDeps['orcaAgents']> = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      ok: true,
      result: {
        agents: [
          { orcaSessionId: ORCA_TARGET, kind: 'chat', state: 'done' },
          { orcaSessionId: ORCA_SENDER, kind: 'chat', state: 'working' },
        ],
      },
    }),
  })
  return { procs, orcaAgents }
}

describe('deliverAgy via Orca Chat (ADR-0088)', () => {
  it('delivers to a verified Orca Chat from a verified Orca sender via mode-600 body-file, cleans it up, and preserves recipient_delivery_held warnings', async () => {
    await withFakeHome(async (h) => {
      clearOrcaAgentCache()
      await seedDb(h, [
        { id: ID_TARGET, title: 'Target chat' },
        { id: ID_SENDER, title: 'Sender chat' },
      ])
      const { procs, orcaAgents } = twoChats(h)
      const rt = await createRuntime({
        env: {
          ...h.env,
          [ORCA_STRUCTURED_VAR]: '1',
          [ORCA_AGENT_SESSION_VAR]: ORCA_SENDER,
          ANTIGRAVITY_CONVERSATION_ID: ID_SENDER,
        },
        builtins,
      })

      let seenArgs: readonly string[] = []
      let seenBody = ''
      let seenMode = 0
      let bodyFilePath = ''
      const r = await sendMessage(
        rt,
        `${ORCA_SESSION_PREFIX}${ORCA_TARGET}`,
        { text: 'Build passed, ready to merge' },
        {
          procs,
          orcaAgents,
          selfPid: 601,
          runOrcaSend: async (args) => {
            seenArgs = args
            const at = args.indexOf('--body-file')
            bodyFilePath = args[at + 1]!
            seenBody = await readFile(bodyFilePath, 'utf8')
            seenMode = (await stat(bodyFilePath)).mode & 0o777
            return {
              exitCode: 0,
              stdout: JSON.stringify({ ok: true, result: { warnings: ['recipient_delivery_held'] } }),
            }
          },
        },
      )

      assert.equal(r.status, 'delivered')
      assert.equal(r.toSessionId, ID_TARGET)
      assert.match(r.note!, /recipient_delivery_held/)
      assert.ok(
        seenArgs.includes('--to') &&
          seenArgs[seenArgs.indexOf('--to') + 1] === `${ORCA_SESSION_PREFIX}${ORCA_TARGET}`,
      )
      assert.ok(
        seenArgs.includes('--from') &&
          seenArgs[seenArgs.indexOf('--from') + 1] === `${ORCA_SESSION_PREFIX}${ORCA_SENDER}`,
      )
      assert.ok(seenArgs.includes('--type') && seenArgs[seenArgs.indexOf('--type') + 1] === 'status')
      assert.ok(seenArgs.includes('--json') && seenArgs.includes('--full'))
      assert.equal(seenMode, 0o600)
      assert.match(seenBody, new RegExp(`sideby message ${r.id}`))
      assert.match(seenBody, new RegExp(`Reply: sideby send ${ID_SENDER}`))
      assert.equal(existsSync(bodyFilePath), false)
    })
  })

  it('enforces caller-identity gate for Panel, plain non-Orca terminals, and contradicting sender signals', async () => {
    await withFakeHome(async (h) => {
      clearOrcaAgentCache()
      await seedDb(h, [
        { id: ID_TARGET, title: 'Target chat' },
        { id: ID_SENDER, title: 'Sender chat' },
      ])
      const { procs, orcaAgents } = twoChats(h)
      let sendCalls = 0
      const runOrcaSend: NonNullable<MessageDeps['runOrcaSend']> = async () => {
        sendCalls++
        return { exitCode: 0, stdout: '{"ok":true}' }
      }

      const rtPlain = await createRuntime({ env: h.env, builtins })
      const fromPanel = await sendMessage(
        rtPlain,
        ID_TARGET,
        { text: 'from panel', fromUser: true },
        { procs, orcaAgents, selfPid: 999, runOrcaSend },
      )
      assert.equal(fromPanel.status, 'paste-needed')
      assert.match(fromPanel.note!, /Panel/)

      const fromPlainTerm = await sendMessage(
        rtPlain,
        ID_TARGET,
        { text: 'from plain terminal' },
        { procs, orcaAgents, selfPid: 999, runOrcaSend },
      )
      assert.equal(fromPlainTerm.status, 'paste-needed')
      assert.match(fromPlainTerm.note!, /verified Orca/)

      const rtConflict = await createRuntime({
        env: {
          ...h.env,
          [ORCA_AGENT_SESSION_VAR]: ORCA_SENDER,
          ANTIGRAVITY_CONVERSATION_ID: ID_OTHER,
        },
        builtins,
      })
      const conflicted = await sendMessage(
        rtConflict,
        ID_TARGET,
        { text: 'conflicted sender' },
        { procs, orcaAgents, selfPid: 601, runOrcaSend },
      )
      assert.equal(conflicted.status, 'paste-needed')
      assert.equal(conflicted.from, undefined)
      assert.doesNotMatch(await readFile(conflicted.file, 'utf8'), /^Reply:/m)
      assert.equal(sendCalls, 0)

      const rtOrcaTerm = await createRuntime({
        env: { ...h.env, [ORCA_HANDLE_VAR]: 'term_live_1' },
        builtins,
      })
      const fromTerm = await sendMessage(
        rtOrcaTerm,
        ID_TARGET,
        { text: 'from verified orca terminal' },
        {
          procs,
          orcaAgents,
          selfPid: 999,
          orcaHandles: async () => new Set(['term_live_1']),
          runOrcaSend: async (args) => {
            assert.equal(args[args.indexOf('--from') + 1], 'term_live_1')
            return { exitCode: 0, stdout: '{"ok":true}' }
          },
        },
      )
      assert.equal(fromTerm.status, 'delivered')
    })
  })

  it('skips delivery to paste-needed when pre-send drift check detects procStart or conversation change', async () => {
    await withFakeHome(async (h) => {
      clearOrcaAgentCache()
      await seedDb(h, [
        { id: ID_TARGET, title: 'Target chat' },
        { id: ID_SENDER, title: 'Sender chat' },
        { id: ID_OTHER, title: 'Switched chat' },
      ])
      const { procs, orcaAgents } = twoChats(h)
      let openCount = 0
      const driftedProcs: LiveSessionDeps = {
        ...procs,
        openFiles: async (pid) => {
          if (pid === 501) {
            openCount++
            const id = openCount === 1 ? ID_TARGET : ID_OTHER
            return [h.path(`${MAIN}/conversations/${id}.db`)]
          }
          return procs.openFiles(pid)
        },
      }
      const rt = await createRuntime({
        env: { ...h.env, [ORCA_STRUCTURED_VAR]: '1', [ORCA_AGENT_SESSION_VAR]: ORCA_SENDER },
        builtins,
      })
      let sendCalls = 0
      const r = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'check drift' },
        {
          procs: driftedProcs,
          orcaAgents,
          selfPid: 601,
          runOrcaSend: async () => {
            sendCalls++
            return { exitCode: 0, stdout: '{"ok":true}' }
          },
        },
      )
      assert.equal(r.status, 'paste-needed')
      assert.match(r.note!, /switched conversations/)
      assert.equal(sendCalls, 0)
    })
  })

  it('maps pre-send refusals to paste-needed, uncertain/timeout failures to unknown, and resolves ENOENT transcript to read once created', async () => {
    await withFakeHome(async (h) => {
      clearOrcaAgentCache()
      await seedDb(h, [
        { id: ID_TARGET, title: 'Target chat' },
        { id: ID_SENDER, title: 'Sender chat' },
      ])
      const { procs, orcaAgents } = twoChats(h)
      const rt = await createRuntime({
        env: { ...h.env, [ORCA_STRUCTURED_VAR]: '1', [ORCA_AGENT_SESSION_VAR]: ORCA_SENDER },
        builtins,
      })

      const preSendErr = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'a' },
        {
          procs,
          orcaAgents,
          selfPid: 601,
          runOrcaSend: async () => {
            throw new OrcaPreSendError('Orca is not installed')
          },
        },
      )
      assert.equal(preSendErr.status, 'paste-needed')

      const refused = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'b' },
        {
          procs,
          orcaAgents,
          selfPid: 601,
          runOrcaSend: async () => ({
            exitCode: 1,
            stdout: JSON.stringify({ ok: false, error: { code: 'recipient_not_found' } }),
          }),
        },
      )
      assert.equal(refused.status, 'paste-needed')

      let timeoutCalls = 0
      const timedOut = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'c' },
        {
          procs,
          orcaAgents,
          selfPid: 601,
          runOrcaSend: async () => {
            timeoutCalls++
            throw new OrcaSendTimeout('Orca did not finish within 20 s')
          },
        },
      )
      assert.equal(timedOut.status, 'unknown')
      assert.equal(timeoutCalls, 1)
      assert.doesNotMatch(timedOut.note!, /paste/i)

      const unavail = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'd' },
        {
          procs,
          orcaAgents,
          selfPid: 601,
          runOrcaSend: async () => ({
            exitCode: 1,
            stdout: JSON.stringify({ ok: false, error: { code: 'runtime_unavailable' } }),
          }),
        },
      )
      assert.equal(unavail.status, 'unknown')

      // WHY: expected transcript.jsonl does not exist yet -> ENOENT stays unread, then flips to read once created (ADR-0088).
      const beforeTranscript = await listMessages(rt, { to: ID_TARGET })
      assert.equal(beforeTranscript.find((m) => m.id === unavail.id)?.status, 'unknown')

      const transcript = agyTranscriptPath(h.path(MAIN), ID_TARGET)
      await h.write(
        transcript.slice(h.home.length + 1),
        `${JSON.stringify({ text: `sideby message ${unavail.id}` })}\n`,
      )
      const afterTranscript = await listMessages(rt, { to: ID_TARGET })
      assert.equal(afterTranscript.find((m) => m.id === unavail.id)?.status, 'read')
    })
  })

  it('kills a SIGTERM-ignoring Orca transport on timeout before removing body-file, returns unknown, and never retries (ADR-0088)', async () => {
    if (process.platform === 'win32') return
    await withFakeHome(async (h) => {
      clearOrcaAgentCache()
      await seedDb(h, [
        { id: ID_TARGET, title: 'Target chat' },
        { id: ID_SENDER, title: 'Sender chat' },
      ])
      const { procs, orcaAgents } = twoChats(h)
      const pidFile = h.path('orca.pid')
      const childPidFile = h.path('orca-child.pid')
      const countFile = h.path('orca.calls')
      const bodySeenFile = h.path('orca.body')
      const binPath = await h.write(
        'bin/orca',
        [
          '#!/bin/sh',
          "trap '' TERM",
          `echo $$ > '${pidFile}'`,
          `echo call >> '${countFile}'`,
          'body=""',
          'while [ $# -gt 0 ]; do',
          '  if [ "$1" = "--body-file" ]; then body="$2"; shift 2; else shift; fi',
          'done',
          `if [ -n "$body" ] && [ -f "$body" ]; then printf '%s' "$body" > '${bodySeenFile}'; fi`,
          `sleep 30 & echo $! > '${childPidFile}'`,
          'wait',
          '',
        ].join('\n'),
        0o755,
      )
      await chmod(binPath, 0o755)
      const rt = await createRuntime({
        env: {
          ...h.env,
          PATH: `${h.path('bin')}:${h.env.PATH ?? ''}`,
          [ORCA_STRUCTURED_VAR]: '1',
          [ORCA_AGENT_SESSION_VAR]: ORCA_SENDER,
        },
        builtins,
      })

      const r = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'timeout kill check' },
        { procs, orcaAgents, selfPid: 601, timeoutMs: 80, killGraceMs: 80 },
      )
      assert.equal(r.status, 'unknown')
      assert.equal((await readFile(countFile, 'utf8')).trim().split('\n').length, 1)

      const seenBodyPath = (await readFile(bodySeenFile, 'utf8')).trim()
      assert.ok(seenBodyPath.length > 0)
      assert.equal(existsSync(seenBodyPath), false)

      const orcaPid = Number((await readFile(pidFile, 'utf8')).trim())
      const childPid = Number((await readFile(childPidFile, 'utf8')).trim())
      for (const pid of [orcaPid, childPid]) {
        assert.throws(
          () => process.kill(pid, 0),
          (err: NodeJS.ErrnoException) => err.code === 'ESRCH',
        )
      }
    })
  })

  it('refuses delivery when PID is reused after selection or baseline targetProcStart is missing (ADR-0088)', async () => {
    await withFakeHome(async (h) => {
      clearOrcaAgentCache()
      await seedDb(h, [
        { id: ID_TARGET, title: 'Target chat' },
        { id: ID_SENDER, title: 'Sender chat' },
      ])
      const { procs, orcaAgents } = twoChats(h)
      const rt = await createRuntime({
        env: { ...h.env, [ORCA_STRUCTURED_VAR]: '1', [ORCA_AGENT_SESSION_VAR]: ORCA_SENDER },
        builtins,
      })

      let sendCalls = 0
      const runOrcaSend: NonNullable<MessageDeps['runOrcaSend']> = async () => {
        sendCalls++
        return { exitCode: 0, stdout: '{"ok":true}' }
      }

      // WHY: 1st scan selects pid 501 at START; 2nd scan (deliverAgy pre-send) sees pid 501 reused with new startMs (ADR-0088).
      let scanCount = 0
      const reusedProcs: LiveSessionDeps = {
        ...procs,
        processes: async () => {
          scanCount++
          const base = await procs.processes()
          if (scanCount === 1) return base
          return base.map((p) => (p.pid === 501 ? { ...p, startMs: START + 1_000 } : p))
        },
      }
      const reused = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'pid reused' },
        { procs: reusedProcs, orcaAgents, selfPid: 601, runOrcaSend },
      )
      assert.equal(reused.status, 'paste-needed')
      assert.match(reused.note!, /changed since it was listed/)
      assert.equal(scanCount, 2)
      assert.equal(sendCalls, 0)

      // WHY: unreadable baseline startMs (NaN) during selection must fail closed with 0 Orca sends (ADR-0088).
      let missingScan = 0
      const missingStartProcs: LiveSessionDeps = {
        ...procs,
        processes: async () => {
          missingScan++
          const base = await procs.processes()
          if (missingScan === 1) return base.map((p) => (p.pid === 501 ? { ...p, startMs: Number.NaN } : p))
          return base
        },
      }
      const missing = await sendMessage(
        rt,
        ID_TARGET,
        { text: 'missing startMs' },
        { procs: missingStartProcs, orcaAgents, selfPid: 601, runOrcaSend },
      )
      assert.equal(missing.status, 'paste-needed')
      assert.match(missing.note!, /could not verify .*process identity/)
      assert.equal(sendCalls, 0)
    })
  })
})
