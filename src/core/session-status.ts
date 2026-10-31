// A Live Session's status (spec §3.32 step 1, "状态"): one ordered table, read from top to bottom, where the first row
// that matches wins. The Host's own word comes from the Family readers; the rest are things sideby itself keeps for
// the Session: open Pending Decisions (spec §3.37) and Messages waiting for the user (spec §3.32 step 2). Read-only.
import type { LiveSessionStatus } from './live-sessions.ts'
import type { MessageReceipt } from './messages.ts'
import { listPendingDecisions, type PendingDecision } from './unattended-pending.ts'

/** Why a Session needs the user: the row of `STATUS_RULES` that matched. Set only with status `needs-you`. */
export type NeedsYouReason = 'host-waits' | 'pending-decision' | 'message-to-approve' | 'message-to-paste'

/** What the table looks at for one Session. */
export interface StatusSignals {
  /** What the Host's own files say (a Family reader's status). */
  host: LiveSessionStatus
  /** Open Pending Decisions kept for this Session. */
  pendingDecisions: number
  /** Messages delivered to it that it shows only once the user approves them in its terminal (ADR-0045). */
  messagesToApprove: number
  /** Messages to it that wait for the user to paste them (`paste-needed`) and its record does not show yet. */
  messagesToPaste: number
}

export interface StatusRule {
  status: LiveSessionStatus
  reason?: NeedsYouReason
  when: (s: StatusSignals) => boolean
}

/** The table of spec §3.32 step 1, in order; the first row whose `when` holds gives the status. */
export const STATUS_RULES: readonly StatusRule[] = [
  { status: 'needs-you', reason: 'host-waits', when: (s) => s.host === 'needs-you' },
  { status: 'needs-you', reason: 'pending-decision', when: (s) => s.pendingDecisions > 0 },
  { status: 'needs-you', reason: 'message-to-approve', when: (s) => s.messagesToApprove > 0 },
  { status: 'needs-you', reason: 'message-to-paste', when: (s) => s.messagesToPaste > 0 },
  { status: 'busy', when: (s) => s.host === 'busy' },
  { status: 'idle', when: (s) => s.host === 'idle' },
  { status: 'unknown', when: () => true },
]

/** The status the first matching row of `STATUS_RULES` gives, and its reason when it is `needs-you`. */
export function sessionStatus(s: StatusSignals): { status: LiveSessionStatus; reason?: NeedsYouReason } {
  const row = STATUS_RULES.find((r) => r.when(s))!
  return row.reason ? { status: row.status, reason: row.reason } : { status: row.status }
}

/** The fields of a Live Session the table needs. */
export interface StatusTarget {
  account: string
  family: string
  sessionId: string
  status: LiveSessionStatus
  transcript?: string
}

/** What sideby keeps for Sessions, read once per listing. */
export interface SessionAttention {
  decisions: readonly PendingDecision[]
  receipts: readonly MessageReceipt[]
}

/** The signals of one Session, from its Host status and what sideby keeps for it. */
export function signalsOf(s: StatusTarget, kept: SessionAttention): StatusSignals {
  const pendingDecisions = kept.decisions.filter(
    (d) =>
      !d.doneAt &&
      d.sessionId === s.sessionId &&
      d.family === s.family &&
      (!d.account || d.account === s.account),
  ).length
  const mine = kept.receipts.filter((r) => r.toSessionId === s.sessionId && r.toAccount === s.account)
  return {
    host: s.status,
    pendingDecisions,
    messagesToApprove: mine.filter((r) => r.status === 'delivered' && r.needsApproval).length,
    // Only where sideby can see the Session's record: a paste shows there and clears the row; without one it never would.
    messagesToPaste: s.transcript ? mine.filter((r) => r.status === 'paste-needed').length : 0,
  }
}

/** Each Session with the status the table gives it; `reason` is set only on `needs-you`, and dropped otherwise. */
export function withStatus<T extends StatusTarget & { reason?: NeedsYouReason }>(
  sessions: readonly T[],
  kept: SessionAttention,
): T[] {
  return sessions.map((s) => {
    const { reason: _old, ...rest } = s
    const r = sessionStatus(signalsOf(s, kept))
    return { ...rest, status: r.status, ...(r.reason ? { reason: r.reason } : {}) } as T
  })
}

/** How many of the newest Messages are looked at: each may read the end of its target's record. */
export const MESSAGES_LOOKED_AT = 50

/**
 * Reads what sideby keeps for Sessions: open Pending Decisions and the newest Messages, both without writing (an old
 * done Decision is not deleted, a Message found read is not saved). A store that cannot be read adds a problem line
 * and counts as empty.
 */
export async function readAttention(
  stateDir: string,
  messages: () => Promise<readonly MessageReceipt[]>,
  problems: string[],
): Promise<SessionAttention> {
  const [decisions, receipts] = await Promise.all([
    listPendingDecisions(stateDir, { prune: false }).catch((err: Error) => {
      problems.push(
        `could not read Pending Decisions (${(err as NodeJS.ErrnoException).code ?? err.message}); sessions waiting on one are not marked; run \`sideby unattended pending\` to see why`,
      )
      return [] as PendingDecision[]
    }),
    messages().catch((err: Error) => {
      problems.push(
        `could not read sent messages (${(err as NodeJS.ErrnoException).code ?? err.message}); sessions with a message to paste are not marked; run \`sideby messages\` to see why`,
      )
      return [] as MessageReceipt[]
    }),
  ])
  return { decisions, receipts }
}
