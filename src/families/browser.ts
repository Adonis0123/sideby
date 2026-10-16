// Vendor websites of the built-in Families, for Browser Sign-ins (spec §3.24, ADR-0023). Internal on purpose: not
// part of the public FamilyDef, so plugin Families cannot declare one in v1.
import type { Account } from '../types.ts'
import { claudeSignInId } from './claude/browser.ts'
import { codexSignInId } from './codex/browser.ts'

export interface WebsiteDef {
  /** The Family id. */
  family: string
  /** Where "Open in browser" goes. */
  url: string
  /**
   * The Local Storage origin whose key names may hold `signInId`, and the reader of that id from the Host's login
   * file. The id is compared in memory only; it is never shown, returned, logged or cached. Missing when the website
   * keeps no id the Host also has (grok.com), so the Account can only be opened in a Browser Profile the user picks.
   */
  match?: { origin: string; signInId(account: Account): Promise<string | undefined> }
}

const WEBSITES: ReadonlyMap<string, WebsiteDef> = new Map(
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
      { family: 'grok', url: 'https://grok.com' },
    ] satisfies WebsiteDef[]
  ).map((w) => [w.family, w]),
)

/** The website of a built-in Family id, if it has one. */
export function websiteDef(familyId: string): WebsiteDef | undefined {
  return WEBSITES.get(familyId)
}

/** Every website that can be matched, for the origins to read. */
export function matchedOrigins(): string[] {
  return [...WEBSITES.values()].flatMap((w) => (w.match ? [w.match.origin] : []))
}
