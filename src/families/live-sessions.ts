// Live Session readers of the built-in Families (spec §3.32, ADR-0039). Internal on purpose: not part of the public
// FamilyDef, so plugin Families have no Live Sessions in v1.
import type { LiveSessionStatus } from '../core/live-sessions.ts'
import type { ProcessView } from '../core/live-sessions-procs.ts'
import type { OrcaAgentListRunner } from '../core/orca-chat.ts'
import type { Account, Env } from '../types.ts'
import { agyLiveSessions } from './agy/live-sessions.ts'
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
  /** The app the Session was started from (Started From), as the Host's own record says; Claude and agy (ADR-0088). */
  startedFrom?: string
  /** Confirmed Orca Chat session id for local Orca `agy acp` Chats (ADR-0088). */
  orcaSessionId?: string
}

export interface LiveSessionReadContext {
  stateDir: string
  env: Env
  now?: Date
  orcaAgents?: OrcaAgentListRunner
  /** WHY: epoch ms when the outer listing deadline fires, so optional enrichments yield in time (ADR-0088). */
  deadlineAtMs?: number
}

export interface LiveSessionReader {
  family: string
  /**
   * The Account's Live Sessions. Reads only the Host's session files, never a credential file; throws only when
   * the Account cannot be read at all (a malformed record is skipped and named in `problems`).
   */
  read(
    account: Account,
    procs: ProcessView,
    problems: string[],
    ctx?: LiveSessionReadContext,
  ): Promise<RawLiveSession[]>
}

const READERS: ReadonlyMap<string, LiveSessionReader> = new Map(
  [claudeLiveSessions, codexLiveSessions, grokLiveSessions, piLiveSessions, agyLiveSessions].map((r) => [
    r.family,
    r,
  ]),
)

/** The Live Session reader of a built-in Family id, if it has one. */
export function liveSessionReader(familyId: string): LiveSessionReader | undefined {
  return READERS.get(familyId)
}
