// What the Panel's Auto Handoff page shows (spec §3.17 "页面与一键开启"): where each account's work would go next and
// the last hand-overs. Reads only; from the chain files it takes the accounts, times and triggers, never a Brief.
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HOOK_FAMILIES } from '../handoff/hook.ts'
import type { Runtime } from '../runtime.ts'
import type { HandoffSettings } from './config.ts'
import { type ChainFile, FILES, type HandoffTrigger, readJsonFile } from './handoff-chain.ts'
import type { HandoffDecision } from './handoff-select.ts'

const SCAN_CHAINS = 40
const RECENT = 5

export interface RecentHandoff {
  from: string
  to: string
  /** When the next account started. */
  at: string
  trigger: HandoffTrigger | null
  briefSource: 'agent' | 'sideby' | 'user' | null
}

export interface HandoffOverview {
  settings: HandoffSettings
  /** Where each subscription account of a Family that can start a hand-over would send its work; empty while off. */
  takeover: { ref: string; family: string; decision: HandoffDecision }[]
  recent: RecentHandoff[]
}

/** The latest hand-overs, newest first: a hop that ended with a trigger and was followed by another hop. */
export async function readRecentHandoffs(stateDir: string, limit = RECENT): Promise<RecentHandoff[]> {
  const root = join(stateDir, 'handoffs')
  const names = await readdir(root).catch(() => [] as string[])
  const dirs = (
    await Promise.all(
      names.map(async (n) => ({ n, t: (await stat(join(root, n)).catch(() => null))?.mtimeMs ?? 0 })),
    )
  )
    .sort((a, b) => b.t - a.t)
    .slice(0, SCAN_CHAINS)
  const out: RecentHandoff[] = []
  for (const { n } of dirs) {
    const chain = await readJsonFile<ChainFile>(join(root, n, FILES.chain))
    const hops = Array.isArray(chain?.hops) ? chain.hops : []
    for (let i = 0; i + 1 < hops.length; i++) {
      const from = hops[i]!
      const to = hops[i + 1]!
      if (
        typeof from.ref !== 'string' ||
        typeof to.ref !== 'string' ||
        !Number.isFinite(Date.parse(to.startedAt))
      )
        continue
      out.push({
        from: from.ref,
        to: to.ref,
        at: to.startedAt,
        trigger: from.trigger ?? null,
        briefSource: from.briefSource ?? null,
      })
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit)
}

export async function handoffOverview(rt: Runtime): Promise<HandoffOverview> {
  const settings = rt.handoffSettings()
  const recent = await readRecentHandoffs(rt.paths.stateDir)
  if (!settings.auto) return { settings, takeover: [], recent }
  const starters = new Set(
    [...rt.families.values()]
      .filter((f) => f.handoff?.starts.length && HOOK_FAMILIES.includes(f.id))
      .map((f) => f.id),
  )
  const subs = (await rt.accounts()).filter((a) => starters.has(a.family) && a.kind === 'subscription')
  const takeover = await Promise.all(
    subs.map(async (a) => {
      let decision: HandoffDecision
      try {
        decision = await rt.handoffDecision(a, [a.ref])
      } catch (err) {
        decision = { kind: 'none', reason: (err as Error).message }
      }
      return { ref: a.ref, family: a.family, decision }
    }),
  )
  return { settings, takeover, recent }
}
