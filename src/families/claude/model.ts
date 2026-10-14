// The model and effort a Claude Code Account starts with (spec §3.19, ADR-0014). Reads only `model`,
// `effortLevel` and `modelSettings.<model>.effortLevel` of the Account's `settings.json`.
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, FamilyModelChoice, ModelChoice } from '../../types.ts'
import { takeFlag } from '../shared/model-args.ts'

const MAX_BYTES = 1_000_000
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

async function configured(account: Account, model?: string, lastModel?: string): Promise<ModelChoice> {
  try {
    const file = join(account.dir, 'settings.json')
    const st = await stat(file)
    if (!st.isFile() || st.size > MAX_BYTES) return {}
    const s = JSON.parse(await readFile(file, 'utf8')) as unknown
    if (!isObj(s)) return {}
    const m = str(s.model)
    const ms = isObj(s.modelSettings) ? s.modelSettings : {}
    const per = (name?: string) =>
      name && isObj(ms[name]) ? str((ms[name] as Record<string, unknown>).effortLevel) : undefined
    // The level saved for the model the session will run: the one passed in, else the file's own, else the last one used.
    const effort = per(model ?? m ?? lastModel) ?? str(s.effortLevel)
    return { ...(m ? { model: m } : {}), ...(effort ? { effort } : {}) }
  } catch {
    return {}
  }
}

export const claudeModelChoice: FamilyModelChoice = {
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  models: ['fable', 'opus', 'sonnet', 'haiku'],
  configured,
  toArgs: (c) => [...(c.model ? ['--model', c.model] : []), ...(c.effort ? ['--effort', c.effort] : [])],
  fromArgs(args) {
    const m = takeFlag(args, ['--model'])
    const e = takeFlag(m.rest, ['--effort'])
    return {
      choice: { ...(m.value ? { model: m.value } : {}), ...(e.value ? { effort: e.value } : {}) },
      rest: e.rest,
    }
  },
}
