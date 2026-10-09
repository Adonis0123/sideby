// How Codex takes part in a Handoff (spec §3.17): hooks through `-c hooks.<event>=…` (the session-flags layer is a
// hook source; verified 2026-10-09), each Account trusting them once in `/hooks`. No hook fires on a failed turn,
// so Codex starts a Handoff only before its limit.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FamilyHandoff } from '../../types.ts'
import {
  type ArgRules,
  carryArgs,
  hasOption,
  optionValue,
  promptAfterDashes,
} from '../shared/handoff-args.ts'
import { topLevelTomlString } from '../shared/toml.ts'
import { codexBrief } from './brief.ts'

/** From `codex --help`. `-c` is a config override in Codex, not a continue flag, so it is kept. */
export const CODEX_ARGS: ArgRules = {
  valued: [
    '-c',
    '--config',
    '--enable',
    '--disable',
    '--remote',
    '--remote-auth-token-env',
    '-m',
    '--model',
    '--local-provider',
    '-p',
    '--profile',
    '-s',
    '--sandbox',
    '-C',
    '--cd',
    '--add-dir',
    '-a',
    '--ask-for-approval',
  ],
  variadic: ['-i', '--image'],
  drop: ['--last', '--all', '--include-non-interactive', '-i', '--image'],
}

/** Subcommands that are not an interactive session; `resume` and `fork` are. */
const NOT_INTERACTIVE = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'apply',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
  'cloud',
  'exec-server',
  'features',
  'help',
  'agents',
])

/** The first argument that is not an option or an option's value. */
function firstPositional(args: readonly string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--') return args[i + 1]
    if (!a.startsWith('-')) return a
    if (!a.includes('=') && CODEX_ARGS.valued.includes(a)) i++
  }
  return undefined
}

/** `-s`/`--sandbox`, else `-c sandbox_mode=…`, else `sandbox_mode` in the Account's config.toml (profiles not read). */
async function sandboxMode(args: readonly string[], dir: string): Promise<string | undefined> {
  const flag = optionValue(args, ['-s', '--sandbox'])
  if (flag) return flag
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') break
    const kv = args[i] === '-c' || args[i] === '--config' ? args[i + 1] : undefined
    const m = kv && /^sandbox_mode\s*=\s*["']?([\w-]+)["']?$/.exec(kv)
    if (m) return m[1]
  }
  try {
    return topLevelTomlString(await readFile(join(dir, 'config.toml'), 'utf8'), 'sandbox_mode')
  } catch {
    return undefined
  }
}

const hookValue = (event: string, command: string) =>
  `hooks.${event}=[{hooks=[{type="command",command="${command}"}]}]`

export const codexHandoff: FamilyHandoff = {
  starts: ['quota'],
  async hookArgs(command) {
    return ['-c', hookValue('PostToolUse', command('PostToolUse')), '-c', hookValue('Stop', command('Stop'))]
  },
  dirArgs: (dir) => ['--add-dir', dir],
  promptArgs: promptAfterDashes,
  continueArgs: (args) => carryArgs(args, CODEX_ARGS),
  resumeArgs: (id) => ['resume', id],
  async eligibility(args, account) {
    const sub = firstPositional(args)
    if (sub && NOT_INTERACTIVE.has(sub))
      return { start: false, receive: false, reason: `\`codex ${sub}\` is not an interactive session` }
    if (hasOption(args, ['--remote']))
      return {
        start: false,
        receive: false,
        reason: '`--remote` talks to a remote app server: another local account cannot take over its session',
      }
    // Under a read-only sandbox the session cannot write its Brief; sideby puts one together instead.
    const sandbox = await sandboxMode(args, account.dir)
    return { start: true, receive: true, ...(sandbox === 'read-only' ? { agentBrief: false } : {}) }
  },
  briefFromSession: codexBrief,
}
