// `sideby handoff status|enable|disable` (spec §3.17 "交给 AI 开启"): what Auto Handoff still needs on this machine,
// and the one config change that turns it on or off. Status only reads; enable and disable write the `handoff` key.
import { join } from 'node:path'
import { HOOK_FAMILIES } from '../handoff/hook.ts'
import type { Runtime } from '../runtime.ts'
import { editConfigHandoff, type HandoffConfig, type HandoffSettings, handoffSettings } from './config.ts'
import { UserError } from './errors.ts'
import { ensureChainDir, readJsonFile, writeJsonFile } from './handoff-chain.ts'
import { hookEntryWorks } from './handoff-run.ts'
import { sidebyBinProblem } from './launch.ts'
import { quotaPressure } from './quota-levels.ts'

export interface HandoffFamilyStatus {
  family: string
  /** What the Family can start; empty when it can only take over. */
  starts: ('quota' | 'limit')[]
  /** Whether sessions of this Family can start a Handoff now. */
  ready: boolean
  /** What keeps it from starting one; each has a matching entry in `nextSteps`. */
  problems: string[]
  /** Worth knowing, but not in the way. */
  notes: string[]
  order: { policy: 'pressure' | 'order'; order: string[]; unknown: string[] }
}

export interface HandoffStatus {
  auto: boolean
  sameFamily: boolean
  prepareAt: number
  threshold: number
  sideby: { ok: boolean; problem?: string }
  families: HandoffFamilyStatus[]
  /** Commands still to run, in order. Setup commands show their change first (exit 10). */
  nextSteps: string[]
}

export async function handoffStatus(rt: Runtime): Promise<HandoffStatus> {
  const s = rt.handoffSettings()
  const accounts = await rt.accounts()
  const aliases = Object.fromEntries(
    Object.entries(rt.config.aliases ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : v.account]),
  )
  const refs = new Set(accounts.map((a) => a.ref))
  const binProblem =
    (await sidebyBinProblem(rt.env, 'the Host runs `sideby handoff-hook` for Auto Handoff')) ??
    ((await hookEntryWorks(rt.env))
      ? undefined
      : 'the sideby on PATH is older than this one and has no `handoff-hook`; upgrade it with `npm i -g sideby`')
  const steps: string[] = []
  if (!s.auto) steps.push('sideby handoff enable')
  if (binProblem) steps.push('npm i -g sideby')

  const families: HandoffFamilyStatus[] = []
  for (const f of rt.families.values()) {
    if (!accounts.some((a) => a.family === f.id)) continue
    const builtIn = HOOK_FAMILIES.includes(f.id)
    const starts = f.handoff && builtIn ? [...f.handoff.starts] : []
    const problems: string[] = []
    const notes: string[] = []
    if (!f.handoff) notes.push(`${f.title} takes no part in Auto Handoff`)
    else if (!starts.length)
      notes.push(
        builtIn || !f.handoff.starts.length
          ? `${f.title} can only take over, never start a handoff`
          : `${f.title} comes from a plugin, so it can only take over for now`,
      )
    if (starts.includes('quota') && f.quotaSetup) {
      const plan = await rt
        .quotaSetup(f.id)
        .plan()
        .catch(() => null)
      if (plan?.status !== 'enabled') {
        problems.push(`${f.title} reports no quota to sideby yet`)
        steps.push(`sideby quota setup ${f.id}`)
      }
    }
    if (starts.length && f.handoff?.hookSetup) {
      const plan = await rt
        .handoffSetup(f.id)
        .plan()
        .catch(() => null)
      if (plan?.status !== 'enabled') {
        problems.push(`${f.title} has no sideby hook file yet`)
        steps.push(`sideby handoff setup ${f.id}`, `sideby doctor ${f.id} --fix`)
      }
    }
    if (f.id === 'codex' && starts.length)
      notes.push('each Codex account asks once to trust sideby’s hooks: type /hooks in Codex and trust them')
    if (f.id === 'grok' && starts.length)
      notes.push(
        'the `workspace` and `read-only` sandboxes can only take over; `strict` and custom ones take no part',
      )
    const fam = s.families[f.id] ?? { policy: 'pressure' as const, order: [] }
    const unknown = fam.order.filter((n) => !refs.has(aliases[n] ?? n))
    if (fam.policy === 'order' && fam.order.length === 0) {
      problems.push(`handoff.families.${f.id} has policy "order" but lists no account`)
      steps.push(`sideby handoff enable --order ${f.id}=<account,account>`)
    }
    if (unknown.length)
      notes.push(`order names ${unknown.join(', ')}, which sideby cannot find; they are skipped`)
    families.push({
      family: f.id,
      starts,
      ready: s.auto && !binProblem && starts.length > 0 && problems.length === 0,
      problems,
      notes,
      order: { policy: fam.policy, order: fam.order, unknown },
    })
  }
  return {
    auto: s.auto,
    sameFamily: s.sameFamily,
    prepareAt: s.prepareAt,
    threshold: s.threshold,
    sideby: binProblem ? { ok: false, problem: binProblem } : { ok: true },
    families,
    nextSteps: steps,
  }
}

/** One `handoff` change; fields left out keep their value. The Panel and the CLI send the same shape. */
export interface HandoffChange {
  auto?: boolean
  sameFamily?: boolean
  prepareAt?: number
  threshold?: number
  waitIfResetWithinMinutes?: number
  countdownSeconds?: number
  /** Handoff Orders by Family; an empty list sends that Family back to ranking by quota. */
  orders?: { family: string; order: string[] }[]
}

/** A line diff of two small texts: unchanged lines start with two spaces, removed with `- `, added with `+ `. */
export function lineDiff(before: string, after: string): string {
  const a = before.split('\n')
  const b = after.split('\n')
  // Longest common subsequence table; the settings block is a few dozen lines at most.
  const lcs = a.map(() => new Array<number>(b.length + 1).fill(0))
  lcs.push(new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(`  ${a[i]}`)
      i++
      j++
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push(`- ${a[i]}`)
      i++
    } else {
      out.push(`+ ${b[j]}`)
      j++
    }
  }
  return out.join('\n')
}

const pretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2)

/**
 * Shows, or with `apply` writes, the `handoff` change (spec §3.17). Every other setting stays. Names in `order`
 * must resolve to an Account.
 */
export async function configureHandoff(
  rt: Runtime,
  change: HandoffChange,
  opts: { apply: boolean },
): Promise<{ changed: boolean; applied: boolean; file: string; diff: string; settings: HandoffSettings }> {
  const known = [...(await rt.accounts()).map((a) => a.ref), ...Object.keys(rt.config.aliases ?? {})]
  for (const { family, order } of change.orders ?? []) {
    if (!rt.families.has(family))
      throw new UserError(`unknown family "${family}"; available: ${[...rt.families.keys()].join(', ')}`)
    const missing: string[] = []
    for (const name of order) await rt.resolve(name).catch(() => missing.push(name))
    if (missing.length)
      throw new UserError(
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not an account or short command; use one of: ${known.join(', ')}`,
        { code: 'unknown-account' },
      )
  }
  const edit = (current: HandoffConfig): HandoffConfig => {
    const next: HandoffConfig = { ...current }
    for (const k of [
      'auto',
      'sameFamily',
      'prepareAt',
      'threshold',
      'waitIfResetWithinMinutes',
      'countdownSeconds',
    ] as const)
      if (change[k] !== undefined) (next as Record<string, unknown>)[k] = change[k]
    if (change.orders?.length) {
      const families = { ...(current.families ?? {}) }
      for (const { family, order } of change.orders)
        if (order.length) families[family] = { policy: 'order', order: [...order] }
        else delete families[family]
      next.families = families
    }
    return next
  }
  const file = rt.paths.configFile
  const r = await editConfigHandoff(file, edit, { dryRun: !opts.apply })
  return {
    changed: r.changed,
    applied: r.changed && opts.apply,
    file,
    diff: r.changed
      ? `--- ${join('sideby', 'config.json')} (handoff)\n${lineDiff(pretty(r.before), pretty(r.after))}\n`
      : '',
    settings: handoffSettings({ handoff: r.after }),
  }
}

const HINT_EVERY_MS = 24 * 60 * 60 * 1000

/**
 * After a session ends with Auto Handoff off: one line pointing at it when the Account's quota passed the threshold
 * and its Family could start a Handoff; at most once a day. Null when there is nothing to say.
 */
export async function handoffHint(rt: Runtime, ref: string): Promise<string | null> {
  const s = rt.handoffSettings()
  if (s.auto) return null
  try {
    const account = await rt.resolve(ref)
    if (!rt.families.get(account.family)?.handoff?.starts.length || !HOOK_FAMILIES.includes(account.family))
      return null
    const pressure = quotaPressure(await rt.quota(account), new Date())
    if (pressure === null || pressure < s.threshold) return null
    const file = join(rt.paths.stateDir, 'handoff', 'hint.json')
    const last = (await readJsonFile<{ at?: string }>(file))?.at
    if (last && Date.now() - Date.parse(last) < HINT_EVERY_MS) return null
    await ensureChainDir(join(rt.paths.stateDir, 'handoff'))
    await writeJsonFile(file, { at: new Date().toISOString() })
    return `${account.ref} is at ${Math.round(pressure)}%. Sessions can hand their task to another account by themselves when quota runs low (off by default): see \`sideby handoff status\`.`
  } catch {
    return null
  }
}
