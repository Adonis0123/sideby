// Entry for `sideby handoff-hook <family> <event>` (spec §3.17). A Host runs it on PostToolUse, Stop and
// StopFailure, so it imports only Node built-ins and leaf modules: never the Runtime, a Family index or
// core/accounts.ts. It never fails the Host: any problem means no output and exit 0.
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BRIEF_DONE,
  FILES,
  HANDOFF_ENV,
  type PlanFile,
  type ReadyFile,
  type RunState,
  readJsonFile,
  writeJsonFile,
} from '../core/handoff-chain.ts'
import { claudeHookReader } from '../families/claude/handoff-hook.ts'
import { codexHookReader } from '../families/codex/handoff-hook.ts'
import { grokHookReader } from '../families/grok/handoff-hook.ts'
import type { Env, HandoffHookEvent } from '../types.ts'
import { crossedWindow, firstMark, fullestWindow, recordTurn } from './levels.ts'
import {
  endTurnMessage,
  notifySequence,
  prepareMessage,
  sessionStartMessage,
  stopMessage,
  thresholdMessage,
  waitNotice,
} from './messages.ts'
import { field, type HookInput, type HookReader } from './reader.ts'

export const HOOK_COMMAND = 'sideby handoff-hook'

const READERS: Record<string, HookReader> = {
  claude: claudeHookReader,
  codex: codexHookReader,
  grok: grokHookReader,
}

/** Families whose hooks this entry understands; only they can start a Handoff. */
export const HOOK_FAMILIES: readonly string[] = Object.keys(READERS)

const EVENTS = new Set<string>(['SessionStart', 'PostToolUse', 'Stop', 'StopFailure'])

async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const chunks: Buffer[] = []
  try {
    for await (const c of stream) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c))
  } catch {
    // keep what arrived
  }
  return Buffer.concat(chunks).toString('utf8')
}

const contextOutput = (text: string, hookEventName: 'SessionStart' | 'PostToolUse' = 'PostToolUse') => ({
  hookSpecificOutput: { hookEventName, additionalContext: text },
})
const blockOutput = (reason: string) => ({ decision: 'block', reason })

/** The session's Brief was written after `since` and ends finished (`BRIEF_DONE`, ADR-0032). */
async function briefFinished(path: string, since: number): Promise<boolean> {
  try {
    if ((await stat(path)).mtimeMs <= since) return false
    return (await readFile(path, 'utf8')).includes(BRIEF_DONE)
  } catch {
    return false
  }
}

/** What one hook call decided: output for the Host, and files to write. Separate from I/O for the tests. */
export async function decide(opts: {
  family: string
  event: HandoffHookEvent
  input: HookInput
  env: Env
  now: Date
}): Promise<{ output?: unknown }> {
  const { family, event, input, env, now } = opts
  const runId = env[HANDOFF_ENV.run]
  const dir = env[HANDOFF_ENV.dir]
  const reader = READERS[family]
  // Not a run sideby started for a Handoff, or another Family's hook (Grok also runs Claude's settings hooks).
  if (!runId || !dir || env[HANDOFF_ENV.family] !== family || !reader) return {}

  const plan = await readJsonFile<PlanFile>(join(dir, FILES.plan))
  const usable = plan && plan.runId === runId ? plan : null
  const runFile = join(dir, FILES.run(runId))
  const state = (await readJsonFile<RunState>(runFile)) ?? {}
  const sessionId = field(input, 'session_id', 'sessionId')
  const transcriptPath = field(input, 'transcript_path', 'transcriptPath')
  const session = {
    ...(sessionId ? { sessionId } : {}),
    ...(transcriptPath ? { transcriptPath } : {}),
  }
  const save = (next: RunState) => writeJsonFile(runFile, { ...next, ...session })
  const readyFile = join(dir, FILES.ready)
  const ready = async (r: Omit<ReadyFile, 'runId' | 'at'>) => {
    if (await readJsonFile<ReadyFile>(readyFile)) return
    await writeJsonFile(readyFile, { runId, at: now.toISOString(), ...session, ...r })
  }

  // The session learns it may move the task on when the user asks; without this it tells the user to start the
  // other account by hand.
  if (event === 'SessionStart') {
    const ref = env.SIDEBY_ACCOUNT
    return ref && usable
      ? { output: contextOutput(sessionStartMessage(ref, usable.brief), 'SessionStart') }
      : {}
  }

  const threshold = usable?.threshold ?? 95
  const levels = usable ?? { prepareAt: 80, threshold }
  const windows = reader.windows ? await reader.windows(input, env, now) : null
  const pressure = windows ? Math.max(0, ...windows.map((w) => w.usedPercent)) : null
  const ref = env.SIDEBY_ACCOUNT ?? family
  const waiting = usable?.decision === 'wait' && usable.until ? usable.until : undefined
  let st = state
  const keep = async (next: RunState) => {
    st = next
    await save(next)
  }
  // Once per run, shown to the user (not the model): sideby will wait for the reset, and how to move on now.
  const waitOutput = async () => {
    if (!waiting || pressure === null || pressure < threshold || st.waitNoticeSentAt) return undefined
    await keep({ ...st, waitNoticeSentAt: now.toISOString() })
    return { systemMessage: waitNotice(ref, waiting, pressure) }
  }

  if (event === 'StopFailure') {
    if (!reader.limitHit?.(input, pressure, threshold)) return {}
    const window = windows ? fullestWindow(windows) : undefined
    await ready({ trigger: 'limit', ...(window ? { window } : {}) })
    // The Host keeps only `terminalSequence` of a StopFailure hook's output.
    return waiting ? { output: { terminalSequence: notifySequence(waitNotice(ref, waiting)) } } : {}
  }

  if (event === 'Stop') {
    // Grok also fires Stop when the session ends; only a finished turn counts.
    const reason = field(input, 'reason')
    if (reason && reason !== 'end_turn') return {}
    const request = await readJsonFile<ReadyFile>(join(dir, FILES.request))
    if (request && request.runId === runId) {
      await ready({ ...request, trigger: 'manual' })
      await rm(join(dir, FILES.request), { force: true })
      return {}
    }
    if (!usable) return {}
    // The turn that just ended joins the window's recent turns before anything is judged (ADR-0032).
    if (windows) await keep(recordTurn(st, windows))
    const notice = await waitOutput()
    if (notice) return { output: notice }
    const window = st.thresholdWindow ? { window: st.thresholdWindow } : {}
    if (st.thresholdSentAt && usable.agentBrief === false) {
      await ready({ trigger: 'threshold', ...window })
      return {}
    }
    if (st.thresholdSentAt) {
      if (await briefFinished(usable.brief, Date.parse(st.thresholdSentAt)))
        await ready({ trigger: 'threshold', brief: usable.brief, briefSource: 'agent', ...window })
      else if (!st.stopBlocked && input.stop_hook_active !== true && input.stopHookActive !== true) {
        await keep({ ...st, stopBlocked: true })
        return { output: blockOutput(stopMessage(usable.brief)) }
      } else await ready({ trigger: 'threshold', ...window })
      return {}
    }
    // A turn without tool calls: the level is first reached here.
    const crossed = windows ? crossedWindow(windows, levels, st) : undefined
    if (crossed && usable.decision === 'pick') {
      if (usable.agentBrief === false) {
        await ready({ trigger: 'threshold', window: crossed })
        return {}
      }
      await keep({ ...st, thresholdSentAt: now.toISOString(), thresholdWindow: crossed, stopBlocked: true })
      return { output: blockOutput(thresholdMessage(usable.brief, crossed)) }
    }
    return {}
  }

  // PostToolUse
  if (!usable || windows === null || pressure === null) return {}
  const first = firstMark(st, windows)
  if (first) await keep(first)
  const notice = await waitOutput()
  if (notice) return { output: notice }
  const crossed = crossedWindow(windows, levels, st)
  if (crossed && usable.decision === 'pick' && !st.thresholdSentAt) {
    await keep({ ...st, thresholdSentAt: now.toISOString(), thresholdWindow: crossed })
    const text =
      usable.agentBrief === false ? endTurnMessage(crossed) : thresholdMessage(usable.brief, crossed)
    return { output: contextOutput(text) }
  }
  if (usable.agentBrief === false) return {}
  const top = fullestWindow(windows)
  if (top && pressure >= usable.prepareAt && !st.prepareSentAt && !st.thresholdSentAt) {
    await keep({ ...st, prepareSentAt: now.toISOString() })
    return { output: contextOutput(prepareMessage(usable.brief, top)) }
  }
  return {}
}

export async function runHandoffHook(
  argv: readonly string[],
  env: Env,
  stdin: AsyncIterable<Uint8Array | string>,
  stdout: NodeJS.WritableStream,
): Promise<number> {
  // `sideby run` asks this first, so an older sideby on PATH without the hook entry is caught before any hook runs.
  if (argv[0] === '--check') {
    stdout.write('ok\n')
    return 0
  }
  try {
    const [family, event] = argv
    if (!family || !event || !EVENTS.has(event) || !env[HANDOFF_ENV.run]) return 0
    let input: unknown
    try {
      input = JSON.parse(await readAll(stdin))
    } catch {
      return 0
    }
    if (input === null || typeof input !== 'object' || Array.isArray(input)) return 0
    const r = await decide({
      family,
      event: event as HandoffHookEvent,
      input: input as HookInput,
      env,
      now: new Date(),
    })
    if (r.output) stdout.write(`${JSON.stringify(r.output)}\n`)
  } catch {
    // never fail the Host
  }
  return 0
}
