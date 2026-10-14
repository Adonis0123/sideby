// The model and effort a Codex Account starts with (spec §3.19, ADR-0014). Reads only the top-level `model` and
// `model_reasoning_effort` of the Account's `config.toml`.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Account, FamilyModelChoice, ModelChoice } from '../../types.ts'
import { takeFlag } from '../shared/model-args.ts'
import { topLevelTomlString } from '../shared/toml.ts'

const EFFORT_KEY = 'model_reasoning_effort'

async function configured(account: Account): Promise<ModelChoice> {
  try {
    const text = await readFile(join(account.dir, 'config.toml'), 'utf8')
    const model = topLevelTomlString(text, 'model')
    const effort = topLevelTomlString(text, EFFORT_KEY)
    return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
  } catch {
    return {}
  }
}

/** `-c model_reasoning_effort=…` is one of possibly many `-c` overrides: only that one is taken out. */
function takeEffort(args: readonly string[]): { value?: string; rest: string[] } {
  const rest: string[] = []
  let value: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') {
      rest.push(...args.slice(i))
      break
    }
    const inline = a.startsWith('--config=') ? a.slice('--config='.length) : null
    const next = (a === '-c' || a === '--config') && i + 1 < args.length ? args[i + 1]! : null
    const kv = inline ?? next
    if (kv?.startsWith(`${EFFORT_KEY}=`)) {
      value = kv.slice(EFFORT_KEY.length + 1).replace(/^(["'])(.*)\1$/, '$2')
      if (next !== null) i++
      continue
    }
    rest.push(a)
  }
  return value === undefined ? { rest } : { value, rest }
}

export const codexModelChoice: FamilyModelChoice = {
  efforts: ['low', 'medium', 'high', 'xhigh'],
  models: [],
  configured,
  toArgs: (c) => [
    ...(c.model ? ['-m', c.model] : []),
    ...(c.effort ? ['-c', `${EFFORT_KEY}="${c.effort}"`] : []),
  ],
  fromArgs(args) {
    const m = takeFlag(args, ['-m', '--model'])
    const e = takeEffort(m.rest)
    return {
      choice: { ...(m.value ? { model: m.value } : {}), ...(e.value ? { effort: e.value } : {}) },
      rest: e.rest,
    }
  },
}
