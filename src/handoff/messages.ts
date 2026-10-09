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
  return `sideby: this account's quota is at ${Math.round(pressure)}%, so another account may take over soon. Write a handoff brief to ${brief} now (${TEMPLATE}). ${RULES} Keep it current after each step, then go on with the task.`
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

/** The next session's first prompt: the Brief's path only, never its text (it would show in a process list). */
export function firstPrompt(fromRef: string, brief: string): string {
  return `This task was handed over from ${fromRef} by sideby because its quota ran low. Read ${brief} first, then continue the task it describes.`
}
