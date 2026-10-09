// The files one Handoff chain keeps under `<state>/handoffs/<chain>/` (spec §3.17). The handoff hook runs on every
// tool call, so this module imports only Node built-ins and leaf modules (never the Runtime or a Family index).
// The parent `sideby run` writes `plan.json` and `chain.json`; the hook writes `run-<id>.json` and `ready.json`;
// `sideby handoff ready` writes `request.json`. Every file is mode 600 in a mode 700 directory.
import { randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from './fs-safe.ts'

/** Environment sideby sets for a Host run that may start a Handoff. The hook does nothing without all three. */
export const HANDOFF_ENV = {
  run: 'SIDEBY_HANDOFF_RUN',
  family: 'SIDEBY_HANDOFF_FAMILY',
  dir: 'SIDEBY_HANDOFF_DIR',
} as const

export type HandoffTrigger = 'threshold' | 'limit' | 'manual'

/** What the parent decided the next Handoff would do, refreshed while the Host runs. */
export interface PlanFile {
  /** The run this plan is for; a plan left by an earlier hop of the chain is ignored. */
  runId: string
  /** Where this run's session writes its Handoff Brief. */
  brief: string
  at: string
  decision: 'pick' | 'wait' | 'none'
  pick?: string
  prepareAt: number
  threshold: number
  /** False when the session cannot write its Brief: no preparing step, and the threshold only ends the turn. */
  agentBrief?: boolean
}

/** What the hook already did in one run. */
export interface RunState {
  prepareSentAt?: string
  thresholdSentAt?: string
  stopBlocked?: boolean
  sessionId?: string
  transcriptPath?: string
}

/** The run is ready to hand off; written by the hook (`ready.json`), or asked for by `sideby handoff ready`. */
export interface ReadyFile {
  runId: string
  at: string
  trigger: HandoffTrigger
  /** The Brief file, when the session or the user wrote one. */
  brief?: string
  briefSource?: 'agent' | 'user'
  sessionId?: string
  transcriptPath?: string
}

export interface ChainHop {
  ref: string
  startedAt: string
  /** How this hop ended, when it handed off. */
  trigger?: HandoffTrigger
  briefSource?: 'agent' | 'sideby' | 'user'
  brief?: string
}

export interface ChainFile {
  hops: ChainHop[]
}

export const FILES = {
  plan: 'plan.json',
  ready: 'ready.json',
  request: 'request.json',
  chain: 'chain.json',
  run: (runId: string) => `run-${runId}.json`,
} as const

/** A short random id for a chain or a run: safe in file names and environment values. */
export function newId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`
}

export function chainDir(stateDir: string, chain: string): string {
  return join(stateDir, 'handoffs', chain)
}

/** Creates the chain directory (and its parents) and makes sure it is mode 700. */
export async function ensureChainDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await chmod(dir, 0o700)
}

/** `<dir>/<n>-<ref>.md`, with the ref's `:` made safe for file names (`claude:001` → `claude-001`). */
export function briefPath(dir: string, n: number, ref: string): string {
  return join(dir, `${n}-${ref.replace(/[^A-Za-z0-9._-]/g, '-')}.md`)
}

/** The parsed JSON object in `path`, or null when it is missing, unreadable or not a JSON object. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const v: unknown = JSON.parse(await readFile(path, 'utf8'))
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as T) : null
  } catch {
    return null
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, 0o600)
}

/**
 * `sideby handoff ready` (spec §3.17): asks the parent to hand over after this turn. Works only inside a run sideby
 * started with Auto Handoff; `briefFile`, when given, is copied into the chain directory (mode 600).
 * Returns the request, or null outside such a run.
 */
export async function requestHandoff(
  env: Readonly<Record<string, string | undefined>>,
  briefFile?: string,
): Promise<ReadyFile | null> {
  const runId = env[HANDOFF_ENV.run]
  const dir = env[HANDOFF_ENV.dir]
  if (!runId || !dir) return null
  let brief: string | undefined
  if (briefFile) {
    brief = join(dir, `user-${runId}.md`)
    await writeFileAtomic(brief, await readFile(briefFile), 0o600)
  }
  const request: ReadyFile = {
    runId,
    at: new Date().toISOString(),
    trigger: 'manual',
    ...(brief ? { brief, briefSource: 'user' as const } : {}),
  }
  await writeJsonFile(join(dir, FILES.request), request)
  return request
}
