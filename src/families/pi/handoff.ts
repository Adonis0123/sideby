// How pi takes part in a Handoff (spec §3.17): it has no Quota source and no hooks sideby can use, so it only takes
// over, starting an interactive session with the Brief's path as its first message (`pi [options] [messages...]`).
import type { FamilyHandoff } from '../../types.ts'
import { hasOption, promptAfterDashes } from '../shared/handoff-args.ts'

export const piHandoff: FamilyHandoff = {
  starts: [],
  promptArgs: promptAfterDashes,
  // pi never starts a Handoff, so it never continues one of its own sessions with the user's arguments.
  continueArgs: () => [],
  resumeArgs: (id) => ['--session', id],
  async eligibility(args) {
    if (hasOption(args, ['-p', '--print']))
      return { start: false, receive: false, reason: 'a headless run (`-p`) has nobody to hand over to' }
    return { start: false, receive: true }
  },
}
