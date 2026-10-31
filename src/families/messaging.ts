// Message delivery of the built-in Families (spec §3.32 step 2, ADR-0040). Internal on purpose, like the Live Session
// and Session History readers: not part of the public FamilyDef. A Family listed here has a channel into its running
// sessions; `core/messages.ts` keeps the Message, picks the Session and hands every other Family a paste.
import type { LiveSession } from '../core/live-sessions.ts'
import type { ProcessView } from '../core/live-sessions-procs.ts'
import type { MessageDeps, MessageStatus } from '../core/messages.ts'
import type { Runtime } from '../runtime.ts'
import type { Account } from '../types.ts'
import { deliverClaude } from './claude/deliver.ts'
import { deliverCodex } from './codex/deliver.ts'

export interface DeliveryRequest {
  rt: Runtime
  /** The target Session, known by its process. */
  to: LiveSession
  pid: number
  acct: Account
  /** What the session receives (`deliveredText`). */
  text: string
  /** The line that points at the kept Message file, for a channel that must not carry the text itself. */
  pasteText: string
  /** A fresh look at the processes. */
  procs: ProcessView
  /**
   * Whether the target's process is gone by now, from another fresh look (for after a delivery that could not be
   * confirmed); a failed look counts as still running.
   */
  ended: () => Promise<boolean>
  deps: MessageDeps
}

export interface Delivery {
  status: MessageStatus
  /** Plain-language note: why paste is needed, what the target must still do, or why it could not be confirmed. */
  note?: string
  /** The Host took it but shows it only after the user approves it in the target's terminal (ADR-0045). */
  needsApproval?: boolean
}

export const DELIVERERS: Readonly<Record<string, (req: DeliveryRequest) => Promise<Delivery>>> = {
  claude: deliverClaude,
  codex: deliverCodex,
}
