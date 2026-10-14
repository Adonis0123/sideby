// Model and effort per Account (spec §3.19, ADR-0014): what an Account starts with, and the one change sideby makes,
// to the model and effort arguments in the config's `accounts.<ref>.args`. No Host file is written.
import { join } from 'node:path'
import { MODEL_NAME } from '../families/shared/model-args.ts'
import type { Runtime } from '../runtime.ts'
import type { Account, ModelChoice } from '../types.ts'
import { editConfigAccounts } from './config.ts'
import { UserError } from './errors.ts'
import { lineDiff } from './handoff-status.ts'

/** Where a shown value comes from: sideby's own argument, the Host's config, or the last session. */
export type ChoiceSource = 'sideby' | 'host' | 'last'

export interface AccountModel {
  ref: string
  family: string
  /** Whether sideby can set it for this Account; when not, `reason` says why. */
  settable: boolean
  reason?: string
  efforts: string[]
  models: string[]
  sideby: ModelChoice
  host: ModelChoice
  last: ModelChoice
  model?: { value: string; from: ChoiceSource }
  effort?: { value: string; from: ChoiceSource }
}

function pick(
  key: keyof ModelChoice,
  sideby: ModelChoice,
  host: ModelChoice,
  last: ModelChoice,
): { value: string; from: ChoiceSource } | undefined {
  if (sideby[key]) return { value: sideby[key]!, from: 'sideby' }
  if (host[key]) return { value: host[key]!, from: 'host' }
  if (last[key]) return { value: last[key]!, from: 'last' }
  return undefined
}

/** `last` is the model and effort of the newest session, from the usage reader when the caller already has it. */
export async function accountModel(rt: Runtime, account: Account, last?: ModelChoice): Promise<AccountModel> {
  const f = rt.families.get(account.family)
  const mc = f?.modelChoice
  const base = {
    ref: account.ref,
    family: account.family,
    efforts: [],
    models: [],
    sideby: {},
    host: {},
    last: {},
  }
  if (!mc)
    return { ...base, settable: false, reason: `${f?.title ?? account.family} has no model choice in sideby` }
  let seen = last
  if (!seen) {
    const u = await rt.usage(account).catch(() => null)
    seen =
      u?.status === 'ok'
        ? {
            ...(u.lastModel ? { model: u.lastModel } : {}),
            ...(u.lastEffort ? { effort: u.lastEffort } : {}),
          }
        : {}
  }
  const sideby = mc.fromArgs(rt.config.accounts?.[account.ref]?.args ?? []).choice
  // An API account's model is the one its proxy.env names (the Family's `model` reader); the effort still comes from settings.
  const apiModel = account.kind === 'api' ? await f.model?.(account).catch(() => undefined) : undefined
  const configured = await mc.configured(account, sideby.model ?? apiModel, seen.model)
  const host = apiModel ? { ...configured, model: apiModel } : configured
  const models = [...new Set([...mc.models, ...(seen.model ? [seen.model] : [])])]
  const out: AccountModel = {
    ...base,
    settable: account.kind !== 'api',
    efforts: [...mc.efforts],
    models,
    sideby,
    host,
    last: seen,
  }
  if (account.kind === 'api') out.reason = 'an API account takes its model from proxy.env'
  const m = pick('model', sideby, host, seen)
  const e = pick('effort', sideby, host, seen)
  if (m) out.model = m
  if (e) out.effort = e
  return out
}

/** A change: `undefined` keeps what sideby sets now, `null` goes back to the Host's default. */
export interface ModelChange {
  model?: string | null
  effort?: string | null
}

const pretty = (v: unknown) => JSON.stringify(v ?? {}, null, 2)

/** Shows, or with `apply` writes, the change to the Account's model and effort arguments. */
export async function setAccountModel(
  rt: Runtime,
  account: Account,
  change: ModelChange,
  opts: { apply: boolean },
): Promise<{ changed: boolean; applied: boolean; file: string; diff: string; args: string[] }> {
  const f = rt.families.get(account.family)
  const mc = f?.modelChoice
  if (!mc)
    throw new UserError(`${f?.title ?? account.family} has no model choice in sideby`, {
      code: 'unsupported',
    })
  if (account.kind === 'api')
    throw new UserError(`${account.ref} is an API account: its model comes from proxy.env, so set it there`, {
      code: 'api-account',
    })
  if (typeof change.model === 'string' && !MODEL_NAME.test(change.model))
    throw new UserError(
      `"${change.model}" is not a model name sideby passes on: use letters, digits and . _ : / [ ] - only, for example ${mc.models[0] ?? 'gpt-5'}`,
      { code: 'bad-value' },
    )
  if (typeof change.effort === 'string' && !mc.efforts.includes(change.effort))
    throw new UserError(
      `"${change.effort}" is not an effort level for ${f!.title}; use one of: ${mc.efforts.join(', ')}, default`,
      {
        code: 'bad-value',
      },
    )
  let args: string[] = []
  const r = await editConfigAccounts(
    rt.paths.configFile,
    (current) => {
      const now = current[account.ref]?.args ?? []
      const unchanged = (list: string[]) => list.length === now.length && list.every((x, i) => x === now[i])
      const { choice, rest } = mc.fromArgs(now)
      const next: ModelChoice = { ...choice }
      for (const k of ['model', 'effort'] as const) {
        if (change[k] === null) delete next[k]
        else if (change[k] !== undefined) next[k] = change[k]!
      }
      // After a `--` everything is prompt text, so the choice goes in front of it.
      const dd = rest.indexOf('--')
      const add = mc.toArgs(next)
      args = dd < 0 ? [...rest, ...add] : [...rest.slice(0, dd), ...add, ...rest.slice(dd)]
      // Nothing to write, not even an empty `accounts` key in a config that has none.
      if (unchanged(args)) return null
      const out = { ...current }
      if (args.length) out[account.ref] = { ...current[account.ref], args }
      else {
        const { args: _gone, ...others } = current[account.ref] ?? {}
        if (Object.keys(others).length) out[account.ref] = others
        else delete out[account.ref]
      }
      return out
    },
    { dryRun: !opts.apply },
  )
  const file = rt.paths.configFile
  return {
    changed: r.changed,
    applied: r.changed && opts.apply,
    file,
    diff: r.changed
      ? `--- ${join('sideby', 'config.json')} (accounts)\n${lineDiff(pretty(r.before), pretty(r.after))}\n`
      : '',
    args,
  }
}
