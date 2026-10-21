// Handoff Rules (spec §3.17 "接力规则", ADR-0046): every rule that decides when a Handoff happens and which Account
// takes over, as it applies now, each with the settings that change it. The CLI prints the English sentences; the
// Panel draws its own words from the same ids and params, so both always say the same thing.
import { LEVEL_MAX } from '../handoff/levels.ts'
import type { Runtime } from '../runtime.ts'
import type { HandoffSettings } from './config.ts'
import { type HandoffOverview, handoffOverview } from './handoff-overview.ts'
import { takeoverLimit } from './quota-levels.ts'

export type HandoffRuleId =
  | 'when'
  | 'windows'
  | 'takeover'
  | 'wait'
  | 'sameFamily'
  | 'otherFamilies'
  | 'api'
  | 'organization'
  | 'order'
  | 'countdown'

export interface HandoffRule {
  id: HandoffRuleId
  /** What the sentence needs; the Panel words it from these. */
  params: Record<string, string | number | boolean | string[]>
  /** The `handoff` config keys that change it; empty when it is fixed. */
  settings: string[]
  /** The rule in plain English, for the CLI and `--json` readers. */
  text: string
}

export interface HandoffRulesView {
  auto: boolean
  rules: HandoffRule[]
  /**
   * Set while Auto Handoff is on, the user has API Accounts and has not yet said whether they may take over: up to
   * ADR-0046 they did, now they do not until the user allows it again.
   */
  apiUndecided: boolean
  /** Where each account's work would go if a Handoff started now (spec §3.17, Q12). */
  takeover: HandoffOverview['takeover']
}

const list = (xs: readonly string[]) => xs.join(' → ')

/** The rules for `settings`; `titles` names each Family, `families` is every Family in load order. */
export function handoffRules(
  s: HandoffSettings,
  ctx: { titles: Readonly<Record<string, string>>; families: readonly string[]; apiAccounts: number },
): HandoffRule[] {
  const title = (f: string) => ctx.titles[f] ?? f
  const limit = takeoverLimit(s.threshold)
  const familyOrder = [
    ...new Set([...s.familyOrder.filter((f) => ctx.families.includes(f)), ...ctx.families]),
  ]
  const rules: HandoffRule[] = [
    {
      id: 'when',
      params: { prepareAt: s.prepareAt, threshold: s.threshold, adaptive: s.adaptive, max: LEVEL_MAX },
      settings: ['prepareAt', 'threshold', 'adaptive'],
      text: s.adaptive
        ? `From ${s.prepareAt}% the session writes a handoff note. It hands over at ${s.threshold}% until sideby has measured how fast this session uses quota; then between ${s.prepareAt}% and ${LEVEL_MAX}%, earlier when recent turns used a lot.`
        : `From ${s.prepareAt}% the session writes a handoff note. It hands over at ${s.threshold}%.`,
    },
    {
      id: 'windows',
      params: {},
      settings: [],
      text: 'Every quota window counts (5 hours, weekly, a billing period); the fullest one decides. No host has a daily quota.',
    },
    {
      id: 'takeover',
      params: { limit },
      settings: ['threshold'],
      text: `An account more than ${limit}% used does not take over, so the next one starts with room to work (${s.threshold}% − 10).`,
    },
    {
      id: 'wait',
      params: { minutes: s.waitIfResetWithinMinutes },
      settings: ['waitIfResetWithinMinutes'],
      text:
        s.waitIfResetWithinMinutes > 0
          ? `If the full window resets within ${s.waitIfResetWithinMinutes} minutes and the session goes on by itself at the reset (Claude Code), it waits instead of switching. Codex and Grok switch right away.`
          : 'It never waits for a reset; it switches right away.',
    },
    {
      id: 'sameFamily',
      params: { on: s.sameFamily },
      settings: ['sameFamily'],
      text: s.sameFamily
        ? 'Other accounts of the same AI may take over first, most quota left first. Vendors may act on moving work between subscriptions.'
        : 'Other accounts of the same AI do not take over.',
    },
    {
      id: 'otherFamilies',
      params: { on: s.otherFamilies, order: familyOrder },
      settings: ['otherFamilies', 'familyOrder'],
      text: s.otherFamilies
        ? `When the same AI has no account that can take over, other AIs may, in this order: ${list(familyOrder.map(title))}; inside each, most quota left first.`
        : 'Other AIs do not take over.',
    },
    {
      id: 'api',
      params: { on: s.api, accounts: ctx.apiAccounts },
      settings: ['api'],
      text: s.api
        ? 'API accounts may take over last, when no subscription account can. They are billed per use and sideby does not cap spending: set a limit in the provider’s console.'
        : 'API accounts do not take over (they are billed per use).',
    },
    {
      id: 'organization',
      params: { allowed: s.crossOrganization },
      settings: ['crossOrganization'],
      text: s.crossOrganization.length
        ? `An account signed in to another organization does not take over, except ${s.crossOrganization.join(', ')}.`
        : 'An account signed in to another organization does not take over.',
    },
  ]
  for (const [family, f] of Object.entries(s.families))
    if (f.policy === 'order' && f.order.length)
      rules.push({
        id: 'order',
        params: { family, order: f.order },
        settings: ['families'],
        text: `From ${title(family)}, accounts are tried in your order: ${list(f.order)}.`,
      })
  rules.push({
    id: 'countdown',
    params: { seconds: s.countdownSeconds },
    settings: ['countdownSeconds'],
    text:
      s.countdownSeconds > 0
        ? `Before the next account starts, a ${s.countdownSeconds}-second countdown runs; Enter cancels it.`
        : 'The next account starts without a countdown.',
  })
  return rules
}

/** The Handoff Rules as they apply on this machine, with where each account's work would go now. */
export async function handoffRulesView(rt: Runtime, overview?: HandoffOverview): Promise<HandoffRulesView> {
  const s = rt.handoffSettings()
  const apiAccounts = (await rt.accounts()).filter((a) => a.kind === 'api').length
  const families = [...rt.families.values()]
  overview ??= await handoffOverview(rt, { always: true })
  return {
    auto: s.auto,
    rules: handoffRules(s, {
      titles: Object.fromEntries(families.map((f) => [f.id, f.title])),
      families: families.filter((f) => f.handoff).map((f) => f.id),
      apiAccounts,
    }),
    apiUndecided: apiUndecided(rt, apiAccounts),
    takeover: overview.takeover,
  }
}

/** Whether to ask a user who had Auto Handoff on before ADR-0046 if API Accounts may still take over. */
export function apiUndecided(rt: Runtime, apiAccounts: number): boolean {
  return rt.handoffSettings().auto && rt.config.handoff?.api === undefined && apiAccounts > 0
}
