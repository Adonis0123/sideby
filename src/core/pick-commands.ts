// Pick Commands (spec §3.13, ADR-0035): a short command bound to a Family that starts the Account a Handoff would
// pick, or the Main Account when no Account of the Family has Quota data.
import type { HandoffPlan } from './handoff.ts'

/** The name offered for a built-in Family when its Aliases follow no pattern; pi gets none (`pi` is the Host). */
export const DEFAULT_PICK_NAMES: Readonly<Record<string, string>> = { claude: 'cc', codex: 'cx', grok: 'gk' }

/**
 * The Pick Command name offered for a Family: the letters its numbered Aliases share (cc001, cc008 → cc), else the
 * built-in default. Never the Host's own command name, which would hide the Host from the shell.
 */
export function suggestPickName(
  family: string,
  bin: string,
  familyAliases: readonly string[],
): string | null {
  const prefixes = new Set(
    familyAliases.map((a) => /^([A-Za-z][A-Za-z_-]*?)-?\d+$/.exec(a)?.[1]).filter((p): p is string => !!p),
  )
  const fromAliases = prefixes.size === 1 ? [...prefixes][0]! : undefined
  const name = fromAliases ?? DEFAULT_PICK_NAMES[family]
  return name && name !== bin ? name : null
}

/** What a Pick Command starts this time, or why it starts nothing. */
export type PickChoice =
  | { ref: string; reason: 'most-room'; pressure: number }
  /** No Account of the Family has Quota data: the Main Account, or the Handoff pick when the main cannot start. */
  | { ref: string; reason: 'no-quota-data' }
  /** The Accounts with Quota data are full; this one has none yet. */
  | { ref: string; reason: 'others-full' }
  | { ref: null; reason: 'none-usable'; earliestReset?: { ref: string; at: string }; signIn: string[] }

/**
 * Turns a Handoff plan into the Account to start (ADR-0035). With some Quota data: the pick. Without any: the Main
 * Account (`mainRef`, a Subscription Account) when it can start, else the pick. Nothing usable (all full, signed out
 * or API): nothing starts.
 */
export function choosePick(plan: HandoffPlan, mainRef: string | null): PickChoice {
  const startable = (ref: string) =>
    plan.accounts.some(
      (e) => e.ref === ref && !e.sameLoginAs && (e.state === 'ready' || e.state === 'unknown'),
    )
  if (!plan.hasQuota && mainRef && startable(mainRef)) return { ref: mainRef, reason: 'no-quota-data' }
  if (plan.pick && plan.accounts.some((e) => e.ref === plan.pick && e.state !== 'api')) {
    const e = plan.accounts.find((x) => x.ref === plan.pick)!
    if (!plan.hasQuota) return { ref: plan.pick, reason: 'no-quota-data' }
    return e.state === 'ready' && e.pressure !== null
      ? { ref: plan.pick, reason: 'most-room', pressure: Math.round(e.pressure) }
      : { ref: plan.pick, reason: 'others-full' }
  }
  return {
    ref: null,
    reason: 'none-usable',
    ...(plan.earliestReset ? { earliestReset: plan.earliestReset } : {}),
    signIn: plan.accounts.filter((e) => e.state === 'logged-out').map((e) => e.ref),
  }
}

/** The line a Pick Command prints before it starts the Host. */
export function pickLine(name: string, choice: Exclude<PickChoice, { ref: null }>): string {
  if (choice.reason === 'most-room')
    return `${name} → ${choice.ref} (${choice.pressure}% used, the most room)`
  if (choice.reason === 'others-full')
    return `${name} → ${choice.ref} (no quota data for it yet; the accounts with data are full)`
  return `${name} → ${choice.ref} (no quota data yet; \`sideby quota\` shows why)`
}
