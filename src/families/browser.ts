// Vendor websites for Browser Sign-ins (spec §3.24, ADR-0023, ADR-0043). The built-in Families' websites are set
// here; a plugin Family declares its own as `FamilyDef.website`, checked by the loader.
import type { FamilyDef, FamilyWebsite } from '../types.ts'
import { claudeSignInId } from './claude/browser.ts'
import { codexSignInId } from './codex/browser.ts'
import { grokSignInId } from './grok/browser.ts'

export type WebsiteDef = FamilyWebsite & {
  /** The Family id. */
  family: string
}

const BUILTIN: ReadonlyMap<string, WebsiteDef> = new Map(
  (
    [
      {
        family: 'claude',
        url: 'https://claude.ai',
        match: { origin: 'https://claude.ai', signInId: claudeSignInId },
      },
      {
        family: 'codex',
        url: 'https://chatgpt.com',
        match: { origin: 'https://chatgpt.com', signInId: codexSignInId },
      },
      // grok.com keys such as `dismissed:<x>:<user_id>` carry the x.ai user id (checked 2026-10-20, ADR-0043).
      {
        family: 'grok',
        url: 'https://grok.com',
        match: { origin: 'https://grok.com', signInId: grokSignInId },
      },
    ] satisfies WebsiteDef[]
  ).map((w) => [w.family, w]),
)

/** The website of a Family: sideby's own for a built-in one, else the one its plugin declares. */
export function websiteDef(
  families: ReadonlyMap<string, FamilyDef>,
  familyId: string,
): WebsiteDef | undefined {
  const own = BUILTIN.get(familyId)
  if (own) return own
  const w = families.get(familyId)?.website
  return w ? { ...w, family: familyId } : undefined
}

/** Every website origin that can be matched, for the origins to read. */
export function matchedOrigins(families: ReadonlyMap<string, FamilyDef>): string[] {
  const ids = new Set([...BUILTIN.keys(), ...families.keys()])
  return [...new Set([...ids].flatMap((id) => websiteDef(families, id)?.match?.origin ?? []))]
}
