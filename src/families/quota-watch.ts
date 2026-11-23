// Folders of built-in Families whose files change an Account's Quota or usage, for the Panel's change feed (spec
// §3.45, ADR-0084). Internal on purpose: not part of the public FamilyDef. Only file names are matched; nothing here
// is ever read.
import { join } from 'node:path'
import type { Account } from '../types.ts'

export interface QuotaWatchDir {
  dir: string
  /** Whether files sit in subfolders (`sessions/2026/11/23/…`). */
  recursive: boolean
  /** The changed name (relative to `dir`, any separator) that counts. */
  match: RegExp
  /** At most one change every this many ms: a running session appends to these files all the time. */
  gapMs: number
}

const SESSION_GAP_MS = 5000

const DIRS: Record<string, (a: Account) => QuotaWatchDir[]> = {
  // Quota (until a kept answer exists, `localFallbackOnly`) and usage from `token_count` events.
  codex: (a) => [
    {
      dir: join(a.dir, 'sessions'),
      recursive: true,
      match: /(^|[\\/])rollout-[^\\/]*\.jsonl$/,
      gapMs: SESSION_GAP_MS,
    },
  ],
  // The Quota Grok logs after each turn (ADR-0025).
  grok: (a) => [
    { dir: join(a.dir, 'logs'), recursive: false, match: /^unified\.jsonl$/, gapMs: SESSION_GAP_MS },
  ],
}

/** The folders to watch for `accounts`. */
export function quotaWatchDirs(accounts: readonly Account[]): QuotaWatchDir[] {
  return accounts.flatMap((a) => (Object.hasOwn(DIRS, a.family) ? DIRS[a.family]!(a) : []))
}
