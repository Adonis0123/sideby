// Turning Auto Handoff on in one step (spec §3.17 "页面与一键开启", ADR-0013): the Panel's button does what the CLI's
// `handoff enable`, `quota setup` and `handoff setup` do, shown first as one plan and applied together after one
// confirmation. Every step is an existing, reversible setup; nothing new is written.
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative } from 'node:path'
import type { Runtime } from '../runtime.ts'
import { realpathOrNull, writeFileAtomic } from './fs-safe.ts'
import { configureHandoff, handoffStatus } from './handoff-status.ts'

export interface EnableStep {
  /** `config`: the `handoff` key; `quota`: the Family's quota display; `hook`: its hook file; `copy`: only that hook file, into the other Accounts of the Family. */
  id: 'config' | 'quota' | 'hook' | 'copy'
  family?: string
  /** The file the step changes; for `copy`, the file that is copied. */
  file?: string
  diff?: string
  /** For `copy`: the Accounts that get the file. */
  accounts?: string[]
}

export interface EnableManual {
  /** `codex-trust`: each Codex account trusts the hooks once, in `/hooks`; `setup-blocked`: a setup that cannot be applied. */
  id: 'codex-trust' | 'setup-blocked'
  family?: string
  message?: string
}

export interface EnablePlan {
  /** Everything is already in place; nothing would be written. */
  alreadyOn: boolean
  /** Why nothing can be done from here (the sideby on PATH does not answer hooks); a person has to fix it first. */
  blocked?: string
  steps: EnableStep[]
  manual: EnableManual[]
  /** Same-Family hand-over as it will be once the plan is applied. */
  sameFamily: boolean
  /** Names this plan; a confirmation that sends it back as `expect` applies only this plan. */
  key: string
}

export interface EnableResult {
  plan: EnablePlan
  results: { id: EnableStep['id']; family?: string; accounts?: string[]; ok: boolean; message: string }[]
  /** The plan is no longer the one that was shown (`expect`), so nothing was written; `plan` is the new one. */
  changed?: boolean
}

const keyOf = (p: Omit<EnablePlan, 'key'>) =>
  createHash('sha256')
    .update(JSON.stringify([p.blocked ?? null, p.sameFamily, p.steps]))
    .digest('hex')
    .slice(0, 16)

/** Whether `rel` below `dir` goes through a link: a file seen through one is already there, or is not ours to change. */
async function throughLink(dir: string, rel: string): Promise<boolean> {
  let at = dir
  for (const part of rel.split('/')) {
    at = join(at, part)
    const st = await lstat(at).catch(() => null)
    if (!st) return false
    if (st.isSymbolicLink()) return true
  }
  return false
}

/**
 * The other Accounts of the Family that lack the hook file `file` (a path in the Main Account) at the same place in
 * their own directory. Only that one file is ever written, and one that is already there is left as it is: an
 * Account's other files are never touched.
 */
async function hookCopies(
  rt: Runtime,
  family: string,
  file: string,
): Promise<{ ref: string; target: string }[]> {
  const accounts = (await rt.accounts()).filter((a) => a.family === family)
  const main = accounts.find((a) => a.isMain)
  if (!main) return []
  const rel = relative(main.dir, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return []
  const mainReal = await realpathOrNull(main.dir)
  const out: { ref: string; target: string }[] = []
  for (const a of accounts) {
    if (a.isMain || (await realpathOrNull(a.dir)) === mainReal || (await throughLink(a.dir, rel))) continue
    const target = join(a.dir, rel)
    // Whether the file is there, not whether it can be read: one that cannot be read is still not ours to replace.
    const have = await lstat(target).then(
      () => true,
      () => false,
    )
    // A file that is already there is not ours to replace, whatever it says.
    if (!have) out.push({ ref: a.ref, target })
  }
  return out
}

/** `sameFamily` left out keeps the current setting; Turn on from the Panel says it either way. */
const changeOf = (opts: { sameFamily?: boolean }) => ({
  auto: true as const,
  ...(opts.sameFamily === undefined ? {} : { sameFamily: opts.sameFamily }),
})

export async function planHandoffEnable(
  rt: Runtime,
  opts: { sameFamily?: boolean } = {},
): Promise<EnablePlan> {
  const st = await handoffStatus(rt)
  if (st.sideby.problem) {
    const plan = {
      alreadyOn: false,
      blocked: st.sideby.problem,
      steps: [],
      manual: [],
      sameFamily: st.sameFamily,
    }
    return { ...plan, key: keyOf(plan) }
  }
  const steps: EnableStep[] = []
  const manual: EnableManual[] = []
  const cfg = await configureHandoff(rt, changeOf(opts), { apply: false })
  if (cfg.changed) steps.push({ id: 'config', file: cfg.file, diff: cfg.diff })
  for (const f of st.families) {
    if (!f.starts.length) continue
    const def = rt.families.get(f.family)
    if (def?.quotaSetup && f.starts.includes('quota')) {
      const plan = await rt
        .quotaSetup(f.family)
        .plan()
        .catch(() => null)
      if (plan?.status === 'ready')
        steps.push({ id: 'quota', family: f.family, file: plan.file, diff: plan.diff })
      else if (plan?.status === 'blocked')
        manual.push({ id: 'setup-blocked', family: f.family, message: plan.message })
    }
    if (def?.handoff?.hookSetup) {
      const plan = await rt
        .handoffSetup(f.family)
        .plan()
        .catch(() => null)
      if (plan?.status === 'ready')
        steps.push({ id: 'hook', family: f.family, file: plan.file, diff: plan.diff })
      else if (plan?.status === 'blocked')
        manual.push({ id: 'setup-blocked', family: f.family, message: plan.message })
      if (plan?.status === 'ready' || plan?.status === 'enabled') {
        const copies = await hookCopies(rt, f.family, plan.file)
        if (copies.length)
          steps.push({ id: 'copy', family: f.family, file: plan.file, accounts: copies.map((c) => c.ref) })
      }
    }
    if (f.family === 'codex') manual.push({ id: 'codex-trust', family: 'codex' })
  }
  const plan = { alreadyOn: steps.length === 0, steps, manual, sameFamily: cfg.settings.sameFamily }
  return { ...plan, key: keyOf(plan) }
}

/**
 * Applies the plan in an order where "on" means "working": the setups first, the config key last. Stops at the first
 * failure. With `expect`, writes nothing unless the plan is still the one that was shown.
 */
export async function applyHandoffEnable(
  rt: Runtime,
  opts: { sameFamily?: boolean; expect?: string } = {},
): Promise<EnableResult> {
  const plan = await planHandoffEnable(rt, opts)
  if (opts.expect !== undefined && opts.expect !== plan.key) return { plan, results: [], changed: true }
  const results: EnableResult['results'] = []
  if (!plan.blocked) {
    const order = ['quota', 'hook', 'copy', 'config'] as const
    const todo = [...plan.steps].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    for (const step of todo) {
      let ok = true
      let message = ''
      try {
        if (step.id === 'quota' || step.id === 'hook') {
          const setup = step.id === 'quota' ? rt.quotaSetup(step.family!) : rt.handoffSetup(step.family!)
          const r = await setup.apply()
          ok = r.status === 'enabled'
          message = r.message
        } else if (step.id === 'copy') {
          const file = step.file!
          const want = await readFile(file, 'utf8')
          const mode = (await stat(file)).mode & 0o777
          const listed = new Set(step.accounts)
          const copies = (await hookCopies(rt, step.family!, file)).filter((c) => listed.has(c.ref))
          for (const c of copies) {
            await mkdir(dirname(c.target), { recursive: true })
            await writeFileAtomic(c.target, want, mode)
          }
          const left = await hookCopies(rt, step.family!, file)
          ok = left.length === 0
          message = left.length
            ? `${left.map((c) => c.ref).join(', ')} still lack ${file}; try again, and if it keeps failing, check that you may write to their hooks folder`
            : ''
        } else {
          const r = await configureHandoff(rt, changeOf(opts), { apply: true })
          ok = r.applied || !r.changed
        }
      } catch (err) {
        ok = false
        message = (err as Error).message
      }
      results.push({
        id: step.id,
        ...(step.family ? { family: step.family } : {}),
        ...(step.accounts ? { accounts: step.accounts } : {}),
        ok,
        message,
      })
      if (!ok) break
    }
  }
  return { plan, results }
}
