// WHY: ADR-0088 optional Orca Chat delivery for Antigravity CLI. Direct delivery runs only for verified non-guessed
// local `agy acp` Chats after a pre-send drift check and caller Orca sender identity check; Panel, plain terminals,
// non-Orca `agy`, and guessed sessions fall back to store-first + `paste-needed`.
import { randomBytes } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedFolder, writeFileAtomic } from '../../core/fs-safe.ts'
import { hostArgs, runsHost } from '../../core/live-sessions-procs.ts'
import {
  classifyOrcaSend,
  normalizeOrcaSessionId,
  ORCA_AGENT_SESSION_VAR,
  ORCA_SEND_TIMEOUT_MS,
  ORCA_SESSION_PREFIX,
  ORCA_STRUCTURED_VAR,
  OrcaPreSendError,
  OrcaSendTimeout,
  orcaAgents,
  runOrcaSend,
} from '../../core/orca-chat.ts'
import { ORCA_HANDLE_VAR, orcaHandles, systemOrca } from '../../panel/orca.ts'
import type { Delivery, DeliveryRequest } from '../messaging.ts'
import { agyLiveSessions } from './live-sessions.ts'
import { classifyAgyArgs } from './mod.ts'

const AGY_SEND_DIR = 'agy-send'

async function verifyOrcaSender(req: DeliveryRequest): Promise<{ from?: string; note?: string }> {
  if (req.fromUser) {
    return {
      note: 'Messages sent from the Panel cannot deliver directly to an Orca Chat yet; paste the line into its chat tab',
    }
  }
  if (req.senderConflict) {
    return {
      note: 'sideby could not verify which session sent this message; paste the line into its tab',
    }
  }
  const { rt, deps } = req
  const callerAgentId = normalizeOrcaSessionId(rt.env[ORCA_AGENT_SESSION_VAR])
  if (callerAgentId) {
    if (req.from && !req.from.guessed && req.from.orcaSessionId === callerAgentId) {
      return { from: `${ORCA_SESSION_PREFIX}${callerAgentId}` }
    }
    const agents = await orcaAgents(rt.env, {
      ...(deps.orcaAgents ? { run: deps.orcaAgents } : {}),
      bypassCache: true,
    })
    if (agents?.has(callerAgentId)) {
      return { from: `${ORCA_SESSION_PREFIX}${callerAgentId}` }
    }
    return {
      note: 'sideby could not verify this Orca Chat sender; paste the line into its chat tab',
    }
  }
  const callerTerminal = rt.env[ORCA_HANDLE_VAR]?.trim()
  if (callerTerminal && rt.env[ORCA_STRUCTURED_VAR] !== '1') {
    const handles = deps.orcaHandles
      ? await deps.orcaHandles().catch(() => new Set<string>())
      : await orcaHandles(systemOrca(rt.env))
    if (handles.has(callerTerminal)) {
      return { from: callerTerminal }
    }
    return {
      note: 'sideby could not verify this Orca terminal sender; paste the line into its chat tab',
    }
  }
  return {
    note: 'Direct delivery to an Orca Chat requires running inside a verified Orca terminal or Chat; paste the line into its chat tab',
  }
}

export async function deliverAgy(req: DeliveryRequest): Promise<Delivery> {
  const { rt, to, acct, pid, procs, deps } = req
  const paste = (note: string): Delivery => ({ status: 'paste-needed', note })

  if (to.guessed) {
    return paste(
      `sideby could not tell which ${to.accountLabel} session is running. Paste the line into the right tab`,
    )
  }
  if (!to.orcaSessionId) {
    return paste(
      'Antigravity CLI cannot receive messages directly outside an Orca Chat; paste the line into its tab',
    )
  }

  const sender = await verifyOrcaSender(req)
  if (!sender.from) return paste(sender.note!)

  // WHY: pre-send best-effort drift check on target pid/procStart, ORCA_AGENT_SESSION_ID, active conversation_id and
  // title right before invoking Orca (ADR-0088).
  const freshProc = await procs.get(pid)
  if (!freshProc) {
    return paste(`${to.label} stopped running; start it again, then paste this line into its chat tab`)
  }
  if (req.targetProcStart === undefined || !Number.isFinite(req.targetProcStart)) {
    return paste(
      `sideby could not verify ${to.label}'s process identity before delivery; paste this line into its chat tab`,
    )
  }
  if (freshProc.startMs !== req.targetProcStart) {
    return paste(`${to.label} changed since it was listed; paste this line into its chat tab`)
  }
  const freshArgs = (await procs.argv(pid)) ?? hostArgs(freshProc.command)
  if (!runsHost(freshProc.command, 'agy') || classifyAgyArgs(freshArgs).subcommand !== 'acp') {
    return paste(`${to.label} is no longer an Orca Chat process; paste this line into its chat tab`)
  }
  const [structured, targetAgentEnv] = await Promise.all([
    procs.envVar(pid, ORCA_STRUCTURED_VAR).catch(() => undefined),
    procs.envVar(pid, ORCA_AGENT_SESSION_VAR).catch(() => undefined),
  ])
  if (structured !== '1' || normalizeOrcaSessionId(targetAgentEnv) !== to.orcaSessionId) {
    return paste(`${to.label} no longer matches its Orca Chat; paste this line into its chat tab`)
  }
  const freshSessions = await agyLiveSessions
    .read(acct, procs, [], {
      stateDir: rt.readContext().stateDir,
      env: rt.env,
      now: rt.readContext().now,
      ...(deps.orcaAgents ? { orcaAgents: deps.orcaAgents } : {}),
    })
    .catch(() => [])
  const current = freshSessions.find(
    (s) =>
      s.pid === pid && s.sessionId === to.sessionId && !s.guessed && s.orcaSessionId === to.orcaSessionId,
  )
  if (!current || (to.title && current.title && current.title !== to.title)) {
    return paste(`${to.label} switched conversations before delivery; paste this line into its chat tab`)
  }

  const sendDir = await ownedFolder(rt.readContext().stateDir, [AGY_SEND_DIR], {
    create: true,
    private: true,
  })
  if (!sendDir) {
    return paste('sideby could not prepare the message transport file; paste the line into its chat tab')
  }
  const bodyFile = join(sendDir, `body-${req.messageId}-${randomBytes(4).toString('hex')}.txt`)
  await writeFileAtomic(bodyFile, `${req.text}\n`, 0o600)

  const subject = (
    req.from
      ? `sideby message ${req.messageId} from ${req.from.accountLabel}`
      : `sideby message ${req.messageId}`
  )
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 80)

  const args = [
    'orchestration',
    'send',
    '--to',
    `${ORCA_SESSION_PREFIX}${to.orcaSessionId}`,
    '--from',
    sender.from,
    '--type',
    'status',
    '--subject',
    subject,
    '--body-file',
    bodyFile,
    '--json',
    '--full',
  ]

  let answer: { exitCode: number; stdout: string }
  try {
    answer = await (deps.runOrcaSend ?? runOrcaSend)(
      args,
      rt.env,
      deps.timeoutMs ?? ORCA_SEND_TIMEOUT_MS,
      deps.killGraceMs,
    )
  } catch (err) {
    if (err instanceof OrcaSendTimeout) {
      const ended = await req.ended()
      return {
        status: 'unknown',
        note: `sideby could not confirm that ${to.label} got it (${err.message}).${ended ? ' The session has ended since.' : ''} It may still show up; check the session before you send it again`,
      }
    }
    if (err instanceof OrcaPreSendError) {
      return paste(`sideby could not reach Orca (${err.message}); paste the line into its chat tab`)
    }
    const ended = await req.ended()
    return {
      status: 'unknown',
      note: `sideby could not confirm that ${to.label} got it (${(err as Error).message}).${ended ? ' The session has ended since.' : ''} It may still show up; check the session before you send it again`,
    }
  } finally {
    await rm(bodyFile, { force: true }).catch(() => {})
  }

  const outcome = classifyOrcaSend(answer)
  if (outcome.kind === 'delivered') {
    return outcome.warning ? { status: 'delivered', note: outcome.warning } : { status: 'delivered' }
  }
  if (outcome.kind === 'paste-needed') {
    return paste(`${outcome.reason}; paste the line into its chat tab`)
  }
  const ended = await req.ended()
  return {
    status: 'unknown',
    note: `sideby could not confirm that ${to.label} got it (${outcome.reason}).${ended ? ' The session has ended since.' : ''} It may still show up; check the session before you send it again`,
  }
}
