// Turning Auto Handoff on in one step (spec §3.17 "页面与一键开启", ADR-0013): the Panel's button does what the CLI's
// `handoff enable`, `quota setup` and `handoff setup` do, shown first as one plan and applied together after one
// confirmation. Every step is an existing, reversible setup; nothing new is written.
import type { Runtime } from '../runtime.ts'
import { configureHandoff, type HandoffStatus, handoffStatus } from './handoff-status.ts'

export interface EnableStep {
  /** `config`: the `handoff` key; `quota`: the Family's quota display; `hook`: its hook file; `copy`: the hook file to the other Accounts. */
  id: 'config' | 'quota' | 'hook' | 'copy'
  family?: string
  /** The file the step changes; `copy` names the Family's Accounts instead. */
  file?: string
  diff?: string
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
}

export interface EnableResult {
  plan: EnablePlan
  results: { id: EnableStep['id']; family?: string; ok: boolean; message: string }[]
  /** What is still missing after the steps. */
  status: HandoffStatus
}

export async function planHandoffEnable(
  rt: Runtime,
  opts: { sameFamily?: boolean } = {},
): Promise<EnablePlan> {
  const st = await handoffStatus(rt)
  if (st.sideby.problem) return { alreadyOn: false, blocked: st.sideby.problem, steps: [], manual: [] }
  const steps: EnableStep[] = []
  const manual: EnableManual[] = []
  const cfg = await configureHandoff(
    rt,
    { auto: true, ...(opts.sameFamily ? { sameFamily: true } : {}) },
    { apply: false },
  )
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
      if (plan?.status === 'ready') {
        steps.push({ id: 'hook', family: f.family, file: plan.file, diff: plan.diff })
        steps.push({ id: 'copy', family: f.family })
      } else if (plan?.status === 'blocked')
        manual.push({ id: 'setup-blocked', family: f.family, message: plan.message })
    }
    if (f.family === 'codex') manual.push({ id: 'codex-trust', family: 'codex' })
  }
  return { alreadyOn: steps.length === 0, steps, manual }
}

/** Applies the plan in an order where "on" means "working": the setups first, the config key last. Stops at the first failure. */
export async function applyHandoffEnable(
  rt: Runtime,
  opts: { sameFamily?: boolean } = {},
): Promise<EnableResult> {
  const plan = await planHandoffEnable(rt, opts)
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
          const r = await rt.doctorWithHistory({ fix: true, target: step.family! })
          const left = r.report.accounts
            .flatMap((a) => a.findings)
            .filter((f) => f.code === 'copy.stale').length
          ok = left === 0
          message = left ? `${left} account(s) still miss the hook file` : ''
        } else {
          const r = await configureHandoff(
            rt,
            { auto: true, ...(opts.sameFamily ? { sameFamily: true } : {}) },
            { apply: true },
          )
          ok = r.applied || !r.changed
        }
      } catch (err) {
        ok = false
        message = (err as Error).message
      }
      results.push({ id: step.id, ...(step.family ? { family: step.family } : {}), ok, message })
      if (!ok) break
    }
  }
  return { plan, results, status: await handoffStatus(rt) }
}
