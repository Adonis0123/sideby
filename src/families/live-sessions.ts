// Live Session readers of the built-in Families (spec §3.32, ADR-0039). Internal on purpose: not part of the public
// FamilyDef, so plugin Families have no Live Sessions in v1.
import type { LiveSessionStatus } from '../core/live-sessions.ts'
import type { ProcessView } from '../core/live-sessions-procs.ts'
import type { Account } from '../types.ts'
import { claudeLiveSessions } from './claude/live-sessions.ts'
import { codexLiveSessions } from './codex/live-sessions.ts'
import { grokLiveSessions } from './grok/live-sessions.ts'
import { piLiveSessions } from './pi/live-sessions.ts'

/** A Live Session as a Family reads it, before sideby adds the Account's name, the Label and the commands. */
export interface RawLiveSession {
  sessionId: string
  /** The Host's own title, when its files give one. */
  title?: string
  status: LiveSessionStatus
  cwd?: string
  pid?: number
  startedAt?: string
  updatedAt?: string
  guessed: boolean
  transcript?: string
}

export interface LiveSessionReader {
  family: string
  /**
   * The Account's Live Sessions. Reads only the Host's session files, never a credential file; throws only when
   * the Account cannot be read at all (a malformed record is skipped and named in `problems`).
   */
  read(account: Account, procs: ProcessView, problems: string[]): Promise<RawLiveSession[]>
}

const READERS: ReadonlyMap<string, LiveSessionReader> = new Map(
  [claudeLiveSessions, codexLiveSessions, grokLiveSessions, piLiveSessions].map((r) => [r.family, r]),
)

/** The Live Session reader of a built-in Family id, if it has one. */
export function liveSessionReader(familyId: string): LiveSessionReader | undefined {
  return READERS.get(familyId)
}
