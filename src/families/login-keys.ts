// Login Key readers (ADR-0028), internal: not part of FamilyDef, so plugin authors never see or provide one.
import type { Account } from '../types.ts'
import { codexLoginKey } from './codex/login-key.ts'
import { grokLoginKey } from './grok/login-key.ts'

/**
 * Family id → its Login Key reader. Must list exactly the Families of `LOGIN_KEY_FAMILIES` (core/same-login.ts);
 * a test keeps the two in step.
 */
export const LOGIN_KEY_READERS: ReadonlyMap<string, (account: Account) => Promise<string | undefined>> =
  new Map([
    ['codex', codexLoginKey],
    ['grok', grokLoginKey],
  ])
