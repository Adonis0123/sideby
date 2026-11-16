// Entry for `sideby progress-hook claude <event>` (spec §3.42, ADR-0076): Progress Reminders. Claude Code runs it in
// the background after every turn (`Stop`, `asyncRewake`) and on every prompt (`UserPromptSubmit`, `async`) in a
// session sideby started while config `progress.every` is set. It imports only Node built-ins and leaf modules: never
// the Runtime, a Family index or core/accounts.ts. It never fails the Host: any problem means no output and exit 0.
//
// `UserPromptSubmit` keeps when the session's latest prompt came, a hash of its id, and whether it was a reminder's
// wake-up. `Stop` watches while the session waits on background work: every `every` minutes it wakes the session with
// exit 2 and asks the model to tell the user what it waits for, then end its turn. It ends without a word when a later
// `Stop` took over, a new turn began (told by the prompt's id), the Host is gone, the setting was turned off or Auto
// Handoff is handing over, and it stays quiet while the session is unattended (ADR-0075). A reminder Network Guard
// held and delivered later still counts as a reminder.
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { FILES, HANDOFF_ENV, type ReadyFile, type RunState, readJsonFile } from '../core/handoff-chain.ts'
import { resolvePaths } from '../core/paths.ts'
import {
  hashOf,
  progressReminderTurn,
  readProgressEvery,
  readPromptRecord,
  readWatch,
  writePromptRecord,
  writeWatch,
} from '../core/progress-state.ts'
import { PROGRESS_MARK, progressWakeUp } from '../core/prompt-origin.ts'
import { sessionUnattended } from '../core/unattended-attended.ts'
import { UNATTENDED_ENV } from '../core/unattended-state.ts'

type Env = Record<string, string | undefined>

/** How often a watch looks whether it is still wanted. */
export const CHECK_EVERY_MS = 60_000
/** A watch ends by itself after this long, under the five-hour `timeout` Claude Code gives the hook. */
export const WATCH_FOR_MS = (4 * 60 + 55) * 60_000
const STDIN_MAX = 8 * 1024 * 1024
/** Input that has not ended after this long is not waited for: the hook then does nothing. */
const STDIN_WAIT_MS = 5000
/** Background tasks named in a reminder, and the most of each description. */
const TASKS_NAMED = 5
const DESCRIPTION_MAX = 80

export interface ProgressHookDeps {
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  /** Whether the Host that started the hook is gone; by default, whether this process's parent changed. */
  parentGone?: () => boolean
  /** This watch's id; random by default. */
  id?: string
  checkEveryMs?: number
}

type Input = AsyncIterable<string | Uint8Array> | string

async function readInput(input: Input): Promise<string> {
  if (typeof input === 'string') return input
  const read = (async () => {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of input) {
      const b = Buffer.from(chunk)
      size += b.length
      if (size > STDIN_MAX) return ''
      chunks.push(b)
    }
    return Buffer.concat(chunks).toString('utf8')
  })()
  read.catch(() => {})
  // A Host that never ends the input must not keep the hook waiting.
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      ;(input as { destroy?: () => unknown }).destroy?.()
      resolve('')
    }, STDIN_WAIT_MS)
  })
  try {
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}

async function parseInput(input: Input): Promise<Record<string, unknown> | undefined> {
  try {
    const v = JSON.parse(await readInput(input)) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const iso = (ms: number) => new Date(ms).toISOString()

/** Notes the session's latest prompt: when, a hash of its id, and whether it is a reminder's wake-up. */
async function notePrompt(env: Env, input: Input, now: Date): Promise<void> {
  const v = await parseInput(input)
  if (!v || v.agent_id !== undefined) return
  const sessionId = str(v.session_id)
  const promptId = str(v.prompt_id)
  if (!sessionId || !promptId) return
  const paths = resolvePaths(env)
  if ((await readProgressEvery(paths.configFile, env)) === undefined) return
  const prompt = typeof v.prompt === 'string' ? v.prompt : ''
  await writePromptRecord(
    paths.stateDir,
    sessionId,
    { at: now.toISOString(), prompt: hashOf(promptId), reminder: progressWakeUp(prompt) },
    now,
  )
}

/** One line of text from the Host: no control characters or quotes, runs of space as one, at most `max` characters. */
function clean(s: string, max: number): string {
  const one = [...s]
    .map((ch) => (ch < ' ' || ch === '\u007f' || ch === '"' || ch === '`' ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/** The background tasks as the reminder names them: kind and description, never the command. */
export function taskList(tasks: readonly unknown[]): string {
  const named = tasks.slice(0, TASKS_NAMED).map((t) => {
    const r = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    const kind =
      r.type === 'shell'
        ? 'command'
        : r.type === 'subagent'
          ? 'subagent'
          : typeof r.type === 'string' && r.type
            ? clean(r.type, 20)
            : 'task'
    const what = typeof r.description === 'string' ? clean(r.description, DESCRIPTION_MAX) : ''
    return what ? `${kind} "${what}"` : kind
  })
  const more = tasks.length > TASKS_NAMED ? `; and ${tasks.length - TASKS_NAMED} more` : ''
  return `${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'}: ${named.join('; ')}${more}`
}

const hhmm = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * What the model is woken with. It starts with `PROGRESS_MARK`, names the clock time the wait began (so a reminder
 * Network Guard held and delivered late still makes sense), and asks for one or two sentences and the end of the turn.
 */
export function reminderMessage(o: {
  tasks: readonly unknown[]
  since: string
  now: Date
  every: number
}): string {
  const since = Date.parse(o.since)
  const minutes = Math.max(1, Math.round((o.now.getTime() - since) / 60_000))
  return [
    `${PROGRESS_MARK} you are waiting on background work (${taskList(o.tasks)}), since ${hhmm(since)}, ${minutes} ${minutes === 1 ? 'minute' : 'minutes'} as of this reminder.`,
    'Tell the user in one or two sentences what you are waiting for, how long it has been, and whether there is new output (look only if that is quick), then end your turn.',
    'Do not start new work or stop the tasks.',
    `sideby sends this every ${o.every} ${o.every === 1 ? 'minute' : 'minutes'} while background work runs; if the user asks how to stop it, the command is \`sideby progress off\`.`,
  ].join(' ')
}

/** Whether Auto Handoff of this session's run is handing over: the threshold was sent or the run is ready. */
async function handingOver(env: Env): Promise<boolean> {
  const runId = env[HANDOFF_ENV.run]
  const dir = env[HANDOFF_ENV.dir]
  if (!runId || !dir) return false
  if (await readJsonFile<ReadyFile>(join(dir, FILES.ready))) return true
  return Boolean((await readJsonFile<RunState>(join(dir, FILES.run(runId))))?.thresholdSentAt)
}

/**
 * The `Stop` watch (spec §3.42). Replaces the session's earlier watch first, then, while background work runs and the
 * setting is on, wakes the session every `progress.every` minutes with a reminder (exit 2). Ends with exit 0 when a
 * later `Stop` took over, the session's latest prompt is not the one this `Stop` ended, the parent is gone, the
 * setting is off, Auto Handoff is handing over, or time runs out. While the session is unattended a reminder is skipped and the wait starts again.
 */
export async function watchWhileWaiting(
  input: Record<string, unknown>,
  env: Env,
  deps: ProgressHookDeps = {},
): Promise<{ exit: 0 | 2; message?: string }> {
  const clock = deps.now ?? (() => new Date())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const startPpid = process.ppid
  const parentGone = deps.parentGone ?? (() => process.ppid !== startPpid || process.ppid === 1)
  const checkEvery = deps.checkEveryMs ?? CHECK_EVERY_MS
  const sessionId = str(input.session_id)
  if (!sessionId) return { exit: 0 }
  const promptId = str(input.prompt_id)
  const paths = resolvePaths(env)
  const start = clock().getTime()
  // The wait goes on across the turns reminders start; any other turn starts a new one.
  const prev = await readWatch(paths.stateDir, sessionId)
  const afterReminder = await progressReminderTurn(paths.stateDir, sessionId, promptId)
  const since = afterReminder && prev ? prev.since : iso(start)
  const id = deps.id ?? randomBytes(8).toString('hex')
  // Written first, so a watch left by an earlier Stop ends even when this one has nothing to watch.
  await writeWatch(paths.stateDir, sessionId, { id, since, at: iso(start) })
  const tasks = input.background_tasks
  if (!Array.isArray(tasks) || tasks.length === 0) return { exit: 0 }
  let every = await readProgressEvery(paths.configFile, env)
  if (every === undefined) return { exit: 0 }
  const ownPrompt = promptId ? hashOf(promptId) : undefined
  let base = start
  for (;;) {
    const wait = Math.min(checkEvery, Math.max(1000, base + every * 60_000 - clock().getTime()))
    await sleep(wait)
    const now = clock()
    const t = now.getTime()
    if (t - start >= WATCH_FOR_MS || parentGone()) return { exit: 0 }
    if ((await readWatch(paths.stateDir, sessionId))?.id !== id) return { exit: 0 }
    // The latest prompt is another one: a turn began after this Stop's, and its own Stop decides again. Compared by
    // the prompt's id, never by time: the next prompt's record can be written before this watch even starts. Only a
    // Stop without an id falls back to whether the record came after it.
    const p = await readPromptRecord(paths.stateDir, sessionId)
    if (p && (ownPrompt ? p.prompt !== ownPrompt : Date.parse(p.at) > start)) return { exit: 0 }
    // Read every time: turning it off, or another interval, reaches a running session.
    every = await readProgressEvery(paths.configFile, env)
    if (every === undefined) return { exit: 0 }
    if (await handingOver(env)) return { exit: 0 }
    if (t - base < every * 60_000) continue
    let quiet = true
    try {
      quiet = (
        await sessionUnattended({
          stateDir: paths.stateDir,
          configFile: paths.configFile,
          session: env[UNATTENDED_ENV] === '1',
          sessionId,
          now,
        })
      ).on
    } catch {
      // cannot tell: no reminder
    }
    if (quiet) {
      base = t
      continue
    }
    // Read once more just before waking, so a Stop that came meanwhile is never answered by this watch.
    const fresh = await readWatch(paths.stateDir, sessionId)
    if (fresh?.id !== id) return { exit: 0 }
    await writeWatch(paths.stateDir, sessionId, { ...fresh, wokeAt: now.toISOString() })
    return { exit: 2, message: reminderMessage({ tasks, since, now, every }) }
  }
}

export async function runProgressHook(
  argv: readonly string[],
  env: Env,
  input: Input,
  io: { err: { write(s: string): unknown } },
  deps: ProgressHookDeps = {},
): Promise<number> {
  const [family, event] = argv
  if (family !== 'claude') return 0
  try {
    if (event === 'UserPromptSubmit') {
      // In the background: its output and exit code change nothing, and it never holds a prompt back.
      await notePrompt(env, input, deps.now ? deps.now() : new Date())
      return 0
    }
    if (event !== 'Stop') return 0
    const v = await parseInput(input)
    if (!v) return 0
    const w = await watchWhileWaiting(v, env, deps)
    // Exit 2 wakes the session (asyncRewake), which hands stderr to the model.
    if (w.exit === 2 && w.message) {
      io.err.write(`${w.message}\n`)
      return 2
    }
  } catch {
    // never fail the Host
  }
  return 0
}
