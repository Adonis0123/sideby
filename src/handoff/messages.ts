// Text the handoff hook puts in front of the model, and the first prompt of the next session (spec §3.17).
// English, since Hosts and models read it; complete in itself, so it works without any skill installed.

const TEMPLATE = [
  'the goal of the task',
  'what is done',
  'the remaining steps',
  'key decisions and why',
  'the files that matter',
].join('; ')

const RULES =
  'Reference specs, ADRs, commits and diffs by path instead of repeating them, list the skills the next agent should use, and never include keys, passwords or personal data.'

export function prepareMessage(brief: string, pressure: number): string {
  return `sideby: this account's quota is at ${Math.round(pressure)}%. Write a handoff brief to ${brief} now (${TEMPLATE}). ${RULES} Keep it current after each step, then go on with the task. Do not tell the user that the work will move to another account: sideby decides that and tells them itself.`
}

export function thresholdMessage(brief: string, pressure: number): string {
  return `sideby: this account's quota is at ${Math.round(pressure)}%. Finish the current step, update the handoff brief at ${brief} (${TEMPLATE}; ${RULES}), then end your turn. sideby will start the next account from that brief.`
}

/** At the threshold when the session cannot write a Brief: sideby puts one together from its records. */
export function endTurnMessage(pressure: number): string {
  return `sideby: this account's quota is at ${Math.round(pressure)}%. Finish the current step and end your turn; sideby will start the next account and tell it what you did.`
}

export function stopMessage(brief: string): string {
  return `sideby: before you stop, update the handoff brief at ${brief} (${TEMPLATE}; ${RULES}), then end your turn.`
}

/** At session start (Claude): this session may hand its task to another account when the user asks. */
export function sessionStartMessage(ref: string, brief: string): string {
  return `sideby: this session runs in ${ref} under sideby with Auto Handoff. If the user wants this task to go on in another account ("continue in cc008", "hand it back to cc008"), do not ask them to start that account: write a handoff brief to ${brief} (${TEMPLATE}; ${RULES}), run \`sideby handoff ready --to <account>\` (an account or short command), tell the user the account it prints, and end your turn. sideby then ends this session and starts that account in this terminal.`
}

const WHY = {
  threshold: 'its quota ran low',
  limit: 'its quota ran out',
  manual: 'the user asked to hand over',
} as const

/** The next session's first prompt: the Brief's path only, never its text (it would show in a process list). */
export function firstPrompt(fromRef: string, brief: string, trigger: keyof typeof WHY): string {
  return `This task was handed over from ${fromRef} by sideby because ${WHY[trigger]}. Read ${brief} first, then continue the task it describes. If the user asks to move the task to another account (back to ${fromRef}, say), run \`sideby handoff ready --to <account>\` and end your turn.`
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })

/** For the user, not the model (ADR-0018): this session will wait for the reset, and how to move on now instead. */
export function waitNotice(ref: string, until: string, pressure?: number): string {
  const now = pressure === undefined ? 'hit its limit' : `is at ${Math.round(pressure)}%`
  const then = pressure === undefined ? 'this session waits' : 'when it runs out this session waits'
  return `sideby: ${ref} ${now}; its quota is back at ${clock(until)}, so ${then} and goes on by itself instead of moving to another account. To move on now, type: ! sideby handoff ready`
}

/** A desktop notification through the Host (OSC 9 and OSC 777), the only output `StopFailure` keeps. */
export function notifySequence(text: string): string {
  const safe = [...text].map((ch) => (ch < ' ' || ch === '\u007f' ? ' ' : ch)).join('')
  return `\u001b]9;${safe}\u0007\u001b]777;notify;sideby;${safe}\u0007`
}
