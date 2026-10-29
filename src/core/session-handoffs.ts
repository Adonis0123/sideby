// Which Sessions an Auto Handoff chain passed a task through (spec §3.32 step 2, ADR-0057): each hop of a chain
// writes `run-<runId>.json` under `<state>/handoffs/<chain>/`, and run ids start with the time, so sorting them sorts
// the hops. Read-only and best effort: only the `sessionId` of run files is read (never a Brief or another chain
// file), a file that cannot be read or parsed is skipped, and nothing is written. Imports Node built-ins only.
import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One hop of a chain: its session, and when the hop started (the time its run id starts with). */
export interface HandoffHop {
  sessionId: string
  /** Milliseconds since the epoch, from the run id's base36 time; 0 when it has none. */
  at: number
}

/** The hops of one chain, oldest first. A resumed session handed over again starts a new chain. */
export type HandoffChain = readonly HandoffHop[]

/** A run file bigger than this is not a hop sideby wrote; it is skipped. */
const RUN_MAX_BYTES = 256 * 1024
const RUN_FILE = /^run-.+\.json$/

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function hopSession(file: string): Promise<string | undefined> {
  try {
    const st = await lstat(file)
    if (!st.isFile() || st.size > RUN_MAX_BYTES) return undefined
    const raw = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const id = (raw as { sessionId?: unknown }).sessionId
    return typeof id === 'string' && id ? id : undefined
  } catch {
    return undefined
  }
}

/** The time a run id starts with (`<base36 ms>-<hex>`, `newId` in handoff-chain.ts); 0 when it has none. */
function runTime(name: string): number {
  const t = Number.parseInt(name.slice('run-'.length).split('-')[0] ?? '', 36)
  return Number.isFinite(t) ? t : 0
}

/** Every Handoff chain under `<stateDir>/handoffs`, each its hops in run-id order; links are not followed. */
export async function readHandoffChains(stateDir: string): Promise<HandoffHop[][]> {
  const root = join(stateDir, 'handoffs')
  const chains: HandoffHop[][] = []
  for (const name of (await names(root)).sort()) {
    const dir = join(root, name)
    const st = await lstat(dir).catch(() => undefined)
    if (!st?.isDirectory()) continue
    const runs = (await names(dir)).filter((n) => RUN_FILE.test(n)).sort()
    const hops: HandoffHop[] = []
    for (const run of runs) {
      const sessionId = await hopSession(join(dir, run))
      // A session that keeps its hop over two run files (a resumed wait) is one hop.
      if (sessionId && sessionId !== hops[hops.length - 1]?.sessionId)
        hops.push({ sessionId, at: runTime(run) })
    }
    if (hops.length) chains.push(hops)
  }
  return chains
}

/**
 * The hops on one side of `sessionId`, following every chain that holds it and, through them, the chains of those
 * hops (a session resumed and handed over again starts a new chain). Each session once, at its latest hop time.
 */
function reach(chains: readonly HandoffChain[], sessionId: string, side: 'before' | 'after'): HandoffHop[] {
  const found = new Map<string, number>()
  const todo = [sessionId]
  for (let id = todo.pop(); id !== undefined; id = todo.pop())
    for (const chain of chains) {
      const i = chain.map((h) => h.sessionId).lastIndexOf(id)
      if (i === -1) continue
      for (const hop of side === 'before' ? chain.slice(0, i) : chain.slice(i + 1)) {
        if (hop.sessionId === sessionId) continue
        const seen = found.get(hop.sessionId)
        if (seen === undefined) todo.push(hop.sessionId)
        if (seen === undefined || hop.at > seen) found.set(hop.sessionId, hop.at)
      }
    }
  return [...found].map(([id, at]) => ({ sessionId: id, at }))
}

/** The session ids the task passed through before `sessionId`, oldest first; undefined when no chain led to it. */
export function earlierHops(chains: readonly HandoffChain[], sessionId: string): string[] | undefined {
  const hops = reach(chains, sessionId, 'before').sort((a, b) => a.at - b.at)
  return hops.length ? hops.map((h) => h.sessionId) : undefined
}

/** The same Sessions, each with `handedOverFrom` where a Handoff chain led to it. */
export function withHandoffs<T extends { sessionId: string }>(
  chains: readonly HandoffChain[],
  sessions: readonly T[],
): (T & { handedOverFrom?: string[] })[] {
  return sessions.map((s) => {
    const from = earlierHops(chains, s.sessionId)
    return from ? { ...s, handedOverFrom: from } : s
  })
}

/** The full session ids in any chain that `target` names: the id itself, or its first 8 or more characters. */
export function chainIdsMatching(chains: readonly HandoffChain[], target: string): string[] {
  const out = new Set<string>()
  for (const chain of chains)
    for (const { sessionId: id } of chain)
      if (id === target || (target.length >= 8 && id.startsWith(target))) out.add(id)
  return [...out]
}

/** The sessions the task passed to after `sessionId`, across every chain, the newest hop first. */
export function laterHops(chains: readonly HandoffChain[], sessionId: string): string[] {
  return reach(chains, sessionId, 'after')
    .sort((a, b) => b.at - a.at)
    .map((h) => h.sessionId)
}
