// How Claude Code takes part in a Handoff (spec §3.17): hooks through `--settings`, which merges with the
// Account's own settings hooks (verified 2026-10-09), and the Brief's directory through `--add-dir`.
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { locate, readObject } from '../../core/claude-settings-file.ts'
import { writeFileAtomic } from '../../core/fs-safe.ts'
import type { FamilyHandoff } from '../../types.ts'
import { type ArgRules, carryArgs, hasOption, promptAfterDashes } from '../shared/handoff-args.ts'
import { claudeBrief } from './brief.ts'

/** From `claude --help`: options that take a value, so it is never mistaken for the old prompt. */
export const CLAUDE_ARGS: ArgRules = {
  valued: [
    '--agent',
    '--agents',
    '--append-system-prompt',
    '--append-system-prompt-file',
    '--autocompact',
    '--debug-file',
    '--effort',
    '--environment',
    '--fallback-model',
    '--input-format',
    '--json-schema',
    '--max-budget-usd',
    '--model',
    '-n',
    '--name',
    '--output-format',
    '--permission-mode',
    '--permission-prompts',
    '--plugin-dir',
    '--plugin-url',
    '--remote-control-session-name-prefix',
    '--session-id',
    '--setting-sources',
    '--settings',
    '--system-prompt',
    '--system-prompt-file',
    '--system-prompt-snapshot',
  ],
  variadic: [
    '--add-dir',
    '--allowedTools',
    '--allowed-tools',
    '--betas',
    '--disallowedTools',
    '--disallowed-tools',
    '--file',
    '--mcp-config',
    '--tools',
  ],
  optional: [
    '--cloud',
    '-d',
    '--debug',
    '--from-pr',
    '--prompt-suggestions',
    '--remote-control',
    '-r',
    '--resume',
    '--teleport',
    '-w',
    '--worktree',
  ],
  drop: [
    '-r',
    '--resume',
    '-c',
    '--continue',
    '--fork-session',
    '--session-id',
    '--from-pr',
    '--teleport',
    '-n',
    '--name',
    '-p',
    '--print',
  ],
}

export const claudeHandoff: FamilyHandoff = {
  starts: ['quota', 'limit'],
  async hookArgs(command, stateDir) {
    const dir = join(stateDir, 'handoff')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const hook = (event: Parameters<typeof command>[0]) => [
      { hooks: [{ type: 'command', command: command(event) }] },
    ]
    const settings = {
      hooks: {
        SessionStart: hook('SessionStart'),
        PostToolUse: hook('PostToolUse'),
        // The second Stop hook runs in the background (`asyncRewake`): while the session waits on background work it
        // watches the Quota and wakes the session at the hand-over level (ADR-0056). 18000 s: five hours.
        Stop: [
          {
            hooks: [
              { type: 'command', command: command('Stop') },
              { type: 'command', command: command('IdleWatch'), asyncRewake: true, timeout: 18000 },
            ],
          },
        ],
        StopFailure: [
          { matcher: 'rate_limit', hooks: [{ type: 'command', command: command('StopFailure') }] },
        ],
      },
    }
    const file = join(dir, 'claude-settings.json')
    await writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, 0o600)
    return ['--settings', file]
  },
  dirArgs: (dir) => ['--add-dir', dir],
  promptArgs: promptAfterDashes,
  continueArgs: (args) => carryArgs(args, CLAUDE_ARGS),
  resumeArgs: (id) => ['--resume', id],
  async eligibility(args) {
    if (hasOption(args, ['-p', '--print']))
      return { start: false, receive: false, reason: 'a headless run (`-p`) has nobody to hand over to' }
    if (hasOption(args, ['--settings']))
      return {
        start: false,
        receive: true,
        reason: '`--settings` is already given, so sideby cannot add its hooks',
      }
    return { start: true, receive: true }
  },
  briefFromSession: claudeBrief,
  // Only `autoContinueAtUsageLimit` is read (ADR-0018); Claude Code's default is true. Managed and project settings
  // and `--settings` can set it too; sideby does not read them.
  async resumesAtReset(account) {
    const where = await locate(account)
    if (!where.exists) return true
    const read = await readObject(where.file)
    return 'error' in read || read.obj.autoContinueAtUsageLimit !== false
  },
}
