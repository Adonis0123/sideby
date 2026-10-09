// Doctor warnings for Auto Handoff (spec §3.17): only when `handoff.auto` is on, never a failure, never fixed.
import { join } from 'node:path'
import type { Account, Finding } from '../types.ts'
import type { HandoffSettings } from './config.ts'
import { statOrNull } from './fs-safe.ts'

export async function handoffFindings(input: {
  settings: HandoffSettings
  /** Family ids this Doctor run checks. */
  families: readonly string[]
  /** Every Account on disk, to resolve `order` entries in any Family. */
  accounts: readonly Account[]
  aliases: Readonly<Record<string, string>>
  /** Whether Claude's quota tap is on; undefined when Claude is not part of the run. */
  claudeTap?: boolean
  home: string
}): Promise<Finding[]> {
  const { settings: s } = input
  if (!s.auto) return []
  const out: Finding[] = []
  const warn = (account: string, code: string, message: string, hint: string): Finding => ({
    level: 'warn',
    account,
    item: 'handoff',
    code,
    message,
    hint,
    source: 'core',
    fixable: false,
  })
  const has = (family: string) =>
    input.families.includes(family) && input.accounts.some((a) => a.family === family)

  if (has('claude') && input.claudeTap === false)
    out.push(
      warn(
        'claude:main',
        'handoff.no-quota-tap',
        'Auto Handoff is on, but Claude Code reports no quota to sideby, so Claude sessions never hand over',
        'run `sideby quota setup claude` (it shows the change first)',
      ),
    )
  if (has('grok') && !(await statOrNull(join(input.home, '.grok', 'hooks', 'sideby-handoff.json'))))
    out.push(
      warn(
        'grok:main',
        'handoff.setup-missing',
        'Auto Handoff is on, but Grok has no sideby hook file, so a Grok session that hits its limit cannot hand over',
        'run `sideby handoff setup grok`, then `sideby doctor grok --fix` to copy it to every Grok account',
      ),
    )
  const refs = new Set(input.accounts.map((a) => a.ref))
  for (const [family, f] of Object.entries(s.families)) {
    if (!input.families.includes(family)) continue
    if (f.policy === 'order' && f.order.length === 0)
      out.push(
        warn(
          `${family}:main`,
          'handoff.order-empty',
          `handoff.families.${family} has policy "order" but no order, so ${family} sessions never hand over`,
          `list the accounts in handoff.families.${family}.order, or drop the policy to rank by quota`,
        ),
      )
    const unknown = f.order.filter((name) => !refs.has(input.aliases[name] ?? name))
    if (unknown.length)
      out.push(
        warn(
          `${family}:main`,
          'handoff.order-unknown',
          `handoff.families.${family}.order names ${unknown.join(', ')}, which sideby cannot find; they are skipped`,
          'fix the names in the config, or create the account with `sideby new`',
        ),
      )
  }
  return out
}
