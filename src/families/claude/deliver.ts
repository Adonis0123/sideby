// Delivering a Message into a running Claude Code session (spec §3.32 step 2, ADR-0040): the session's own message
// socket, after `crossSessionInbound` and the socket's owner, folder and identity are checked. Every refusal comes
// back as a paste with the reason; nothing here reads a key file or a token.
import { inboundGroups } from '../../core/inbound.ts'
import { hostArgs } from '../../core/live-sessions-procs.ts'
import type { Delivery, DeliveryRequest } from '../messaging.ts'
import {
  checkSocket,
  claudeSocketOf,
  DELIVER_TIMEOUT_MS,
  messageLine,
  sessionBypass,
  socketChanged,
  socketRoots,
  UnconfirmedWrite,
  writeToSocket,
} from './messaging.ts'

export async function deliverClaude(req: DeliveryRequest): Promise<Delivery> {
  const { rt, to, acct, pid, procs, deps } = req
  const paste = (note: string) => ({ status: 'paste-needed' as const, note })
  const [group] = await inboundGroups([acct], rt.readContext())
  const inbound = group?.state ?? 'default'
  // A settings file sideby cannot read may still hold "refuse" for the running session, so it is not a guess to act on.
  if (inbound === 'blocked')
    return paste(
      `sideby could not tell if ${to.accountLabel} accepts messages (${group?.reason}); paste this line into its tab`,
    )
  if (inbound === 'refuse')
    return paste(
      `${to.accountLabel} blocks messages from other sessions (crossSessionInbound is "refuse"). Paste the line into its tab, or change crossSessionInbound in its settings.json`,
    )
  const sock = await claudeSocketOf(acct.dir, pid, to.sessionId, procs)
  if ('problem' in sock)
    return paste(`sideby did not deliver it because ${sock.problem}; paste the line into its tab`)
  const checked = await checkSocket(sock.path, {
    tempRoots: deps.tempRoots ?? socketRoots(rt.env),
    uid: deps.uid ?? process.getuid?.(),
  })
  if ('problem' in checked)
    return paste(`sideby did not deliver it because ${checked.problem}; paste the line into its tab`)
  try {
    await (deps.write ?? writeToSocket)(
      sock.path,
      messageLine(req.text),
      deps.timeoutMs ?? DELIVER_TIMEOUT_MS,
      () => socketChanged(sock.path, checked.identity),
    )
  } catch (err) {
    if (err instanceof UnconfirmedWrite) {
      // Written, but never confirmed: a paste on top of it could reach the session twice.
      const ended = await req.ended()
      return {
        status: 'unknown',
        note: `sideby wrote it to ${to.label} but could not confirm it arrived (${err.message}).${ended ? ' The session has ended since.' : ''} It may still show up; check the session before you send it again`,
      }
    }
    return paste(
      `sideby could not reach ${to.label} (${(err as Error).message}); paste the line into its tab`,
    )
  }
  if (inbound === 'accept') return { status: 'delivered' }
  const proc = await procs.get(pid)
  const args = (await procs.argv(pid)) ?? (proc ? hostArgs(proc.command) : [])
  if (inbound === 'hold' || (await sessionBypass(to.transcript, args)))
    return {
      status: 'delivered',
      needsApproval: true,
      note: `sent, but ${to.accountLabel} needs your approval: approve the message in its terminal within 5 minutes, or run \`sideby messages inbound accept\` to receive future messages right away`,
    }
  return { status: 'delivered' }
}
